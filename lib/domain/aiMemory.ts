import { stripNodeDisplaySyntaxMarkers } from "./displaySyntax";
import { stripInlineFormattingMarkers } from "./inlineFormatting";
import { replaceLinkMarkupWithLabels } from "./links";

export const AI_WORKING_MEMORY_PAGE_TITLE = "AI Working Memory";

const LEADING_CHAT_FILLER_PATTERN =
  /^(?:hey|hi|yo|ok|okay|so|hmm|uh|um|also|btw|by the way)[,\s]+/i;

const COMPLETION_PATTERNS = [
  /\b(?:i\s+)?(?:watched|finished|completed|did|read|saw)\s+(.+)$/i,
  /\b(?:i\s+)?(?:listened to)\s+(.+)$/i,
  /\b(?:i(?:'|’)?m|i am)?\s*done with\s+(.+)$/i,
  /\b(?:mark|move)\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|watched|finished)$/i,
];

const STORE_PATTERNS = [
  /\b(?:i\s+)?(?:wanna|want to|would like to)\s+make sure to\s+(.+)$/i,
  /\bmake sure to\s+(.+)$/i,
  /\b(?:remember|save|capture|jot down|write down|track|log)\s+(?:that\s+)?(.+)$/i,
  /\b(?:i\s+)?(?:need|want)\s+to\s+remember\s+(?:to\s+)?(.+)$/i,
];

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

export type AiMemoryItem = {
  nodeId: string;
  text: string;
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
