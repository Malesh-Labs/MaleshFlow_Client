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

const WIKI_LINK_PATTERN = /\[\[([^[\]]+)\]\]/g;
const NODE_LINK_PATTERN = /\(\(([a-zA-Z0-9_-]+)\)\)/g;
const NODE_WIKI_TARGET_PATTERN = /^(.*?)\|node:([a-zA-Z0-9_-]+)$/;

export function extractLinks(text: string) {
  const matches: Array<{ index: number; link: ExtractedLink }> = [];

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
        index: match.index ?? 0,
        link: {
          kind: "node",
          label: match[0],
          targetNodeRef: ref,
        },
      });
      continue;
    }

    matches.push({
      index: match.index ?? 0,
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
      index: match.index ?? 0,
      link: {
        kind: "node",
        label: match[0],
        targetNodeRef: ref,
      },
    });
  }

  return matches.sort((left, right) => left.index - right.index).map((match) => match.link);
}
