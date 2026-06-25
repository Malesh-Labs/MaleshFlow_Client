import { v } from "convex/values";
import {
  internalQuery,
  mutation,
  query,
  type DatabaseReader,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  appendPlannerDayCore,
  appendPlannerLinkedTaskCopy,
  ensurePlannerSections,
  findPlannerSectionNode,
  getCurrentPlannerDay,
  getPageSourceMeta,
  getPlannerDayRoots,
  getPlannerDayTimestamp,
  getPlannerLinkedSourceTaskId,
  PLANNER_FOCUS_SLOT,
  isPlannerPage,
  listEligiblePlannerSourceTasks,
  completePlannerLinkedTask,
  getNodeSourceMeta,
} from "./lib/planner";
import {
  collectNodeTree,
  computeNodePosition,
  enqueuePageRootEmbeddingRefresh,
  listPageNodes,
  setNodeTreeArchivedState,
} from "./lib/workspace";
import {
  comparePlannerTaskOrder,
  getEffectiveTaskDueDateRange,
  getPlannerMergeDuplicateResolution,
  getPlannerMergeItemRichnessScore,
} from "../lib/domain/planner";
import { getAppendPosition } from "../lib/domain/positions";
import {
  getExplicitWikiLinkPreviewText,
  replaceLinkMarkupWithLabels,
} from "../lib/domain/links";
import { stripInlineFormattingMarkers } from "../lib/domain/inlineFormatting";

const PURE_NODE_WIKI_LINK_PATTERN = /^\[\[(?:(.*?)\|)?node:([a-zA-Z0-9_-]+)\]\]$/;
const PURE_PAREN_NODE_LINK_PATTERN = /^\(\(([a-zA-Z0-9_-]+)\)\)$/;
const PURE_RAW_NODE_REFERENCE_PATTERN = /^node:([a-zA-Z0-9_-]+)$/;

function normalizePlannerSuggestionText(text: string) {
  return stripInlineFormattingMarkers(replaceLinkMarkupWithLabels(text)).trim();
}

async function resolvePlannerSuggestionText(db: DatabaseReader, text: string) {
  const trimmed = text.trim();
  const wikiMatch = trimmed.match(PURE_NODE_WIKI_LINK_PATTERN);
  const parenMatch = trimmed.match(PURE_PAREN_NODE_LINK_PATTERN);
  const rawMatch = trimmed.match(PURE_RAW_NODE_REFERENCE_PATTERN);

  const explicitLabel = wikiMatch?.[1]
    ? getExplicitWikiLinkPreviewText(wikiMatch[1]).trim()
    : "";
  if (explicitLabel) {
    return explicitLabel;
  }

  const targetNodeId =
    wikiMatch?.[2]?.trim() ??
    parenMatch?.[1]?.trim() ??
    rawMatch?.[1]?.trim() ??
    "";
  if (!targetNodeId) {
    return text;
  }

  const targetNode = await db.get(targetNodeId as Id<"nodes">);
  const resolvedText = targetNode?.text ? normalizePlannerSuggestionText(targetNode.text) : "";
  return resolvedText || text;
}

async function buildPlannerTaskSelectionSummary(ctx: MutationCtx, plannerNode: Doc<"nodes">) {
  const linkedSourceTaskId = getPlannerLinkedSourceTaskId(plannerNode);
  const linkedSourceTask = linkedSourceTaskId ? await ctx.db.get(linkedSourceTaskId) : null;
  const sourcePageId =
    linkedSourceTask?.pageId ??
    (plannerNode.sourceMeta &&
    typeof plannerNode.sourceMeta === "object" &&
    typeof (plannerNode.sourceMeta as Record<string, unknown>).sourceTaskPageId === "string"
      ? ((plannerNode.sourceMeta as Record<string, unknown>).sourceTaskPageId as Id<"pages">)
      : null);
  const sourcePage = sourcePageId ? await ctx.db.get(sourcePageId) : null;

  return {
    plannerNodeId: plannerNode._id,
    text: await resolvePlannerSuggestionText(ctx.db, linkedSourceTask?.text ?? plannerNode.text),
    dueAt: linkedSourceTask?.dueAt ?? plannerNode.dueAt ?? null,
    dueEndAt: linkedSourceTask?.dueEndAt ?? plannerNode.dueEndAt ?? null,
    sourcePageId: sourcePage?._id ?? null,
    sourcePageTitle: sourcePage?.title ?? null,
    linkedSourceTaskId: linkedSourceTask?._id ?? linkedSourceTaskId ?? null,
  };
}

