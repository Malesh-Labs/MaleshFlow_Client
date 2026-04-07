export type ExtractedLink =
  | {
      kind: "page";
      label: string;
      targetPageTitle?: string;
      targetPageRef?: string;
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
const PLAIN_URL_PATTERN =
  /(?:https?:\/\/[^\s<]+|www\.[^\s<]+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s<]*)?)/g;
const PLAIN_EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PAGE_WIKI_TARGET_PATTERN = /^(?:(.*?)\|)?page:([a-zA-Z0-9_-]+)$/;
const NODE_WIKI_TARGET_PATTERN = /^(?:(.*?)\|)?node:([a-zA-Z0-9_-]+)$/;
const COMPLETE_MARKDOWN_LINK_PATTERN = /^\[([^\]]+)\]\(([^)]*)\)$/;
const COMPLETE_WIKI_LINK_PATTERN = /^\[\[([^[\]]+)\]\]$/;

function rangesOverlap(
  left: Pick<ExtractedLinkMatch, "start" | "end">,
  right: Pick<ExtractedLinkMatch, "start" | "end">,
) {
  return left.start < right.end && right.start < left.end;
}

function trimTrailingUrlPunctuation(value: string) {
  let trimmed = value.replace(/[.,!?;:>]+$/g, "");
  while (trimmed.endsWith(")") && !trimmed.includes("(")) {
    trimmed = trimmed.slice(0, -1);
  }
  while (trimmed.endsWith("]") && !trimmed.includes("[")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function isValidPlainUrlBoundary(text: string, start: number) {
  if (start <= 0) {
    return true;
  }

  const previousCharacter = text[start - 1];
  return previousCharacter ? !/[A-Za-z0-9_@]/.test(previousCharacter) : true;
}

function isValidPlainEmailBoundary(text: string, start: number, end: number) {
  const previousCharacter = start > 0 ? text[start - 1] : "";
  const nextCharacter = end < text.length ? text[end] : "";

  const emailCharacterPattern = /[A-Za-z0-9._%+-]/;
  return (
    (!previousCharacter || !emailCharacterPattern.test(previousCharacter)) &&
    (!nextCharacter || !emailCharacterPattern.test(nextCharacter))
  );
}

export function extractLinkMatches(text: string) {
  const matches: ExtractedLinkMatch[] = [];

  for (const match of text.matchAll(WIKI_LINK_PATTERN)) {
    const inner = match[1]?.trim();
    if (!inner) {
      continue;
    }

    const pageMatch = inner.match(PAGE_WIKI_TARGET_PATTERN);
    if (pageMatch) {
      const ref = pageMatch[2]?.trim();
      if (!ref) {
        continue;
      }

      matches.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        link: {
          kind: "page",
          label: match[0],
          targetPageRef: ref,
        },
      });
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

  for (const match of text.matchAll(PLAIN_URL_PATTERN)) {
    const rawUrl = match[0]?.trim();
    const start = match.index ?? 0;
    if (!rawUrl || !isValidPlainUrlBoundary(text, start)) {
      continue;
    }

    const targetUrl = trimTrailingUrlPunctuation(rawUrl);
    if (targetUrl.length === 0) {
      continue;
    }

    const end = start + targetUrl.length;
    const overlapsExistingMatch = matches.some((existingMatch) =>
      rangesOverlap(existingMatch, { start, end }),
    );
    if (overlapsExistingMatch) {
      continue;
    }

    matches.push({
      start,
      end,
      link: {
        kind: "external",
        label: targetUrl,
        text: targetUrl,
        targetUrl,
      },
    });
  }

  for (const match of text.matchAll(PLAIN_EMAIL_PATTERN)) {
    const rawEmail = match[0]?.trim();
    const start = match.index ?? 0;
    if (!rawEmail) {
      continue;
    }

    const trimmedEmail = trimTrailingUrlPunctuation(rawEmail);
    const end = start + trimmedEmail.length;
    if (
      trimmedEmail.length === 0 ||
      !isValidPlainEmailBoundary(text, start, end)
    ) {
      continue;
    }

    const overlapsExistingMatch = matches.some((existingMatch) =>
      rangesOverlap(existingMatch, { start, end }),
    );
    if (overlapsExistingMatch) {
      continue;
    }

    matches.push({
      start,
      end,
      link: {
        kind: "external",
        label: trimmedEmail,
        text: trimmedEmail,
        targetUrl: `mailto:${trimmedEmail}`,
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
    return getExplicitWikiLinkPreviewText(match.link.label) || match.link.targetPageTitle || "";
  }

  if (match.link.kind === "external") {
    return match.link.text;
  }

  if (match.link.label.startsWith("[[")) {
    return getExplicitWikiLinkPreviewText(match.link.label);
  }

  return "";
}

export function getExplicitWikiLinkPreviewText(label: string) {
  if (!label.startsWith("[[") || !label.endsWith("]]")) {
    return "";
  }

  return label
    .slice(2, -2)
    .replace(/^(?:node|page):[a-zA-Z0-9_-]+$/, "")
    .replace(/\|(node|page):[a-zA-Z0-9_-]+$/, "")
    .trim();
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

export function sanitizeGeneratedWikiLinkLabel(value: string) {
  return (
    replaceLinkMarkupWithLabels(value)
      .replace(/\|/g, "/")
      .replace(/\]\]/g, "] ]")
      .trim() || "Untitled node"
  );
}

export function rewriteMatchingPageWikiLinks(
  text: string,
  shouldRewrite: (
    link: Extract<ExtractedLink, { kind: "page" }>,
  ) => boolean,
  nextTitle: string,
  previousTitle?: string,
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

    if (match.link.kind === "page" && shouldRewrite(match.link)) {
      if (match.link.targetPageRef) {
        const previewText = getExplicitWikiLinkPreviewText(match.link.label);
        if (
          previewText.length === 0 ||
          previewText.localeCompare(previousTitle ?? "", undefined, {
            sensitivity: "base",
          }) !== 0
        ) {
          nextText +=
            previewText.length === 0
              ? `[[page:${match.link.targetPageRef}]]`
              : text.slice(match.start, match.end);
        } else {
          nextText += `[[${nextTitle}|page:${match.link.targetPageRef}]]`;
        }
      } else {
        nextText += `[[${nextTitle}]]`;
      }
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
