import slugify from "slugify";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type DatabaseReader,
  type DatabaseWriter,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey, isOwnerKeyValid } from "./lib/auth";
import {
  buildUniquePageSlug,
  computeNodePosition,
  deleteNodeTree,
  enqueueNodeEmbeddingRefresh,
  enqueueNodeAiWork,
  enqueuePageRootEmbeddingRefresh,
  listPageNodes,
  setNodeTreeArchivedState,
  syncLinksForNode,
} from "./lib/workspace";
import {
  EMBEDDING_REBUILD_STATE_KEY,
  buildEmbeddingRebuildStatus,
  getEmbeddingRebuildState,
} from "./lib/embeddingRebuild";
import { nodeKindValidator, nullableNodeIdValidator, priorityValidator, recurrenceFrequencyValidator, taskStatusValidator } from "./lib/validators";
import {
  PLANNER_TEMPLATE_SLOT,
  buildPlannerChatPromptContext,
  ensurePlannerSections,
  findPlannerSectionNode,
  getPlannerDayRoots,
  getPlannerLinkedSourceTaskId,
  getPlannerStartDate,
  isPlannerPage,
  isPlannerScanExcludedPage,
  isTaskSourcePage,
  listEligiblePlannerSourceTasks,
} from "./lib/planner";
import { replaceLiteralOccurrences } from "../lib/domain/findReplace";
import { getEffectiveTaskDueDateRange } from "../lib/domain/planner";
import {
  collectRootSubtreeLines,
  shouldGenerateEmbeddingForNodeText,
} from "../lib/domain/embeddings";
import {
  extractLinkMatches,
  extractLinks,
  getExplicitWikiLinkPreviewText,
  replaceLinkMarkupWithLabels,
  rewriteMatchingPageWikiLinks,
} from "../lib/domain/links";
import { extractTagMatches } from "../lib/domain/tags";

function getTimestamp() {
  return Date.now();
}

const MAX_BACKLINK_COUNT_NODE_BATCH = 250;
const MAX_PAGE_TREE_NODES = 1200;
const MAX_PAGE_TREE_NODE_TEXT_CHARS = 250_000;
const MAX_PAGE_TREE_BACKLINKS = 1200;
const MAX_NODE_AI_ANCESTOR_DEPTH = 40;
const MAX_NODE_AI_SUBTREE_NODES = 2000;
const PAGE_DELETE_NODE_BATCH_SIZE = 100;
const PAGE_DELETE_LINK_BATCH_SIZE = 200;
const PAGE_DELETE_MESSAGE_BATCH_SIZE = 200;
const FIND_REPLACE_PREVIEW_LIMIT = 40;
const FIND_REPLACE_BATCH_SIZE = 50;
const EMBEDDING_REBUILD_BATCH_SIZE = 200;

async function collectEmbeddingJobCountsForRun(
  db: DatabaseReader,
  runId: string,
) {
  let queued = 0;
  let running = 0;
  let completed = 0;
  let error = 0;
  let lastError: string | null = null;
  let latestErrorUpdatedAt = -1;

  for await (const job of db
    .query("embeddingJobs")
    .withIndex("by_rebuildRunId", (query) => query.eq("rebuildRunId", runId))) {
    if (job.status === "queued") {
      queued += 1;
    } else if (job.status === "running") {
      running += 1;
    } else if (job.status === "completed") {
      completed += 1;
    } else if (job.status === "error") {
      error += 1;
      if (job.lastError && job.updatedAt >= latestErrorUpdatedAt) {
        latestErrorUpdatedAt = job.updatedAt;
        lastError = job.lastError;
      }
    }
  }

  return {
    queued,
    running,
    completed,
    error,
    lastError,
  };
}

async function collectNodeAncestorTexts(
  db: DatabaseReader,
  parentNodeId: Id<"nodes"> | null,
) {
  const ancestors: string[] = [];
  let currentParentId = parentNodeId;
  let depth = 0;

  while (currentParentId && depth < MAX_NODE_AI_ANCESTOR_DEPTH) {
    const parent = await db.get(currentParentId);
    if (!parent) {
      break;
    }

    ancestors.unshift(parent.text);
    currentParentId = parent.parentNodeId;
    depth += 1;
  }

  return ancestors;
}

async function collectCappedRootSubtreeLines(
  db: DatabaseReader,
  rootNode: Doc<"nodes">,
) {
  const collected: Array<{
    _id: string;
    parentNodeId: string | null;
    position: number;
    text: string;
    kind: string;
    taskStatus: string | null;
  }> = [];
  const queue: Array<Id<"nodes">> = [rootNode._id];

  while (queue.length > 0 && collected.length < MAX_NODE_AI_SUBTREE_NODES) {
    const parentNodeId = queue.shift()!;
    const children = await db
      .query("nodes")
      .withIndex("by_page_parent_position", (query) =>
        query.eq("pageId", rootNode.pageId).eq("parentNodeId", parentNodeId),
      )
      .collect();

    for (const child of children) {
      if (child.archived) {
        continue;
      }
      if (collected.length >= MAX_NODE_AI_SUBTREE_NODES) {
        break;
      }
      collected.push({
        _id: child._id,
        parentNodeId: child.parentNodeId,
        position: child.position,
        text: child.text,
        kind: child.kind,
        taskStatus: child.taskStatus,
      });
      queue.push(child._id);
    }
  }

  return collectRootSubtreeLines(rootNode._id, [
    {
      _id: rootNode._id,
      parentNodeId: rootNode.parentNodeId,
      position: rootNode.position,
      text: rootNode.text,
      kind: rootNode.kind,
      taskStatus: rootNode.taskStatus,
    },
    ...collected,
  ]);
}

async function listPageNodesForTree(
  ctx: QueryCtx,
  pageId: Id<"pages">,
) {
  const fetchedNodes = await ctx.db
    .query("nodes")
    .withIndex("by_page_archived", (query) =>
      query.eq("pageId", pageId).eq("archived", false),
    )
    .take(MAX_PAGE_TREE_NODES + 1);

  const nodes: Doc<"nodes">[] = [];
  let textChars = 0;

  for (const node of fetchedNodes) {
    const nextTextChars = textChars + node.text.length;
    if (nodes.length >= MAX_PAGE_TREE_NODES || nextTextChars > MAX_PAGE_TREE_NODE_TEXT_CHARS) {
      return {
        nodes,
        truncated: true,
      };
    }

    nodes.push(node);
    textChars = nextTextChars;
  }

  return {
    nodes,
    truncated: fetchedNodes.length > MAX_PAGE_TREE_NODES,
  };
}

async function listPageBacklinksForTree(
  ctx: QueryCtx,
  pageId: Id<"pages">,
) {
  const backlinks = await ctx.db
    .query("links")
    .withIndex("by_target_page", (query) => query.eq("targetPageId", pageId))
    .take(MAX_PAGE_TREE_BACKLINKS + 1);

  return {
    backlinks: backlinks.slice(0, MAX_PAGE_TREE_BACKLINKS),
    truncated: backlinks.length > MAX_PAGE_TREE_BACKLINKS,
  };
}

function getPageSourceMeta(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return page && typeof page.sourceMeta === "object" && page.sourceMeta
    ? (page.sourceMeta as Record<string, unknown>)
    : {};
}

function isSidebarSpecialPage(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getPageSourceMeta(page).specialPage === "sidebar";
}

function isPagePendingDeletion(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getPageSourceMeta(page).deletingForever === true;
}

async function takePageDeletionNodeBatch(
  ctx: QueryCtx,
  pageId: Id<"pages">,
) {
  const activeNodes = await ctx.db
    .query("nodes")
    .withIndex("by_page_archived", (query) =>
      query.eq("pageId", pageId).eq("archived", false),
    )
    .take(PAGE_DELETE_NODE_BATCH_SIZE);

  if (activeNodes.length > 0) {
    return activeNodes;
  }

  return await ctx.db
    .query("nodes")
    .withIndex("by_page_archived", (query) =>
      query.eq("pageId", pageId).eq("archived", true),
    )
    .take(PAGE_DELETE_NODE_BATCH_SIZE);
}

function normalizeLinkSearchQuery(value: string) {
  return value.trim().toLowerCase();
}

function linkSearchScore(text: string, query: string) {
  const normalizedText = text.toLowerCase();
  if (query.length === 0) {
    return 0;
  }

  if (normalizedText.startsWith(query)) {
    return 0;
  }

  const wordStartPattern = new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (wordStartPattern.test(normalizedText)) {
    return 1;
  }

  if (normalizedText.includes(query)) {
    return 2;
  }

  return Number.POSITIVE_INFINITY;
}

function formatNodeForKnowledgeContext(
  node: Pick<Doc<"nodes">, "text" | "kind" | "taskStatus">,
  textOverride?: string,
) {
  const text = (textOverride ?? node.text).trim();
  if (text.length === 0 || text === ".") {
    return "";
  }

  if (node.kind === "task") {
    return `${node.taskStatus === "done" ? "[x]" : "[ ]"} ${text}`;
  }

  return text;
}

async function resolveKnowledgeContextText(
  db: DatabaseReader,
  text: string,
  nodeMap: Map<string, Doc<"nodes">>,
  resolvedNodeTextCache: Map<string, string>,
) {
  async function getResolvedNodeText(nodeRef: string) {
    const cached = resolvedNodeTextCache.get(nodeRef);
    if (cached !== undefined) {
      return cached;
    }

    const node =
      nodeMap.get(nodeRef) ??
      (await db.get(nodeRef as Id<"nodes">));
    const resolved =
      node
        ? replaceLinkMarkupWithLabels(node.text).trim() || node.text.trim()
        : `node:${nodeRef}`;
    resolvedNodeTextCache.set(nodeRef, resolved);
    return resolved;
  }

  const matches = extractLinkMatches(text);
  let cursor = 0;
  let nextText = "";

  for (const match of matches) {
    if (match.start > cursor) {
      nextText += text.slice(cursor, match.start);
    }

    if (match.link.kind === "node") {
      const previewText =
        match.link.label.startsWith("[[")
          ? getExplicitWikiLinkPreviewText(match.link.label)
          : "";
      nextText +=
        previewText.length > 0
          ? previewText
          : await getResolvedNodeText(match.link.targetNodeRef);
    } else {
      nextText += text.slice(match.start, match.end);
    }
    cursor = match.end;
  }

  if (cursor < text.length) {
    nextText += text.slice(cursor);
  }

  const normalizedLinkText = replaceLinkMarkupWithLabels(nextText);
  const rawNodeReferencePattern = /(^|[^A-Za-z0-9_])(node:([a-zA-Z0-9_-]+))/g;
  let rawCursor = 0;
  let finalText = "";

  for (const match of normalizedLinkText.matchAll(rawNodeReferencePattern)) {
    const start = match.index ?? 0;
    const prefix = match[1] ?? "";
    const fullMatch = match[2] ?? "";
    const nodeRef = match[3] ?? "";

    if (start > rawCursor) {
      finalText += normalizedLinkText.slice(rawCursor, start);
    }

    finalText += prefix;
    finalText += nodeRef.length > 0 ? await getResolvedNodeText(nodeRef) : fullMatch;
    rawCursor = start + prefix.length + fullMatch.length;
  }

  if (rawCursor < normalizedLinkText.length) {
    finalText += normalizedLinkText.slice(rawCursor);
  }

  return finalText;
}