async function buildPlannerSourceTaskSummary(
  db: DatabaseReader,
  sourceTask: Doc<"nodes">,
) {
  const sourcePage = await db.get(sourceTask.pageId);

  return {
    sourceTaskId: sourceTask._id,
    text: await resolvePlannerSuggestionText(db, sourceTask.text),
    dueAt: sourceTask.dueAt ?? null,
    dueEndAt: sourceTask.dueEndAt ?? null,
    sourcePageId: sourcePage?._id ?? null,
    sourcePageTitle: sourcePage?.title ?? null,
  };
}

function isPlannerPlaceholderTaskText(text: string) {
  return text.trim() === "__small__";
}

async function updateMovedPlannerSubtreeDate(
  ctx: MutationCtx,
  rootNodeId: Id<"nodes">,
  plannerDate: number,
  now: number,
) {
  const subtree = await collectNodeTree(ctx.db, rootNodeId);
  for (const node of subtree) {
    const sourceMeta = getNodeSourceMeta(node);
    if (typeof sourceMeta.plannerDate !== "number") {
      continue;
    }
    await ctx.db.patch(node._id, {
      sourceMeta: {
        ...sourceMeta,
        plannerDate,
      },
      updatedAt: now,
    });
  }
}

type PlannerMergeDuplicateCandidate = {
  node: Doc<"nodes">;
  location: "focus" | "carry";
};

async function moveDirectPlannerMergeChildren(
  ctx: MutationCtx,
  args: {
    fromParentId: Id<"nodes">;
    toParentId: Id<"nodes">;
    now: number;
    plannerDate?: number | null;
  },
) {
  const fromParent = await ctx.db.get(args.fromParentId);
  const toParent = await ctx.db.get(args.toParentId);
  if (!fromParent || !toParent || fromParent.archived || toParent.archived) {
    return 0;
  }

  const children = (
    await ctx.db
      .query("nodes")
      .withIndex("by_page_parent_position", (query) =>
        query.eq("pageId", fromParent.pageId).eq("parentNodeId", fromParent._id),
      )
      .collect()
  )
    .filter((node) => !node.archived)
    .sort((left, right) => left.position - right.position);
  if (children.length === 0) {
    return 0;
  }

  const targetChildren = (
    await ctx.db
      .query("nodes")
      .withIndex("by_page_parent_position", (query) =>
        query.eq("pageId", toParent.pageId).eq("parentNodeId", toParent._id),
      )
      .collect()
  )
    .filter((node) => !node.archived)
    .sort((left, right) => left.position - right.position);
  let afterNodeId = targetChildren[targetChildren.length - 1]?._id ?? null;
  let movedCount = 0;

  for (const child of children) {
    const nextPosition = await computeNodePosition(
      ctx.db,
      toParent.pageId,
      toParent._id,
      afterNodeId,
    );
    await ctx.db.patch(child._id, {
      pageId: toParent.pageId,
      parentNodeId: toParent._id,
      position: nextPosition,
      updatedAt: args.now,
    });

    if (child.pageId !== toParent.pageId) {
      const subtree = await collectNodeTree(ctx.db, child._id);
      for (const descendant of subtree) {
        if (descendant._id === child._id) {
          continue;
        }
        await ctx.db.patch(descendant._id, {
          pageId: toParent.pageId,
          updatedAt: args.now,
        });
      }
    }

    if (typeof args.plannerDate === "number") {
      await updateMovedPlannerSubtreeDate(ctx, child._id, args.plannerDate, args.now);
    }

    afterNodeId = child._id;
    movedCount += 1;
  }

  return movedCount;
}

export const ensurePlannerPageSections = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Only planner pages can have planner sections.");
    }

    return await ensurePlannerSections(ctx, page);
  },
});

