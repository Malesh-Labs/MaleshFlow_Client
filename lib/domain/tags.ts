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
