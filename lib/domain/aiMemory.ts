import { stripNodeDisplaySyntaxMarkers } from "./displaySyntax";
import { stripInlineFormattingMarkers } from "./inlineFormatting";
import { replaceLinkMarkupWithLabels } from "./links";

export const AI_WORKING_MEMORY_PAGE_TITLE = "AI Working Memory";

const LEADING_CHAT_FILLER_PATTERN =
  /^(?:hey|hi|yo|ok|okay|so|hmm|uh|um|also|btw|by the way)[,\s]+/i;

const COMPLETION_PATTERNS = [
  /\b(?:i\s+)?(?:watched|finished|completed|did|read|saw)\s+(.+)$/i,
  /\b(?:i\s+)?(?:listened to)\s+(.+)$/i,
  /\b(?:i\s+)?(?:went to|went back to|visited)\s+(.+)$/i,
  /\b(?:i\s+)?(?:bought|booked|planned|tried|got)\s+(.+)$/i,
  /\b(?:i(?:'|’)?m|i am)?\s*done with\s+(.+)$/i,
  /\b(?:mark|move)\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|watched|finished)$/i,
];

const STORE_PATTERNS = [
  /\b(?:i\s+)?(?:wanna|want to|would like to)\s+make sure to\s+(.+)$/i,
  /\bmake sure to\s+(.+)$/i,
  /\b(?:remember|save|capture|jot down|write down|track|log)\s+(?:that\s+)?(.+)$/i,
  /\b(?:i\s+)?(?:need|want)\s+to\s+remember\s+(?:to\s+)?(.+)$/i,
];

const QUESTION_LIKE_PATTERN =
  /^(?:what|who|when|where|why|how|which|show|list|find|search|summarize|explain|tell me|do|does|did|can|could|should|would|is|are|am|was|were)\b/i;

const TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "complete",
  "completed",
  "did",
  "do",
  "done",
  "for",
  "finished",
  "go",
  "went",
  "i",
  "in",
  "item",
  "listen",
  "listened",
  "make",
  "me",
  "movie",
  "movies",
  "of",
  "on",
  "read",
  "remember",
  "saw",
  "see",
  "show",
  "shows",
  "stuff",
  "sure",
  "task",
  "the",
  "thing",
  "things",
  "to",
  "todo",
  "watch",
  "watched",
  "with",
]);

const TOKEN_ALIASES: Record<string, string> = {
  booked: "book",
  bought: "buy",
  gotten: "get",
  got: "get",
  planned: "plan",
  saw: "see",
  tried: "try",
  visited: "visit",
  watched: "watch",
  went: "go",
};

export type AiMemoryItem = {
  nodeId: string;
  text: string;
};

export type AiMemoryStoreOutlineItem = {
  text: string;
  noteCompleted: boolean;
};

export type AiMemoryStoreOutline = {
  parentText: string | null;
  items: AiMemoryStoreOutlineItem[];
};

export type AiMemoryInlineChecklistItem = AiMemoryStoreOutlineItem & {
  start: number;
  end: number;
};

export type AiMemoryInlineChecklistOutline = {
  parentText: string | null;
  items: AiMemoryInlineChecklistItem[];
};

export type AiMemoryMatchResult =
  | {
      kind: "none";
    }
  | {
      kind: "single";
      item: AiMemoryItem;
    }
  | {
      kind: "ambiguous";
      items: AiMemoryItem[];
    };

function normalizeInput(value: string) {
  let normalized = replaceLinkMarkupWithLabels(value)
    .replace(/\s+/g, " ")
    .trim();
  while (LEADING_CHAT_FILLER_PATTERN.test(normalized)) {
    normalized = normalized.replace(LEADING_CHAT_FILLER_PATTERN, "").trim();
  }
  return normalized;
}

function cleanExtractedText(value: string) {
  return stripNodeDisplaySyntaxMarkers(
    stripInlineFormattingMarkers(replaceLinkMarkupWithLabels(value)),
  )
    .replace(/\s+(?:you can\s+)?(?:mark|move|set)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^(?:to|that)\s+/i, "")
    .replace(/[?.!,;:]+$/g, "")
    .trim();
}