export const setPlannerStartDate = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    startDate: v.number(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    const sourceMeta = {
      ...getPageSourceMeta(page),
      plannerStartDate: args.startDate,
    };
    await ctx.db.patch(page._id, {
      sourceMeta,
      updatedAt: Date.now(),
    });

    return args.startDate;
  },
});

export const appendPlannerDay = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    await ensurePlannerSections(ctx, page);
    const nodes = await listPageNodes(ctx.db, page._id);
    const dayRoots = getPlannerDayRoots(nodes);
    if (dayRoots.length === 0) {
      throw new Error("Create the first day in the planner before adding the next one.");
    }
    const nextPlannerDate =
      (getPlannerDayTimestamp(dayRoots[dayRoots.length - 1]!) ??
        getPlannerDayTimestamp(dayRoots[0]!) ??
        0) +
      24 * 60 * 60 * 1000;

    return await appendPlannerDayCore(ctx, {
      page,
      plannerDate: nextPlannerDate,
    });
  },
});

export const addRandomPlannerTask = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    seed: v.number(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    const ensuredSections = await ensurePlannerSections(ctx, page);
    const nodes = await listPageNodes(ctx.db, page._id);
    const focusSection =
      findPlannerSectionNode(nodes, PLANNER_FOCUS_SLOT) ??
      (ensuredSections.focusSectionId
        ? ((await ctx.db.get(ensuredSections.focusSectionId)) ?? null)
        : null);
    if (!focusSection) {
      throw new Error("Could not prepare the Focus section.");
    }

    const currentDay = getCurrentPlannerDay(nodes);
    if (!currentDay) {
      throw new Error("Add the first planner day before pulling in tasks.");
    }

    const plannerDate = getPlannerDayTimestamp(currentDay);
    if (!plannerDate) {
      throw new Error("Current planner day is missing its date.");
    }

    const currentDayTree = await collectNodeTree(ctx.db, currentDay._id);
    const focusTree = await collectNodeTree(ctx.db, focusSection._id);
    const existingSourceIds = new Set(
      [...currentDayTree, ...focusTree]
        .map((node) => getPlannerLinkedSourceTaskId(node))
        .filter((value): value is Id<"nodes"> => value !== null)
        .map((value) => value as string),
    );

    const candidates = await listEligiblePlannerSourceTasks(ctx.db, {
      excludeSourceTaskIds: existingSourceIds,
      dueByDate: plannerDate,
    });
    if (candidates.length === 0) {
      throw new Error("No remaining open tasks are available for today.");
    }

    const focusChildren = focusTree
      .filter((node) => node.parentNodeId === focusSection._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    const afterNodeId = focusChildren[focusChildren.length - 1]?._id ?? null;
    const index = Math.abs(Math.trunc(args.seed)) % candidates.length;
    const sourceTask = candidates[index]!;
    const plannerNodeId = await appendPlannerLinkedTaskCopy(ctx, {
      plannerPageId: page._id,
      parentNodeId: focusSection._id,
      plannerDate,
      sourceTask,
      afterNodeId,
    });

    const insertedPlannerNode = await ctx.db.get(plannerNodeId);
    if (!insertedPlannerNode) {
      throw new Error("Could not create the suggested planner task.");
    }
    const summary = await buildPlannerTaskSelectionSummary(ctx, insertedPlannerNode);

    return {
      created: true,
      targetSectionNodeId: focusSection._id,
      ...summary,
    };
  },
});

export const suggestRandomPlannerTaskCandidate = internalQuery({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    seed: v.number(),
    excludeSourceTaskIds: v.optional(v.array(v.id("nodes"))),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    const nodes = await listPageNodes(ctx.db, page._id);
    const focusSection = findPlannerSectionNode(nodes, PLANNER_FOCUS_SLOT);
    const currentDay = getCurrentPlannerDay(nodes);
    if (!currentDay) {
      throw new Error("Add the first planner day before pulling in tasks.");
    }

    const plannerDate = getPlannerDayTimestamp(currentDay);
    if (!plannerDate) {
      throw new Error("Current planner day is missing its date.");
    }

    const currentDayTree = await collectNodeTree(ctx.db, currentDay._id);
    const focusTree = focusSection ? await collectNodeTree(ctx.db, focusSection._id) : [];
    const existingSourceIds = new Set(
      [...currentDayTree, ...focusTree]
        .map((node) => getPlannerLinkedSourceTaskId(node))
        .filter((value): value is Id<"nodes"> => value !== null)
        .map((value) => value as string),
    );

    const candidates = await listEligiblePlannerSourceTasks(ctx.db, {
      excludeSourceTaskIds: new Set([
        ...existingSourceIds,
        ...(args.excludeSourceTaskIds ?? []).map((value) => value as string),
      ]),
      dueByDate: plannerDate,
    });
    if (candidates.length === 0) {
      throw new Error("No remaining open tasks are available for today.");
    }

    const index = Math.abs(Math.trunc(args.seed)) % candidates.length;
    const sourceTask = candidates[index]!;
    return {
      targetSectionNodeId: focusSection?._id ?? null,
      ...(await buildPlannerSourceTaskSummary(ctx.db, sourceTask)),
    };
  },
});

