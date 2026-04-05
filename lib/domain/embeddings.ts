import { EMBEDDING_DIMENSIONS } from "./constants";

export function shouldGenerateEmbeddingForNodeText(text: string) {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return false;
  }

  return normalized !== "---" && normalized !== ".";
}

export function buildEmbeddingInput(args: {
  pageTitle: string;
  ancestors: string[];
  nodeText: string;
}) {
  const parts = [
    `Page: ${args.pageTitle}`,
    args.ancestors.length > 0 ? `Path: ${args.ancestors.join(" > ")}` : "",
    `Node: ${args.nodeText}`,
  ].filter(Boolean);

  return parts.join("\n");
}

export function buildRootEmbeddingInput(args: {
  pageTitle: string;
  rootText: string;
  subtreeLines: string[];
}) {
  const parts = [
    `Page: ${args.pageTitle}`,
    `Root: ${args.rootText}`,
    args.subtreeLines.length > 0
      ? `Subtree:\n${args.subtreeLines.join("\n")}`
      : "",
  ].filter(Boolean);

  return parts.join("\n");
}

export function buildDeterministicEmbedding(text: string) {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const normalized = text.trim().toLowerCase();

  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    const slot = (code * (index + 17)) % EMBEDDING_DIMENSIONS;
    vector[slot] += ((code % 17) + 1) / 17;
  }

  const magnitude = Math.sqrt(
    vector.reduce((total, value) => total + value * value, 0),
  );

  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

export function formatNodeForEmbedding(node: {
  text: string;
  kind: string;
  taskStatus: string | null;
}) {
  const text = node.text.trim();
  if (text.length === 0) {
    return "";
  }

  if (node.kind === "task") {
    return `${node.taskStatus === "done" ? "[x]" : "[ ]"} ${text}`;
  }

  return text;
}

export function collectRootSubtreeLines(
  rootNodeId: string,
  allNodes: Array<{
    _id: string;
    parentNodeId: string | null;
    position: number;
    text: string;
    kind: string;
    taskStatus: string | null;
  }>,
) {
  const sortedNodes = [...allNodes].sort((left, right) => left.position - right.position);
  const childrenByParent = new Map<string | null, Array<(typeof sortedNodes)[number]>>();

  for (const node of sortedNodes) {
    const key = node.parentNodeId ?? null;
    const bucket = childrenByParent.get(key) ?? [];
    bucket.push(node);
    childrenByParent.set(key, bucket);
  }

  const lines: string[] = [];
  const visit = (nodeId: string, depth: number) => {
    const children = childrenByParent.get(nodeId) ?? [];
    for (const child of children) {
      const prefix = "  ".repeat(depth);
      const formatted = formatNodeForEmbedding(child);
      if (formatted.length > 0) {
        lines.push(`${prefix}- ${formatted}`);
      }
      visit(child._id, depth + 1);
    }
  };

  visit(rootNodeId, 0);
  return lines;
}
