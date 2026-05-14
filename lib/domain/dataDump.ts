export type DataDumpNode = {
  _id: string;
  parentNodeId: string | null;
  sourceMeta?: unknown;
};

export type DataDumpManifestInput = {
  generatedAt: string;
  exportedPageCount: number;
  excludedPageCount: number;
  exportedArchivedNodeSubtreeCount: number;
  excludedNodeSubtreeCount: number;
  excludedNodeCount: number;
  legacyFileCount: number;
  contentFileCount: number;
};

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

function getSourceMeta(record: { sourceMeta?: unknown } | null | undefined) {
  return record && typeof record.sourceMeta === "object" && record.sourceMeta
    ? (record.sourceMeta as Record<string, unknown>)
    : {};
}

export function isDataDumpExcluded(
  record: { sourceMeta?: unknown } | null | undefined,
) {
  return getSourceMeta(record).excludeFromDataDump === true;
}

export function filterDataDumpNodes<TNode extends DataDumpNode>(nodes: TNode[]) {
  const nodeById = new Map(nodes.map((node) => [node._id as string, node]));
  const childrenByParent = new Map<string | null, TNode[]>();

  for (const node of nodes) {
    const key = node.parentNodeId ?? null;
    const bucket = childrenByParent.get(key) ?? [];
    bucket.push(node);
    childrenByParent.set(key, bucket);
  }

  function hasExcludedAncestor(node: TNode) {
    const visited = new Set<string>();
    let currentParentId = node.parentNodeId;

    while (currentParentId) {
      if (visited.has(currentParentId)) {
        break;
      }
      visited.add(currentParentId);

      const parentNode = nodeById.get(currentParentId);
      if (!parentNode) {
        break;
      }
      if (isDataDumpExcluded(parentNode)) {
        return true;
      }

      currentParentId = parentNode.parentNodeId;
    }

    return false;
  }

  const excludedNodeIds = new Set<string>();
  const excludedRootIds = new Set<string>();

  function markSubtreeExcluded(rootNodeId: string) {
    const queue = [rootNodeId];

    while (queue.length > 0) {
      const currentNodeId = queue.shift()!;
      if (excludedNodeIds.has(currentNodeId)) {
        continue;
      }

      excludedNodeIds.add(currentNodeId);
      for (const child of childrenByParent.get(currentNodeId) ?? []) {
        queue.push(child._id as string);
      }
    }
  }

  for (const node of nodes) {
    const nodeId = node._id as string;
    if (!isDataDumpExcluded(node) || hasExcludedAncestor(node)) {
      continue;
    }

    excludedRootIds.add(nodeId);
    markSubtreeExcluded(nodeId);
  }

  return {
    nodes: nodes.filter((node) => !excludedNodeIds.has(node._id as string)),
    excludedNodeIds,
    excludedRootIds,
    excludedNodeCount: excludedNodeIds.size,
    excludedNodeSubtreeCount: excludedRootIds.size,
  };
}

export function sanitizeDataDumpPathSegment(value: string, fallback = "untitled") {
  const cleaned = value
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.\.+/g, ".")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/^[._ -]+/, "")
    .replace(/[._ -]+$/, "")
    .trim();
  const segment = cleaned.length > 0 && !/^[._ -]+$/.test(cleaned) ? cleaned : fallback;
  const safeSegment = segment.slice(0, 120).trim() || fallback;

  return WINDOWS_RESERVED_NAMES.has(safeSegment.toLowerCase())
    ? `${safeSegment}-file`
    : safeSegment;
}

export function buildUniqueDataDumpPath({
  directory = [],
  name,
  extension = "",
  usedPaths,
}: {
  directory?: string[];
  name: string;
  extension?: string;
  usedPaths: Set<string>;
}) {
  const normalizedExtension = extension.replace(/^\.+/, "").trim();
  const extensionSuffix = normalizedExtension ? `.${normalizedExtension}` : "";
  const baseName =
    extensionSuffix && name.toLowerCase().endsWith(extensionSuffix.toLowerCase())
      ? name.slice(0, -extensionSuffix.length)
      : name;
  const safeDirectory = directory
    .map((segment) => sanitizeDataDumpPathSegment(segment, "folder"))
    .filter((segment) => segment.length > 0);
  const safeBaseName = sanitizeDataDumpPathSegment(baseName, "untitled");
  let suffix = 1;
  let candidate = [...safeDirectory, `${safeBaseName}${extensionSuffix}`].join("/");

  while (usedPaths.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = [...safeDirectory, `${safeBaseName} ${suffix}${extensionSuffix}`].join("/");
  }

  usedPaths.add(candidate.toLowerCase());
  return candidate;
}

export function buildDataDumpManifest(input: DataDumpManifestInput) {
  return {
    version: 1,
    generatedAt: input.generatedAt,
    counts: {
      exportedPages: input.exportedPageCount,
      excludedPages: input.excludedPageCount,
      exportedArchivedNodeSubtrees: input.exportedArchivedNodeSubtreeCount,
      excludedNodeSubtrees: input.excludedNodeSubtreeCount,
      excludedNodes: input.excludedNodeCount,
      legacyFiles: input.legacyFileCount,
      contentFiles: input.contentFileCount,
    },
  };
}
