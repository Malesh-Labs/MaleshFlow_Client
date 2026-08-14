import { z } from "zod";
import type { TaskStatus } from "./constants";
import { formatDueDate, getTodayReferenceDate, isOverdueDueDateRange } from "./recurrence";
import { extractLinkMatches } from "./links";
import { stripInlineFormattingMarkers } from "./inlineFormatting";

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
  text: z.string().nullable(),
  parentNodeId: z.string().nullable(),
  afterNodeId: z.string().nullable(),
});

export const plannerChatPlanSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  preview: z.array(z.string()).max(12),
  operations: z.array(plannerChatOperationSchema).max(12),
});

export const plannerDayRollforwardPlanSchema = z.object({
  rationale: z.string(),
  orderedNodeIds: z.array(z.string()).max(128),
});

export type PlannerChatOperation = z.infer<typeof plannerChatOperationSchema>;
export type PlannerChatPlan = z.infer<typeof plannerChatPlanSchema>;
export type PlannerDayRollforwardPlan = z.infer<typeof plannerDayRollforwardPlanSchema>;

export type PlannerTaskLike = {
  _id: string;
  dueAt: number | null;
  dueEndAt?: number | null;
  priority?: string | null;
  updatedAt?: number;
  position?: number;
};

export type TaskDueInheritanceNode = {
  _id: string;
  kind: string;
  parentNodeId?: string | null;
  dueAt: number | null;
  dueEndAt?: number | null;
};

export type PlannerMergeDuplicateResolution =
  | {
      duplicate: false;
    }
  | {
      duplicate: true;
      keep: "left" | "right";
      reason: "exact" | "prefix";
    };

type PlannerMergeDuplicateFingerprint = {
  canonicalText: string;
  tokens: string[];
  linkTokenCount: number;
  wordTokenCount: number;
  alphanumericLength: number;
};

function normalizePlannerMergePlainText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .match(/[a-z0-9]+/g) ?? [];
}

function getPlannerMergeLinkToken(match: ReturnType<typeof extractLinkMatches>[number]) {
  if (match.link.kind === "node") {
    return `node:${match.link.targetNodeRef.toLowerCase()}`;
  }
  if (match.link.kind === "page" && match.link.targetPageRef) {
    return `page:${match.link.targetPageRef.toLowerCase()}`;
  }
  return null;
}

function buildPlannerMergeDuplicateFingerprint(text: string): PlannerMergeDuplicateFingerprint {
  const strippedText = stripInlineFormattingMarkers(text);
  const matches = extractLinkMatches(strippedText).sort(
    (left, right) => left.start - right.start,
  );
  const tokens: string[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      tokens.push(...normalizePlannerMergePlainText(strippedText.slice(cursor, match.start)));
    }

    const linkToken = getPlannerMergeLinkToken(match);
    if (linkToken) {
      tokens.push(linkToken);
    } else if (match.link.kind === "page" && match.link.targetPageTitle) {
      tokens.push(...normalizePlannerMergePlainText(match.link.targetPageTitle));
    } else if (match.link.kind === "external") {
      tokens.push(...normalizePlannerMergePlainText(match.link.text));
    }
    cursor = match.end;
  }

  if (cursor < strippedText.length) {
    tokens.push(...normalizePlannerMergePlainText(strippedText.slice(cursor)));
  }

  const linkTokenCount = tokens.filter((token) => token.includes(":")).length;
  const wordTokens = tokens.filter((token) => !token.includes(":"));

  return {
    canonicalText: tokens.join(" "),
    tokens,
    linkTokenCount,
    wordTokenCount: wordTokens.length,
    alphanumericLength: wordTokens.join("").length,
  };
}

function isSubstantialPlannerMergeDuplicateBase(
  fingerprint: PlannerMergeDuplicateFingerprint,
) {
  return (
    fingerprint.linkTokenCount > 0 ||
    fingerprint.wordTokenCount >= 2 ||
    fingerprint.alphanumericLength >= 8
  );
}

function isSubstantialPlannerMergePrefixBase(
  fingerprint: PlannerMergeDuplicateFingerprint,
) {
  return (
    fingerprint.linkTokenCount > 0 ||
    fingerprint.wordTokenCount >= 4 ||
    fingerprint.alphanumericLength >= 24
  );
}

function tokensStartWith(left: string[], right: string[]) {
  if (left.length > right.length) {
    return false;
  }
  return left.every((token, index) => token === right[index]);
}

export function getPlannerMergeItemRichnessScore(text: string) {
  return stripInlineFormattingMarkers(text).replace(/\s+/g, " ").trim().length;
}