export const resolvePlannerSuggestionNodeText = internalQuery({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      return null;
    }
    return await resolvePlannerSuggestionText(ctx.db, node.text);
  },
});

export const addPlannerSourceTask = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    sourceTaskId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    const ensuredSections = await ensurePlannerSections(ctx, page);
    const nodes = await listPageNodes(ctx.db, page._id);
    const focusSection =
      findPlannerSectionNode(nodes, PLANNER_FOCUS_SLOT) ??
      (ensuredSections.focusSectionId
        ? ((await ctx.db.get(ensuredSections.focusSectionId)) ?? null)
        : null);
    if (!focusSection) {
      throw new Error("Could not prepare the Focus section.");
    }

    const currentDay = getCurrentPlannerDay(nodes);
    if (!currentDay) {
      throw new Error("Add the first planner day before pulling in tasks.");
    }

    const plannerDate = getPlannerDayTimestamp(currentDay);
    if (!plannerDate) {
      throw new Error("Current planner day is missing its date.");
    }

    const currentDayTree = await collectNodeTree(ctx.db, currentDay._id);
    const focusTree = await collectNodeTree(ctx.db, focusSection._id);
    const existingSourceIds = new Set(
      [...currentDayTree, ...focusTree]
        .map((node) => getPlannerLinkedSourceTaskId(node))
        .filter((value): value is Id<"nodes"> => value !== null)
        .map((value) => value as string),
    );
    if (existingSourceIds.has(args.sourceTaskId as string)) {
      throw new Error("That task is already in today's plan.");
    }

    const candidates = await listEligiblePlannerSourceTasks(ctx.db, {
      excludeSourceTaskIds: existingSourceIds,
      dueByDate: plannerDate,
    });
    const sourceTask =
      candidates.find((candidate) => candidate._id === args.sourceTaskId) ?? null;
    if (!sourceTask) {
      throw new Error("That task is no longer eligible for today.");
    }

    const focusChildren = focusTree
      .filter((node) => node.parentNodeId === focusSection._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    const afterNodeId = focusChildren[focusChildren.length - 1]?._id ?? null;
    const plannerNodeId = await appendPlannerLinkedTaskCopy(ctx, {
      plannerPageId: page._id,
      parentNodeId: focusSection._id,
      plannerDate,
      sourceTask,
      afterNodeId,
    });

    const insertedPlannerNode = await ctx.db.get(plannerNodeId);
    if (!insertedPlannerNode) {
      throw new Error("Could not create the suggested planner task.");
    }
    const summary = await buildPlannerTaskSelectionSummary(ctx, insertedPlannerNode);

    return {
      created: true,
      targetSectionNodeId: focusSection._id,
      ...summary,
    };
  },
});

