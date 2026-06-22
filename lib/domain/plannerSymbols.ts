import { isSeparatorLineText, stripNodeDisplaySyntaxMarkers } from "./displaySyntax";
import { stripInlineFormattingMarkers } from "./inlineFormatting";
import {
  extractLinkMatches,
  getExplicitWikiLinkPreviewText,
  replaceLinkMarkupWithLabels,
} from "./links";

const RAW_NODE_REFERENCE_PATTERN = /^node:([a-zA-Z0-9_-]+)$/;
export const PLANNER_EMOJI_CACHE_STYLE = "emoji-v2";
// Maximum number of emoji a single planner label may render. Shared by the
// validator, the generation prompt, and the diagnostic error message.
export const MAX_PLANNER_SYMBOL_COUNT = 5;

const EMOJI_FALLBACK_PALETTE = [
  "📝",
  "✅",
  "📌",
  "🔥",
  "⚡️",
  "🌱",
  "🧠",
  "💬",
  "📚",
  "🧭",
  "🎯",
  "🛠️",
  "🧩",
  "📦",
  "🕒",
  "✨",
];

export type PurePlannerNodeReference = {
  nodeId: string;
  explicitLabel: string;
};

function splitGraphemes(value: string) {
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  return segmenter
    ? [...segmenter.segment(value)].map((segment) => segment.segment)
    : Array.from(value);
}

export function parsePurePlannerNodeReference(value: string): PurePlannerNodeReference | null {
  const trimmed = value.trim();
  const rawMatch = trimmed.match(RAW_NODE_REFERENCE_PATTERN);
  if (rawMatch?.[1]) {
    return {
      nodeId: rawMatch[1],
      explicitLabel: "",
    };
  }

  const matches = extractLinkMatches(trimmed).filter((match) => match.link.kind === "node");
  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0]!;
  if (match.start !== 0 || match.end !== trimmed.length || match.link.kind !== "node") {
    return null;
  }

  return {
    nodeId: match.link.targetNodeRef,
    explicitLabel: getExplicitWikiLinkPreviewText(match.link.label).trim(),
  };
}

export function normalizePlannerSymbolSourceText(value: string) {
  const normalized = stripNodeDisplaySyntaxMarkers(
    stripInlineFormattingMarkers(replaceLinkMarkupWithLabels(value)),
  )
    .replace(/\s+/g, " ")
    .trim();
  return normalized || value.replace(/\s+/g, " ").trim();
}

export function isPlannerSymbolizableText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "." && !isSeparatorLineText(trimmed);
}

type FocusSymbolTextExemptNode = {
  _id: string;
  text: string;
  children?: FocusSymbolTextExemptNode[];
};

function collectNodeAndDescendantIds(node: FocusSymbolTextExemptNode): string[] {
  return [
    node._id,
    ...(node.children ?? []).flatMap((child) => collectNodeAndDescendantIds(child)),
  ];
}

export function listFocusSymbolTextExemptNodeIds<T extends FocusSymbolTextExemptNode>(
  focusChildren: T[],
) {
  const exemptNodeIds: string[] = [];
  for (const child of focusChildren) {
    if (isSeparatorLineText(child.text.trim())) {
      break;
    }
    exemptNodeIds.push(...collectNodeAndDescendantIds(child));
  }
  return exemptNodeIds;
}

// Keycap emoji (0-9, #, * each followed by U+FE0F U+20E3 -- e.g. the
// keycap "1" the model returns for a "1st" item) embed an ASCII digit
// codepoint, so they trip the \p{N} guard below and must be allowed
// explicitly instead of being rejected as "contains a digit".
const KEYCAP_EMOJI_PATTERN = /^[#*0-9]\uFE0F?\u20E3$/;

function isEmojiGrapheme(grapheme: string) {
  if (KEYCAP_EMOJI_PATTERN.test(grapheme)) {
    return true;
  }
  if (/[\p{L}\p{N}]/u.test(grapheme)) {
    return false;
  }
  return (
    /\p{Emoji_Presentation}/u.test(grapheme) ||
    /\p{Extended_Pictographic}\uFE0F/u.test(grapheme) ||
    grapheme.includes("\uFE0F")
  );
}

export function normalizeGeneratedPlannerSymbols(value: string) {
  const compact = value.replace(/\s+/g, "").trim();
  if (!compact) {
    return null;
  }

  const emojis = splitGraphemes(compact).filter((symbol) => symbol.trim().length > 0);
  // Require every grapheme to be an emoji (rejecting words/glyphs/text), but
  // tolerate the model over-producing for compound items by keeping the first
  // MAX_PLANNER_SYMBOL_COUNT rather than failing the whole batch.
  if (emojis.length < 1 || !emojis.every(isEmojiGrapheme)) {
    return null;
  }

  return emojis.slice(0, MAX_PLANNER_SYMBOL_COUNT).join("");
}

export function buildDeterministicPlannerSymbols(seedText: string) {
  let hash = 2166136261;
  for (const character of seedText) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const first = EMOJI_FALLBACK_PALETTE[Math.abs(hash) % EMOJI_FALLBACK_PALETTE.length]!;
  const second =
    EMOJI_FALLBACK_PALETTE[
      Math.abs(hash >>> 8) % EMOJI_FALLBACK_PALETTE.length
    ]!;
  return first === second ? first : `${first}${second}`;
}
