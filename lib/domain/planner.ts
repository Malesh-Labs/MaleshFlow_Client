import { z } from "zod";
import { formatDueDate, getTodayReferenceDate, isOverdueDueDateRange } from "./recurrence";

export const PLANNER_WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type PlannerWeekdayName = (typeof PLANNER_WEEKDAY_NAMES)[number];

export const PLANNER_CHAT_OPERATION_TYPES = [
  "complete_planner_task",
  "delete_planner_node",
  "update_planner_node",
  "move_planner_node",
] as const;

export type PlannerChatOperationType =
  (typeof PLANNER_CHAT_OPERATION_TYPES)[number];

export const plannerChatOperationSchema = z.object({
  type: z.enum(PLANNER_CHAT_OPERATION_TYPES),
  description: z.string(),
  nodeId: z.string(),
  text: z.string().optional(),
  parentNodeId: z.string().nullable().optional(),
  afterNodeId: z.string().nullable().optional(),
});

export const plannerChatPlanSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  preview: z.array(z.string()).max(12),
  operations: z.array(plannerChatOperationSchema).max(12),
});

export type PlannerChatOperation = z.infer<typeof plannerChatOperationSchema>;
export type PlannerChatPlan = z.infer<typeof plannerChatPlanSchema>;

export type PlannerTaskLike = {
  _id: string;
  dueAt: number | null;
  dueEndAt?: number | null;
  priority?: string | null;
  updatedAt?: number;
  position?: number;
};

function getPlannerDayDate(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

export function getPlannerWeekdayName(timestamp: number): PlannerWeekdayName {
  const weekday = new Date(timestamp).getDay();
  switch (weekday) {
    case 0:
      return "Sunday";
    case 1:
      return "Monday";
    case 2:
      return "Tuesday";
    case 3:
      return "Wednesday";
    case 4:
      return "Thursday";
    case 5:
      return "Friday";
    case 6:
    default:
      return "Saturday";
  }
}

export function formatPlannerDayTitle(timestamp: number) {
  return `### ${getPlannerWeekdayName(timestamp)} ${formatDueDate(timestamp)}`;
}

export function formatPlannerStartDateLabel(timestamp: number | null | undefined) {
  if (!timestamp) {
    return "Set Start Date";
  }

  return `Starts ${formatDueDate(timestamp)}`;
}

export function addPlannerCalendarDays(timestamp: number, days: number) {
  const base = getPlannerDayDate(timestamp);
  base.setDate(base.getDate() + days);
  return base.getTime();
}

export function plannerDayMatchesDueDateRange(args: {
  dayTimestamp: number;
  dueAt: number | null;
  dueEndAt?: number | null;
}) {
  if (!args.dueAt) {
    return false;
  }

  const day = getPlannerDayDate(args.dayTimestamp).getTime();
  const dueStart = getPlannerDayDate(args.dueAt).getTime();
  const dueEnd = getPlannerDayDate(args.dueEndAt ?? args.dueAt).getTime();

  return day >= dueStart && day <= dueEnd;
}

function getPriorityScore(priority: string | null | undefined) {
  switch (priority) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    default:
      return 3;
  }
}

function getDueSortValue(task: PlannerTaskLike) {
  return task.dueEndAt ?? task.dueAt ?? Number.POSITIVE_INFINITY;
}

export function comparePlannerTaskOrder(
  left: PlannerTaskLike,
  right: PlannerTaskLike,
  now = getTodayReferenceDate(),
) {
  const leftOverdue = isOverdueDueDateRange(left.dueAt, left.dueEndAt ?? null, now);
  const rightOverdue = isOverdueDueDateRange(right.dueAt, right.dueEndAt ?? null, now);
  if (leftOverdue !== rightOverdue) {
    return leftOverdue ? -1 : 1;
  }

  const leftDue = getDueSortValue(left);
  const rightDue = getDueSortValue(right);
  if (leftDue !== rightDue) {
    return leftDue - rightDue;
  }

  const leftPriority = getPriorityScore(left.priority);
  const rightPriority = getPriorityScore(right.priority);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftUpdatedAt = left.updatedAt ?? Number.POSITIVE_INFINITY;
  const rightUpdatedAt = right.updatedAt ?? Number.POSITIVE_INFINITY;
  if (leftUpdatedAt !== rightUpdatedAt) {
    return leftUpdatedAt - rightUpdatedAt;
  }

  return (left.position ?? Number.POSITIVE_INFINITY) - (right.position ?? Number.POSITIVE_INFINITY);
}
