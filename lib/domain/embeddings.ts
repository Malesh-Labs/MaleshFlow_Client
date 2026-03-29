import { EMBEDDING_DIMENSIONS } from "./constants";

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
