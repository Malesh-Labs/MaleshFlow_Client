export type ExtractedLink =
  | {
      kind: "page";
      label: string;
      targetPageTitle: string;
    }
  | {
      kind: "node";
      label: string;
      targetNodeRef: string;
    };

export type ExtractedLinkMatch = {
  start: number;
  end: number;
  link: ExtractedLink;
};

const WIKI_LINK_PATTERN = /\[\[([^[\]]+)\]\]/g;
const NODE_LINK_PATTERN = /\(\(([a-zA-Z0-9_-]+)\)\)/g;
const NODE_WIKI_TARGET_PATTERN = /^(.*?)\|node:([a-zA-Z0-9_-]+)$/;

export function extractLinkMatches(text: string) {
  const matches: ExtractedLinkMatch[] = [];

  for (const match of text.matchAll(WIKI_LINK_PATTERN)) {
    const inner = match[1]?.trim();
    if (!inner) {
      continue;
    }

    const nodeMatch = inner.match(NODE_WIKI_TARGET_PATTERN);
    if (nodeMatch) {
      const ref = nodeMatch[2]?.trim();
      if (!ref) {
        continue;
      }

      matches.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        link: {
          kind: "node",
          label: match[0],
          targetNodeRef: ref,
        },
      });
      continue;
    }

    matches.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      link: {
        kind: "page",
        label: match[0],
        targetPageTitle: inner,
      },
    });
  }

  for (const match of text.matchAll(NODE_LINK_PATTERN)) {
    const ref = match[1]?.trim();
    if (!ref) {
      continue;
    }

    matches.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      link: {
        kind: "node",
        label: match[0],
        targetNodeRef: ref,
      },
    });
  }

  return matches.sort((left, right) => left.start - right.start);
}

export function extractLinks(text: string) {
  return extractLinkMatches(text).map((match) => match.link);
}

function getReadableLinkLabel(match: ExtractedLinkMatch) {
  if (match.link.kind === "page") {
    return match.link.targetPageTitle;
  }

  if (match.link.label.startsWith("[[")) {
    return match.link.label
      .slice(2, -2)
      .replace(/\|node:[a-zA-Z0-9_-]+$/, "")
      .trim();
  }

  return "";
}

function replaceLinkMarkup(
  text: string,
  replacer: (match: ExtractedLinkMatch) => string,
) {
  const matches = extractLinkMatches(text);
  if (matches.length === 0) {
    return text.trim();
  }

  let cursor = 0;
  let nextText = "";

  for (const match of matches) {
    if (match.start > cursor) {
      nextText += text.slice(cursor, match.start);
    }

    nextText += replacer(match);
    cursor = match.end;
  }

  if (cursor < text.length) {
    nextText += text.slice(cursor);
  }

  return nextText.replace(/\s+/g, " ").trim();
}

export function stripLinkMarkup(text: string) {
  return replaceLinkMarkup(text, () => "");
}

export function replaceLinkMarkupWithLabels(text: string) {
  return replaceLinkMarkup(text, (match) => getReadableLinkLabel(match));
}