export function extractAiMemoryStoreText(input: string) {
  const normalized = normalizeInput(input);
  if (normalized.length === 0 || extractAiMemoryCompletionText(normalized)) {
    return null;
  }

  for (const pattern of STORE_PATTERNS) {
    const match = normalized.match(pattern);
    const text = cleanExtractedText(match?.[1] ?? "");
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

function cleanStoreParentText(value: string) {
  return cleanExtractedText(value)
    .replace(/^(?:please\s+)?(?:remember|save|capture|jot down|write down|track|log)\s+/i, "")
    .replace(/^the\s+following\s+/i, "")
    .replace(/^that\s+/i, "")
    .trim();
}

function cleanChecklistItemText(value: string) {
  const withoutOuterStrike = value
    .trim()
    .replace(/^~~([\s\S]+)~~$/, "$1")
    .trim();
  return cleanExtractedText(withoutOuterStrike);
}

function parseMemoryChecklistLine(line: string): AiMemoryStoreOutlineItem | null {
  const checkboxMatch = line.match(/^\s*(?:[-*]\s*)?\[\s*([xX]?)\s*\]\s+(.+)$/);
  const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
  const rawText = checkboxMatch?.[2] ?? bulletMatch?.[1] ?? "";
  if (!rawText) {
    return null;
  }

  const text = cleanChecklistItemText(rawText);
  if (text.length === 0) {
    return null;
  }

  return {
    text,
    noteCompleted: Boolean(checkboxMatch?.[1]) || /~~.+~~/.test(rawText),
  };
}

export function extractAiMemoryStoreOutline(input: string): AiMemoryStoreOutline | null {
  const lines = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstItemIndex = lines.findIndex((line) => parseMemoryChecklistLine(line) !== null);
  if (firstItemIndex < 0) {
    return null;
  }

  const items = lines
    .slice(firstItemIndex)
    .map((line) => parseMemoryChecklistLine(line))
    .filter((item): item is AiMemoryStoreOutlineItem => item !== null);
  if (items.length === 0) {
    return null;
  }

  const parentText =
    firstItemIndex > 0
      ? cleanStoreParentText(lines.slice(0, firstItemIndex).join(" "))
      : "";

  return {
    parentText: parentText.length > 0 ? parentText : null,
    items,
  };
}

export function extractAiMemoryInlineChecklistOutline(
  input: string,
): AiMemoryInlineChecklistOutline | null {
  const checkboxPattern = /\[\s*([xX]?)\s*\]\s*/g;
  const matches = [...input.matchAll(checkboxPattern)];
  if (matches.length === 0) {
    return null;
  }

  const parentText = cleanStoreParentText(input.slice(0, matches[0]?.index ?? 0));
  const items = matches
    .map((match, index) => {
      const start = match.index ?? 0;
      const textStart = start + match[0].length;
      const end = matches[index + 1]?.index ?? input.length;
      const rawText = input.slice(textStart, end).trim();
      const text = cleanChecklistItemText(rawText);
      if (text.length === 0) {
        return null;
      }

      return {
        text,
        noteCompleted: Boolean(match[1]) || /~~.+~~/.test(rawText),
        start,
        end,
      };
    })
    .filter((item): item is AiMemoryInlineChecklistItem => item !== null);

  if (items.length === 0) {
    return null;
  }

  return {
    parentText: parentText.length > 0 ? parentText : null,
    items,
  };
}

export function removeAiMemoryInlineChecklistItem(
  input: string,
  item: Pick<AiMemoryInlineChecklistItem, "start" | "end">,
) {
  return `${input.slice(0, item.start)} ${input.slice(item.end)}`
    .replace(/\s+/g, " ")
    .trim();
}

export function extractAiMemoryImplicitStoreText(input: string) {
  const normalized = normalizeInput(input);
  if (
    normalized.length === 0 ||
    QUESTION_LIKE_PATTERN.test(normalized) ||
    extractAiMemoryCompletionText(normalized) ||
    extractAiMemoryStoreText(normalized)
  ) {
    return null;
  }

  const commaStoreMatch = normalized.match(
    /^(?:another|new|one more|more|add(?:\s+another)?)\b[^,]{0,120},\s*(.+)$/i,
  );
  const candidate = commaStoreMatch?.[1] ?? normalized;
  const text = cleanExtractedText(candidate);
  return text.length > 0 ? text : null;
}

export function extractAiMemoryCompletionText(input: string) {
  const normalized = normalizeInput(input);
  if (normalized.length === 0) {
    return null;
  }

  for (const pattern of COMPLETION_PATTERNS) {
    const match = normalized.match(pattern);
    const text = cleanExtractedText(match?.[1] ?? "");
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

function normalizeComparableText(value: string) {
  return cleanExtractedText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparableText(value: string) {
  return normalizeComparableText(value)
    .split(" ")
    .map((token) => TOKEN_ALIASES[token] ?? token)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !TOKEN_STOP_WORDS.has(token));
}

function scoreMemoryMatch(query: string, item: AiMemoryItem) {
  const normalizedQuery = normalizeComparableText(query);
  const normalizedItem = normalizeComparableText(item.text);
  if (normalizedQuery.length === 0 || normalizedItem.length === 0) {
    return 0;
  }

  if (normalizedItem === normalizedQuery) {
    return 100;
  }

  const queryTokens = tokenizeComparableText(query);
  const itemTokens = tokenizeComparableText(item.text);
  if (queryTokens.length === 0 || itemTokens.length === 0) {
    return normalizedItem.includes(normalizedQuery) || normalizedQuery.includes(normalizedItem)
      ? 70
      : 0;
  }

  const itemTokenSet = new Set(itemTokens);
  const overlap = queryTokens.filter((token) => itemTokenSet.has(token)).length;
  const coverage = overlap / queryTokens.length;
  const density = overlap / itemTokens.length;
  const substringBonus =
    normalizedItem.includes(normalizedQuery) || normalizedQuery.includes(normalizedItem) ? 1 : 0;

  return coverage * 60 + density * 30 + substringBonus * 10;
}

export function matchAiMemoryCompletion(
  query: string,
  items: AiMemoryItem[],
): AiMemoryMatchResult {
  const scored = items
    .map((item) => ({
      item,
      score: scoreMemoryMatch(query, item),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const best = scored[0] ?? null;
  if (!best || best.score < 50) {
    return {
      kind: "none",
    };
  }

  const ambiguousItems = scored
    .filter((entry) => Math.abs(entry.score - best.score) < 20)
    .map((entry) => entry.item);

  if (ambiguousItems.length > 1) {
    return {
      kind: "ambiguous",
      items: ambiguousItems,
    };
  }

  return {
    kind: "single",
    item: best.item,
  };
}