export const reorderPlannerDay = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    dayNodeId: v.id("nodes"),
    orderedNodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    const dayNode = await ctx.db.get(args.dayNodeId);
    if (!dayNode || dayNode.archived || dayNode.pageId !== args.pageId) {
      throw new Error("Planner day not found.");
    }

    const dayTree = await collectNodeTree(ctx.db, args.dayNodeId);
    const directChildren = dayTree
      .filter((node) => node.parentNodeId === args.dayNodeId && !node.archived)
      .sort((left, right) => left.position - right.position);
    const directChildIds = directChildren.map((node) => node._id as string);
    if (directChildIds.length !== args.orderedNodeIds.length) {
      throw new Error("Planner day order did not match the visible items.");
    }

    const expectedIds = new Set(directChildIds);
    const seenIds = new Set<string>();
    const isValid = args.orderedNodeIds.every((nodeId) => {
      const key = nodeId as string;
      if (!expectedIds.has(key) || seenIds.has(key)) {
        return false;
      }
      seenIds.add(key);
      return true;
    });
    if (!isValid || seenIds.size !== directChildren.length) {
      throw new Error("Planner day order contained unexpected items.");
    }

    let afterNodeId: Id<"nodes"> | null = null;
    for (const nodeId of args.orderedNodeIds) {
      const nextPosition = await computeNodePosition(
        ctx.db,
        args.pageId,
        args.dayNodeId,
        afterNodeId,
      );
      await ctx.db.patch(nodeId, {
        parentNodeId: args.dayNodeId,
        position: nextPosition,
        updatedAt: Date.now(),
      });
      afterNodeId = nodeId;
    }

    await enqueuePageRootEmbeddingRefresh(ctx, args.pageId);
  },
});

export const reorderPlannerFocusSection = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    focusSectionId: v.id("nodes"),
    orderedNodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    const focusSection = await ctx.db.get(args.focusSectionId);
    if (!focusSection || focusSection.archived || focusSection.pageId !== args.pageId) {
      throw new Error("Planner Focus section not found.");
    }
    if (getNodeSourceMeta(focusSection).sectionSlot !== PLANNER_FOCUS_SLOT) {
      throw new Error("That section is not the planner Focus section.");
    }

    const focusTree = await collectNodeTree(ctx.db, args.focusSectionId);
    const directChildren = focusTree
      .filter((node) => node.parentNodeId === args.focusSectionId && !node.archived)
      .sort((left, right) => left.position - right.position);
    const directChildIds = directChildren.map((node) => node._id as string);
    if (directChildIds.length !== args.orderedNodeIds.length) {
      throw new Error("Planner Focus order did not match the visible items.");
    }

    const expectedIds = new Set(directChildIds);
    const seenIds = new Set<string>();
    const isValid = args.orderedNodeIds.every((nodeId) => {
      const key = nodeId as string;
      if (!expectedIds.has(key) || seenIds.has(key)) {
        return false;
      }
      seenIds.add(key);
      return true;
    });
    if (!isValid || seenIds.size !== directChildren.length) {
      throw new Error("Planner Focus order contained unexpected items.");
    }

    let afterNodeId: Id<"nodes"> | null = null;
    for (const nodeId of args.orderedNodeIds) {
      const nextPosition = await computeNodePosition(
        ctx.db,
        args.pageId,
        args.focusSectionId,
        afterNodeId,
      );
      await ctx.db.patch(nodeId, {
        parentNodeId: args.focusSectionId,
        position: nextPosition,
        updatedAt: Date.now(),
      });
      afterNodeId = nodeId;
    }

    await enqueuePageRootEmbeddingRefresh(ctx, args.pageId);
  },
});