function groupNodesByParent(nodes: Doc<"nodes">[]) {
  const sortedNodes = [...nodes].sort((left, right) => left.position - right.position);
  const childrenByParent = new Map<string | null, Doc<"nodes">[]>();

  for (const node of sortedNodes) {
    const key = (node.parentNodeId as string | null) ?? null;
    const bucket = childrenByParent.get(key) ?? [];
    bucket.push(node);
    childrenByParent.set(key, bucket);
  }

  return childrenByParent;
}

function buildOutlineLines(
  childrenByParent: Map<string | null, Doc<"nodes">[]>,
  parentNodeId: string | null,
  depth: number,
  resolvedTextById?: Map<string, string>,
) {
  const lines: string[] = [];
  const children = childrenByParent.get(parentNodeId) ?? [];

  for (const child of children) {
    const formatted = formatNodeForKnowledgeContext(
      child,
      resolvedTextById?.get(child._id as string),
    );
    if (formatted.length > 0) {
      lines.push(`${"  ".repeat(depth)}${formatted}`);
    }
    lines.push(
      ...buildOutlineLines(childrenByParent, child._id as string, depth + 1, resolvedTextById),
    );
  }

  return lines;
}

function buildNodeSubtreeLines(
  childrenByParent: Map<string | null, Doc<"nodes">[]>,
  currentNode: Doc<"nodes"> | null,
  depth: number,
  resolvedTextById?: Map<string, string>,
) {
  if (!currentNode) {
    return [];
  }

  const lines: string[] = [];
  const formatted = formatNodeForKnowledgeContext(
    currentNode,
    resolvedTextById?.get(currentNode._id as string),
  );
  if (formatted.length > 0) {
    lines.push(`${"  ".repeat(depth)}${formatted}`);
  }

  for (const child of childrenByParent.get(currentNode._id as string) ?? []) {
    lines.push(...buildNodeSubtreeLines(childrenByParent, child, depth + 1, resolvedTextById));
  }

  return lines;
}

function buildNodeAncestorPath(
  node: Doc<"nodes">,
  nodeMap: Map<string, Doc<"nodes">>,
  resolvedTextById?: Map<string, string>,
) {
  const labels: string[] = [];
  let currentNode: Doc<"nodes"> | null = node;

  while (currentNode) {
    const formatted = formatNodeForKnowledgeContext(
      currentNode,
      resolvedTextById?.get(currentNode._id as string),
    );
    if (formatted.length > 0) {
      labels.unshift(formatted);
    }

    if (!currentNode.parentNodeId) {
      break;
    }

    currentNode = nodeMap.get(currentNode.parentNodeId as string) ?? null;
  }

  return labels.join(" > ");
}

function filterNodesForKnowledgeContext(
  page: Doc<"pages">,
  nodes: Doc<"nodes">[],
) {
  if (!isPlannerPage(page)) {
    return nodes;
  }

  const templateSection = findPlannerSectionNode(nodes, PLANNER_TEMPLATE_SLOT);
  if (!templateSection) {
    return nodes;
  }

  const childrenByParent = groupNodesByParent(nodes);
  const excludedIds = new Set<string>();
  const queue: string[] = [templateSection._id as string];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (excludedIds.has(currentId)) {
      continue;
    }
    excludedIds.add(currentId);
    for (const child of childrenByParent.get(currentId) ?? []) {
      queue.push(child._id as string);
    }
  }

  return nodes.filter((node) => !excludedIds.has(node._id as string));
}

async function buildPageKnowledgeContextEntry(
  ctx: QueryCtx,
  page: Doc<"pages">,
  options?: {
    omitScheduledTaskSubtrees?: boolean;
    section?: "linked" | "planner" | "backlog";
  },
) {
  const nodes = await listPageNodes(ctx.db, page._id);
  let visibleNodes = filterNodesForKnowledgeContext(
    page,
    nodes.filter((node) => !node.archived),
  );
  if (options?.omitScheduledTaskSubtrees) {
    const nodeMap = new Map(visibleNodes.map((node) => [node._id as string, node]));
    const childrenByParent = groupNodesByParent(visibleNodes);
    const excludedIds = new Set<string>();
    const queue: string[] = [];

    for (const node of visibleNodes) {
      if (node.kind !== "task") {
        continue;
      }

      const effectiveDueDateRange = getEffectiveTaskDueDateRange(node, nodeMap);
      if (!effectiveDueDateRange.dueAt) {
        continue;
      }

      queue.push(node._id as string);
    }

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (excludedIds.has(currentId)) {
        continue;
      }
      excludedIds.add(currentId);
      for (const child of childrenByParent.get(currentId) ?? []) {
        queue.push(child._id as string);
      }
    }

    visibleNodes = visibleNodes.filter((node) => !excludedIds.has(node._id as string));
  }
  const nodeMap = new Map(visibleNodes.map((node) => [node._id as string, node]));
  const resolvedNodeTextCache = new Map<string, string>();
  const resolvedTextById = new Map<string, string>();
  for (const node of visibleNodes) {
    resolvedTextById.set(
      node._id as string,
      await resolveKnowledgeContextText(ctx.db, node.text, nodeMap, resolvedNodeTextCache),
    );
  }
  const childrenByParent = groupNodesByParent(visibleNodes);
  const content = buildOutlineLines(childrenByParent, null, 0, resolvedTextById).join("\n");
  const representativeNode =
    visibleNodes.find(
      (node) =>
        formatNodeForKnowledgeContext(node, resolvedTextById.get(node._id as string)).length > 0,
    ) ??
    visibleNodes[0] ??
    null;

  return {
    page,
    representativeNode,
    content,
    section: options?.section ?? "linked",
  };
}

const nodeCreateInputValidator = v.object({
  clientId: v.optional(v.string()),
  parentNodeId: v.optional(nullableNodeIdValidator),
  parentClientId: v.optional(v.string()),
  afterNodeId: v.optional(nullableNodeIdValidator),
  afterClientId: v.optional(v.string()),
  text: v.optional(v.string()),
  kind: v.optional(nodeKindValidator),
  lockKind: v.optional(v.boolean()),
  noteCompleted: v.optional(v.boolean()),
  taskStatus: v.optional(taskStatusValidator),
  dueAt: v.optional(v.union(v.number(), v.null())),
  dueEndAt: v.optional(v.union(v.number(), v.null())),
  recurrenceFrequency: v.optional(recurrenceFrequencyValidator),
});

async function filterVisibleLinks(ctx: QueryCtx, links: Doc<"links">[]) {
  const sourceNodeIds = [
    ...new Set(
      links
        .map((link) => link.sourceNodeId)
        .filter(Boolean) as Id<"nodes">[],
    ),
  ];
  const sourcePageIds = [
    ...new Set(
      links
        .map((link) => link.sourcePageId)
        .filter(Boolean) as Id<"pages">[],
    ),
  ];

  const sourceNodes = await Promise.all(sourceNodeIds.map((nodeId) => ctx.db.get(nodeId)));
  const sourcePages = await Promise.all(sourcePageIds.map((pageId) => ctx.db.get(pageId)));
  const visibleNodeIds = new Set(
    sourceNodes.filter((node) => node && !node.archived).map((node) => node!._id),
  );
  const visiblePageIds = new Set(
    sourcePages.filter((page) => page && !page.archived).map((page) => page!._id),
  );

  return links.filter((link) => {
    if (link.sourceNodeId) {
      return visibleNodeIds.has(link.sourceNodeId);
    }

    if (link.sourcePageId) {
      return visiblePageIds.has(link.sourcePageId);
    }

    return true;
  });
}

async function listScopedFindReplaceNodes(
  db: DatabaseReader | DatabaseWriter,
  pageId?: Id<"pages">,
  updatedBefore?: number,
) {
  if (pageId) {
    const page = await db.get(pageId);
    if (!page || isPagePendingDeletion(page)) {
      return {
        pagesById: new Map<Id<"pages">, Doc<"pages">>(),
        nodes: [] as Doc<"nodes">[],
      };
    }

    const nodes = (await db
      .query("nodes")
      .withIndex("by_page_archived", (query) =>
        query.eq("pageId", pageId).eq("archived", false),
      )
      .collect())
      .filter((node) => updatedBefore === undefined || node.updatedAt <= updatedBefore)
      .sort((left, right) => left.position - right.position);

    return {
      pagesById: new Map([[page._id, page]]),
      nodes,
    };
  }

  const pages = (await db
    .query("pages")
    .withIndex("by_archived_position", (query) => query.eq("archived", false))
    .collect())
    .filter((page) => !isPagePendingDeletion(page))
    .sort((left, right) => left.position - right.position);
  const pagesById = new Map(pages.map((page) => [page._id, page]));
  const nodes: Doc<"nodes">[] = [];

  for (const page of pages) {
    const pageNodes = (await db
      .query("nodes")
      .withIndex("by_page_archived", (query) =>
        query.eq("pageId", page._id).eq("archived", false),
      )
      .collect())
      .filter((node) => updatedBefore === undefined || node.updatedAt <= updatedBefore)
      .sort((left, right) => left.position - right.position);
    nodes.push(...pageNodes);
  }

  return {
    pagesById,
    nodes,
  };
}

async function buildVisibleNodeBacklinkCounts(
  ctx: QueryCtx,
  nodeIds: Id<"nodes">[],
  options: {
    excludeSourcePageId?: Id<"pages"> | null;
  } = {},
) {
  if (nodeIds.length > MAX_BACKLINK_COUNT_NODE_BATCH) {
    return {};
  }

  const counts = await Promise.all(
    [...new Set(nodeIds)].map(async (nodeId) => {
      const links = await listNodeBacklinks(ctx, nodeId);
      const visibleLinks = (await filterVisibleLinks(ctx, links)).filter(
        (link) => link.sourcePageId !== options.excludeSourcePageId,
      );
      return [nodeId as string, visibleLinks.length] as const;
    }),
  );

  return Object.fromEntries(
    counts.filter(([, count]) => count > 0),
  ) as Record<string, number>;
}

