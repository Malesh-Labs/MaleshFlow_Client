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
      includeParent?: boolean;
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
const NODE_WIKI_TARGET_PATTERN = /^(?:(.*?)\|)?node:([a-zA-Z0-9_-]+)(\?parent)?$/;
const NODE_PARENT_LINK_OPTION = "?parent";
const COMPLETE_MARKDOWN_LINK_PATTERN = /^\[([^\]]+)\]\(([^)]*)\)$/;
const COMPLETE_WIKI_LINK_PATTERN = /^\[\[([^[\]]+)\]\]$/;
const HTML_ANCHOR_PATTERN = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
const HTML_BLOCK_BREAK_PATTERN =
  /<(?:br\s*\/?|\/(?:div|p|li|ul|ol|h[1-6]|blockquote|pre|tr|table))>/gi;
const HTML_LIST_ITEM_OPEN_PATTERN = /<li\b[^>]*>/gi;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const HTML_SCRIPT_STYLE_PATTERN = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

function decodeHtmlEntities(value: string) {
  return value.replace(
    /&(?:nbsp|amp|lt|gt|quot|apos|#39|#x27|#(\d+)|#x([0-9a-fA-F]+));/g,
    (match, decimalCode, hexCode) => {
      switch (match) {
        case "&nbsp;":
          return " ";
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
        case "&#39;":
        case "&#x27;":
          return "'";
        default:
          if (decimalCode) {
            return String.fromCodePoint(Number.parseInt(decimalCode, 10));
          }
          if (hexCode) {
            return String.fromCodePoint(Number.parseInt(hexCode, 16));
          }
          return match;
      }
    },
  );
}

function htmlFragmentToText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(HTML_COMMENT_PATTERN, "")
      .replace(HTML_SCRIPT_STYLE_PATTERN, "")
      .replace(HTML_BLOCK_BREAK_PATTERN, "\n")
      .replace(HTML_LIST_ITEM_OPEN_PATTERN, "- ")
      .replace(HTML_TAG_PATTERN, ""),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function convertHtmlClipboardToMarkdownText(html: string) {
  const replacedAnchors = html
    .replace(HTML_COMMENT_PATTERN, "")
    .replace(HTML_SCRIPT_STYLE_PATTERN, "")
    .replace(HTML_ANCHOR_PATTERN, (_match, _quote, rawHref, innerHtml) => {
      const href = decodeHtmlEntities(String(rawHref)).trim();
      const label = htmlFragmentToText(String(innerHtml)).replace(/\s+/g, " ").trim();
      if (!href) {
        return label;
      }
      if (label.length === 0 || label === href) {
        return href;
      }
      return `[${label.replace(/\]/g, "\\]")}](${href})`;
    });

  return htmlFragmentToText(replacedAnchors);
}

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

    const trailingParentOption =
      text
        .slice((match.index ?? 0) + match[0].length)
        .startsWith(NODE_PARENT_LINK_OPTION);
    const nodeMatch = inner.match(NODE_WIKI_TARGET_PATTERN);
    if (nodeMatch) {
      const ref = nodeMatch[2]?.trim();
      if (!ref) {
        continue;
      }
      const hasParentOption = nodeMatch[3] === NODE_PARENT_LINK_OPTION || trailingParentOption;
      const label = trailingParentOption
        ? `${match[0]}${NODE_PARENT_LINK_OPTION}`
        : match[0];

      matches.push({
        start: match.index ?? 0,
        end:
          (match.index ?? 0) +
          match[0].length +
          (trailingParentOption ? NODE_PARENT_LINK_OPTION.length : 0),
        link: {
          kind: "node",
          label,
          targetNodeRef: ref,
          ...(hasParentOption ? { includeParent: true } : {}),
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
  if (!label.startsWith("[[")) {
    return "";
  }

  const wikiLabel = label.endsWith(`]]${NODE_PARENT_LINK_OPTION}`)
    ? label.slice(0, -NODE_PARENT_LINK_OPTION.length)
    : label;
  if (!wikiLabel.endsWith("]]")) {
    return "";
  }

  return wikiLabel
    .slice(2, -2)
    .replace(/^node:[a-zA-Z0-9_-]+(?:\?parent)?$/, "")
    .replace(/^page:[a-zA-Z0-9_-]+$/, "")
    .replace(/\|node:[a-zA-Z0-9_-]+(?:\?parent)?$/, "")
    .replace(/\|page:[a-zA-Z0-9_-]+$/, "")
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

function sanitizeWikiLinkReplacementLabel(value: string) {
  return value
    .replace(/\|/g, "/")
    .replace(/\]\]/g, "] ]")
    .trim();
}

export function rewritePlainPageWikiLinksToTarget(
  text: string,
  shouldRewrite: (
    link: Extract<ExtractedLink, { kind: "page" }>,
  ) => boolean,
  target: {
    kind: "node" | "page";
    ref: string;
  },
) {
  const matches = extractLinkMatches(text);
  if (matches.length === 0) {
    return null;
  }

  let cursor = 0;
  let nextText = "";
  let occurrenceCount = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      nextText += text.slice(cursor, match.start);
    }

    if (
      match.link.kind === "page" &&
      !match.link.targetPageRef &&
      match.link.targetPageTitle &&
      shouldRewrite(match.link)
    ) {
      const label =
        sanitizeWikiLinkReplacementLabel(
          getExplicitWikiLinkPreviewText(match.link.label) ||
            match.link.targetPageTitle,
        ) || (target.kind === "node" ? "Linked node" : "Linked page");
      nextText += `[[${label}|${target.kind}:${target.ref}]]`;
      occurrenceCount += 1;
    } else {
      nextText += text.slice(match.start, match.end);
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    nextText += text.slice(cursor);
  }

  if (occurrenceCount === 0) {
    return null;
  }

  return {
    value: nextText,
    occurrenceCount,
  };
}

export function rewritePlainPageWikiLinksToNode(
  text: string,
  shouldRewrite: (
    link: Extract<ExtractedLink, { kind: "page" }>,
  ) => boolean,
  targetNodeRef: string,
) {
  return rewritePlainPageWikiLinksToTarget(text, shouldRewrite, {
    kind: "node",
    ref: targetNodeRef,
  });
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
