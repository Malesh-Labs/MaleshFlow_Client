export type ExtractedTagMatch = {
  start: number;
  end: number;
  label: string;
  value: string;
  normalizedValue: string;
};

const TAG_PATTERN = /(^|[^A-Za-z0-9_])#([A-Za-z0-9]+(?:[/-][A-Za-z0-9]+)*)/g;

export function extractTagMatches(text: string) {
  const matches: ExtractedTagMatch[] = [];

  for (const match of text.matchAll(TAG_PATTERN)) {
    const boundary = match[1] ?? "";
    const value = match[2] ?? "";
    if (value.length === 0) {
      continue;
    }

    const boundaryLength = boundary.length;
    const start = (match.index ?? 0) + boundaryLength;
    const label = `#${value}`;
    matches.push({
      start,
      end: start + label.length,
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
