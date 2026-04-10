import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import type { RecurrenceFrequency } from "@/lib/domain/recurrence";

type PageDoc = Doc<"pages">;
type NodeDoc = Doc<"nodes">;
type LinkDoc = Doc<"links">;

type PageTreeResult = {
  page: PageDoc;
  nodes: NodeDoc[];
  backlinks: LinkDoc[];
  pageBacklinkCount: number;
  pageBacklinkCountTruncated?: boolean;
  nodeBacklinkCounts: Record<string, number>;
  loadWarning?: string | null;
};

type SidebarTreeResult = {
  page: PageDoc;
  nodes: NodeDoc[];
  linkedPageIds: Id<"pages">[];
  nodeBacklinkCounts: Record<string, number>;
};

type SimpleTaskViewPageResult = {
  page: PageDoc;
  nodes: NodeDoc[];
  loadWarning?: string | null;
};

type NodeTaskStatus = "todo" | "in_progress" | "done" | "cancelled" | null;

export type OptimisticNodeUpdateArgs = {
  ownerKey: string;
  nodeId: Id<"nodes">;
  text?: string;
  kind?: "note" | "task";
  lockKind?: boolean;
  taskStatus?: NodeTaskStatus;
  noteCompleted?: boolean;
  priority?: NodeDoc["priority"];
  dueAt?: number | null;
  dueEndAt?: number | null;
  recurrenceFrequency?: RecurrenceFrequency | null;
};

type OptimisticNodeUpdatePatch = Omit<OptimisticNodeUpdateArgs, "ownerKey">;

export type OptimisticNodeBatchUpdateArgs = {
  ownerKey: string;
  updates: OptimisticNodeUpdatePatch[];
};

export type OptimisticNodeMove = {
  nodeId: Id<"nodes">;
  pageId?: Id<"pages">;
  parentNodeId?: Id<"nodes"> | null;
  afterNodeId?: Id<"nodes"> | null;
};

export type OptimisticNodeCreateInput = {
  clientId?: string;
  parentNodeId?: Id<"nodes"> | null;
  parentClientId?: string;
  afterNodeId?: Id<"nodes"> | null;
  afterClientId?: string;
  text?: string;
  kind?: "note" | "task";
  lockKind?: boolean;
  noteCompleted?: boolean;
  taskStatus?: NodeTaskStatus;
  dueAt?: number | null;
  dueEndAt?: number | null;
  recurrenceFrequency?: RecurrenceFrequency | null;
};

export type OptimisticNodeSplitArgs = {
  ownerKey: string;
  nodeId: Id<"nodes">;
  headText: string;
  headKind: "note" | "task";
  headTaskStatus?: NodeTaskStatus;
  tailText: string;
  tailKind: "note" | "task";
  tailTaskStatus?: NodeTaskStatus;
};

export type OptimisticPlannerTaskCompletionArgs = {
  ownerKey: string;
  plannerNodeId: Id<"nodes">;
  completionMode: "dueDate" | "today";
};

function getTimestamp() {
  return Date.now();
}

function getSourceMeta(record: { sourceMeta?: unknown } | null | undefined) {
  return record && typeof record.sourceMeta === "object" && record.sourceMeta
    ? { ...(record.sourceMeta as Record<string, unknown>) }
    : {};
}

function updatePageTreeQueries(
  localStore: OptimisticLocalStore,
  ownerKey: string,
  updater: (value: PageTreeResult) => PageTreeResult,
) {
  for (const queryResult of localStore.getAllQueries(api.workspace.getPageTree)) {
    if (queryResult.args.ownerKey !== ownerKey || !queryResult.value) {
      continue;
    }
    localStore.setQuery(
      api.workspace.getPageTree,
      queryResult.args,
      updater(queryResult.value as PageTreeResult) as never,
    );
  }
}

function updateSidebarTreeQueries(
  localStore: OptimisticLocalStore,
  ownerKey: string,
  updater: (value: SidebarTreeResult) => SidebarTreeResult,
) {
  for (const queryResult of localStore.getAllQueries(api.workspace.getSidebarTree)) {
    if (queryResult.args.ownerKey !== ownerKey || !queryResult.value) {
      continue;
    }
    localStore.setQuery(
      api.workspace.getSidebarTree,
      queryResult.args,
      updater(queryResult.value),
    );
  }
}

