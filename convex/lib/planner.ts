import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import {
  buildUniquePageSlug,
  collectNodeTree,
  computeNodePosition,
  enqueueNodeAiWork,
  enqueuePageRootEmbeddingRefresh,
  listPageNodes,
  syncLinksForNode,
  setNodeTreeArchivedState,
} from "./workspace";
import {
  comparePlannerTaskOrder,
  formatPlannerDayTitle,
  getEffectiveTaskDueDateRange,
  getPlannerWeekdayName,
  plannerDayMatchesDueDateRange,
} from "../../lib/domain/planner";
import {
  advanceRecurringDueDateRange,
  parseRecurrenceFrequency,
  type RecurringCompletionMode,
} from "../../lib/domain/recurrence";

export const PLANNER_SIDEBAR_SLOT = "plannerSidebar";
export const PLANNER_TEMPLATE_SLOT = "plannerTemplate";
export const PLANNER_FOCUS_SLOT = "plannerFocus";
export const PLANNER_DAY_META_KIND = "plannerDay";
export const PLANNER_LINKED_TASK_META_KIND = "plannerLinkedTask";
const PLANNER_TEMPLATE_WEEKDAY_ORDER = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
export type PlannerSourceTask = Doc<"nodes"> & {
  dueAt: number | null;
  dueEndAt: number | null;
};

function getRecordMeta(value: unknown) {
  return value && typeof value === "object"
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function sanitizePlannerLinkLabel(value: string, fallback = "Untitled") {
  const trimmed = value.replace(/\|/g, "/").replace(/\]\]/g, "] ]").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function isPlannerPlaceholderTaskText(text: string) {
  return text.trim() === "__small__";
}

export function isPlannerDerivedSourceTask(
  node: Pick<Doc<"nodes">, "sourceMeta"> | null | undefined,
) {
  const sourceMeta = getNodeSourceMeta(node);
  return (
    sourceMeta.sourceType === "planner" ||
    sourceMeta.sourceType === "plannerTemplateClone" ||
    sourceMeta.sourceType === "plannerArchive" ||
    typeof sourceMeta.plannerKind === "string"
  );
}

export function getPageSourceMeta(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getRecordMeta(page?.sourceMeta ?? null);
}

export function getNodeSourceMeta(node: Pick<Doc<"nodes">, "sourceMeta"> | null | undefined) {
  return getRecordMeta(node?.sourceMeta ?? null);
}

export function getPlannerStartDate(
  page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined,
) {
  const sourceMeta = getPageSourceMeta(page);
  return typeof sourceMeta.plannerStartDate === "number"
    ? sourceMeta.plannerStartDate
    : null;
}

export function isPlannerPage(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  const sourceMeta = getPageSourceMeta(page);
  return sourceMeta.pageType === "planner";
}

export function isTaskSourcePage(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  const sourceMeta = getPageSourceMeta(page);
  return sourceMeta.pageType === "task" || sourceMeta.sidebarSection === "Tasks";
}

export function isPlannerScanExcludedPage(
  page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined,
) {
  const sourceMeta = getPageSourceMeta(page);
  return sourceMeta.excludeFromPlannerScan === true;
}

export function findPlannerSectionNode(
  nodes: Doc<"nodes">[],
  slot:
    | typeof PLANNER_SIDEBAR_SLOT
    | typeof PLANNER_TEMPLATE_SLOT
    | typeof PLANNER_FOCUS_SLOT,
) {
  return (
    nodes.find((node) => getNodeSourceMeta(node).sectionSlot === slot) ?? null
  );
}

export function isPlannerDayNode(node: Pick<Doc<"nodes">, "sourceMeta"> | null | undefined) {
  return getNodeSourceMeta(node).plannerKind === PLANNER_DAY_META_KIND;
}

export function getPlannerDayTimestamp(
  node: Pick<Doc<"nodes">, "sourceMeta"> | null | undefined,
) {
  const value = getNodeSourceMeta(node).plannerDate;
  return typeof value === "number" ? value : null;
}