export const resolveNextPlannerTask = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    const nodes = await listPageNodes(ctx.db, page._id);
    const currentDay = getCurrentPlannerDay(nodes);
    if (!currentDay) {
      throw new Error("Add the first planner day before choosing the next task.");
    }

    const currentDayTree = await collectNodeTree(ctx.db, currentDay._id);
    const currentDayNodeMap = new Map(
      currentDayTree.map((node) => [node._id as string, node]),
    );
    const currentDayTasks = currentDayTree
      .filter((node) => node._id !== currentDay._id)
      .filter((node) => node.kind === "task" && node.taskStatus !== "done" && node.taskStatus !== "cancelled")
      .filter((node) => !isPlannerPlaceholderTaskText(node.text))
      .sort((left, right) =>
        comparePlannerTaskOrder(
          { ...left, ...getEffectiveTaskDueDateRange(left, currentDayNodeMap) },
          { ...right, ...getEffectiveTaskDueDateRange(right, currentDayNodeMap) },
        ),
      );
    if (currentDayTasks.length > 0) {
      const summary = await buildPlannerTaskSelectionSummary(ctx, currentDayTasks[0]!);
      return {
        created: false,
        ...summary,
      };
    }

    const plannerDate = getPlannerDayTimestamp(currentDay);
    if (!plannerDate) {
      throw new Error("Current planner day is missing its date.");
    }

    const existingSourceIds = new Set(
      currentDayTree
        .map((node) => getPlannerLinkedSourceTaskId(node))
        .filter((value): value is Id<"nodes"> => value !== null)
        .map((value) => value as string),
    );
    const sourceTasks = await listEligiblePlannerSourceTasks(ctx.db, {
      excludeSourceTaskIds: existingSourceIds,
    });
    const nextSourceTask = sourceTasks.sort((left, right) =>
      comparePlannerTaskOrder(left, right),
    )[0];
    if (!nextSourceTask) {
      throw new Error("No open tasks are available right now.");
    }

    const dayChildren = currentDayTree
      .filter((node) => node.parentNodeId === currentDay._id)
      .sort((left, right) => left.position - right.position);
    const afterNodeId = dayChildren[dayChildren.length - 1]?._id ?? null;
    const plannerNodeId = await appendPlannerLinkedTaskCopy(ctx, {
      plannerPageId: page._id,
      parentNodeId: currentDay._id,
      plannerDate,
      sourceTask: nextSourceTask,
      afterNodeId,
    });
    const insertedPlannerNode = await ctx.db.get(plannerNodeId);
    if (!insertedPlannerNode) {
      throw new Error("Could not create the suggested planner task.");
    }
    const summary = await buildPlannerTaskSelectionSummary(ctx, insertedPlannerNode);

    return {
      created: true,
      ...summary,
    };
  },
});

