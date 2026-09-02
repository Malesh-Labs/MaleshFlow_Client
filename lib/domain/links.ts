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
      hideTags?: boolean;
      showChildren?: boolean;
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
const NODE_WIKI_TARGET_PATTERN = /^(?:(.*?)\|)?node:([a-zA-Z0-9_-]+)(\?[A-Za-z]+(?:[?&][A-Za-z]+)*)?$/;
const BARE_NODE_WIKI_TARGET_PATTERN = /^(?:node_[a-zA-Z0-9_-]+|k17[0-9a-z]{20,})$/i;
const BARE_NODE_WIKI_TARGET_WITH_OPTIONS_PATTERN =
  /^((?:node_[a-zA-Z0-9_-]+|k17[0-9a-z]{20,}))(\?[A-Za-z]+(?:[?&][A-Za-z]+)*)?$/i;
const NODE_LINK_OPTION_TEXT_PATTERN =
  /\?(?:showparent|hidetags|showchildren)(?:[?&](?:showparent|hidetags|showchildren))*$/i;
const NODE_LINK_OPTION_CANDIDATE_PATTERN = /^\?[A-Za-z]+(?:[?&][A-Za-z]+)*/;
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

function parseNodeLinkOptions(optionText: string | null | undefined) {
  if (!optionText) {
    return {
      text: "",
      includeParent: false,
      hideTags: false,
      showChildren: false,
    };
  }

  if (!optionText.startsWith("?")) {
    return null;
  }

  const options = optionText.slice(1).split(/[?&]/);
  if (options.length === 0 || options.some((option) => option.length === 0)) {
    return null;
  }

  const optionSet = new Set(options.map((option) => option.toLowerCase()));
  if (
    ![...optionSet].every(
      (option) =>
        option === "showparent" ||
        option === "hidetags" ||
        option === "showchildren",
    )
  ) {
    return null;
  }

  return {
    text: optionText,
    includeParent: optionSet.has("showparent"),
    hideTags: optionSet.has("hidetags"),
    showChildren: optionSet.has("showchildren"),
  };
}

function readTrailingNodeLinkOptions(text: string, start: number) {
  const match = text.slice(start).match(NODE_LINK_OPTION_CANDIDATE_PATTERN);
  if (!match) {
    return {
      text: "",
      includeParent: false,
      hideTags: false,
      showChildren: false,
    };
  }

  return parseNodeLinkOptions(match[0]) ?? {
    text: "",
    includeParent: false,
    hideTags: false,
    showChildren: false,
  };
}

function stripTrailingNodeLinkOptions(label: string) {
  return label.replace(NODE_LINK_OPTION_TEXT_PATTERN, "");
}