async function listNodeBacklinks(
  ctx: QueryCtx,
  nodeId: Id<"nodes">,
) {
  const [resolvedLinks, referencedLinks] = await Promise.all([
    ctx.db
      .query("links")
      .withIndex("by_target_node", (query) => query.eq("targetNodeId", nodeId))
      .collect(),
    ctx.db
      .query("links")
      .withIndex("by_target_node_ref", (query) =>
        query.eq("targetNodeRef", nodeId as string),
      )
      .collect(),
  ]);

  return [...new Map(
    [...resolvedLinks, ...referencedLinks]
      .filter((link) => link.kind === "node")
      .map((link) => [link._id, link]),
  ).values()];
}

function buildLocalNodeBacklinkCounts(nodes: Doc<"nodes">[]) {
  const pageNodeIds = new Set(nodes.map((node) => node._id as string));
  const counts = new Map<string, number>();

  for (const node of nodes) {
    for (const link of extractLinks(node.text)) {
      if (link.kind !== "node" || !pageNodeIds.has(link.targetNodeRef)) {
        continue;
      }

      counts.set(link.targetNodeRef, (counts.get(link.targetNodeRef) ?? 0) + 1);
    }
  }

  return Object.fromEntries(
    [...counts.entries()].filter(([, count]) => count > 0),
  ) as Record<string, number>;
}

function mergeNodeBacklinkCounts(
  ...countMaps: Array<Record<string, number>>
) {
  const merged = new Map<string, number>();

  for (const countMap of countMaps) {
    for (const [nodeId, count] of Object.entries(countMap)) {
      merged.set(nodeId, (merged.get(nodeId) ?? 0) + count);
    }
  }

  return Object.fromEntries(merged) as Record<string, number>;
}

export const listPages = query({
  args: {
    ownerKey: v.string(),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    if (args.includeArchived) {
      const [activePages, archivedPages] = await Promise.all([
        ctx.db
          .query("pages")
          .withIndex("by_archived_position", (query) =>
            query.eq("archived", false),
          )
          .collect(),
        ctx.db
          .query("pages")
          .withIndex("by_archived_position", (query) =>
            query.eq("archived", true),
          )
          .collect(),
      ]);

      return [...activePages, ...archivedPages].filter(
        (page) => !isSidebarSpecialPage(page) && !isPagePendingDeletion(page),
      );
    }

    return (await ctx.db
      .query("pages")
      .withIndex("by_archived_position", (query) =>
        query.eq("archived", false),
      )
      .collect()).filter(
      (page) => !isSidebarSpecialPage(page) && !isPagePendingDeletion(page),
    );
  },
});

export const getSidebarTree = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const pages = await ctx.db.query("pages").collect();
    const sidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;
    if (!sidebarPage) {
      return null;
    }

    const nodes = await listPageNodes(ctx.db, sidebarPage._id);
    const activeSidebarNodeIds = new Set(nodes.map((node) => node._id as Id<"nodes">));
    const links = await ctx.db
      .query("links")
      .withIndex("by_source_page", (query) => query.eq("sourcePageId", sidebarPage._id))
      .collect();
    const visibleSidebarLinks = links.filter(
      (link) =>
        link.sourceNodeId !== null &&
        activeSidebarNodeIds.has(link.sourceNodeId) &&
        link.resolved &&
        link.targetPageId !== null,
    );
    let nodeBacklinkCounts: Record<string, number> = {};
    try {
      nodeBacklinkCounts = mergeNodeBacklinkCounts(
        buildLocalNodeBacklinkCounts(nodes),
        await buildVisibleNodeBacklinkCounts(
          ctx,
          nodes.map((node) => node._id),
          { excludeSourcePageId: sidebarPage._id },
        ),
      );
    } catch {
      nodeBacklinkCounts = {};
    }
    return {
      page: sidebarPage,
      nodes,
      nodeBacklinkCounts,
      linkedPageIds: [
        ...new Set(
          visibleSidebarLinks
            .map((link) => link.targetPageId)
            .filter((pageId): pageId is Id<"pages"> => pageId !== null),
        ),
      ],
    };
  },
});

export const ensureSidebarPage = mutation({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const pages = await ctx.db.query("pages").collect();
    const existingSidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;
    if (existingSidebarPage) {
      const sourceMeta = getPageSourceMeta(existingSidebarPage);
      if (sourceMeta.pageType !== "note" || sourceMeta.sidebarSection !== "Notes") {
        await ctx.db.patch(existingSidebarPage._id, {
          sourceMeta: {
            ...sourceMeta,
            pageType: "note",
            sidebarSection: "Notes",
          },
          updatedAt: getTimestamp(),
        });
      }
      return existingSidebarPage._id;
    }

    const now = getTimestamp();
    const slug = await buildUniquePageSlug(ctx.db, "Sidebar");
    return await ctx.db.insert("pages", {
      title: "Sidebar",
      slug,
      icon: null,
      archived: false,
      position: -1024,
      sourceMeta: {
        sourceType: "system",
        specialPage: "sidebar",
        hidden: true,
        pageType: "note",
        sidebarSection: "Notes",
      },
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const refreshSidebarLinks = mutation({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const pages = await ctx.db.query("pages").collect();
    const sidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;
    if (!sidebarPage) {
      return {
        refreshedCount: 0,
      };
    }

    const sidebarNodes = await listPageNodes(ctx.db, sidebarPage._id);
    for (const node of sidebarNodes) {
      await syncLinksForNode(ctx.db, node);
    }

    return {
      refreshedCount: sidebarNodes.length,
    };
  },
});

export const validateOwnerKey = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (_ctx, args) => {
    return isOwnerKeyValid(args.ownerKey);
  },
});

export const rebuildEmbeddings = mutation({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const now = getTimestamp();
    const runId = `${now}`;
    const existingState = await getEmbeddingRebuildState(ctx.db);
    const nextState = {
      key: EMBEDDING_REBUILD_STATE_KEY,
      runId,
      status: "running" as const,
      scanComplete: false,
      scannedNodes: 0,
      eligibleNodes: 0,
      skippedNodes: 0,
      queued: 0,
      running: 0,
      completed: 0,
      error: 0,
      lastQueuedAt: null,
      startedAt: now,
      updatedAt: now,
    };

    if (existingState) {
      await ctx.db.replace(existingState._id, nextState);
    } else {
      await ctx.db.insert("embeddingRebuildState", nextState);
    }

    await ctx.scheduler.runAfter(0, internal.workspace.rebuildEmbeddingsBatch, {
      runId,
      cursor: null,
      batchSize: EMBEDDING_REBUILD_BATCH_SIZE,
    });

    return {
      started: true,
      batchSize: EMBEDDING_REBUILD_BATCH_SIZE,
      runId,
    };
  },
});

export const cancelEmbeddingRebuild = mutation({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const state = await getEmbeddingRebuildState(ctx.db);
    if (!state || state.status !== "running") {
      return {
        cancelled: false,
        message: "No embedding rebuild is currently running.",
      };
    }

    const now = getTimestamp();
    await ctx.db.patch(state._id, {
      status: "cancelled",
      queued: 0,
      running: 0,
      scanComplete: true,
      updatedAt: now,
      finishedAt: now,
      lastError: "Cancelled by user.",
    });

    return {
      cancelled: true,
      runId: state.runId,
    };
  },
});

export const rebuildEmbeddingsBatch = internalMutation({
  args: {
    runId: v.string(),
    cursor: v.union(v.string(), v.null()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const state = await getEmbeddingRebuildState(ctx.db);
    if (!state || state.runId !== args.runId || state.status !== "running") {
      return;
    }

    const batchSize = Math.max(
      1,
      Math.min(args.batchSize ?? EMBEDDING_REBUILD_BATCH_SIZE, EMBEDDING_REBUILD_BATCH_SIZE),
    );
    const result = await ctx.db.query("nodes").paginate({
      cursor: args.cursor,
      numItems: batchSize,
    });
    const now = getTimestamp();
    let scannedDelta = 0;
    let eligibleDelta = 0;
    let skippedDelta = 0;
    let queuedDelta = 0;

    for (const node of result.page) {
      scannedDelta += 1;
      if (node.archived || !shouldGenerateEmbeddingForNodeText(node.text)) {
        skippedDelta += 1;
        await ctx.runMutation(internal.aiData.clearNodeEmbedding, {
          nodeId: node._id,
        });
        continue;
      }

      eligibleDelta += 1;
      const existingJob = await ctx.db
        .query("embeddingJobs")
        .withIndex("by_node", (query) => query.eq("nodeId", node._id))
        .first();

      if (existingJob) {
        await ctx.db.patch(existingJob._id, {
          status: "queued",
          lastQueuedAt: now,
          rebuildRunId: args.runId,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("embeddingJobs", {
          nodeId: node._id,
          status: "queued",
          attempts: 0,
          lastQueuedAt: now,
          rebuildRunId: args.runId,
          updatedAt: now,
        });
      }
      queuedDelta += 1;

      await ctx.scheduler.runAfter(0, internal.ai.generateEmbeddingForNode, {
        nodeId: node._id,
      });
    }

    const latestState = await getEmbeddingRebuildState(ctx.db);
    if (!latestState || latestState.runId !== args.runId || latestState.status !== "running") {
      return;
    }

    const nextQueued = latestState.queued + queuedDelta;
    const nextStateStatus =
      result.isDone && latestState.running === 0 && nextQueued === 0
        ? latestState.error > 0
          ? "error"
          : "completed"
        : latestState.status;

    await ctx.db.patch(latestState._id, {
      scannedNodes: latestState.scannedNodes + scannedDelta,
      eligibleNodes: latestState.eligibleNodes + eligibleDelta,
      skippedNodes: latestState.skippedNodes + skippedDelta,
      queued: nextQueued,
      lastQueuedAt: queuedDelta > 0 ? now : latestState.lastQueuedAt,
      scanComplete: result.isDone,
      status: nextStateStatus,
      updatedAt: now,
      ...(nextStateStatus !== "running" ? { finishedAt: now } : {}),
    });

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.workspace.rebuildEmbeddingsBatch, {
        runId: args.runId,
        cursor: result.continueCursor,
        batchSize,
      });
    }
  },
});

export const getEmbeddingRebuildStatus = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const state = await getEmbeddingRebuildState(ctx.db);
    if (!state) {
      return buildEmbeddingRebuildStatus(null);
    }

    const jobCounts = await collectEmbeddingJobCountsForRun(ctx.db, state.runId);
    const derivedStatus =
      state.status === "cancelled"
        ? "cancelled"
        : state.scanComplete && jobCounts.queued === 0 && jobCounts.running === 0
          ? jobCounts.error > 0
            ? "error"
            : "completed"
          : "running";
    return buildEmbeddingRebuildStatus(state, {
      ...jobCounts,
      status: derivedStatus,
    });
  },
});

