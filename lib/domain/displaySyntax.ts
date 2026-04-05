export type ParsedHeadingSyntax =
  | {
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      level: null;
      text: string;
    };

const HEADING_SYNTAX_PATTERN = /^(#{1,3})\s+(.+)$/;

export function parseHeadingSyntax(value: string): ParsedHeadingSyntax {
  const match = value.match(HEADING_SYNTAX_PATTERN);
  if (!match) {
    return {
      level: null,
      text: value,
    };
  }

  const level = match[1]?.length;
  const text = match[2]?.trimEnd() ?? "";
  if (!level || text.trim().length === 0) {
    return {
      level: null,
      text: value,
    };
  }

  return {
    level: level as 1 | 2 | 3,
    text,
  };
}

export function cycleHeadingSyntax(
  value: string,
  selectionStart: number,
  selectionEnd: number,
) {
  const parsed = parseHeadingSyntax(value);
  const currentPrefixLength = parsed.level === null ? 0 : parsed.level + 1;
  const nextLevel =
    parsed.level === null ? 1 : parsed.level === 1 ? 2 : parsed.level === 2 ? 3 : null;
  const nextPrefix = nextLevel === null ? "" : `${"#".repeat(nextLevel)} `;
  const nextValue = `${nextPrefix}${parsed.text}`;

  const mapSelection = (position: number) =>
    Math.min(
      nextValue.length,
      nextPrefix.length + Math.max(0, position - currentPrefixLength),
    );

  return {
    value: nextValue,
    selectionStart: mapSelection(Math.min(selectionStart, selectionEnd)),
    selectionEnd: mapSelection(Math.max(selectionStart, selectionEnd)),
  };
}