export const completePlannerTask = mutation({
  args: {
    ownerKey: v.string(),
    plannerNodeId: v.id("nodes"),
    completionMode: v.union(v.literal("dueDate"), v.literal("today")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    await completePlannerLinkedTask(ctx, {
      plannerNodeId: args.plannerNodeId,
      completionMode: args.completionMode,
    });
  },
});

export const completePlannerDay = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Planner page not found.");
    }

    const ensuredSections = await ensurePlannerSections(ctx, page);
    const nodes = await listPageNodes(ctx.db, page._id);
    const focusSection =
      findPlannerSectionNode(nodes, PLANNER_FOCUS_SLOT) ??
      (ensuredSections.focusSectionId
        ? ((await ctx.db.get(ensuredSections.focusSectionId)) ?? null)
        : null);
    if (!focusSection) {
      throw new Error("Could not prepare the Focus section.");
    }

    const dayRoots = getPlannerDayRoots(nodes);
    const topDay = dayRoots[0] ?? null;
    if (!topDay) {
      throw new Error("Add a planner day before completing one.");
    }

    const topDayDate = getPlannerDayTimestamp(topDay);
    if (!topDayDate) {
      throw new Error("Top planner day is missing its date.");
    }

    const now = Date.now();
    const topDayTree = await collectNodeTree(ctx.db, topDay._id);
    const topDayChildren = topDayTree
      .filter((node) => node.parentNodeId === topDay._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    const focusTree = await collectNodeTree(ctx.db, focusSection._id);
    const focusDirectChildren = focusTree
      .filter((node) => node.parentNodeId === focusSection._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    let movedCount = 0;
    let archivedDuplicateCount = 0;
    let keptCarryChildren: Doc<"nodes">[] = [];
    let duplicateCandidates: PlannerMergeDuplicateCandidate[] = focusDirectChildren.map(
      (node) => ({
        node,
        location: "focus" as const,
      }),
    );
    const linkedSourceCandidates = new Map<string, Doc<"nodes">>();

    const removeDuplicateCandidate = (nodeId: Id<"nodes">) => {
      duplicateCandidates = duplicateCandidates.filter(
        (candidate) => candidate.node._id !== nodeId,
      );
      for (const [sourceTaskId, candidate] of linkedSourceCandidates) {
        if (candidate._id === nodeId) {
          linkedSourceCandidates.delete(sourceTaskId);
          break;
        }
      }
    };

    const addDuplicateCandidate = (
      node: Doc<"nodes">,
      location: PlannerMergeDuplicateCandidate["location"],
    ) => {
      duplicateCandidates.push({ node, location });
      const linkedSourceTaskId = getPlannerLinkedSourceTaskId(node);
      if (linkedSourceTaskId && !linkedSourceCandidates.has(linkedSourceTaskId as string)) {
        linkedSourceCandidates.set(linkedSourceTaskId as string, node);
      }
    };

    for (const node of focusTree) {
      if (node.archived) {
        continue;
      }
      const linkedSourceTaskId = getPlannerLinkedSourceTaskId(node);
      if (linkedSourceTaskId && !linkedSourceCandidates.has(linkedSourceTaskId as string)) {
        linkedSourceCandidates.set(linkedSourceTaskId as string, node);
      }
    }

    for (const child of topDayChildren) {
      const linkedSourceTaskId = getPlannerLinkedSourceTaskId(child);
      let duplicateMatch:
        | {
            candidate: PlannerMergeDuplicateCandidate;
            keep: "candidate" | "incoming";
          }
        | null = null;

      for (const candidate of duplicateCandidates) {
        const resolution = getPlannerMergeDuplicateResolution(candidate.node.text, child.text);
        if (resolution.duplicate) {
          duplicateMatch = {
            candidate,
            keep: resolution.keep === "right" ? "incoming" : "candidate",
          };
          break;
        }
      }

      if (!duplicateMatch && linkedSourceTaskId) {
        const sourceCandidate = linkedSourceCandidates.get(linkedSourceTaskId as string) ?? null;
        if (sourceCandidate) {
          duplicateMatch = {
            candidate: {
              node: sourceCandidate,
              location: "focus",
            },
            keep:
              getPlannerMergeItemRichnessScore(child.text) >
              getPlannerMergeItemRichnessScore(sourceCandidate.text)
                ? "incoming"
                : "candidate",
          };
        }
      }

      if (duplicateMatch) {
        if (duplicateMatch.keep === "incoming") {
          await moveDirectPlannerMergeChildren(ctx, {
            fromParentId: duplicateMatch.candidate.node._id,
            toParentId: child._id,
            now,
          });
          await setNodeTreeArchivedState(ctx.db, duplicateMatch.candidate.node._id, true, now);
          keptCarryChildren = keptCarryChildren.filter(
            (node) => node._id !== duplicateMatch.candidate.node._id,
          );
          removeDuplicateCandidate(duplicateMatch.candidate.node._id);
          keptCarryChildren.push(child);
          addDuplicateCandidate(child, "carry");
        } else {
          await moveDirectPlannerMergeChildren(ctx, {
            fromParentId: child._id,
            toParentId: duplicateMatch.candidate.node._id,
            now,
            plannerDate: topDayDate,
          });
          await setNodeTreeArchivedState(ctx.db, child._id, true, now);
        }
        archivedDuplicateCount += 1;
        continue;
      }
      keptCarryChildren.push(child);
      addDuplicateCandidate(child, "carry");
    }

    const orderedCarryChildren = [...keptCarryChildren];
    let nextCarryPosition = getAppendPosition(
      focusDirectChildren[focusDirectChildren.length - 1]?.position ?? null,
    );

    for (const node of orderedCarryChildren) {
      await ctx.db.patch(node._id, {
        parentNodeId: focusSection._id,
        position: nextCarryPosition,
        updatedAt: now,
      });
      await updateMovedPlannerSubtreeDate(ctx, node._id, topDayDate, now);
      movedCount += 1;
      nextCarryPosition = getAppendPosition(nextCarryPosition);
    }

    await setNodeTreeArchivedState(ctx.db, topDay._id, true, now);
    await enqueuePageRootEmbeddingRefresh(ctx, page._id);

    return {
      completedDayNodeId: topDay._id,
      focusSectionId: focusSection._id,
      movedCount,
      archivedDuplicateCount,
    };
  },
});

export const getPlannerDaySummary = query({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      return null;
    }

    const nodes = await listPageNodes(ctx.db, page._id);
    const currentDay = getCurrentPlannerDay(nodes);
    if (!currentDay) {
      return {
        currentDayNodeId: null,
        currentDayDate: null,
      };
    }

    return {
      currentDayNodeId: currentDay._id,
      currentDayDate: getPlannerDayTimestamp(currentDay),
    };
  },
});