export const getRecentEmbeddingErrors = query({
  args: {
    ownerKey: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const limit = Math.max(1, Math.min(args.limit ?? 6, 20));
    const jobs = await ctx.db
      .query("embeddingJobs")
      .withIndex("by_status_updatedAt", (query) => query.eq("status", "error"))
      .order("desc")
      .take(limit);

    const nodes = await Promise.all(jobs.map((job) => ctx.db.get(job.nodeId)));
    const pageIds = [...new Set(nodes.filter(Boolean).map((node) => node!.pageId))];
    const pages = await Promise.all(pageIds.map((pageId) => ctx.db.get(pageId)));
    const pageMap = new Map(
      pages
        .filter((page): page is Doc<"pages"> => page !== null)
        .map((page) => [page._id as string, page]),
    );

    return jobs.map((job, index) => {
      const node = nodes[index] ?? null;
      const page = node ? pageMap.get(node.pageId as string) ?? null : null;
      return {
        jobId: job._id,
        nodeId: job.nodeId,
        pageId: page?._id ?? null,
        pageTitle: page?.title ?? null,
        nodeText: node?.text ?? null,
        error: job.lastError ?? "Unknown embedding error.",
        updatedAt: job.updatedAt,
      };
    });
  },
});

export const listTags = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const pages = await ctx.db.query("pages").collect();
    const activePageIds = new Set(
      pages
        .filter((page) => !page.archived)
        .map((page) => page._id as string),
    );
    const nodes = (await ctx.db.query("nodes").collect()).filter(
      (node) => !node.archived && activePageIds.has(node.pageId as string),
    );

    const tagsByNormalizedValue = new Map<
      string,
      { label: string; value: string; normalizedValue: string; count: number }
    >();

    for (const node of nodes) {
      for (const match of extractTagMatches(node.text)) {
        const existing = tagsByNormalizedValue.get(match.normalizedValue);
        if (existing) {
          existing.count += 1;
          continue;
        }

        tagsByNormalizedValue.set(match.normalizedValue, {
          label: match.label,
          value: match.value,
          normalizedValue: match.normalizedValue,
          count: 1,
        });
      }
    }

    return [...tagsByNormalizedValue.values()].sort((left, right) => {
      if (left.normalizedValue !== right.normalizedValue) {
        return left.normalizedValue.localeCompare(right.normalizedValue);
      }

      return left.label.localeCompare(right.label);
    });
  },
});

export const getPageTree = query({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || isPagePendingDeletion(page)) {
      return null;
    }

    const warnings: string[] = [];

    let nodes: Doc<"nodes">[] = [];
    let nodesTruncated = false;
    try {
      const result = await listPageNodesForTree(ctx, args.pageId);
      nodes = result.nodes;
      nodesTruncated = result.truncated;
      if (nodesTruncated) {
        warnings.push(
          "This page is too large to load fully right now, so only the first portion is shown.",
        );
      }
    } catch (error) {
      console.error("Failed to load page-tree nodes", {
        pageId: args.pageId,
        error,
      });
      warnings.push(
        "Some outline items could not be loaded right now, so this page may be partially empty.",
      );
    }

    let visibleBacklinks: Doc<"links">[] = [];
    let backlinksTruncated = false;
    if (!page.archived && !nodesTruncated) {
      try {
        const backlinkResult = await listPageBacklinksForTree(ctx, args.pageId);
        backlinksTruncated = backlinkResult.truncated;
        if (backlinksTruncated) {
          warnings.push("Backlink counts are partial for this page.");
        }
        visibleBacklinks = (await filterVisibleLinks(ctx, backlinkResult.backlinks)).filter(
          (link) => link.kind === "page",
        );
      } catch (error) {
        console.error("Failed to load page-tree backlinks", {
          pageId: args.pageId,
          error,
        });
        warnings.push("Backlink metadata was skipped while loading this page.");
      }
    }

    let nodeBacklinkCounts: Record<string, number> = {};
    if (!page.archived && nodes.length > 0 && !nodesTruncated) {
      try {
        nodeBacklinkCounts = mergeNodeBacklinkCounts(
          buildLocalNodeBacklinkCounts(nodes),
          await buildVisibleNodeBacklinkCounts(
            ctx,
            nodes.map((node) => node._id),
            { excludeSourcePageId: args.pageId },
          ),
        );
      } catch (error) {
        console.error("Failed to build page-tree node backlink counts", {
          pageId: args.pageId,
          error,
        });
        warnings.push("Some backlink badges were skipped while loading this page.");
      }
    }

    return {
      page,
      nodes,
      backlinks: visibleBacklinks,
      pageBacklinkCount: visibleBacklinks.length,
      pageBacklinkCountTruncated: backlinksTruncated,
      nodeBacklinkCounts,
      loadWarning: warnings.length > 0 ? warnings.join(" ") : null,
    };
  },
});

export const getPageRootAppendTarget = query({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || isPagePendingDeletion(page)) {
      return null;
    }

    const lastRootNode = await ctx.db
      .query("nodes")
      .withIndex("by_page_parent_position", (q) =>
        q.eq("pageId", args.pageId).eq("parentNodeId", null),
      )
      .order("desc")
      .take(1);

    return (lastRootNode[0]?._id as Id<"nodes"> | undefined) ?? null;
  },
});

export const previewFindAndReplace = query({
  args: {
    ownerKey: v.string(),
    find: v.string(),
    replace: v.string(),
    pageId: v.optional(v.id("pages")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    if (args.find.length === 0) {
      return {
        matches: [],
        totalNodes: 0,
        totalOccurrences: 0,
        previewTruncated: false,
      };
    }

    const previewLimit = Math.max(
      1,
      Math.min(args.limit ?? FIND_REPLACE_PREVIEW_LIMIT, FIND_REPLACE_PREVIEW_LIMIT),
    );
    const { pagesById, nodes } = await listScopedFindReplaceNodes(ctx.db, args.pageId);
    const matches: Array<{
      node: Doc<"nodes">;
      page: Doc<"pages"> | null;
      occurrenceCount: number;
      replacedText: string;
    }> = [];
    let totalNodes = 0;
    let totalOccurrences = 0;

    for (const node of nodes) {
      const replacement = replaceLiteralOccurrences(node.text, args.find, args.replace);
      if (!replacement) {
        continue;
      }

      totalNodes += 1;
      totalOccurrences += replacement.occurrenceCount;
      if (matches.length < previewLimit) {
        matches.push({
          node,
          page: pagesById.get(node.pageId) ?? null,
          occurrenceCount: replacement.occurrenceCount,
          replacedText: replacement.value,
        });
      }
    }

    return {
      matches,
      totalNodes,
      totalOccurrences,
      previewTruncated: totalNodes > matches.length,
    };
  },
});

export const applyFindAndReplaceBatch = mutation({
  args: {
    ownerKey: v.string(),
    find: v.string(),
    replace: v.string(),
    pageId: v.optional(v.id("pages")),
    batchSize: v.optional(v.number()),
    updatedBefore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    if (args.find.length === 0) {
      return {
        replacedNodeCount: 0,
        replacedOccurrenceCount: 0,
        hasMore: false,
        updatedBefore: args.updatedBefore ?? getTimestamp(),
      };
    }

    const batchSize = Math.max(
      1,
      Math.min(args.batchSize ?? FIND_REPLACE_BATCH_SIZE, FIND_REPLACE_BATCH_SIZE),
    );
    const updatedBefore = args.updatedBefore ?? getTimestamp();
    const { nodes } = await listScopedFindReplaceNodes(ctx.db, args.pageId, updatedBefore);
    const replacements: Array<{
      nodeId: Id<"nodes">;
      pageId: Id<"pages">;
      text: string;
      occurrenceCount: number;
    }> = [];

    for (const node of nodes) {
      const replacement = replaceLiteralOccurrences(node.text, args.find, args.replace);
      if (!replacement) {
        continue;
      }

      replacements.push({
        nodeId: node._id,
        pageId: node.pageId,
        text: replacement.value,
        occurrenceCount: replacement.occurrenceCount,
      });
      if (replacements.length >= batchSize) {
        break;
      }
    }

    let replacedOccurrenceCount = 0;
    const pageIdsToRefresh = new Set<Id<"pages">>();

    for (const replacement of replacements) {
      await ctx.db.patch(replacement.nodeId, {
        text: replacement.text,
        updatedAt: getTimestamp(),
      });
      const refreshedNode = await ctx.db.get(replacement.nodeId);
      if (!refreshedNode) {
        continue;
      }

      replacedOccurrenceCount += replacement.occurrenceCount;
      pageIdsToRefresh.add(replacement.pageId);
      await syncLinksForNode(ctx.db, refreshedNode);
      await enqueueNodeAiWork(ctx, refreshedNode._id);
    }

    for (const pageId of pageIdsToRefresh) {
      await enqueuePageRootEmbeddingRefresh(ctx, pageId);
    }

    const hasMore = replacements.length >= batchSize;

    return {
      replacedNodeCount: replacements.length,
      replacedOccurrenceCount,
      hasMore,
      updatedBefore,
    };
  },
});

export const archivePage = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page) {
      throw new Error("Page not found.");
    }

    if (isSidebarSpecialPage(page)) {
      throw new Error("The sidebar outline cannot be archived.");
    }

    await ctx.db.patch(args.pageId, {
      archived: args.archived,
      updatedAt: getTimestamp(),
    });
  },
});

export const deletePageForever = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page) {
      throw new Error("Page not found.");
    }

    if (isSidebarSpecialPage(page)) {
      throw new Error("The sidebar outline cannot be deleted.");
    }

    if (!page.archived) {
      throw new Error("Only archived pages can be deleted forever.");
    }

    if (!isPagePendingDeletion(page)) {
      await ctx.db.patch(args.pageId, {
        sourceMeta: {
          ...getPageSourceMeta(page),
          deletingForever: true,
          deletingForeverStartedAt: getTimestamp(),
        },
        updatedAt: getTimestamp(),
      });
    }

    await ctx.scheduler.runAfter(0, internal.workspace.deletePageForeverBatch, {
      pageId: args.pageId,
    });
  },
});