function isBareNodeWikiTargetRef(value: string) {
  return BARE_NODE_WIKI_TARGET_PATTERN.test(value.trim());
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
      const innerOptions = parseNodeLinkOptions(nodeMatch[3]);
      if (!innerOptions) {
        continue;
      }
      const trailingOptions = readTrailingNodeLinkOptions(
        text,
        (match.index ?? 0) + match[0].length,
      );
      const label = trailingOptions.text
        ? `${match[0]}${trailingOptions.text}`
        : match[0];
      const includeParent = innerOptions.includeParent || trailingOptions.includeParent;
      const hideTags = innerOptions.hideTags || trailingOptions.hideTags;
      const showChildren = innerOptions.showChildren || trailingOptions.showChildren;

      matches.push({
        start: match.index ?? 0,
        end:
          (match.index ?? 0) +
          match[0].length +
          trailingOptions.text.length,
        link: {
          kind: "node",
          label,
          targetNodeRef: ref,
          ...(includeParent ? { includeParent: true } : {}),
          ...(hideTags ? { hideTags: true } : {}),
          ...(showChildren ? { showChildren: true } : {}),
        },
      });
      continue;
    }

    const bareNodeMatch = inner.match(BARE_NODE_WIKI_TARGET_WITH_OPTIONS_PATTERN);
    if (bareNodeMatch) {
      const ref = bareNodeMatch[1]?.trim();
      if (!ref) {
        continue;
      }
      const innerOptions = parseNodeLinkOptions(bareNodeMatch[2]);
      if (!innerOptions) {
        continue;
      }
      const trailingOptions = readTrailingNodeLinkOptions(
        text,
        (match.index ?? 0) + match[0].length,
      );
      const label = trailingOptions.text
        ? `${match[0]}${trailingOptions.text}`
        : match[0];
      const includeParent = innerOptions.includeParent || trailingOptions.includeParent;
      const hideTags = innerOptions.hideTags || trailingOptions.hideTags;
      const showChildren = innerOptions.showChildren || trailingOptions.showChildren;

      matches.push({
        start: match.index ?? 0,
        end:
          (match.index ?? 0) +
          match[0].length +
          trailingOptions.text.length,
        link: {
          kind: "node",
          label,
          targetNodeRef: ref,
          ...(includeParent ? { includeParent: true } : {}),
          ...(hideTags ? { hideTags: true } : {}),
          ...(showChildren ? { showChildren: true } : {}),
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

  const wikiLabel = stripTrailingNodeLinkOptions(label);
  if (!wikiLabel.endsWith("]]")) {
    return "";
  }

  return wikiLabel
    .slice(2, -2)
    .replace(
      /^node:[a-zA-Z0-9_-]+(?:\?(?:showparent|hidetags|showchildren)(?:[?&](?:showparent|hidetags|showchildren))*)?$/i,
      "",
    )
    .replace(
      /^(?:node_[a-zA-Z0-9_-]+|k17[0-9a-z]{20,})(?:\?(?:showparent|hidetags|showchildren)(?:[?&](?:showparent|hidetags|showchildren))*)?$/i,
      "",
    )
    .replace(/^page:[a-zA-Z0-9_-]+$/, "")
    .replace(
      /\|node:[a-zA-Z0-9_-]+(?:\?(?:showparent|hidetags|showchildren)(?:[?&](?:showparent|hidetags|showchildren))*)?$/i,
      "",
    )
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

export function replaceNodeLinkMarkupWithResolvedText(
  text: string,
  nodeTextById: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  options: {
    maxDepth?: number;
  } = {},
) {
  const maxDepth = Math.max(1, options.maxDepth ?? 3);
  const nodeTextMap = nodeTextById as ReadonlyMap<string, string>;
  const nodeTextRecord = nodeTextById as Readonly<Record<string, string>>;
  const getNodeText = (nodeId: string) =>
    typeof nodeTextMap.get === "function"
      ? nodeTextMap.get(nodeId)
      : nodeTextRecord[nodeId];

  const resolveText = (value: string, depth: number, ancestorNodeIds: Set<string>): string => {
    const matches = extractLinkMatches(value);
    if (matches.length === 0) {
      return value;
    }

    let cursor = 0;
    let nextText = "";
    for (const match of matches) {
      if (match.start > cursor) {
        nextText += value.slice(cursor, match.start);
      }

      if (match.link.kind !== "node") {
        nextText += value.slice(match.start, match.end);
        cursor = match.end;
        continue;
      }

      const explicitLabel = getExplicitWikiLinkPreviewText(match.link.label);
      if (explicitLabel) {
        nextText += explicitLabel;
        cursor = match.end;
        continue;
      }

      const targetNodeId = match.link.targetNodeRef;
      const targetText = getNodeText(targetNodeId);
      if (
        targetText !== undefined &&
        depth < maxDepth &&
        !ancestorNodeIds.has(targetNodeId)
      ) {
        const nextAncestorNodeIds = new Set(ancestorNodeIds);
        nextAncestorNodeIds.add(targetNodeId);
        nextText += resolveText(targetText, depth + 1, nextAncestorNodeIds);
      }
      cursor = match.end;
    }

    if (cursor < value.length) {
      nextText += value.slice(cursor);
    }

    return nextText;
  };

  return resolveText(text, 0, new Set());
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

function normalizeWikiLinkReplacementComparisonText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function buildWikiLinkReplacementMarkup(
  label: string,
  target: {
    kind: "node" | "page";
    ref: string;
    displayText?: string;
  },
) {
  const safeLabel =
    sanitizeWikiLinkReplacementLabel(label) ||
    (target.kind === "node" ? "Linked node" : "Linked page");
  const normalizedLabel = normalizeWikiLinkReplacementComparisonText(label);
  const normalizedDisplayText = normalizeWikiLinkReplacementComparisonText(
    target.displayText ?? "",
  );
  if (
    target.kind === "node" &&
    normalizedLabel.length > 0 &&
    normalizedLabel === normalizedDisplayText &&
    isBareNodeWikiTargetRef(target.ref)
  ) {
    return `[[${target.ref}]]`;
  }

  return `[[${safeLabel}|${target.kind}:${target.ref}]]`;
}

export function rewritePlainPageWikiLinksToTarget(
  text: string,
  shouldRewrite: (
    link: Extract<ExtractedLink, { kind: "page" }>,
  ) => boolean,
  target: {
    kind: "node" | "page";
    ref: string;
    displayText?: string;
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
      nextText += buildWikiLinkReplacementMarkup(label, target);
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
  targetNodeDisplayText?: string,
) {
  return rewritePlainPageWikiLinksToTarget(text, shouldRewrite, {
    kind: "node",
    ref: targetNodeRef,
    displayText: targetNodeDisplayText,
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