export function isPlannerLinkedTaskNode(
  node: Pick<Doc<"nodes">, "sourceMeta"> | null | undefined,
) {
  return getNodeSourceMeta(node).plannerKind === PLANNER_LINKED_TASK_META_KIND;
}

export function getPlannerLinkedSourceTaskId(
  node: Pick<Doc<"nodes">, "sourceMeta"> | null | undefined,
) {
  const value = getNodeSourceMeta(node).sourceTaskNodeId;
  return typeof value === "string" && value.length > 0
    ? (value as Id<"nodes">)
    : null;
}

export function getPlannerDayRoots(nodes: Doc<"nodes">[]) {
  return nodes
    .filter((node) => node.parentNodeId === null && isPlannerDayNode(node))
    .sort((left, right) => {
      const leftDate = getPlannerDayTimestamp(left) ?? 0;
      const rightDate = getPlannerDayTimestamp(right) ?? 0;
      if (leftDate !== rightDate) {
        return leftDate - rightDate;
      }
      return left.position - right.position;
    });
}

export function getCurrentPlannerDay(nodes: Doc<"nodes">[]) {
  const roots = getPlannerDayRoots(nodes);
  return roots[0] ?? null;
}

function buildChildrenByParent(nodes: Doc<"nodes">[]) {
  const map = new Map<string | null, Doc<"nodes">[]>();
  for (const node of nodes) {
    const key = (node.parentNodeId as string | null) ?? null;
    const siblings = map.get(key) ?? [];
    siblings.push(node);
    map.set(key, siblings);
  }

  for (const siblings of map.values()) {
    siblings.sort((left, right) => left.position - right.position);
  }

  return map;
}

function buildNodeMap(nodes: Doc<"nodes">[]) {
  return new Map(nodes.map((node) => [node._id as string, node]));
}

function isPlannerNodeCompleted(node: Doc<"nodes">) {
  if (node.kind === "task") {
    return node.taskStatus === "done";
  }
  return getNodeSourceMeta(node).noteCompleted === true;
}

function isPlannerDayAncestorNode(node: Doc<"nodes"> | null | undefined) {
  return !!node && isPlannerDayNode(node);
}

function isPlannerArchiveBoundaryNode(node: Doc<"nodes"> | null | undefined) {
  if (!node) {
    return false;
  }

  const sourceMeta = getNodeSourceMeta(node);
  return isPlannerDayNode(node) || sourceMeta.sectionSlot === PLANNER_FOCUS_SLOT;
}

function isPlannerSubtreeCompleted(
  nodeId: Id<"nodes">,
  nodeMap: Map<string, Doc<"nodes">>,
  childrenByParent: Map<string | null, Doc<"nodes">[]>,
) {
  const rootNode = nodeMap.get(nodeId as string);
  if (!rootNode || !isPlannerNodeCompleted(rootNode)) {
    return false;
  }

  const descendants = childrenByParent.get(nodeId as string) ?? [];
  for (const child of descendants) {
    if (!isPlannerSubtreeCompleted(child._id, nodeMap, childrenByParent)) {
      return false;
    }
  }

  return true;
}

function findArchivablePlannerSubtreeRoot(
  startNode: Doc<"nodes">,
  nodeMap: Map<string, Doc<"nodes">>,
  childrenByParent: Map<string | null, Doc<"nodes">[]>,
) {
  let currentNode: Doc<"nodes"> | null = startNode;
  while (currentNode) {
    const parentNode: Doc<"nodes"> | null = currentNode.parentNodeId
      ? (nodeMap.get(currentNode.parentNodeId as string) ?? null)
      : null;

    if (isPlannerArchiveBoundaryNode(parentNode)) {
      return isPlannerSubtreeCompleted(currentNode._id, nodeMap, childrenByParent)
        ? currentNode
        : null;
    }

    currentNode = parentNode;
  }

  return null;
}

