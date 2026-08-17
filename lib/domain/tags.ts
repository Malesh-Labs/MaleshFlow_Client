import { extractLinkMatches } from "./links";

export type ExtractedTagMatch = {
  start: number;
  end: number;
  label: string;
  value: string;
  normalizedValue: string;
};

const TAG_PATTERN = /(^|[^A-Za-z0-9_]|__)#([A-Za-z0-9]+(?:[/-][A-Za-z0-9]+)*)/g;

function isWithinLinkRange(
  start: number,
  end: number,
  linkRanges: Array<{ start: number; end: number }>,
) {
  return linkRanges.some((range) => start < range.end && range.start < end);
}

export function extractTagMatches(text: string) {
  const matches: ExtractedTagMatch[] = [];
  const linkRanges = extractLinkMatches(text).map((match) => ({
    start: match.start,
    end: match.end,
  }));

  for (const match of text.matchAll(TAG_PATTERN)) {
    const boundary = match[1] ?? "";
    const value = match[2] ?? "";
    if (value.length === 0) {
      continue;
    }

    const boundaryLength = boundary.length;
    const start = (match.index ?? 0) + boundaryLength;
    const label = `#${value}`;
    const end = start + label.length;
    if (isWithinLinkRange(start, end, linkRanges)) {
      continue;
    }

    matches.push({
      start,
      end,
      label,
      value,
      normalizedValue: value.toLowerCase(),
    });
  }

  return matches;
}

export function extractTags(text: string) {
  return extractTagMatches(text).map((match) => match.value);
}

export function textHasTag(text: string, normalizedTag: string) {
  return extractTagMatches(text).some(
    (match) => match.normalizedValue === normalizedTag,
  );
}

export function splitEdgeTagMatches(text: string) {
  let remaining = text.trimStart();
  const leadingTags: ExtractedTagMatch[] = [];
  const trailingTags: ExtractedTagMatch[] = [];

  while (remaining.length > 0) {
    const tagMatch = extractTagMatches(remaining).find((match) => match.start === 0);
    if (!tagMatch) {
      break;
    }

    leadingTags.push(tagMatch);
    remaining = remaining.slice(tagMatch.end).trimStart();
  }

  remaining = remaining.trimEnd();
  while (remaining.length > 0) {
    const tagMatch = extractTagMatches(remaining).find(
      (match) => match.end === remaining.length,
    );
    if (!tagMatch) {
      break;
    }

    trailingTags.unshift(tagMatch);
    remaining = remaining.slice(0, tagMatch.start).trimEnd();
  }

  return {
    leadingTags,
    trailingTags,
    text: remaining,
  };
}

export function stripTagsFromText(text: string) {
  const matches = extractTagMatches(text);
  if (matches.length === 0) {
    return text.trim();
  }

  let cursor = 0;
  let nextText = "";

  for (const match of matches) {
    if (match.start > cursor) {
      nextText += text.slice(cursor, match.start);
    }
    cursor = match.end;
  }

  if (cursor < text.length) {
    nextText += text.slice(cursor);
  }

  return nextText.replace(/\s+/g, " ").trim();
}
