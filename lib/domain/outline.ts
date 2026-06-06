import { sortByPosition } from "./positions";

export type OutlineNodeLike = {
  _id: string;
  pageId: string;
  parentNodeId: string | null;
  position: number;
  text: string;
  kind: string;
  taskStatus: string | null;
  priority: string | null;
  dueAt: number | null;
  dueEndAt?: number | null;
  archived: boolean;
  sourceMeta?: Record<string, unknown> | null;
};

export type OutlineTreeNode<T extends OutlineNodeLike> = T & {
  children: Array<OutlineTreeNode<T>>;
};

export function buildOutlineTree<T extends OutlineNodeLike>(nodes: T[]) {
  const sorted = sortByPosition(nodes);
  const byId = new Map<string, OutlineTreeNode<T>>();
  const roots: Array<OutlineTreeNode<T>> = [];

  for (const node of sorted) {
    byId.set(node._id, { ...node, children: [] });
  }

  for (const node of sorted) {
    const treeNode = byId.get(node._id)!;
    if (node.parentNodeId) {
      const parent = byId.get(node.parentNodeId);
      if (parent) {
        parent.children.push(treeNode);
        continue;
      }
    }
    roots.push(treeNode);
  }

  return roots;
}

export function flattenOutlineTree<T extends OutlineNodeLike>(
  roots: Array<OutlineTreeNode<T>>,
) {
  const flattened: Array<OutlineTreeNode<T>> = [];

  const visit = (node: OutlineTreeNode<T>) => {
    flattened.push(node);
    for (const child of sortByPosition(node.children)) {
      visit(child);
    }
  };

  for (const root of sortByPosition(roots)) {
    visit(root);
  }

  return flattened;
}

function findOutlineNodePath<T extends OutlineNodeLike>(
  nodes: Array<OutlineTreeNode<T>>,
  targetNodeId: string,
): Array<OutlineTreeNode<T>> | null {
  for (const node of nodes) {
    if (node._id === targetNodeId) {
      return [node];
    }

    const childPath = findOutlineNodePath(node.children, targetNodeId);
    if (childPath) {
      return [node, ...childPath];
    }
  }

  return null;
}

export function buildFocusedOutlineContext<T extends OutlineNodeLike>(
  roots: Array<OutlineTreeNode<T>>,
  focusedNodeId: string,
) {
  const path = findOutlineNodePath(roots, focusedNodeId);
  if (!path || path.length === 0) {
    return {
      roots: [] as Array<OutlineTreeNode<T>>,
      focusedNode: null as OutlineTreeNode<T> | null,
      parentNode: null as OutlineTreeNode<T> | null,
      rootParentNodeId: null as string | null,
    };
  }

  const focusedNode = path[path.length - 1]!;
  const parentNode = path.length > 1 ? path[path.length - 2]! : null;
  const focusedNodeClone = {
    ...focusedNode,
    children: [...focusedNode.children],
  };

  if (!parentNode) {
    return {
      roots: [focusedNodeClone],
      focusedNode,
      parentNode,
      rootParentNodeId: null,
    };
  }

  const parentNodeClone = {
    ...parentNode,
    children: [focusedNodeClone],
  };

  return {
    roots: [parentNodeClone],
    focusedNode,
    parentNode,
    rootParentNodeId: parentNode.parentNodeId,
  };
}

export function getAncestorChain<T extends OutlineNodeLike>(
  nodes: T[],
  nodeId: string,
) {
  const byId = new Map(nodes.map((node) => [node._id, node]));
  const chain: T[] = [];
  let cursor = byId.get(nodeId) ?? null;

  while (cursor?.parentNodeId) {
    const parent = byId.get(cursor.parentNodeId);
    if (!parent) {
      break;
    }
    chain.unshift(parent);
    cursor = parent;
  }

  return chain;
}
