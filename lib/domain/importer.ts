import { dateInputValueToTimestamp, type RecurrenceFrequency } from "./recurrence";
import { normalizeImportedOutlineText } from "./migration";

export type ImportedNodeKind = "note" | "task";
export type ImportedTaskStatus = "todo" | "in_progress" | "done" | "cancelled" | null;

export type ImportedOutlineNode = {
  text: string;
  kind: ImportedNodeKind;
  taskStatus: ImportedTaskStatus;
  noteCompleted: boolean;
  dueAt: number | null;
  dueEndAt: number | null;
  recurrenceFrequency: RecurrenceFrequency;
  lockKind: boolean;
  children: ImportedOutlineNode[];
};

const DYNALIST_MARKDOWN_LINK_PATTERN =
  /\[([^\]]+)\]\((https?:\/\/dynalist\.io\/[^)\s]+)\)/gi;
const DUE_MARKER_PATTERN =
  /\s*!\(\s*(\d{4}-\d{2}-\d{2})(?:\s*-\s*(\d{4}-\d{2}-\d{2}))?(?:\s*\|\s*([^)]+?))?\s*\)\s*$/i;
const TASK_DONE_PATTERN = /^\[x\]\s*(.*)$/i;
const TASK_TODO_PATTERN = /^\[\s\]\s*(.*)$/;
const LEADING_BULLET_PATTERN = /^(?:[-*•]\s+)(.*)$/;

function replaceDynalistMarkdownLinks(text: string) {
  return text.replace(
    DYNALIST_MARKDOWN_LINK_PATTERN,
    (_match, label: string) => `[[${label.trim()}]]`,
  );
}

function unwrapFullLineStrike(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("~~") && trimmed.endsWith("~~") && trimmed.length > 4) {
    return {
      text: trimmed.slice(2, -2).trim(),
      wrapped: true,
    };
  }

  return {
    text: trimmed,
    wrapped: false,
  };
}

function restoreFullLineStrike(text: string, wrapped: boolean) {
  const trimmed = text.trim();
  if (!wrapped || trimmed.length === 0) {
    return trimmed;
  }

  return `~~${trimmed}~~`;
}

function parseRecurrenceShorthand(value: string | undefined): RecurrenceFrequency {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(
    /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/,
  );
  if (!match) {
    return null;
  }

  const interval = Number(match[1]);
  if (!Number.isInteger(interval) || interval <= 0) {
    return null;
  }

  const token = match[2]!;
  const unit =
    token === "d" || token.startsWith("day")
      ? "day"
      : token === "w" || token.startsWith("week")
        ? "week"
        : token === "m" || token.startsWith("month")
          ? "month"
          : "year";

  if (interval === 1) {
    if (unit === "day") {
      return "daily";
    }
    if (unit === "week") {
      return "weekly";
    }
    if (unit === "month") {
      return "monthly";
    }
    return "yearly";
  }

  return {
    interval,
    unit,
  };
}

function parseImportedLine(rawLine: string): Omit<ImportedOutlineNode, "children"> | null {
  const normalizedLine = replaceDynalistMarkdownLinks(rawLine);
  const { text: unwrappedText, wrapped: hadFullLineStrike } =
    unwrapFullLineStrike(normalizedLine);

  let workingText = unwrappedText;
  let dueAt: number | null = null;
  let dueEndAt: number | null = null;
  let recurrenceFrequency: RecurrenceFrequency = null;

  const dueMatch = workingText.match(DUE_MARKER_PATTERN);
  if (dueMatch) {
    dueAt = dateInputValueToTimestamp(dueMatch[1] ?? "");
    dueEndAt = dateInputValueToTimestamp(dueMatch[2] ?? "");
    recurrenceFrequency = parseRecurrenceShorthand(dueMatch[3]);
    if (dueAt && dueEndAt && dueEndAt <= dueAt) {
      dueEndAt = null;
    }
    workingText = workingText.slice(0, dueMatch.index).trim();
  }

  const bulletMatch = workingText.match(LEADING_BULLET_PATTERN);
  if (bulletMatch?.[1]) {
    workingText = bulletMatch[1].trim();
  }

  const doneMatch = workingText.match(TASK_DONE_PATTERN);
  if (doneMatch) {
    const text = doneMatch[1]?.trim() ?? "";
    if (!text) {
      return null;
    }

    return {
      text,
      kind: "task",
      taskStatus: "done",
      noteCompleted: false,
      dueAt,
      dueEndAt,
      recurrenceFrequency,
      lockKind: true,
    };
  }

  const todoMatch = workingText.match(TASK_TODO_PATTERN);
  if (todoMatch) {
    const text = restoreFullLineStrike(todoMatch[1]?.trim() ?? "", hadFullLineStrike);
    if (!text) {
      return null;
    }

    return {
      text,
      kind: "task",
      taskStatus: "todo",
      noteCompleted: false,
      dueAt,
      dueEndAt,
      recurrenceFrequency,
      lockKind: true,
    };
  }

  const text = restoreFullLineStrike(workingText, hadFullLineStrike);
  if (!text) {
    return null;
  }

  const kind: ImportedNodeKind = dueAt || recurrenceFrequency ? "task" : "note";
  return {
    text,
    kind,
    taskStatus: kind === "task" ? "todo" : null,
    noteCompleted: false,
    dueAt: kind === "task" ? dueAt : null,
    dueEndAt: kind === "task" ? dueEndAt : null,
    recurrenceFrequency: kind === "task" ? recurrenceFrequency : null,
    lockKind: kind === "task",
  };
}

function getLineDepth(rawLine: string) {
  const indent = rawLine.match(/^[\t ]*/)?.[0] ?? "";
  const normalizedIndent = indent.replace(/\t/g, "  ");
  return Math.floor(normalizedIndent.length / 2);
}

export function parseImportedTextToOutlineNodes(rawText: string) {
  const normalizedText = normalizeImportedOutlineText(rawText);
  if (!normalizedText) {
    return [] as ImportedOutlineNode[];
  }

  const root: ImportedOutlineNode[] = [];
  const stack: Array<{
    depth: number;
    node: ImportedOutlineNode;
  }> = [];

  for (const rawLine of normalizedText.split("\n")) {
    if (rawLine.trim().length === 0) {
      continue;
    }

    const parsedNode = parseImportedLine(rawLine);
    if (!parsedNode) {
      continue;
    }

    const nextNode: ImportedOutlineNode = {
      ...parsedNode,
      children: [],
    };
    const depth = getLineDepth(rawLine);

    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]?.node ?? null;
    if (parent) {
      parent.children.push(nextNode);
    } else {
      root.push(nextNode);
    }

    stack.push({
      depth,
      node: nextNode,
    });
  }

  return root;
}
