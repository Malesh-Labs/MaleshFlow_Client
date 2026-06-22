import { isSeparatorLineText, stripNodeDisplaySyntaxMarkers } from "./displaySyntax";
import { stripInlineFormattingMarkers } from "./inlineFormatting";
import {
  extractLinkMatches,
  getExplicitWikiLinkPreviewText,
  replaceLinkMarkupWithLabels,
} from "./links";

const RAW_NODE_REFERENCE_PATTERN = /^node:([a-zA-Z0-9_-]+)$/;
const SYMBOL_FALLBACK_PALETTE = [
  "●",
  "◆",
  "✦",
  "✚",
  "↗",
  "◐",
  "◎",
  "☉",
  "◇",
  "✶",
  "◌",
  "⬡",
  "⚑",
  "☑",
  "⌁",
  "◈",
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

export function listFocusSymbolTextExemptNodeIds<T extends { _id: string; text: string }>(
  focusChildren: T[],
) {
  const exemptNodeIds: string[] = [];
  for (const child of focusChildren) {
    if (isSeparatorLineText(child.text.trim())) {
      break;
    }
    exemptNodeIds.push(child._id);
  }
  return exemptNodeIds;
}

export function normalizeGeneratedPlannerSymbols(value: string) {
  const compact = value.replace(/\s+/g, "").trim();
  if (!compact || /[\p{L}\p{N}]/u.test(compact)) {
    return null;
  }

  const symbols = splitGraphemes(compact).filter((symbol) => symbol.trim().length > 0);
  if (symbols.length < 1 || symbols.length > 3) {
    return null;
  }

  return symbols.join("");
}

export function buildDeterministicPlannerSymbols(seedText: string) {
  let hash = 2166136261;
  for (const character of seedText) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const first = SYMBOL_FALLBACK_PALETTE[Math.abs(hash) % SYMBOL_FALLBACK_PALETTE.length]!;
  const second =
    SYMBOL_FALLBACK_PALETTE[
      Math.abs(hash >>> 8) % SYMBOL_FALLBACK_PALETTE.length
    ]!;
  return first === second ? first : `${first}${second}`;
}