function updateSimpleTaskViewQueries(
  localStore: OptimisticLocalStore,
  ownerKey: string,
  updater: (value: SimpleTaskViewPageResult[]) => SimpleTaskViewPageResult[],
) {
  for (const queryResult of localStore.getAllQueries(api.workspace.getSimpleTaskView)) {
    if (queryResult.args.ownerKey !== ownerKey || !queryResult.value) {
      continue;
    }
    localStore.setQuery(
      api.workspace.getSimpleTaskView,
      queryResult.args,
      updater(queryResult.value as SimpleTaskViewPageResult[]) as never,
    );
  }
}

function updateListPagesQueries(
  localStore: OptimisticLocalStore,
  ownerKey: string,
  updater: (value: PageDoc[]) => PageDoc[],
) {
  for (const queryResult of localStore.getAllQueries(api.workspace.listPages)) {
    if (queryResult.args.ownerKey !== ownerKey || !queryResult.value) {
      continue;
    }
    localStore.setQuery(
      api.workspace.listPages,
      queryResult.args,
      updater(queryResult.value),
    );
  }
}

function patchNodeList(
  nodes: NodeDoc[],
  nodeId: Id<"nodes">,
  patcher: (node: NodeDoc) => NodeDoc,
) {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node._id !== nodeId) {
      return node;
    }
    changed = true;
    return patcher(node);
  });
  return changed ? nextNodes : nodes;
}

function patchNodeInWorkspaceQueries(
  localStore: OptimisticLocalStore,
  ownerKey: string,
  nodeId: Id<"nodes">,
  patcher: (node: NodeDoc) => NodeDoc,
) {
  updatePageTreeQueries(localStore, ownerKey, (result) => ({
    ...result,
    nodes: patchNodeList(result.nodes, nodeId, patcher),
  }));
  updateSidebarTreeQueries(localStore, ownerKey, (result) => ({
    ...result,
    nodes: patchNodeList(result.nodes, nodeId, patcher),
  }));
  updateSimpleTaskViewQueries(localStore, ownerKey, (groups) =>
    groups.map((group) => ({
      ...group,
      nodes: patchNodeList(group.nodes, nodeId, patcher),
    })),
  );
}

function patchPageInWorkspaceQueries(
  localStore: OptimisticLocalStore,
  ownerKey: string,
  pageId: Id<"pages">,
  patcher: (page: PageDoc) => PageDoc,
) {
  updateListPagesQueries(localStore, ownerKey, (pages) =>
    pages.map((page) => (page._id === pageId ? patcher(page) : page)),
  );
  updatePageTreeQueries(localStore, ownerKey, (result) =>
    result.page._id === pageId ? { ...result, page: patcher(result.page) } : result,
  );
  updateSidebarTreeQueries(localStore, ownerKey, (result) =>
    result.page._id === pageId ? { ...result, page: patcher(result.page) } : result,
  );
  updateSimpleTaskViewQueries(localStore, ownerKey, (groups) =>
    groups.map((group) =>
      group.page._id === pageId ? { ...group, page: patcher(group.page) } : group,
    ),
  );
}