// Compares two subtrees' texts (depth-first order) using the same canonical
// fingerprint as duplicate matching, so formatting/emoji/punctuation differences
// don't count but any textual or structural difference does. Order-sensitive on
// purpose: a reordered subtree is treated as different, which errs on the safe
// side for the duplicate merge (no merge rather than a destructive one).
export function arePlannerMergeSubtreeTextsEquivalent(
  leftTexts: string[],
  rightTexts: string[],
) {
  if (leftTexts.length !== rightTexts.length) {
    return false;
  }

  return leftTexts.every(
    (text, index) =>
      buildPlannerMergeDuplicateFingerprint(text).canonicalText ===
      buildPlannerMergeDuplicateFingerprint(rightTexts[index]!).canonicalText,
  );
}

export function getPlannerMergeDuplicateResolution(
  leftText: string,
  rightText: string,
): PlannerMergeDuplicateResolution {
  const left = buildPlannerMergeDuplicateFingerprint(leftText);
  const right = buildPlannerMergeDuplicateFingerprint(rightText);
  if (!left.canonicalText || !right.canonicalText) {
    return { duplicate: false };
  }

  const leftScore = getPlannerMergeItemRichnessScore(leftText);
  const rightScore = getPlannerMergeItemRichnessScore(rightText);
  const keep = rightScore > leftScore ? "right" : "left";

  if (left.canonicalText === right.canonicalText) {
    return isSubstantialPlannerMergeDuplicateBase(left)
      ? { duplicate: true, keep, reason: "exact" }
      : { duplicate: false };
  }

  const shorter = left.tokens.length <= right.tokens.length ? left : right;
  const longer = shorter === left ? right : left;
  if (!isSubstantialPlannerMergePrefixBase(shorter)) {
    return { duplicate: false };
  }
  if (!tokensStartWith(shorter.tokens, longer.tokens)) {
    return { duplicate: false };
  }

  return { duplicate: true, keep, reason: "prefix" };
}

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

export function getPlannerDateRangeBoundary(args: {
  dayTimestamp: number;
  dueAt: number | null;
  dueEndAt?: number | null;
}) {
  if (!args.dueAt) {
    return null;
  }

  const day = getPlannerDayDate(args.dayTimestamp).getTime();
  const dueStart = getPlannerDayDate(args.dueAt).getTime();
  const dueEnd = getPlannerDayDate(args.dueEndAt ?? args.dueAt).getTime();
  if (dueEnd <= dueStart) {
    return null;
  }

  if (day === dueStart) {
    return "begins" as const;
  }

  if (day === dueEnd) {
    return "ends" as const;
  }

  return null;
}

export function plannerDayMatchesDueDateBoundary(args: {
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
  if (dueEnd > dueStart) {
    return getPlannerDateRangeBoundary(args) !== null;
  }

  return day === dueStart;
}

export function getEffectiveTaskDueDateRange<
  TNode extends TaskDueInheritanceNode,
  TMapNode extends TaskDueInheritanceNode,
>(
  node: TNode,
  _nodeMap: Map<string, TMapNode>,
) {
  if (node.kind !== "task") {
    return {
      dueAt: null,
      dueEndAt: null,
    };
  }

  if (node.dueAt) {
    return {
      dueAt: node.dueAt,
      dueEndAt: node.dueEndAt ?? null,
    };
  }

  return {
    dueAt: null,
    dueEndAt: null,
  };
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

// Receipt of everything completePlannerTask changed, returned to the client so
// an undo can reverse the full effect server-side: restore patched planner
// nodes and source tasks, delete nodes the completion created (the Past Weeks
// archive clone and any recurring sidebar copies), and unarchive the subtree.
export type PlannerCompletionPatchedNode = {
  nodeId: string;
  taskStatus: TaskStatus | null;
  dueAt: number | null;
  dueEndAt: number | null;
  sourceMeta: unknown;
};

export type PlannerCompletionPatchedSourceTask = {
  nodeId: string;
  taskStatus: TaskStatus | null;
  dueAt: number | null;
  dueEndAt: number | null;
};

export type PlannerCompletionDeletedFavorite = {
  targetKind: "page" | "node";
  targetPageId: string;
  targetNodeId: string | null;
  position: number;
};

// Also reused by task-page completion (archive-to-Done), which shares the
// same clone-then-archive shape as the planner's Past Weeks flow.
export type PlannerCompletionReceipt = {
  plannerNodes: PlannerCompletionPatchedNode[];
  sourceTasks: PlannerCompletionPatchedSourceTask[];
  appendedPlannerNodeIds: string[];
  deletedFavorites: PlannerCompletionDeletedFavorite[];
  archivedRootNodeId: string | null;
  pastWeeksCloneRootNodeId: string | null;
};

export function plannerCompletionReceiptHasEffects(
  receipt: PlannerCompletionReceipt | null | undefined,
) {
  if (!receipt) {
    return false;
  }
  return (
    receipt.plannerNodes.length > 0 ||
    receipt.sourceTasks.length > 0 ||
    receipt.appendedPlannerNodeIds.length > 0 ||
    receipt.deletedFavorites.length > 0 ||
    receipt.archivedRootNodeId !== null ||
    receipt.pastWeeksCloneRootNodeId !== null
  );
}
