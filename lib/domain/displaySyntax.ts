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