export const deletePageForeverBatch = internalMutation({
  args: {
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) {
      return;
    }

    const nodeBatch = await takePageDeletionNodeBatch(ctx, args.pageId);
    if (nodeBatch.length > 0) {
      for (const node of nodeBatch) {
        const outboundLinks = await ctx.db
          .query("links")
          .withIndex("by_source_node", (query) => query.eq("sourceNodeId", node._id))
          .collect();
        const inboundLinks = await ctx.db
          .query("links")
          .withIndex("by_target_node", (query) => query.eq("targetNodeId", node._id))
          .collect();
        const embeddingJobs = await ctx.db
          .query("embeddingJobs")
          .withIndex("by_node", (query) => query.eq("nodeId", node._id))
          .collect();
        const embeddings = await ctx.db
          .query("nodeEmbeddings")
          .withIndex("by_node", (query) => query.eq("nodeId", node._id))
          .collect();

        for (const link of new Map(
          [...outboundLinks, ...inboundLinks].map((link) => [link._id, link]),
        ).values()) {
          await ctx.db.delete(link._id);
        }

        for (const job of embeddingJobs) {
          await ctx.db.delete(job._id);
        }

        for (const embedding of embeddings) {
          await ctx.db.delete(embedding._id);
        }

        await ctx.db.delete(node._id);
      }

      await ctx.scheduler.runAfter(0, internal.workspace.deletePageForeverBatch, {
        pageId: args.pageId,
      });
      return;
    }

    const outboundPageLinks = await ctx.db
      .query("links")
      .withIndex("by_source_page", (query) => query.eq("sourcePageId", args.pageId))
      .take(PAGE_DELETE_LINK_BATCH_SIZE);
    const inboundPageLinks = await ctx.db
      .query("links")
      .withIndex("by_target_page", (query) => query.eq("targetPageId", args.pageId))
      .take(PAGE_DELETE_LINK_BATCH_SIZE);

    const pageLinkBatch = [...new Map(
      [...outboundPageLinks, ...inboundPageLinks].map((link) => [link._id, link]),
    ).values()];
    if (pageLinkBatch.length > 0) {
      for (const link of pageLinkBatch) {
        await ctx.db.delete(link._id);
      }

      await ctx.scheduler.runAfter(0, internal.workspace.deletePageForeverBatch, {
        pageId: args.pageId,
      });
      return;
    }

    const pageThreads = await ctx.db
      .query("chatThreads")
      .withIndex("by_page_updatedAt", (query) => query.eq("pageId", args.pageId))
      .take(1);

    if (pageThreads.length > 0) {
      const thread = pageThreads[0]!;
      const messages = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread_createdAt", (query) => query.eq("threadId", thread._id))
        .take(PAGE_DELETE_MESSAGE_BATCH_SIZE);

      if (messages.length > 0) {
        for (const message of messages) {
          await ctx.db.delete(message._id);
        }
      } else {
        await ctx.db.delete(thread._id);
      }

      await ctx.scheduler.runAfter(0, internal.workspace.deletePageForeverBatch, {
        pageId: args.pageId,
      });
      return;
    }

    await ctx.db.delete(args.pageId);
  },
});

export const getBacklinks = query({
  args: {
    ownerKey: v.string(),
    pageId: v.optional(v.id("pages")),
    nodeId: v.optional(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    if (args.nodeId) {
      const nodeId = args.nodeId;
      const links = await listNodeBacklinks(ctx, nodeId);
      return await filterVisibleLinks(ctx, links);
    }

    if (args.pageId) {
      const pageId = args.pageId;
      const links = await ctx.db
        .query("links")
        .withIndex("by_target_page", (query) =>
          query.eq("targetPageId", pageId),
        )
        .collect();
      return (await filterVisibleLinks(ctx, links)).filter((link) => link.kind === "page");
    }

    return [];
  },
});

export const searchLinkTargets = query({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    excludeNodeId: v.optional(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const normalizedQuery = normalizeLinkSearchQuery(args.query);
    const limit = Math.max(1, Math.min(args.limit ?? 8, 12));

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_archived_position", (query) => query.eq("archived", false))
      .collect();
    const visiblePages = pages.filter(
      (page) => !isSidebarSpecialPage(page) && !isPagePendingDeletion(page),
    );

    const pageResults = [...visiblePages]
      .filter((page) => linkSearchScore(page.title, normalizedQuery) !== Number.POSITIVE_INFINITY)
      .sort((left, right) => {
        const leftScore = linkSearchScore(left.title, normalizedQuery);
        const rightScore = linkSearchScore(right.title, normalizedQuery);
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return left.position - right.position;
      })
      .slice(0, limit);

    const activePageIds = new Set(visiblePages.map((page) => page._id));
    const nodes = (await ctx.db.query("nodes").collect()).filter(
      (node) =>
        !node.archived &&
        activePageIds.has(node.pageId) &&
        node._id !== args.excludeNodeId &&
        node.text.trim().length > 0 &&
        node.text.trim() !== ".",
    );
    const pageMap = new Map(visiblePages.map((page) => [page._id, page]));

    const nodeResults = nodes
      .filter((node) => linkSearchScore(node.text, normalizedQuery) !== Number.POSITIVE_INFINITY)
      .sort((left, right) => {
        const leftScore = linkSearchScore(left.text, normalizedQuery);
        const rightScore = linkSearchScore(right.text, normalizedQuery);
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return right.updatedAt - left.updatedAt;
      })
      .slice(0, limit)
      .map((node) => ({
        node,
        page: pageMap.get(node.pageId) ?? null,
      }))
      .filter((entry) => entry.page !== null);

    return {
      pages: pageResults,
      nodes: nodeResults,
    };
  },
});

export const resolveNodeLinks = query({
  args: {
    ownerKey: v.string(),
    nodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const uniqueNodeIds = [...new Set(args.nodeIds)];
    const nodes = await Promise.all(uniqueNodeIds.map((nodeId) => ctx.db.get(nodeId)));
    const pageIds = [
      ...new Set(
        nodes
          .filter((node): node is Doc<"nodes"> => node !== null)
          .map((node) => node.pageId),
      ),
    ];
    const pages = await Promise.all(pageIds.map((pageId) => ctx.db.get(pageId)));
    const pageMap = new Map(
      pages
        .filter((page): page is Doc<"pages"> => page !== null)
        .map((page) => [page._id, page]),
    );

    return nodes
      .filter((node): node is Doc<"nodes"> => node !== null)
      .map((node) => {
        const page = pageMap.get(node.pageId) ?? null;
        return {
          nodeId: node._id,
          pageId: page?._id ?? null,
          text: node.text,
          archived: node.archived,
          pageArchived: page?.archived ?? false,
        };
      });
  },
});

export const listTasks = query({
  args: {
    ownerKey: v.string(),
    status: v.optional(taskStatusValidator),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const tasks = await ctx.db
      .query("nodes")
      .withIndex("by_kind_status", (query) =>
        query.eq("kind", "task"),
      )
      .collect();

    return tasks
      .filter((task) => !task.archived)
      .filter((task) => (args.status !== undefined ? task.taskStatus === args.status : true))
      .sort((left, right) => {
      if (left.dueAt && right.dueAt) {
        return left.dueAt - right.dueAt;
      }

      if (left.dueAt) {
        return -1;
      }

      if (right.dueAt) {
        return 1;
      }

      return right.updatedAt - left.updatedAt;
      });
  },
});

export const createPage = mutation({
  args: {
    ownerKey: v.string(),
    title: v.string(),
    afterPageId: v.optional(v.id("pages")),
    sidebarSection: v.optional(
      v.union(
        v.literal("Models"),
        v.literal("Tasks"),
        v.literal("Notes"),
        v.literal("Templates"),
        v.literal("Journal"),
        v.literal("Scratchpads"),
      ),
    ),
    pageType: v.optional(
      v.union(
        v.literal("default"),
        v.literal("note"),
        v.literal("task"),
        v.literal("planner"),
        v.literal("model"),
        v.literal("journal"),
        v.literal("scratchpad"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const now = getTimestamp();

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_archived_position", (query) =>
        query.eq("archived", false),
      )
      .collect();
    const sortedPages = pages.sort((left, right) => left.position - right.position);
    const afterIndex = args.afterPageId
      ? sortedPages.findIndex((page) => page._id === args.afterPageId)
      : sortedPages.length - 1;
    const before = sortedPages[afterIndex]?.position ?? null;
    const after = sortedPages[afterIndex + 1]?.position ?? null;
    const position =
      before === null
        ? after === null
          ? 1024
          : after / 2
        : after === null
          ? before + 1024
          : (before + after) / 2;

    const slug = await buildUniquePageSlug(ctx.db, args.title);
    const pageId = await ctx.db.insert("pages", {
      title: args.title.trim() || "Untitled",
      slug,
      icon: null,
      archived: false,
      position,
      sourceMeta: {
        sourceType: "manual",
        sidebarSection: args.sidebarSection ?? "Tasks",
        pageType: args.pageType ?? "default",
      },
      createdAt: now,
      updatedAt: now,
    });

    if (args.pageType === "model") {
      await ctx.db.insert("nodes", {
        pageId,
        parentNodeId: null,
        position: 1024,
        text: "Model",
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          sectionSlot: "model",
          locked: true,
        },
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert("nodes", {
        pageId,
        parentNodeId: null,
        position: 2048,
        text: "Recent",
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          sectionSlot: "recentExamples",
          locked: true,
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    if (args.pageType === "task") {
      await ctx.db.insert("nodes", {
        pageId,
        parentNodeId: null,
        position: 1024,
        text: "Sidebar",
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          sectionSlot: "taskSidebar",
          locked: true,
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    if (args.pageType === "planner") {
      const plannerPage = await ctx.db.get(pageId);
      if (plannerPage) {
        await ensurePlannerSections(ctx, plannerPage);
      }
    }

    if (args.pageType === "journal") {
      await ctx.db.insert("nodes", {
        pageId,
        parentNodeId: null,
        position: 1024,
        text: "Thoughts/Stuff",
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          sectionSlot: "journalThoughts",
          locked: true,
        },
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert("nodes", {
        pageId,
        parentNodeId: null,
        position: 2048,
        text: "Feedback",
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          sectionSlot: "journalFeedback",
          locked: true,
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    if (args.pageType === "scratchpad") {
      await ctx.db.insert("nodes", {
        pageId,
        parentNodeId: null,
        position: 1024,
        text: "Live",
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          sectionSlot: "scratchpadLive",
          locked: true,
        },
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert("nodes", {
        pageId,
        parentNodeId: null,
        position: 2048,
        text: "Previous",
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          sectionSlot: "scratchpadPrevious",
          locked: true,
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    await enqueuePageRootEmbeddingRefresh(ctx, pageId);

    return pageId;
  },
});

export const ensureTaskPageSidebarSection = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived) {
      throw new Error("Page not found.");
    }

    const pageSourceMeta = getPageSourceMeta(page);
    const isTaskPage =
      pageSourceMeta.pageType === "task" || pageSourceMeta.sidebarSection === "Tasks";
    if (!isTaskPage) {
      throw new Error("Only task pages can have a task sidebar section.");
    }

    const nodes = await listPageNodes(ctx.db, args.pageId);
    const existingSection = nodes.find((node) => {
      const sourceMeta =
        node.sourceMeta && typeof node.sourceMeta === "object"
          ? (node.sourceMeta as Record<string, unknown>)
          : null;
      return sourceMeta?.sectionSlot === "taskSidebar";
    });

    if (existingSection) {
      return existingSection._id;
    }

    const rootNodes = nodes.filter((node) => node.parentNodeId === null);
    const position = Math.max(...rootNodes.map((node) => node.position), 0) + 1024;
    const now = getTimestamp();
    const nodeId = await ctx.db.insert("nodes", {
      pageId: args.pageId,
      parentNodeId: null,
      position,
      text: "Sidebar",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "system",
        sectionSlot: "taskSidebar",
        locked: true,
      },
      createdAt: now,
      updatedAt: now,
    });

    await enqueuePageRootEmbeddingRefresh(ctx, args.pageId);
    return nodeId;
  },
});

export const ensurePlannerPageSections = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      throw new Error("Only planner pages can have planner sections.");
    }

    return await ensurePlannerSections(ctx, page);
  },
});

export const setPlannerScanExcluded = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    excluded: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isTaskSourcePage(page)) {
      throw new Error("Only active task pages can be toggled for planner scans.");
    }

    const nextSourceMeta = {
      ...getPageSourceMeta(page),
      excludeFromPlannerScan: args.excluded,
    };
    await ctx.db.patch(args.pageId, {
      sourceMeta: nextSourceMeta,
      updatedAt: getTimestamp(),
    });

    return args.excluded;
  },
});

export const renamePage = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const page = await ctx.db.get(args.pageId);
    if (!page) {
      throw new Error("Page not found.");
    }

    const nextTitle = args.title.trim() || "Untitled";
    const previousSlug = page.slug;
    const slug = await buildUniquePageSlug(ctx.db, nextTitle, args.pageId);
    await ctx.db.patch(args.pageId, {
      title: nextTitle,
      slug,
      updatedAt: getTimestamp(),
    });

    const inboundPageLinks = await ctx.db
      .query("links")
      .withIndex("by_target_page", (query) => query.eq("targetPageId", args.pageId))
      .collect();
    const sourceNodeIds = [
      ...new Set(
        inboundPageLinks
          .filter(
            (link): link is Doc<"links"> & { sourceNodeId: Id<"nodes"> } =>
              link.kind === "page" &&
              link.resolved &&
              link.sourceNodeId !== null,
          )
          .map((link) => link.sourceNodeId),
      ),
    ];
    const touchedSourcePageIds = new Set<Id<"pages">>();

    for (const sourceNodeId of sourceNodeIds) {
      const sourceNode = await ctx.db.get(sourceNodeId);
      if (!sourceNode || sourceNode.archived) {
        continue;
      }

      const nextText = rewriteMatchingPageWikiLinks(
        sourceNode.text,
        (link) =>
          link.targetPageRef === (args.pageId as string) ||
          (!!link.targetPageTitle &&
            (slugify(link.targetPageTitle, { lower: true, strict: true }) || "untitled") ===
              previousSlug),
        nextTitle,
        page.title,
      );

      if (nextText === sourceNode.text) {
        continue;
      }

      const updatedAt = getTimestamp();
      const updatedNode = {
        ...sourceNode,
        text: nextText,
        updatedAt,
      };
      await ctx.db.patch(sourceNodeId, {
        text: nextText,
        updatedAt,
      });
      await syncLinksForNode(ctx.db, updatedNode);
      await enqueueNodeEmbeddingRefresh(ctx, sourceNodeId);
      touchedSourcePageIds.add(sourceNode.pageId);
    }

    const pageNodes = await listPageNodes(ctx.db, args.pageId);
    for (const node of pageNodes) {
      await ctx.scheduler.runAfter(0, internal.ai.generateEmbeddingForNode, {
        nodeId: node._id,
      });
    }

    for (const sourcePageId of touchedSourcePageIds) {
      await enqueuePageRootEmbeddingRefresh(ctx, sourcePageId);
    }
  },
});

export const createNode = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    parentNodeId: v.optional(nullableNodeIdValidator),
    afterNodeId: v.optional(nullableNodeIdValidator),
    text: v.optional(v.string()),
    kind: v.optional(nodeKindValidator),
    taskStatus: v.optional(taskStatusValidator),
    dueAt: v.optional(v.union(v.number(), v.null())),
    dueEndAt: v.optional(v.union(v.number(), v.null())),
    recurrenceFrequency: v.optional(recurrenceFrequencyValidator),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const now = getTimestamp();
    const parentNodeId = args.parentNodeId ?? null;
    const position = await computeNodePosition(
      ctx.db,
      args.pageId,
      parentNodeId,
      args.afterNodeId ?? null,
    );

    const nodeId = await ctx.db.insert("nodes", {
      pageId: args.pageId,
      parentNodeId,
      position,
      text: args.text?.trim() || "",
      kind: args.kind ?? "note",
      taskStatus: args.kind === "task" ? (args.taskStatus ?? "todo") : null,
      priority: null,
      dueAt: args.kind === "task" ? (args.dueAt ?? null) : null,
      dueEndAt: args.kind === "task" ? (args.dueEndAt ?? null) : null,
      archived: false,
      sourceMeta: {
        sourceType: "manual",
        recurrenceFrequency:
          args.kind === "task" ? (args.recurrenceFrequency ?? null) : null,
      },
      createdAt: now,
      updatedAt: now,
    });

    const node = await ctx.db.get(nodeId);
    if (node) {
      await syncLinksForNode(ctx.db, node);
      await enqueueNodeAiWork(ctx, nodeId);
    }

    return nodeId;
  },
});

