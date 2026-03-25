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

const PAGE_LINK_PATTERN = /\[\[([^[\]]+)\]\]/g;
const NODE_LINK_PATTERN = /\(\(([a-zA-Z0-9_-]+)\)\)/g;

export function extractLinks(text: string) {
  const links: ExtractedLink[] = [];

  for (const match of text.matchAll(PAGE_LINK_PATTERN)) {
    const title = match[1]?.trim();
    if (!title) {
      continue;
    }

    links.push({
      kind: "page",
      label: match[0],
      targetPageTitle: title,
    });
  }

  for (const match of text.matchAll(NODE_LINK_PATTERN)) {
    const ref = match[1]?.trim();
    if (!ref) {
      continue;
    }

    links.push({
      kind: "node",
      label: match[0],
      targetNodeRef: ref,
    });
  }

  return links;
}