function applyNodeUpdatePatch(
  node: NodeDoc,
  update: Omit<OptimisticNodeUpdateArgs, "ownerKey" | "nodeId">,
) {
  const nextNode: NodeDoc = {
    ...node,
    updatedAt: getTimestamp(),
  };

  if (update.text !== undefined) {
    nextNode.text = update.text;
  }

  if (update.kind !== undefined) {
    nextNode.kind = update.kind;
    nextNode.taskStatus =
      update.kind === "task" ? (update.taskStatus ?? node.taskStatus ?? "todo") : null;
  } else if (update.taskStatus !== undefined) {
    nextNode.taskStatus = update.taskStatus;
  }

  if (update.priority !== undefined) {
    nextNode.priority = update.priority;
  }

  if (update.dueAt !== undefined) {
    nextNode.dueAt = update.dueAt;
  }

  if (update.dueEndAt !== undefined) {
    nextNode.dueEndAt = update.dueEndAt;
  }

  if (
    update.lockKind !== undefined ||
    update.noteCompleted !== undefined ||
    update.kind !== undefined ||
    update.recurrenceFrequency !== undefined
  ) {
    const sourceMeta = getSourceMeta(node);

    if (update.lockKind !== undefined) {
      sourceMeta.taskKindLocked = update.lockKind;
    }

    if (update.noteCompleted !== undefined) {
      sourceMeta.noteCompleted = update.noteCompleted;
    } else if (update.kind === "task") {
      sourceMeta.noteCompleted = false;
    }

    if (update.recurrenceFrequency !== undefined) {
      sourceMeta.recurrenceFrequency = update.recurrenceFrequency;
    } else if (update.kind === "note") {
      sourceMeta.recurrenceFrequency = null;
    }

    nextNode.sourceMeta = sourceMeta;
  }

  return nextNode;
}

function buildNodeChildrenMap(nodes: NodeDoc[]) {
  const childrenByParent = new Map<string | null, NodeDoc[]>();
  for (const node of nodes) {
    const parentKey = node.parentNodeId ? (node.parentNodeId as string) : null;
    const bucket = childrenByParent.get(parentKey) ?? [];
    bucket.push(node);
    childrenByParent.set(parentKey, bucket);
  }
  for (const bucket of childrenByParent.values()) {
    bucket.sort((left, right) => left.position - right.position);
  }
  return childrenByParent;
}

function collectSubtreeNodeIds(nodes: NodeDoc[], rootNodeIds: Id<"nodes">[]) {
  const childrenByParent = buildNodeChildrenMap(nodes);
  const collected = new Set<string>();
  const queue = rootNodeIds.map((nodeId) => nodeId as string);

  while (queue.length > 0) {
    const currentNodeId = queue.shift()!;
    if (collected.has(currentNodeId)) {
      continue;
    }
    collected.add(currentNodeId);
    for (const child of childrenByParent.get(currentNodeId) ?? []) {
      queue.push(child._id as string);
    }
  }

  return collected;
}

function removeArchivedNodesFromCounts(
  counts: Record<string, number>,
  removedNodeIds: Set<string>,
) {
  return Object.fromEntries(
    Object.entries(counts).filter(([nodeId]) => !removedNodeIds.has(nodeId)),
  ) as Record<string, number>;
}

function computeOptimisticNodePosition(
  nodes: NodeDoc[],
  movingNodeId: Id<"nodes">,
  pageId: Id<"pages">,
  parentNodeId: Id<"nodes"> | null,
  afterNodeId: Id<"nodes"> | null,
) {
  const siblings = nodes
    .filter(
      (candidate) =>
        candidate._id !== movingNodeId &&
        candidate.pageId === pageId &&
        ((candidate.parentNodeId as Id<"nodes"> | null) ?? null) === parentNodeId,
    )
    .sort((left, right) => left.position - right.position);
  const insertIndex =
    afterNodeId === null
      ? 0
      : Math.max(
          0,
          siblings.findIndex((candidate) => candidate._id === afterNodeId) + 1,
        );
  const previousSibling = insertIndex > 0 ? siblings[insertIndex - 1] ?? null : null;
  const nextSibling = siblings[insertIndex] ?? null;

  if (previousSibling && nextSibling) {
    const midpoint = (previousSibling.position + nextSibling.position) / 2;
    if (
      Number.isFinite(midpoint) &&
      midpoint !== previousSibling.position &&
      midpoint !== nextSibling.position
    ) {
      return midpoint;
    }
    return previousSibling.position + 1;
  }

  if (previousSibling) {
    return previousSibling.position + 1024;
  }

  if (nextSibling) {
    return nextSibling.position - 1024;
  }

  return 0;
}

