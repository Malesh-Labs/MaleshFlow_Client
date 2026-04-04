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
export const PLANNER_DAY_META_KIND = "plannerDay";
export const PLANNER_LINKED_TASK_META_KIND = "plannerLinkedTask";

function getRecordMeta(value: unknown) {
  return value && typeof value === "object"
    ? { ...(value as Record<string, unknown>) }
    : {};
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

export function findPlannerSectionNode(
  nodes: Doc<"nodes">[],
  slot: typeof PLANNER_SIDEBAR_SLOT | typeof PLANNER_TEMPLATE_SLOT,
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
  return roots[roots.length - 1] ?? null;
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

  for (const weekday of [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]) {
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

  await enqueuePageRootEmbeddingRefresh(ctx, page._id);

  return {
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
    sourceTask: Doc<"nodes">;
    afterNodeId: Id<"nodes"> | null;
  },
) {
  const sourceMeta = getNodeSourceMeta(args.sourceTask);
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
    text: args.sourceTask.text,
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
  } = {},
) {
  const tasks = await db
    .query("nodes")
    .withIndex("by_kind_status", (query) => query.eq("kind", "task"))
    .collect();

  const activeTasks = tasks.filter(
    (task) => !task.archived && task.taskStatus !== "done" && task.taskStatus !== "cancelled",
  );
  const uniquePageIds = [...new Set(activeTasks.map((task) => task.pageId))];
  const pages = await Promise.all(uniquePageIds.map((pageId) => db.get(pageId)));
  const pageMap = new Map(
    pages.filter((page): page is Doc<"pages"> => page !== null).map((page) => [page._id, page]),
  );

  return activeTasks.filter((task) => {
    const page = pageMap.get(task.pageId);
    if (!page || page.archived || !isTaskSourcePage(page)) {
      return false;
    }

    if (args.excludeSourceTaskIds?.has(task._id as string)) {
      return false;
    }

    if (args.plannerDate) {
      return plannerDayMatchesDueDateRange({
        dayTimestamp: args.plannerDate,
        dueAt: task.dueAt,
        dueEndAt: task.dueEndAt ?? null,
      });
    }

    return true;
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

  const sourceTaskId = getPlannerLinkedSourceTaskId(plannerNode);
  const now = Date.now();
  if (sourceTaskId) {
    const sourceTask = await ctx.db.get(sourceTaskId);
    if (sourceTask && !sourceTask.archived) {
      const recurrenceFrequency = parseRecurrenceFrequency(
        getNodeSourceMeta(sourceTask).recurrenceFrequency,
      );
      if (recurrenceFrequency && sourceTask.dueAt) {
        const nextRange = advanceRecurringDueDateRange({
          dueAt: sourceTask.dueAt,
          dueEndAt: sourceTask.dueEndAt ?? null,
          frequency: recurrenceFrequency,
          mode: args.completionMode,
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
      await enqueuePageRootEmbeddingRefresh(ctx, sourceTask.pageId);
    }
  }

  const pastWeeksPage = await ensurePastWeeksPage(ctx);
  const plannerSubtree = await collectNodeTree(ctx.db, plannerNode._id);
  const existingPastWeeksRoots = (await listPageNodes(ctx.db, pastWeeksPage._id)).filter(
    (node) => node.parentNodeId === null,
  );
  const afterNodeId =
    existingPastWeeksRoots.sort((left, right) => left.position - right.position)[
      existingPastWeeksRoots.length - 1
    ]?._id ?? null;

  await clonePlannerSubtree(ctx, {
    sourceNodes: plannerSubtree,
    rootNodeId: plannerNode._id,
    targetPageId: pastWeeksPage._id,
    targetParentNodeId: null,
    targetAfterNodeId: afterNodeId,
    transformSourceMeta: (sourceNode, sourceMeta) => ({
      ...sourceMeta,
      sourceType: "plannerArchive",
      archivedFromPlannerNodeId: plannerNode._id,
      archivedAt: now,
    }),
    transformNode: (sourceNode, depth) =>
      depth === 0 && sourceNode.kind === "task"
        ? {
            taskStatus: "done",
          }
        : {},
  });

  await setNodeTreeArchivedState(ctx.db, plannerNode._id, true, now);
  await enqueuePageRootEmbeddingRefresh(ctx, plannerNode.pageId);
  await enqueuePageRootEmbeddingRefresh(ctx, pastWeeksPage._id);
}

export function buildPlannerChatPromptContext(args: {
  page: Doc<"pages">;
  plannerNodes: Doc<"nodes">[];
  sourceTasks: Doc<"nodes">[];
}) {
  const currentDay = getCurrentPlannerDay(args.plannerNodes);
  const currentDayChildren = currentDay
    ? args.plannerNodes
        .filter((node) => node.parentNodeId === currentDay._id)
        .sort((left, right) => left.position - right.position)
    : [];

  return {
    currentDayTitle: currentDay?.text ?? null,
    currentDayId: currentDay?._id ?? null,
    currentDayLines: currentDayChildren.map((node) => ({
      nodeId: node._id as string,
      text: node.text,
      linkedSourceTaskId: getPlannerLinkedSourceTaskId(node),
      status: node.taskStatus,
    })),
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
    const weekdaySubtree = await collectNodeTree(ctx.db, weekdayRoot._id);
    const weekdayChildren = weekdaySubtree
      .filter((node) => node.parentNodeId === weekdayRoot._id)
      .sort((left, right) => left.position - right.position);
    for (const child of weekdayChildren) {
      afterChildId = await clonePlannerSubtree(ctx, {
        sourceNodes: weekdaySubtree,
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