export const createNodesBatch = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    nodes: v.array(nodeCreateInputValidator),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const now = getTimestamp();
    const createdNodes: Doc<"nodes">[] = [];
    let lastCreatedId: Id<"nodes"> | null = null;
    let lastParentNodeId: Id<"nodes"> | null = null;
    const createdNodeIdsByClientId = new Map<string, Id<"nodes">>();

    for (const entry of args.nodes) {
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
      const position = await computeNodePosition(
        ctx.db,
        args.pageId,
        parentNodeId,
        afterNodeId,
      );

      const nodeId = await ctx.db.insert("nodes", {
        pageId: args.pageId,
        parentNodeId,
        position,
        text: entry.text?.trim() || "",
        kind: entry.kind ?? "note",
        taskStatus: entry.kind === "task" ? (entry.taskStatus ?? "todo") : null,
        priority: null,
        dueAt: entry.kind === "task" ? (entry.dueAt ?? null) : null,
        dueEndAt: entry.kind === "task" ? (entry.dueEndAt ?? null) : null,
        archived: false,
        sourceMeta: {
          sourceType: "manual",
          taskKindLocked: entry.lockKind ?? false,
          noteCompleted:
            entry.kind === "note"
              ? (entry.noteCompleted ?? false)
              : false,
          recurrenceFrequency:
            entry.kind === "task" ? (entry.recurrenceFrequency ?? null) : null,
        },
        createdAt: now,
        updatedAt: now,
      });

      const node = await ctx.db.get(nodeId);
      if (!node) {
        continue;
      }

      createdNodes.push(node);
      if (entry.clientId) {
        createdNodeIdsByClientId.set(entry.clientId, nodeId);
      }
      lastCreatedId = nodeId;
      lastParentNodeId = parentNodeId;
      await syncLinksForNode(ctx.db, node);
      await enqueueNodeAiWork(ctx, nodeId);
    }

    await enqueuePageRootEmbeddingRefresh(ctx, args.pageId);

    return createdNodes;
  },
});

export const updateNode = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    text: v.optional(v.string()),
    kind: v.optional(nodeKindValidator),
    lockKind: v.optional(v.boolean()),
    taskStatus: v.optional(taskStatusValidator),
    noteCompleted: v.optional(v.boolean()),
    priority: v.optional(priorityValidator),
    dueAt: v.optional(v.union(v.number(), v.null())),
    dueEndAt: v.optional(v.union(v.number(), v.null())),
    recurrenceFrequency: v.optional(recurrenceFrequencyValidator),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      throw new Error("Node not found.");
    }

    const patch: Partial<Doc<"nodes">> = {
      updatedAt: getTimestamp(),
    };

    if (args.text !== undefined) {
      patch.text = args.text;
    }

    if (args.kind !== undefined) {
      patch.kind = args.kind;
      patch.taskStatus = args.kind === "task" ? (args.taskStatus ?? node.taskStatus ?? "todo") : null;
    } else if (args.taskStatus !== undefined) {
      patch.taskStatus = args.taskStatus;
    }

    if (args.priority !== undefined) {
      patch.priority = args.priority;
    }

    if (args.dueAt !== undefined) {
      patch.dueAt = args.dueAt;
    }

    if (args.dueEndAt !== undefined) {
      patch.dueEndAt = args.dueEndAt;
    }

    if (
      args.lockKind !== undefined ||
      args.noteCompleted !== undefined ||
      args.kind !== undefined ||
      args.recurrenceFrequency !== undefined
    ) {
      const sourceMeta =
        node.sourceMeta && typeof node.sourceMeta === "object"
          ? { ...(node.sourceMeta as Record<string, unknown>) }
          : {};

      if (args.lockKind !== undefined) {
        sourceMeta.taskKindLocked = args.lockKind;
      }

      if (args.noteCompleted !== undefined) {
        sourceMeta.noteCompleted = args.noteCompleted;
      } else if (args.kind === "task") {
        sourceMeta.noteCompleted = false;
      }

      if (args.recurrenceFrequency !== undefined) {
        sourceMeta.recurrenceFrequency = args.recurrenceFrequency;
      } else if (args.kind === "note") {
        sourceMeta.recurrenceFrequency = null;
      }

      patch.sourceMeta = sourceMeta;
    }

    await ctx.db.patch(args.nodeId, patch);
    const refreshed = await ctx.db.get(args.nodeId);
    if (refreshed) {
      await syncLinksForNode(ctx.db, refreshed);
      await enqueueNodeAiWork(ctx, refreshed._id);
      await enqueuePageRootEmbeddingRefresh(ctx, refreshed.pageId);
    }
  },
});