function applyOptimisticMovesToNodes(nodes: NodeDoc[], moves: OptimisticNodeMove[]) {
  const nextNodes = nodes.map((node) => ({ ...node }));
  const nodeById = new Map(nextNodes.map((node) => [node._id as string, node]));

  for (const move of moves) {
    const node = nodeById.get(move.nodeId as string);
    if (!node) {
      continue;
    }

    const pageId = move.pageId ?? (node.pageId as Id<"pages">);
    const parentNodeId =
      move.parentNodeId === undefined
        ? ((node.parentNodeId as Id<"nodes"> | null) ?? null)
        : move.parentNodeId;
    const afterNodeId = move.afterNodeId ?? null;
    const position = computeOptimisticNodePosition(
      nextNodes,
      move.nodeId,
      pageId,
      parentNodeId,
      afterNodeId,
    );

    node.pageId = pageId;
    node.parentNodeId = parentNodeId;
    node.position = position;
    node.updatedAt = getTimestamp();
  }

  return nextNodes;
}

function buildOptimisticCreateTempIds(
  entries: OptimisticNodeCreateInput[],
  createdAt: number,
) {
  return entries.map(
    (entry, index) =>
      `optimistic-node:${entry.clientId ?? `${createdAt}:${index}`}` as Id<"nodes">,
  );
}

function sortNodesByPosition(nodes: NodeDoc[]) {
  return [...nodes].sort((left, right) => {
    if (left.position !== right.position) {
      return left.position - right.position;
    }
    return left.createdAt - right.createdAt;
  });
}

function applyOptimisticCreatesToNodes(
  nodes: NodeDoc[],
  pageId: Id<"pages">,
  entries: OptimisticNodeCreateInput[],
  tempNodeIds: Id<"nodes">[],
  createdAt: number,
) {
  if (entries.length === 0) {
    return nodes;
  }

  const nextNodes = [...nodes];
  const createdNodeIdsByClientId = new Map<string, Id<"nodes">>();
  let lastCreatedId: Id<"nodes"> | null = null;
  let lastParentNodeId: Id<"nodes"> | null = null;

  for (const [index, entry] of entries.entries()) {
    const tempNodeId = tempNodeIds[index]!;
    const parentNodeId =
      entry.parentClientId !== undefined
        ? (createdNodeIdsByClientId.get(entry.parentClientId) ?? null)
        : (entry.parentNodeId ?? null);
    const afterNodeId =
      entry.afterClientId !== undefined
        ? (createdNodeIdsByClientId.get(entry.afterClientId) ?? null)
        : entry.afterNodeId !== undefined
          ? (entry.afterNodeId ?? null)
          : lastParentNodeId === parentNodeId
            ? lastCreatedId
            : null;
    const position = computeOptimisticNodePosition(
      nextNodes,
      tempNodeId,
      pageId,
      parentNodeId,
      afterNodeId,
    );
    const kind = entry.kind ?? "note";
    const nextNode: NodeDoc = {
      _id: tempNodeId,
      _creationTime: createdAt,
      pageId,
      parentNodeId,
      position,
      text: entry.text?.trim() || "",
      kind,
      taskStatus: kind === "task" ? (entry.taskStatus ?? "todo") : null,
      priority: null,
      dueAt: kind === "task" ? (entry.dueAt ?? null) : null,
      dueEndAt: kind === "task" ? (entry.dueEndAt ?? null) : null,
      archived: false,
      sourceMeta: {
        sourceType: "manual",
        taskKindLocked: entry.lockKind ?? false,
        noteCompleted: kind === "note" ? (entry.noteCompleted ?? false) : false,
        recurrenceFrequency: kind === "task" ? (entry.recurrenceFrequency ?? null) : null,
      },
      createdAt,
      updatedAt: createdAt,
    };

    nextNodes.push(nextNode);
    if (entry.clientId) {
      createdNodeIdsByClientId.set(entry.clientId, tempNodeId);
    }
    lastCreatedId = tempNodeId;
    lastParentNodeId = parentNodeId;
  }

  return sortNodesByPosition(nextNodes);
}

