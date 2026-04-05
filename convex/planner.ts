import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  appendPlannerDayCore,
  appendPlannerLinkedTaskCopy,
  ensurePlannerSections,
  getCurrentPlannerDay,
  getPageSourceMeta,
  getPlannerDayRoots,
  getPlannerDayTimestamp,
  getPlannerLinkedSourceTaskId,
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
} from "../lib/domain/planner";

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
    text: linkedSourceTask?.text ?? plannerNode.text,
    dueAt: linkedSourceTask?.dueAt ?? plannerNode.dueAt ?? null,
    dueEndAt: linkedSourceTask?.dueEndAt ?? plannerNode.dueEndAt ?? null,
    sourcePageId: sourcePage?._id ?? null,
    sourcePageTitle: sourcePage?.title ?? null,
    linkedSourceTaskId: linkedSourceTask?._id ?? linkedSourceTaskId ?? null,
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

    const nodes = await listPageNodes(ctx.db, page._id);
    const currentDay = getCurrentPlannerDay(nodes);
    if (!currentDay) {
      throw new Error("Add the first planner day before pulling in tasks.");
    }

    const plannerDate = getPlannerDayTimestamp(currentDay);
    if (!plannerDate) {
      throw new Error("Current planner day is missing its date.");
    }

    const currentDayTree = await collectNodeTree(ctx.db, currentDay._id);
    const existingSourceIds = new Set(
      currentDayTree
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

    const dayChildren = currentDayTree
      .filter((node) => node.parentNodeId === currentDay._id)
      .sort((left, right) => left.position - right.position);
    const afterNodeId = dayChildren[dayChildren.length - 1]?._id ?? null;
    const index = Math.abs(Math.trunc(args.seed)) % candidates.length;
    const sourceTask = candidates[index]!;
    const plannerNodeId = await appendPlannerLinkedTaskCopy(ctx, {
      plannerPageId: page._id,
      dayNodeId: currentDay._id,
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
      dayNodeId: currentDay._id,
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
      dayNodeId: currentDay._id,
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
    orderedNodeIds: v.optional(v.array(v.id("nodes"))),
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
    const topDay = dayRoots[0] ?? null;
    if (!topDay) {
      throw new Error("Add a planner day before completing one.");
    }

    const topDayDate = getPlannerDayTimestamp(topDay);
    if (!topDayDate) {
      throw new Error("Top planner day is missing its date.");
    }

    let nextDay: Doc<"nodes"> | null = dayRoots[1] ?? null;
    if (!nextDay) {
      const created = await appendPlannerDayCore(ctx, {
        page,
        plannerDate: topDayDate + 24 * 60 * 60 * 1000,
      });
      nextDay = await ctx.db.get(created.dayNodeId);
    }

    if (!nextDay) {
      throw new Error("Could not prepare the next planner day.");
    }

    const nextDayDate = getPlannerDayTimestamp(nextDay);
    if (!nextDayDate) {
      throw new Error("Next planner day is missing its date.");
    }

    const now = Date.now();
    const topDayTree = await collectNodeTree(ctx.db, topDay._id);
    const topDayChildren = topDayTree
      .filter((node) => node.parentNodeId === topDay._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    const nextDayTree = await collectNodeTree(ctx.db, nextDay._id);
    const existingLinkedSourceIds = new Set(
      nextDayTree
        .map((node) => getPlannerLinkedSourceTaskId(node))
        .filter((value): value is Id<"nodes"> => value !== null)
        .map((value) => value as string),
    );

    const nextDayDirectChildren = nextDayTree
      .filter((node) => node.parentNodeId === nextDay!._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    let afterNodeId = nextDayDirectChildren[nextDayDirectChildren.length - 1]?._id ?? null;
    let movedCount = 0;
    let archivedDuplicateCount = 0;
    const keptCarryChildren: Doc<"nodes">[] = [];

    for (const child of topDayChildren) {
      const linkedSourceTaskId = getPlannerLinkedSourceTaskId(child);
      if (linkedSourceTaskId && existingLinkedSourceIds.has(linkedSourceTaskId as string)) {
        await setNodeTreeArchivedState(ctx.db, child._id, true, now);
        archivedDuplicateCount += 1;
        continue;
      }
      keptCarryChildren.push(child);
      if (linkedSourceTaskId) {
        existingLinkedSourceIds.add(linkedSourceTaskId as string);
      }
    }

    const candidateIds = [
      ...nextDayDirectChildren.map((node) => node._id as Id<"nodes">),
      ...keptCarryChildren.map((node) => node._id as Id<"nodes">),
    ];
    const candidateIdSet = new Set(candidateIds.map((id) => id as string));
    let orderedNodeIds = candidateIds;
    if (args.orderedNodeIds && args.orderedNodeIds.length === candidateIds.length) {
      const seen = new Set<string>();
      const isValid =
        args.orderedNodeIds.every((nodeId) => {
          const key = nodeId as string;
          if (!candidateIdSet.has(key) || seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        }) && seen.size === candidateIds.length;
      if (isValid) {
        orderedNodeIds = [...args.orderedNodeIds];
      }
    }

    const carryIdSet = new Set(keptCarryChildren.map((node) => node._id as string));
    for (const nodeId of orderedNodeIds) {
      const node = candidateIds.find((candidateId) => candidateId === nodeId)
        ? (await ctx.db.get(nodeId))
        : null;
      if (!node || node.archived) {
        continue;
      }
      const nextPosition = await computeNodePosition(
        ctx.db,
        page._id,
        nextDay._id,
        afterNodeId,
      );
      const isCarryNode = carryIdSet.has(nodeId as string);
      await ctx.db.patch(node._id, {
        parentNodeId: nextDay._id,
        position: nextPosition,
        updatedAt: now,
      });
      if (isCarryNode) {
        await updateMovedPlannerSubtreeDate(ctx, node._id, nextDayDate, now);
        movedCount += 1;
      }
      afterNodeId = node._id;
    }

    await setNodeTreeArchivedState(ctx.db, topDay._id, true, now);
    await enqueuePageRootEmbeddingRefresh(ctx, page._id);

    return {
      completedDayNodeId: topDay._id,
      nextDayNodeId: nextDay._id,
      movedCount,
      archivedDuplicateCount,
      createdNextDay: dayRoots[1] ? false : true,
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