export const updateNodesBatch = mutation({
  args: {
    ownerKey: v.string(),
    updates: v.array(
      v.object({
        nodeId: v.id("nodes"),
        text: v.optional(v.string()),
        kind: v.optional(nodeKindValidator),
        lockKind: v.optional(v.boolean()),
        taskStatus: v.optional(taskStatusValidator),
        noteCompleted: v.optional(v.boolean()),
        priority: v.optional(priorityValidator),
        dueAt: v.optional(v.union(v.number(), v.null())),
        dueEndAt: v.optional(v.union(v.number(), v.null())),
        recurrenceFrequency: v.optional(recurrenceFrequencyValidator),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    if (args.updates.length === 0) {
      return null;
    }

    const touchedPageIds = new Set<Id<"pages">>();

    for (const update of args.updates) {
      const node = await ctx.db.get(update.nodeId);
      if (!node) {
        throw new Error("Node not found.");
      }

      const patch: Partial<Doc<"nodes">> = {
        updatedAt: getTimestamp(),
      };

      if (update.text !== undefined) {
        patch.text = update.text;
      }

      if (update.kind !== undefined) {
        patch.kind = update.kind;
        patch.taskStatus =
          update.kind === "task"
            ? (update.taskStatus ?? node.taskStatus ?? "todo")
            : null;
      } else if (update.taskStatus !== undefined) {
        patch.taskStatus = update.taskStatus;
      }

      if (update.priority !== undefined) {
        patch.priority = update.priority;
      }

      if (update.dueAt !== undefined) {
        patch.dueAt = update.dueAt;
      }

      if (update.dueEndAt !== undefined) {
        patch.dueEndAt = update.dueEndAt;
      }

      if (
        update.lockKind !== undefined ||
        update.noteCompleted !== undefined ||
        update.kind !== undefined ||
        update.recurrenceFrequency !== undefined
      ) {
        const sourceMeta =
          node.sourceMeta && typeof node.sourceMeta === "object"
            ? { ...(node.sourceMeta as Record<string, unknown>) }
            : {};

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

        patch.sourceMeta = sourceMeta;
      }

      await ctx.db.patch(update.nodeId, patch);
      const refreshed = await ctx.db.get(update.nodeId);
      if (refreshed) {
        await syncLinksForNode(ctx.db, refreshed);
        await enqueueNodeAiWork(ctx, refreshed._id);
        touchedPageIds.add(refreshed.pageId);
      }
    }

    for (const pageId of touchedPageIds) {
      await enqueuePageRootEmbeddingRefresh(ctx, pageId);
    }

    return null;
  },
});

export const splitNode = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    headText: v.string(),
    headKind: nodeKindValidator,
    headTaskStatus: v.optional(taskStatusValidator),
    tailText: v.string(),
    tailKind: nodeKindValidator,
    tailTaskStatus: v.optional(taskStatusValidator),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      throw new Error("Node not found.");
    }

    const now = getTimestamp();
    await ctx.db.patch(args.nodeId, {
      text: args.headText,
      kind: args.headKind,
      taskStatus: args.headKind === "task" ? (args.headTaskStatus ?? "todo") : null,
      updatedAt: now,
    });

    const position = await computeNodePosition(
      ctx.db,
      node.pageId,
      node.parentNodeId,
      node._id,
    );

    const createdNodeId = await ctx.db.insert("nodes", {
      pageId: node.pageId,
      parentNodeId: node.parentNodeId,
      position,
      text: args.tailText,
      kind: args.tailKind,
      taskStatus: args.tailKind === "task" ? (args.tailTaskStatus ?? "todo") : null,
      priority: null,
      dueAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "manual",
      },
      createdAt: now,
      updatedAt: now,
    });

    const updatedNode = await ctx.db.get(args.nodeId);
    const createdNode = await ctx.db.get(createdNodeId);

    if (updatedNode) {
      await syncLinksForNode(ctx.db, updatedNode);
      await enqueueNodeAiWork(ctx, updatedNode._id);
    }

    if (createdNode) {
      await syncLinksForNode(ctx.db, createdNode);
      await enqueueNodeAiWork(ctx, createdNode._id);
    }

    await enqueuePageRootEmbeddingRefresh(ctx, node.pageId);

    return {
      updatedNode,
      createdNode,
    };
  },
});

export const replaceNodeAndInsertSiblings = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    text: v.string(),
    kind: nodeKindValidator,
    taskStatus: v.optional(taskStatusValidator),
    siblings: v.array(
      v.object({
        text: v.string(),
        kind: nodeKindValidator,
        taskStatus: v.optional(taskStatusValidator),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      throw new Error("Node not found.");
    }

    const now = getTimestamp();
    await ctx.db.patch(args.nodeId, {
      text: args.text.trim(),
      kind: args.kind,
      taskStatus: args.kind === "task" ? (args.taskStatus ?? "todo") : null,
      updatedAt: now,
    });

    const createdNodes: Doc<"nodes">[] = [];
    let afterNodeId: Id<"nodes"> | null = node._id;
    for (const sibling of args.siblings) {
      const position = await computeNodePosition(
        ctx.db,
        node.pageId,
        node.parentNodeId,
        afterNodeId,
      );
      const createdNodeId = await ctx.db.insert("nodes", {
        pageId: node.pageId,
        parentNodeId: node.parentNodeId,
        position,
        text: sibling.text.trim(),
        kind: sibling.kind,
        taskStatus: sibling.kind === "task" ? (sibling.taskStatus ?? "todo") : null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "manual",
        },
        createdAt: now,
        updatedAt: now,
      });
      afterNodeId = createdNodeId;
      const createdNode = await ctx.db.get(createdNodeId);
      if (createdNode) {
        createdNodes.push(createdNode);
        await syncLinksForNode(ctx.db, createdNode);
        await enqueueNodeAiWork(ctx, createdNode._id);
      }
    }

    const updatedNode = await ctx.db.get(args.nodeId);
    if (updatedNode) {
      await syncLinksForNode(ctx.db, updatedNode);
      await enqueueNodeAiWork(ctx, updatedNode._id);
    }

    await enqueuePageRootEmbeddingRefresh(ctx, node.pageId);

    return {
      updatedNode,
      createdNodes,
    };
  },
});

export const moveNode = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    pageId: v.optional(v.id("pages")),
    parentNodeId: v.optional(nullableNodeIdValidator),
    afterNodeId: v.optional(nullableNodeIdValidator),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      throw new Error("Node not found.");
    }

    const previousPageId = node.pageId;
    const pageId = args.pageId ?? node.pageId;
    const parentNodeId =
      args.parentNodeId === undefined ? node.parentNodeId : args.parentNodeId;
    const position = await computeNodePosition(
      ctx.db,
      pageId,
      parentNodeId,
      args.afterNodeId ?? null,
    );

    await ctx.db.patch(args.nodeId, {
      pageId,
      parentNodeId,
      position,
      updatedAt: getTimestamp(),
    });

    await enqueueNodeEmbeddingRefresh(ctx, args.nodeId);
    await enqueuePageRootEmbeddingRefresh(ctx, previousPageId);
    if (pageId !== previousPageId) {
      await enqueuePageRootEmbeddingRefresh(ctx, pageId);
    }
  },
});

export const moveNodesBatch = mutation({
  args: {
    ownerKey: v.string(),
    moves: v.array(
      v.object({
        nodeId: v.id("nodes"),
        pageId: v.optional(v.id("pages")),
        parentNodeId: v.optional(nullableNodeIdValidator),
        afterNodeId: v.optional(nullableNodeIdValidator),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    if (args.moves.length === 0) {
      return null;
    }

    const touchedPageIds = new Set<Id<"pages">>();

    for (const move of args.moves) {
      const node = await ctx.db.get(move.nodeId);
      if (!node) {
        throw new Error("Node not found.");
      }

      const previousPageId = node.pageId;
      const pageId = move.pageId ?? node.pageId;
      const parentNodeId =
        move.parentNodeId === undefined ? node.parentNodeId : move.parentNodeId;
      const position = await computeNodePosition(
        ctx.db,
        pageId,
        parentNodeId,
        move.afterNodeId ?? null,
      );

      await ctx.db.patch(move.nodeId, {
        pageId,
        parentNodeId,
        position,
        updatedAt: getTimestamp(),
      });

      touchedPageIds.add(previousPageId);
      touchedPageIds.add(pageId);
      await enqueueNodeEmbeddingRefresh(ctx, move.nodeId);
    }

    for (const pageId of touchedPageIds) {
      await enqueuePageRootEmbeddingRefresh(ctx, pageId);
    }

    return null;
  },
});

export const reorderNode = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    afterNodeId: v.optional(nullableNodeIdValidator),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      throw new Error("Node not found.");
    }

    const position = await computeNodePosition(
      ctx.db,
      node.pageId,
      node.parentNodeId,
      args.afterNodeId ?? null,
    );

    await ctx.db.patch(args.nodeId, {
      position,
      updatedAt: getTimestamp(),
    });

    await enqueuePageRootEmbeddingRefresh(ctx, node.pageId);
  },
});

export const archiveNode = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    await ctx.db.patch(args.nodeId, {
      archived: args.archived ?? true,
      updatedAt: getTimestamp(),
    });
  },
});

export const setNodeTreeArchived = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      throw new Error("Node not found.");
    }

    const descendants = await setNodeTreeArchivedState(
      ctx.db,
      args.nodeId,
      args.archived,
      getTimestamp(),
    );

    if (!args.archived) {
      for (const node of descendants) {
        await syncLinksForNode(ctx.db, {
          ...node,
          archived: false,
        });
        await enqueueNodeAiWork(ctx, node._id);
      }
    }

    await enqueuePageRootEmbeddingRefresh(ctx, node.pageId);
  },
});

export const setNodeTreesArchivedBatch = mutation({
  args: {
    ownerKey: v.string(),
    nodeIds: v.array(v.id("nodes")),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    if (args.nodeIds.length === 0) {
      return null;
    }

    const touchedPageIds = new Set<Id<"pages">>();

    for (const nodeId of args.nodeIds) {
      const node = await ctx.db.get(nodeId);
      if (!node) {
        throw new Error("Node not found.");
      }

      const descendants = await setNodeTreeArchivedState(
        ctx.db,
        nodeId,
        args.archived,
        getTimestamp(),
      );

      touchedPageIds.add(node.pageId);

      if (!args.archived) {
        for (const descendant of descendants) {
          await syncLinksForNode(ctx.db, {
            ...descendant,
            archived: false,
          });
          await enqueueNodeAiWork(ctx, descendant._id);
        }
      }
    }

    for (const pageId of touchedPageIds) {
      await enqueuePageRootEmbeddingRefresh(ctx, pageId);
    }

    return null;
  },
});

export const deleteNode = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    await deleteNodeTree(ctx.db, args.nodeId);
  },
});

export const getNodeEmbeddingContext = internalQuery({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      return null;
    }

    const page = await ctx.db.get(node.pageId);
    if (!page) {
      return null;
    }

    const ancestors = await collectNodeAncestorTexts(ctx.db, node.parentNodeId);
    const subtreeLines =
      node.parentNodeId === null ? await collectCappedRootSubtreeLines(ctx.db, node) : [];

    return {
      pageTitle: page.title,
      node: {
        _id: node._id,
        pageId: node.pageId,
        parentNodeId: node.parentNodeId,
        text: node.text,
        kind: node.kind,
        taskStatus: node.taskStatus,
        archived: node.archived,
      },
      ancestors,
      subtreeLines,
    };
  },
});

export const getNodeTaskMetadataContext = internalQuery({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      return null;
    }

    const page = await ctx.db.get(node.pageId);
    if (!page) {
      return null;
    }

    return {
      pageTitle: page.title,
      node: {
        _id: node._id,
        text: node.text,
        kind: node.kind,
        taskStatus: node.taskStatus,
        priority: node.priority,
        archived: node.archived,
        sourceMeta: node.sourceMeta,
      },
      ancestors: await collectNodeAncestorTexts(ctx.db, node.parentNodeId),
    };
  },
});

