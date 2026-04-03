import { v } from "convex/values";

export const nodeKindValidator = v.union(v.literal("note"), v.literal("task"));
export const taskStatusValidator = v.union(
  v.literal("todo"),
  v.literal("in_progress"),
  v.literal("done"),
  v.literal("cancelled"),
  v.null(),
);
export const priorityValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.null(),
);
export const recurrenceFrequencyValidator = v.union(
  v.literal("daily"),
  v.literal("weekly"),
  v.literal("monthly"),
  v.literal("yearly"),
  v.object({
    interval: v.number(),
    unit: v.union(
      v.literal("day"),
      v.literal("week"),
      v.literal("month"),
      v.literal("year"),
    ),
  }),
  v.null(),
);
export const nullableNodeIdValidator = v.union(v.id("nodes"), v.null());
export const nullablePageIdValidator = v.union(v.id("pages"), v.null());
export const nullableLinkKindValidator = v.union(
  v.literal("page"),
  v.literal("node"),
);