export function applyOptimisticPageRename(
  localStore: OptimisticLocalStore,
  args: {
    ownerKey: string;
    pageId: Id<"pages">;
    title: string;
  },
) {
  patchPageInWorkspaceQueries(localStore, args.ownerKey, args.pageId, (page) => ({
    ...page,
    title: args.title.trim() || "Untitled",
    updatedAt: getTimestamp(),
  }));
}

export function applyOptimisticPlannerScanExcluded(
  localStore: OptimisticLocalStore,
  args: {
    ownerKey: string;
    pageId: Id<"pages">;
    excluded: boolean;
  },
) {
  patchPageInWorkspaceQueries(localStore, args.ownerKey, args.pageId, (page) => {
    const sourceMeta = getSourceMeta(page);
    sourceMeta.excludeFromPlannerScan = args.excluded;
    return {
      ...page,
      sourceMeta,
      updatedAt: getTimestamp(),
    };
  });

  if (args.excluded) {
    updateSimpleTaskViewQueries(localStore, args.ownerKey, (groups) =>
      groups.filter((group) => group.page._id !== args.pageId),
    );
  }
}

export function applyOptimisticPagePinnedInAllSidebar(
  localStore: OptimisticLocalStore,
  args: {
    ownerKey: string;
    pageId: Id<"pages">;
    pinned: boolean;
  },
) {
  patchPageInWorkspaceQueries(localStore, args.ownerKey, args.pageId, (page) => {
    const sourceMeta = getSourceMeta(page);
    sourceMeta.pinnedInAllSidebar = args.pinned;
    return {
      ...page,
      sourceMeta,
      updatedAt: getTimestamp(),
    };
  });
}

export function applyOptimisticNodeUpdate(
  localStore: OptimisticLocalStore,
  args: OptimisticNodeUpdateArgs,
) {
  patchNodeInWorkspaceQueries(localStore, args.ownerKey, args.nodeId, (node) =>
    applyNodeUpdatePatch(node, args),
  );
}

export function applyOptimisticNodeBatchUpdates(
  localStore: OptimisticLocalStore,
  args: OptimisticNodeBatchUpdateArgs,
) {
  for (const update of args.updates) {
    applyOptimisticNodeUpdate(localStore, { ...update, ownerKey: args.ownerKey });
  }
}

export function applyOptimisticNodeMoves(
  localStore: OptimisticLocalStore,
  args: {
    ownerKey: string;
    moves: OptimisticNodeMove[];
  },
) {
  updatePageTreeQueries(localStore, args.ownerKey, (result) => ({
    ...result,
    nodes: applyOptimisticMovesToNodes(result.nodes, args.moves),
  }));
  updateSidebarTreeQueries(localStore, args.ownerKey, (result) => ({
    ...result,
    nodes: applyOptimisticMovesToNodes(result.nodes, args.moves),
  }));
  updateSimpleTaskViewQueries(localStore, args.ownerKey, (groups) =>
    groups.map((group) => ({
      ...group,
      nodes: applyOptimisticMovesToNodes(group.nodes, args.moves),
    })),
  );
}

export function applyOptimisticNodeCreates(
  localStore: OptimisticLocalStore,
  args: {
    ownerKey: string;
    pageId: Id<"pages">;
    nodes: OptimisticNodeCreateInput[];
  },
) {
  const createdAt = getTimestamp();
  const tempNodeIds = buildOptimisticCreateTempIds(args.nodes, createdAt);

  updatePageTreeQueries(localStore, args.ownerKey, (result) =>
    result.page._id === args.pageId
      ? {
          ...result,
          nodes: applyOptimisticCreatesToNodes(
            result.nodes,
            args.pageId,
            args.nodes,
            tempNodeIds,
            createdAt,
          ),
        }
      : result,
  );
  updateSidebarTreeQueries(localStore, args.ownerKey, (result) =>
    result.page._id === args.pageId
      ? {
          ...result,
          nodes: applyOptimisticCreatesToNodes(
            result.nodes,
            args.pageId,
            args.nodes,
            tempNodeIds,
            createdAt,
          ),
        }
      : result,
  );
  updateSimpleTaskViewQueries(localStore, args.ownerKey, (groups) =>
    groups.map((group) =>
      group.page._id === args.pageId
        ? {
            ...group,
            nodes: applyOptimisticCreatesToNodes(
              group.nodes,
              args.pageId,
              args.nodes,
              tempNodeIds,
              createdAt,
            ),
          }
        : group,
    ),
  );
}

