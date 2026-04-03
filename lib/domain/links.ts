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
    }
  | {
      kind: "external";
      label: string;
      text: string;
      targetUrl: string;
    };

export type ExtractedLinkMatch = {
  start: number;
  end: number;
  link: ExtractedLink;
};

const WIKI_LINK_PATTERN = /\[\[([^[\]]+)\]\]/g;
const NODE_LINK_PATTERN = /\(\(([a-zA-Z0-9_-]+)\)\)/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const NODE_WIKI_TARGET_PATTERN = /^(?:(.*?)\|)?node:([a-zA-Z0-9_-]+)$/;
const COMPLETE_MARKDOWN_LINK_PATTERN = /^\[([^\]]+)\]\(([^)]*)\)$/;
const COMPLETE_WIKI_LINK_PATTERN = /^\[\[([^[\]]+)\]\]$/;

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

  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const labelText = match[1]?.trim();
    const targetUrl = match[2]?.trim();
    if (!labelText || !targetUrl) {
      continue;
    }

    matches.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      link: {
        kind: "external",
        label: match[0],
        text: labelText,
        targetUrl,
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

  if (match.link.kind === "external") {
    return match.link.text;
  }

  if (match.link.label.startsWith("[[")) {
    return match.link.label
      .slice(2, -2)
      .replace(/^(?:node:[a-zA-Z0-9_-]+)$/, "")
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

export function rewriteMatchingPageWikiLinks(
  text: string,
  shouldRewrite: (targetPageTitle: string) => boolean,
  nextTitle: string,
) {
  const matches = extractLinkMatches(text);
  if (matches.length === 0) {
    return text;
  }

  let cursor = 0;
  let nextText = "";

  for (const match of matches) {
    if (match.start > cursor) {
      nextText += text.slice(cursor, match.start);
    }

    if (match.link.kind === "page" && shouldRewrite(match.link.targetPageTitle)) {
      nextText += `[[${nextTitle}]]`;
    } else {
      nextText += text.slice(match.start, match.end);
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    nextText += text.slice(cursor);
  }

  return nextText;
}

export function applySelectedLinkShortcut(
  text: string,
  selectionStart: number,
  selectionEnd: number,
) {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.max(start, Math.max(selectionStart, selectionEnd));
  if (start === end) {
    return null;
  }

  const selectedText = text.slice(start, end);
  let replacement: string | null = null;

  const markdownMatch = selectedText.match(COMPLETE_MARKDOWN_LINK_PATTERN);
  if (markdownMatch) {
    replacement = `[[${markdownMatch[1]}]]`;
  } else if (!COMPLETE_WIKI_LINK_PATTERN.test(selectedText)) {
    replacement = `[${selectedText}]()`;
  }

  if (replacement === null) {
    return null;
  }

  return {
    value: `${text.slice(0, start)}${replacement}${text.slice(end)}`,
    selectionStart: start,
    selectionEnd: start + replacement.length,
  };
}
