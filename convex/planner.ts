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
  getPlannerStartDate,
  isPlannerPage,
  listEligiblePlannerSourceTasks,
  completePlannerLinkedTask,
} from "./lib/planner";
import { collectNodeTree, listPageNodes } from "./lib/workspace";
import { comparePlannerTaskOrder } from "../lib/domain/planner";

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
    const startDate = getPlannerStartDate(page);
    if (!startDate) {
      throw new Error("Set a start date first.");
    }

    const dayRoots = getPlannerDayRoots(nodes);
    const nextPlannerDate =
      dayRoots.length === 0
        ? startDate
        : (getPlannerDayTimestamp(dayRoots[dayRoots.length - 1]!) ?? startDate) +
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

    return {
      plannerNodeId,
      sourceTaskNodeId: sourceTask._id,
    };
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
    const currentDayTasks = currentDayTree
      .filter((node) => node._id !== currentDay._id)
      .filter((node) => node.kind === "task" && node.taskStatus !== "done" && node.taskStatus !== "cancelled")
      .sort((left, right) => comparePlannerTaskOrder(left, right));
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