function applyOptimisticSplitToNodes(nodes: NodeDoc[], args: OptimisticNodeSplitArgs) {
  const sourceNode = nodes.find((node) => node._id === args.nodeId) ?? null;
  if (!sourceNode) {
    return nodes;
  }

  const updatedNodes = patchNodeList(nodes, args.nodeId, (node) =>
    applyNodeUpdatePatch(node, {
      text: args.headText,
      kind: args.headKind,
      taskStatus: args.headKind === "task" ? (args.headTaskStatus ?? "todo") : null,
    }),
  );

  return applyOptimisticCreatesToNodes(
    updatedNodes,
    sourceNode.pageId,
    [
      {
        clientId: `split:${args.nodeId}`,
        parentNodeId: (sourceNode.parentNodeId as Id<"nodes"> | null) ?? null,
        afterNodeId: args.nodeId,
        text: args.tailText,
        kind: args.tailKind,
        taskStatus: args.tailKind === "task" ? (args.tailTaskStatus ?? "todo") : null,
      },
    ],
    [`optimistic-node:split:${args.nodeId}` as Id<"nodes">],
    getTimestamp(),
  );
}

export function applyOptimisticNodeSplit(
  localStore: OptimisticLocalStore,
  args: OptimisticNodeSplitArgs,
) {
  updatePageTreeQueries(localStore, args.ownerKey, (result) => ({
    ...result,
    nodes: applyOptimisticSplitToNodes(result.nodes, args),
  }));
  updateSidebarTreeQueries(localStore, args.ownerKey, (result) => ({
    ...result,
    nodes: applyOptimisticSplitToNodes(result.nodes, args),
  }));
  updateSimpleTaskViewQueries(localStore, args.ownerKey, (groups) =>
    groups.map((group) => ({
      ...group,
      nodes: applyOptimisticSplitToNodes(group.nodes, args),
    })),
  );
}

export function applyOptimisticPlannerTaskCompletion(
  localStore: OptimisticLocalStore,
  args: OptimisticPlannerTaskCompletionArgs,
) {
  patchNodeInWorkspaceQueries(localStore, args.ownerKey, args.plannerNodeId, (node) =>
    applyNodeUpdatePatch(node, {
      taskStatus: node.kind === "task" ? "done" : undefined,
      noteCompleted: node.kind === "note" ? true : undefined,
    }),
  );
}

export function applyOptimisticNodeTreeArchive(
  localStore: OptimisticLocalStore,
  args: {
    ownerKey: string;
    rootNodeIds: Id<"nodes">[];
  },
) {
  updatePageTreeQueries(localStore, args.ownerKey, (result) => {
    const removedNodeIds = collectSubtreeNodeIds(result.nodes, args.rootNodeIds);
    return {
      ...result,
      nodes: result.nodes.filter((node) => !removedNodeIds.has(node._id as string)),
      nodeBacklinkCounts: removeArchivedNodesFromCounts(result.nodeBacklinkCounts, removedNodeIds),
    };
  });
  updateSidebarTreeQueries(localStore, args.ownerKey, (result) => {
    const removedNodeIds = collectSubtreeNodeIds(result.nodes, args.rootNodeIds);
    return {
      ...result,
      nodes: result.nodes.filter((node) => !removedNodeIds.has(node._id as string)),
      nodeBacklinkCounts: removeArchivedNodesFromCounts(result.nodeBacklinkCounts, removedNodeIds),
    };
  });
  updateSimpleTaskViewQueries(localStore, args.ownerKey, (groups) =>
    groups.map((group) => {
      const removedNodeIds = collectSubtreeNodeIds(group.nodes, args.rootNodeIds);
      return {
        ...group,
        nodes: group.nodes.filter((node) => !removedNodeIds.has(node._id as string)),
      };
    }),
  );
}