async function syncPlannerLinkedSourceTaskCompletion(
  ctx: MutationCtx,
  plannerNodes: Doc<"nodes">[],
  completionMode: RecurringCompletionMode,
  now: number,
) {
  const syncedSourceTaskIds = new Set<string>();
  const touchedPageIds = new Set<string>();

  for (const plannerNode of plannerNodes) {
    const sourceTaskId = getPlannerLinkedSourceTaskId(plannerNode);
    if (!sourceTaskId || syncedSourceTaskIds.has(sourceTaskId as string)) {
      continue;
    }
    syncedSourceTaskIds.add(sourceTaskId as string);

    const sourceTask = await ctx.db.get(sourceTaskId);
    if (!sourceTask || sourceTask.archived) {
      continue;
    }

    const recurrenceFrequency = parseRecurrenceFrequency(
      getNodeSourceMeta(sourceTask).recurrenceFrequency,
    );
    if (recurrenceFrequency && sourceTask.dueAt) {
      const nextRange = advanceRecurringDueDateRange({
        dueAt: sourceTask.dueAt,
        dueEndAt: sourceTask.dueEndAt ?? null,
        frequency: recurrenceFrequency,
        mode: completionMode,
      });
      await ctx.db.patch(sourceTask._id, {
        taskStatus: "todo",
        dueAt: nextRange.dueAt,
        dueEndAt: nextRange.dueEndAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(sourceTask._id, {
        taskStatus: "done",
        updatedAt: now,
      });
    }

    touchedPageIds.add(sourceTask.pageId as string);
  }

  for (const pageId of touchedPageIds) {
    await enqueuePageRootEmbeddingRefresh(ctx, pageId as Id<"pages">);
  }
}

async function archivePlannerSubtreeToPastWeeks(
  ctx: MutationCtx,
  plannerRootNode: Doc<"nodes">,
  completionMode: RecurringCompletionMode,
  now: number,
) {
  const plannerSubtree = await collectNodeTree(ctx.db, plannerRootNode._id);
  await syncPlannerLinkedSourceTaskCompletion(ctx, plannerSubtree, completionMode, now);

  const pastWeeksPage = await ensurePastWeeksPage(ctx);
  const existingPastWeeksRoots = (await listPageNodes(ctx.db, pastWeeksPage._id)).filter(
    (node) => node.parentNodeId === null,
  );
  const afterNodeId =
    existingPastWeeksRoots.sort((left, right) => left.position - right.position)[
      existingPastWeeksRoots.length - 1
    ]?._id ?? null;

  await clonePlannerSubtree(ctx, {
    sourceNodes: plannerSubtree,
    rootNodeId: plannerRootNode._id,
    targetPageId: pastWeeksPage._id,
    targetParentNodeId: null,
    targetAfterNodeId: afterNodeId,
    transformSourceMeta: (_sourceNode, sourceMeta) => ({
      ...sourceMeta,
      sourceType: "plannerArchive",
      archivedFromPlannerNodeId: plannerRootNode._id,
      archivedAt: now,
    }),
    transformNode: (sourceNode, depth) =>
      depth === 0 && sourceNode.kind === "task"
        ? {
            taskStatus: "done",
          }
        : {},
  });

  await setNodeTreeArchivedState(ctx.db, plannerRootNode._id, true, now);
  await enqueuePageRootEmbeddingRefresh(ctx, plannerRootNode.pageId);
  await enqueuePageRootEmbeddingRefresh(ctx, pastWeeksPage._id);
}

export async function clonePlannerSubtree(
  ctx: MutationCtx,
  args: {
    sourceNodes: Doc<"nodes">[];
    rootNodeId: Id<"nodes">;
    targetPageId: Id<"pages">;
    targetParentNodeId: Id<"nodes"> | null;
    targetAfterNodeId: Id<"nodes"> | null;
    transformSourceMeta?: (
      sourceNode: Doc<"nodes">,
      sourceMeta: Record<string, unknown>,
      depth: number,
    ) => Record<string, unknown>;
    transformNode?: (
      sourceNode: Doc<"nodes">,
      depth: number,
    ) => Partial<
      Pick<
        Doc<"nodes">,
        "text" | "kind" | "taskStatus" | "priority" | "dueAt" | "dueEndAt"
      >
    >;
  },
) {
  const sourceMap = new Map(args.sourceNodes.map((node) => [node._id, node]));
  const childrenByParent = buildChildrenByParent(args.sourceNodes);

  const cloneRecursive = async (
    sourceNodeId: Id<"nodes">,
    parentNodeId: Id<"nodes"> | null,
    afterNodeId: Id<"nodes"> | null,
    depth: number,
  ): Promise<Id<"nodes"> | null> => {
    const sourceNode = sourceMap.get(sourceNodeId);
    if (!sourceNode) {
      return null;
    }

    const sourceMeta = getNodeSourceMeta(sourceNode);
    const nextSourceMeta = args.transformSourceMeta
      ? args.transformSourceMeta(sourceNode, sourceMeta, depth)
      : sourceMeta;
    const overrides = args.transformNode
      ? args.transformNode(sourceNode, depth)
      : {};
    const position = await computeNodePosition(
      ctx.db,
      args.targetPageId,
      parentNodeId,
      afterNodeId,
    );
    const nodeId = await ctx.db.insert("nodes", {
      pageId: args.targetPageId,
      parentNodeId,
      position,
      text: overrides.text ?? sourceNode.text,
      kind: overrides.kind ?? sourceNode.kind,
      taskStatus:
        overrides.kind === "note"
          ? null
          : (overrides.taskStatus ?? sourceNode.taskStatus),
      priority: overrides.priority ?? sourceNode.priority,
      dueAt:
        (overrides.kind ?? sourceNode.kind) === "task"
          ? (overrides.dueAt ?? sourceNode.dueAt)
          : null,
      dueEndAt:
        (overrides.kind ?? sourceNode.kind) === "task"
          ? (overrides.dueEndAt ?? sourceNode.dueEndAt ?? null)
          : null,
      archived: false,
      sourceMeta: nextSourceMeta,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const inserted = await ctx.db.get(nodeId);
    if (inserted) {
      await syncLinksForNode(ctx.db, inserted);
      await enqueueNodeAiWork(ctx, inserted._id);
    }

    let previousChildId: Id<"nodes"> | null = null;
    const children = childrenByParent.get(sourceNodeId as string) ?? [];
    for (const child of children) {
      previousChildId = await cloneRecursive(
        child._id,
        nodeId,
        previousChildId,
        depth + 1,
      );
    }

    return nodeId;
  };

  return await cloneRecursive(
    args.rootNodeId,
    args.targetParentNodeId,
    args.targetAfterNodeId,
    0,
  );
}

export async function ensurePlannerSections(
  ctx: MutationCtx,
  page: Doc<"pages">,
) {
  const nodes = await listPageNodes(ctx.db, page._id);
  const now = Date.now();
  let sidebarSection = findPlannerSectionNode(nodes, PLANNER_SIDEBAR_SLOT);
  let templateSection = findPlannerSectionNode(nodes, PLANNER_TEMPLATE_SLOT);
  let focusSection = findPlannerSectionNode(nodes, PLANNER_FOCUS_SLOT);

  const rootNodes = nodes.filter((node) => node.parentNodeId === null);
  let afterNodeId: Id<"nodes"> | null =
    rootNodes.sort((left, right) => left.position - right.position)[rootNodes.length - 1]?._id ??
    null;

  if (!sidebarSection) {
    const nodeId = await ctx.db.insert("nodes", {
      pageId: page._id,
      parentNodeId: null,
      position: await computeNodePosition(ctx.db, page._id, null, afterNodeId),
      text: "Sidebar",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "system",
        sectionSlot: PLANNER_SIDEBAR_SLOT,
        locked: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    sidebarSection = await ctx.db.get(nodeId);
    afterNodeId = nodeId;
  }

  if (!templateSection) {
    const nodeId = await ctx.db.insert("nodes", {
      pageId: page._id,
      parentNodeId: null,
      position: await computeNodePosition(ctx.db, page._id, null, afterNodeId),
      text: "Template",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "system",
        sectionSlot: PLANNER_TEMPLATE_SLOT,
        locked: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    templateSection = await ctx.db.get(nodeId);
  }

  if (!focusSection) {
    const nodeId = await ctx.db.insert("nodes", {
      pageId: page._id,
      parentNodeId: null,
      position: await computeNodePosition(ctx.db, page._id, null, null),
      text: "Focus",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "system",
        sectionSlot: PLANNER_FOCUS_SLOT,
        locked: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    focusSection = await ctx.db.get(nodeId);
  }

  if (!templateSection) {
    throw new Error("Could not initialize planner template section.");
  }

  const refreshedNodes = await listPageNodes(ctx.db, page._id);
  const templateChildren = refreshedNodes.filter(
    (node) => node.parentNodeId === templateSection!._id,
  );
  const existingWeekdayNames = new Set(templateChildren.map((node) => node.text.trim()));
  let previousWeekdayId: Id<"nodes"> | null =
    templateChildren.sort((left, right) => left.position - right.position)[
      templateChildren.length - 1
    ]?._id ?? null;

  for (const weekday of PLANNER_TEMPLATE_WEEKDAY_ORDER) {
    if (existingWeekdayNames.has(weekday)) {
      previousWeekdayId =
        templateChildren.find((node) => node.text.trim() === weekday)?._id ?? previousWeekdayId;
      continue;
    }

    const weekdayId: Id<"nodes"> = await ctx.db.insert("nodes", {
      pageId: page._id,
      parentNodeId: templateSection._id,
      position: await computeNodePosition(
        ctx.db,
        page._id,
        templateSection._id,
        previousWeekdayId,
      ),
      text: weekday,
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "system",
        plannerTemplateWeekday: weekday,
        locked: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    previousWeekdayId = weekdayId;
  }

  const reorderedTemplateChildren = (await listPageNodes(ctx.db, page._id)).filter(
    (node) => node.parentNodeId === templateSection!._id,
  );
  let previousReorderedWeekdayId: Id<"nodes"> | null = null;
  for (const weekday of PLANNER_TEMPLATE_WEEKDAY_ORDER) {
    const weekdayNode =
      reorderedTemplateChildren.find((node) => node.text.trim() === weekday) ?? null;
    if (!weekdayNode) {
      continue;
    }

    await ctx.db.patch(weekdayNode._id, {
      position: await computeNodePosition(
        ctx.db,
        page._id,
        templateSection._id,
        previousReorderedWeekdayId,
      ),
      updatedAt: now,
    });
    previousReorderedWeekdayId = weekdayNode._id;
  }

  await enqueuePageRootEmbeddingRefresh(ctx, page._id);

  return {
    focusSectionId: focusSection?._id ?? null,
    sidebarSectionId: sidebarSection?._id ?? null,
    templateSectionId: templateSection._id,
  };
}

async function ensurePastWeeksPage(ctx: MutationCtx) {
  const archivedPages = await ctx.db
    .query("pages")
    .withIndex("by_archived_position", (query) => query.eq("archived", true))
    .take(200);
  const existing = archivedPages.find((page) => page.title === "Past Weeks") ?? null;
  if (existing) {
    return existing;
  }

  const slug = await buildUniquePageSlug(ctx.db, "Past Weeks");
  const pageId = await ctx.db.insert("pages", {
    title: "Past Weeks",
    slug,
    icon: null,
    archived: true,
    position: Date.now(),
    sourceMeta: {
      sourceType: "system",
      pageType: "note",
      archivedPurpose: "plannerHistory",
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const page = await ctx.db.get(pageId);
  if (!page) {
    throw new Error("Could not create Past Weeks.");
  }
  return page;
}

export async function appendPlannerLinkedTaskCopy(
  ctx: MutationCtx,
  args: {
    plannerPageId: Id<"pages">;
    dayNodeId: Id<"nodes">;
    plannerDate: number;
    sourceTask: PlannerSourceTask;
    afterNodeId: Id<"nodes"> | null;
  },
) {
  const sourceMeta = getNodeSourceMeta(args.sourceTask);
  const sourcePage = await ctx.db.get(args.sourceTask.pageId);
  const pageLinkText =
    sourcePage && !sourcePage.archived
      ? ` [[${sanitizePlannerLinkLabel(sourcePage.title, "Source page")}|page:${sourcePage._id}]]`
      : "";
  const position = await computeNodePosition(
    ctx.db,
    args.plannerPageId,
    args.dayNodeId,
    args.afterNodeId,
  );
  const nodeId = await ctx.db.insert("nodes", {
    pageId: args.plannerPageId,
    parentNodeId: args.dayNodeId,
    position,
    text: `[[node:${args.sourceTask._id}]]${pageLinkText}`,
    kind: "task",
    taskStatus: args.sourceTask.taskStatus ?? "todo",
    priority: args.sourceTask.priority,
    dueAt: args.sourceTask.dueAt,
    dueEndAt: args.sourceTask.dueEndAt ?? null,
    archived: false,
    sourceMeta: {
      sourceType: "planner",
      plannerKind: PLANNER_LINKED_TASK_META_KIND,
      plannerDate: args.plannerDate,
      sourceTaskNodeId: args.sourceTask._id,
      sourceTaskPageId: args.sourceTask.pageId,
      taskKindLocked: true,
      recurrenceFrequency: sourceMeta.recurrenceFrequency ?? null,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const inserted = await ctx.db.get(nodeId);
  if (inserted) {
    await syncLinksForNode(ctx.db, inserted);
    await enqueueNodeAiWork(ctx, inserted._id);
  }

  return nodeId;
}

export async function listEligiblePlannerSourceTasks(
  db: DatabaseReader,
  args: {
    excludeSourceTaskIds?: Set<string>;
    plannerDate?: number | null;
    dueByDate?: number | null;
  } = {},
) {
  const tasks = await db
    .query("nodes")
    .withIndex("by_kind_status", (query) => query.eq("kind", "task"))
    .collect();

  const activeTasks = tasks.filter(
    (task) =>
      !task.archived &&
      task.taskStatus !== "done" &&
      task.taskStatus !== "cancelled" &&
      !isPlannerPlaceholderTaskText(task.text) &&
      !isPlannerDerivedSourceTask(task),
  );
  const uniquePageIds = [...new Set(activeTasks.map((task) => task.pageId))];
  const pages = await Promise.all(uniquePageIds.map((pageId) => db.get(pageId)));
  const pageMap = new Map(
    pages.filter((page): page is Doc<"pages"> => page !== null).map((page) => [page._id, page]),
  );
  const eligiblePageIds = uniquePageIds.filter((pageId) => {
    const page = pageMap.get(pageId);
    if (!page || page.archived || !isTaskSourcePage(page)) {
      return false;
    }

    if (isPlannerScanExcludedPage(page)) {
      return false;
    }

    return true;
  });
  const pageNodeMaps = new Map<string, Map<string, Doc<"nodes">>>();
  await Promise.all(
    eligiblePageIds.map(async (pageId) => {
      const pageNodes = await listPageNodes(db, pageId);
      pageNodeMaps.set(pageId as string, buildNodeMap(pageNodes));
    }),
  );

  return activeTasks.flatMap((task) => {
    const page = pageMap.get(task.pageId);
    if (!page || page.archived || !isTaskSourcePage(page) || isPlannerScanExcludedPage(page)) {
      return [];
    }

    if (args.excludeSourceTaskIds?.has(task._id as string)) {
      return [];
    }

    const pageNodeMap = pageNodeMaps.get(task.pageId as string);
    const effectiveDueRange = pageNodeMap
      ? getEffectiveTaskDueDateRange(task, pageNodeMap)
      : {
          dueAt: task.dueAt ?? null,
          dueEndAt: task.dueEndAt ?? null,
        };
    const effectiveTask: PlannerSourceTask = {
      ...task,
      dueAt: effectiveDueRange.dueAt,
      dueEndAt: effectiveDueRange.dueEndAt ?? null,
    };

    if (args.plannerDate) {
      return plannerDayMatchesDueDateRange({
        dayTimestamp: args.plannerDate,
        dueAt: effectiveTask.dueAt,
        dueEndAt: effectiveTask.dueEndAt ?? null,
      })
        ? [effectiveTask]
        : [];
    }

    if (args.dueByDate) {
      if (!effectiveTask.dueAt) {
        return [effectiveTask];
      }

      return effectiveTask.dueAt <= args.dueByDate ? [effectiveTask] : [];
    }

    return [effectiveTask];
  });
}

export async function completePlannerLinkedTask(
  ctx: MutationCtx,
  args: {
    plannerNodeId: Id<"nodes">;
    completionMode: RecurringCompletionMode;
  },
) {
  const plannerNode = await ctx.db.get(args.plannerNodeId);
  if (!plannerNode || plannerNode.archived) {
    throw new Error("Planner item not found.");
  }

  const now = Date.now();

  if (!isPlannerNodeCompleted(plannerNode)) {
    const sourceMeta = getNodeSourceMeta(plannerNode);
    if (plannerNode.kind === "task") {
      await ctx.db.patch(plannerNode._id, {
        taskStatus: "done",
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(plannerNode._id, {
        sourceMeta: {
          ...sourceMeta,
          noteCompleted: true,
        },
        updatedAt: now,
      });
    }
  }

  const pageNodes = await listPageNodes(ctx.db, plannerNode.pageId);
  const nodeMap = buildNodeMap(pageNodes);
  const childrenByParent = buildChildrenByParent(pageNodes);
  const refreshedPlannerNode = nodeMap.get(args.plannerNodeId as string);
  if (!refreshedPlannerNode) {
    throw new Error("Planner item not found after completion.");
  }

  const archivableRoot = findArchivablePlannerSubtreeRoot(
    refreshedPlannerNode,
    nodeMap,
    childrenByParent,
  );
  if (!archivableRoot) {
    await enqueuePageRootEmbeddingRefresh(ctx, refreshedPlannerNode.pageId);
    return;
  }

  await archivePlannerSubtreeToPastWeeks(ctx, archivableRoot, args.completionMode, now);
}

export function buildPlannerChatPromptContext(args: {
  page: Doc<"pages">;
  plannerNodes: Doc<"nodes">[];
  sourceTasks: Doc<"nodes">[];
}) {
  const sourceTaskMap = new Map(args.sourceTasks.map((task) => [task._id as string, task]));
  const childrenByParent = buildChildrenByParent(args.plannerNodes);
  const currentDay = getCurrentPlannerDay(args.plannerNodes);
  const sidebarSection = findPlannerSectionNode(args.plannerNodes, PLANNER_SIDEBAR_SLOT);
  const currentDayChildren = currentDay
    ? args.plannerNodes
        .filter((node) => node.parentNodeId === currentDay._id)
        .sort((left, right) => left.position - right.position)
    : [];
  const anytimeLines: Array<{
    nodeId: string;
    text: string;
    linkedSourceTaskId: Id<"nodes"> | null;
    status: string | null;
    depth: number;
  }> = [];

  const appendSectionLines = (parentNodeId: Id<"nodes">, depth: number) => {
    const children = childrenByParent.get(parentNodeId as string) ?? [];
    for (const node of children) {
      const linkedSourceTaskId = getPlannerLinkedSourceTaskId(node);
      anytimeLines.push({
        nodeId: node._id as string,
        text: linkedSourceTaskId
          ? (sourceTaskMap.get(linkedSourceTaskId as string)?.text ?? node.text)
          : node.text,
        linkedSourceTaskId,
        status: node.taskStatus,
        depth,
      });
      appendSectionLines(node._id, depth + 1);
    }
  };

  if (sidebarSection) {
    appendSectionLines(sidebarSection._id, 0);
  }

  return {
    currentDayTitle: currentDay?.text ?? null,
    currentDayId: currentDay?._id ?? null,
    currentDayLines: currentDayChildren.map((node) => ({
      nodeId: node._id as string,
      text:
        (() => {
          const linkedSourceTaskId = getPlannerLinkedSourceTaskId(node);
          if (!linkedSourceTaskId) {
            return node.text;
          }
          return sourceTaskMap.get(linkedSourceTaskId as string)?.text ?? node.text;
        })(),
      linkedSourceTaskId: getPlannerLinkedSourceTaskId(node),
      status: node.taskStatus,
    })),
    anytimeLines,
    openSourceTasks: args.sourceTasks
      .sort((left, right) => comparePlannerTaskOrder(left, right))
      .slice(0, 40)
      .map((task) => ({
        nodeId: task._id as string,
        text: task.text,
        dueAt: task.dueAt,
        dueEndAt: task.dueEndAt ?? null,
      })),
  };
}

export async function appendPlannerDayCore(
  ctx: MutationCtx,
  args: {
    page: Doc<"pages">;
    plannerDate: number;
  },
) {
  const nodes = await listPageNodes(ctx.db, args.page._id);
  const templateSection = findPlannerSectionNode(nodes, PLANNER_TEMPLATE_SLOT);
  if (!templateSection) {
    throw new Error("Planner template section not found.");
  }

  const existingDay = getPlannerDayRoots(nodes).find(
    (node) => getPlannerDayTimestamp(node) === args.plannerDate,
  );
  if (existingDay) {
    return { dayNodeId: existingDay._id, insertedTaskNodeIds: [] as Id<"nodes">[] };
  }

  const rootNodes = nodes.filter((node) => node.parentNodeId === null);
  const afterRootId =
    rootNodes.sort((left, right) => left.position - right.position)[rootNodes.length - 1]?._id ??
    null;
  const dayNodeId = await ctx.db.insert("nodes", {
    pageId: args.page._id,
    parentNodeId: null,
    position: await computeNodePosition(ctx.db, args.page._id, null, afterRootId),
    text: formatPlannerDayTitle(args.plannerDate),
    kind: "note",
    taskStatus: null,
    priority: null,
    dueAt: null,
    dueEndAt: null,
    archived: false,
    sourceMeta: {
      sourceType: "system",
      plannerKind: PLANNER_DAY_META_KIND,
      plannerDate: args.plannerDate,
      locked: true,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const dayNode = await ctx.db.get(dayNodeId);
  if (dayNode) {
    await syncLinksForNode(ctx.db, dayNode);
    await enqueueNodeAiWork(ctx, dayNode._id);
  }

  const refreshedNodes = await listPageNodes(ctx.db, args.page._id);
  const templateChildren = refreshedNodes
    .filter((node) => node.parentNodeId === templateSection._id)
    .sort((left, right) => left.position - right.position);
  const weekdayRoot =
    templateChildren.find(
      (node) => node.text.trim() === getPlannerWeekdayName(args.plannerDate),
    ) ?? null;

  const insertedTaskNodeIds: Id<"nodes">[] = [];
  let afterChildId: Id<"nodes"> | null = null;

  if (weekdayRoot) {
    const weekdayChildren = refreshedNodes
      .filter((node) => node.parentNodeId === weekdayRoot._id)
      .sort((left, right) => left.position - right.position);
    for (const child of weekdayChildren) {
      const childSubtree = await collectNodeTree(ctx.db, child._id);
      afterChildId = await clonePlannerSubtree(ctx, {
        sourceNodes: [child, ...childSubtree],
        rootNodeId: child._id,
        targetPageId: args.page._id,
        targetParentNodeId: dayNodeId,
        targetAfterNodeId: afterChildId,
        transformSourceMeta: (sourceNode, sourceMeta) => ({
          ...sourceMeta,
          sourceType: "plannerTemplateClone",
          plannerDate: args.plannerDate,
        }),
      });
    }
  }

  const existingSourceTaskIds = new Set<string>();
  const eligibleSourceTasks = await listEligiblePlannerSourceTasks(ctx.db, {
    plannerDate: args.plannerDate,
    excludeSourceTaskIds: existingSourceTaskIds,
  });
  const sortedEligible = eligibleSourceTasks.sort((left, right) =>
    comparePlannerTaskOrder(left, right),
  );

  for (const task of sortedEligible) {
    const insertedId = await appendPlannerLinkedTaskCopy(ctx, {
      plannerPageId: args.page._id,
      dayNodeId,
      plannerDate: args.plannerDate,
      sourceTask: task,
      afterNodeId: afterChildId,
    });
    insertedTaskNodeIds.push(insertedId);
    afterChildId = insertedId;
  }

  await enqueuePageRootEmbeddingRefresh(ctx, args.page._id);
  return {
    dayNodeId,
    insertedTaskNodeIds,
  };
}