export const getWorkspaceContext = internalQuery({
  args: {
    pageId: v.optional(v.id("pages")),
  },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_archived_position", (query) => query.eq("archived", false))
      .collect();
    const allNodes = await ctx.db
      .query("nodes")
      .withIndex("by_kind_status", (query) => query.eq("kind", "task"))
      .collect();
    const tasks = allNodes
      .filter((node) => !node.archived && node.kind === "task" && node.taskStatus !== "done")
      .slice(0, 50);
    const pageNodes = args.pageId
      ? await listPageNodes(ctx.db, args.pageId)
      : allNodes.filter((node) => !node.archived);

    return {
      pages,
      tasks,
      pageNodes,
    };
  },
});

export const getModelPageContext = internalQuery({
  args: {
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived) {
      return null;
    }

    const nodes = await listPageNodes(ctx.db, args.pageId);
    const rootNodes = [...nodes]
      .filter((node) => node.parentNodeId === null)
      .sort((left, right) => left.position - right.position);

    const getSectionNode = (slot: "model" | "recentExamples") =>
      rootNodes.find((node) => {
        const sourceMeta =
          node.sourceMeta && typeof node.sourceMeta === "object"
            ? (node.sourceMeta as Record<string, unknown>)
            : null;
        return sourceMeta?.sectionSlot === slot;
      }) ?? null;

    const modelSection = getSectionNode("model");
    const recentExamplesSection = getSectionNode("recentExamples");

    const getSectionChildren = (sectionNodeId: Doc<"nodes">["_id"] | null) =>
      nodes
        .filter((node) => node.parentNodeId === sectionNodeId)
        .sort((left, right) => left.position - right.position);

    return {
      page,
      modelSection,
      recentExamplesSection,
      modelLines: getSectionChildren(modelSection?._id ?? null),
      recentExampleLines: getSectionChildren(recentExamplesSection?._id ?? null),
    };
  },
});

export const getPlannerPageContext = internalQuery({
  args: {
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isPlannerPage(page)) {
      return null;
    }

    const nodes = await listPageNodes(ctx.db, args.pageId);
    const rootNodes = [...nodes]
      .filter((node) => node.parentNodeId === null)
      .sort((left, right) => left.position - right.position);

    const plannerSidebarSection =
      rootNodes.find((node) => {
        const sourceMeta =
          node.sourceMeta && typeof node.sourceMeta === "object"
            ? (node.sourceMeta as Record<string, unknown>)
            : null;
        return sourceMeta?.sectionSlot === "plannerSidebar";
      }) ?? null;
    const plannerTemplateSection =
      rootNodes.find((node) => {
        const sourceMeta =
          node.sourceMeta && typeof node.sourceMeta === "object"
            ? (node.sourceMeta as Record<string, unknown>)
            : null;
        return sourceMeta?.sectionSlot === "plannerTemplate";
      }) ?? null;

    const plannerDays = getPlannerDayRoots(nodes);
    const linkedSourceTaskIds = [
      ...new Set(
        nodes
          .map((node) => getPlannerLinkedSourceTaskId(node))
          .filter((value): value is Id<"nodes"> => value !== null),
      ),
    ];
    const linkedSourceTasks = await Promise.all(
      linkedSourceTaskIds.map((nodeId) => ctx.db.get(nodeId)),
    );
    const openSourceTasks = await listEligiblePlannerSourceTasks(ctx.db, {});
    const contextSourceTasks = [
      ...new Map(
        [...linkedSourceTasks, ...openSourceTasks]
          .filter((task): task is Doc<"nodes"> => task !== null && !task.archived)
          .map((task) => [task._id as string, task]),
      ).values(),
    ];

    return {
      page,
      plannerStartDate: getPlannerStartDate(page),
      plannerSidebarSection,
      plannerTemplateSection,
      plannerDays,
      nodes,
      linkedSourceTasks: linkedSourceTasks.filter(
        (task): task is Doc<"nodes"> => task !== null && !task.archived,
      ),
      ...buildPlannerChatPromptContext({
        page,
        plannerNodes: nodes,
        sourceTasks: contextSourceTasks,
      }),
    };
  },
});

export const getJournalPageContext = internalQuery({
  args: {
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived) {
      return null;
    }

    const nodes = await listPageNodes(ctx.db, args.pageId);
    const rootNodes = [...nodes]
      .filter((node) => node.parentNodeId === null)
      .sort((left, right) => left.position - right.position);

    const getSectionNode = (slot: "journalThoughts" | "journalFeedback") =>
      rootNodes.find((node) => {
        const sourceMeta =
          node.sourceMeta && typeof node.sourceMeta === "object"
            ? (node.sourceMeta as Record<string, unknown>)
            : null;
        return sourceMeta?.sectionSlot === slot;
      }) ?? null;

    const thoughtsSection = getSectionNode("journalThoughts");
    const feedbackSection = getSectionNode("journalFeedback");

    const getSectionChildren = (sectionNodeId: Doc<"nodes">["_id"] | null) =>
      nodes
        .filter((node) => node.parentNodeId === sectionNodeId)
        .sort((left, right) => left.position - right.position);

    return {
      page,
      thoughtsSection,
      feedbackSection,
      thoughtLines: getSectionChildren(thoughtsSection?._id ?? null),
      feedbackLines: getSectionChildren(feedbackSection?._id ?? null),
    };
  },
});

export const getLinkedKnowledgeContext = internalQuery({
  args: {
    pageIds: v.array(v.id("pages")),
    nodeIds: v.array(v.id("nodes")),
    includeDefaultPlannerAndTaskPages: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const uniquePageIds = [...new Set(args.pageIds)];
    const uniqueNodeIds = [...new Set(args.nodeIds)];

    const defaultContextPages = args.includeDefaultPlannerAndTaskPages
      ? (await ctx.db.query("pages").collect()).filter((page) => {
          if (page.archived || isSidebarSpecialPage(page)) {
            return false;
          }

          if (isPlannerPage(page)) {
            return true;
          }

          return isTaskSourcePage(page) && !isPlannerScanExcludedPage(page);
        })
      : [];
    const allPageIds = [
      ...new Set([
        ...uniquePageIds.map((pageId) => pageId as string),
        ...defaultContextPages.map((page) => page._id as string),
      ]),
    ] as Id<"pages">[];

    const pages = await Promise.all(allPageIds.map((pageId) => ctx.db.get(pageId)));
    const visiblePages = pages.filter(
      (page): page is Doc<"pages"> => page !== null && !page.archived && !isSidebarSpecialPage(page),
    );

    const pageEntries = await Promise.all(
      visiblePages.map((page) =>
        buildPageKnowledgeContextEntry(ctx, page, {
          omitScheduledTaskSubtrees:
            args.includeDefaultPlannerAndTaskPages === true && isTaskSourcePage(page),
          section: isPlannerPage(page)
            ? "planner"
            : isTaskSourcePage(page)
              ? "backlog"
              : "linked",
        }),
      ),
    );

    const nodes = await Promise.all(uniqueNodeIds.map((nodeId) => ctx.db.get(nodeId)));
    const visibleNodeEntries = await Promise.all(
      nodes.map(async (node) => {
        if (!node || node.archived) {
          return null;
        }

        const page = await ctx.db.get(node.pageId);
        if (!page || page.archived || isSidebarSpecialPage(page)) {
          return null;
        }

        const pageNodes = await listPageNodes(ctx.db, page._id);
        const visiblePageNodes = pageNodes.filter((entry) => !entry.archived);
        const childrenByParent = groupNodesByParent(visiblePageNodes);
        const nodeMap = new Map(
          visiblePageNodes.map((entry) => [entry._id as string, entry]),
        );
        const resolvedNodeTextCache = new Map<string, string>();
        const resolvedTextById = new Map<string, string>();
        for (const visibleNode of visiblePageNodes) {
          resolvedTextById.set(
            visibleNode._id as string,
            await resolveKnowledgeContextText(
              ctx.db,
              visibleNode.text,
              nodeMap,
              resolvedNodeTextCache,
            ),
          );
        }
        const path = buildNodeAncestorPath(node, nodeMap, resolvedTextById);
        const subtree = buildNodeSubtreeLines(
          childrenByParent,
          node,
          0,
          resolvedTextById,
        ).join("\n");
        const content = [path.length > 0 ? `Path: ${path}` : "", subtree]
          .filter((value) => value.trim().length > 0)
          .join("\n");

        return {
          node,
          page,
          content,
        };
      }),
    );

    return {
      pages: pageEntries,
      nodes: visibleNodeEntries.filter(
        (
          entry,
        ): entry is {
          node: Doc<"nodes">;
          page: Doc<"pages">;
          content: string;
        } => entry !== null,
      ),
    };
  },
});

export const getResolvedLinkedTargetsForNodes = internalQuery({
  args: {
    nodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    const uniqueNodeIds = [...new Set(args.nodeIds)];
    const pageIds = new Set<Id<"pages">>();
    const nodeIds = new Set<Id<"nodes">>();

    for (const sourceNodeId of uniqueNodeIds) {
      const links = await ctx.db
        .query("links")
        .withIndex("by_source_node", (query) => query.eq("sourceNodeId", sourceNodeId))
        .collect();

      for (const link of links) {
        if (!link.resolved) {
          continue;
        }

        if (link.targetPageId) {
          pageIds.add(link.targetPageId);
        }

        if (link.targetNodeId) {
          nodeIds.add(link.targetNodeId);
        }
      }
    }

    return {
      pageIds: [...pageIds],
      nodeIds: [...nodeIds],
    };
  },
});

export const getSearchableNodes = internalQuery({
  args: {
    pageId: v.optional(v.id("pages")),
  },
  handler: async (ctx, args) => {
    if (args.pageId) {
      return await listPageNodes(ctx.db, args.pageId);
    }

    const nodes = await ctx.db
      .query("nodes")
      .withIndex("by_kind_status", (query) => query.eq("kind", "task"))
      .collect();

    return nodes.filter((node) => !node.archived);
  },
});

export const hydrateNodes = internalQuery({
  args: {
    nodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    const nodes = await Promise.all(args.nodeIds.map((nodeId) => ctx.db.get(nodeId)));
    const presentNodes = nodes.filter(Boolean) as Doc<"nodes">[];

    const pages = await Promise.all(
      presentNodes.map((node) => ctx.db.get(node.pageId)),
    );
    const pageMap = new Map(
      pages.filter(Boolean).map((page) => [page!._id, page!]),
    );

    return presentNodes.map((node) => ({
      node,
      page: pageMap.get(node.pageId) ?? null,
    }));
  },
});

export const syncNodeLinks = internalMutation({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      return;
    }

    await syncLinksForNode(ctx.db, node);
  },
});
