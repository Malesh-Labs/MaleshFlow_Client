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
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey, isOwnerKeyValid } from "./lib/auth";
import {
  buildUniquePageSlug,
  collectNodeTree,
  computeNodePosition,
  deleteNodeTree,
  enqueueNodeEmbeddingRefresh,
  enqueueNodeAiWork,
  enqueuePageRootEmbeddingRefresh,
  getPageBySlug,
  listPageNodes,
  listSiblingNodes,
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
  PLANNER_FOCUS_SLOT,
  PLANNER_SIDEBAR_SLOT,
  PLANNER_TEMPLATE_SLOT,
  buildPlannerChatPromptContext,
  clonePlannerSubtree,
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
  advanceRecurringDueDateRange,
  parseRecurrenceFrequency,
  type RecurringCompletionMode,
} from "../lib/domain/recurrence";
import {
  type ExtractedLink,
  extractLinkMatches,
  extractLinks,
  getExplicitWikiLinkPreviewText,
  replaceLinkMarkupWithLabels,
  rewriteMatchingPageWikiLinks,
  rewritePlainPageWikiLinksToTarget,
} from "../lib/domain/links";
import { extractTagMatches } from "../lib/domain/tags";
import {
  isSeparatorLineText,
  stripNodeDisplaySyntaxMarkers,
} from "../lib/domain/displaySyntax";

function getTimestamp() {
  return Date.now();
}

type NodeKind = Doc<"nodes">["kind"];
type NodeTaskStatus = Doc<"nodes">["taskStatus"];

function normalizeNodeKindForText(text: string, kind: NodeKind | null | undefined) {
  return isSeparatorLineText(text) ? "note" : (kind ?? "note");
}

function normalizeTaskStatusForKind(
  kind: NodeKind,
  taskStatus: NodeTaskStatus | undefined,
  fallbackTaskStatus: NodeTaskStatus | undefined = undefined,
) {
  return kind === "task" ? (taskStatus ?? fallbackTaskStatus ?? "todo") : null;
}

const MAX_BACKLINK_COUNT_NODE_BATCH = 250;
const MAX_PAGE_TREE_NODES = 2500;
const MAX_PAGE_TREE_NODE_TEXT_CHARS = 500_000;
const MAX_PAGE_TREE_BACKLINKS = 1200;
const MAX_MULTI_PAGE_VIEW_PAGES = 8;
const MAX_MULTI_PAGE_VIEW_NODE_SECTIONS = 16;
const MAX_MULTI_PAGE_VIEW_NODES = 5000;
const MAX_MULTI_PAGE_VIEW_TEXT_CHARS = 1_000_000;
const MAX_NODE_AI_ANCESTOR_DEPTH = 40;
const MAX_NODE_AI_SUBTREE_NODES = 2000;
const PAGE_DELETE_NODE_BATCH_SIZE = 100;
const PAGE_DELETE_LINK_BATCH_SIZE = 200;
const PAGE_DELETE_MESSAGE_BATCH_SIZE = 200;
const FIND_REPLACE_PREVIEW_LIMIT = 40;
const FIND_REPLACE_BATCH_SIZE = 50;
const UNRESOLVED_PAGE_LINK_SCAN_PAGE_LIMIT = 1000;
const UNRESOLVED_PAGE_LINK_SCAN_NODE_LIMIT = 5000;
const UNRESOLVED_PAGE_LINK_GROUP_LIMIT = 100;
const UNRESOLVED_PAGE_LINK_SAMPLE_LIMIT = 4;
const UNRESOLVED_PAGE_LINK_REPLACE_BATCH_SIZE = 50;
const EMBEDDING_REBUILD_BATCH_SIZE = 200;
const MULTI_PAGE_INCLUDED_PAGES_SLOT = "multiPageIncludedPages";
const MAX_WORKSPACE_ACTION_PARENT_CANDIDATES = 12;
const MAX_WORKSPACE_ACTION_LINK_BACKLINKS = 40;
const MAX_WORKSPACE_ACTION_CHILD_PREVIEW = 5;
const MAX_WORKSPACE_ACTION_ANCESTOR_DEPTH = 8;

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
  return await listPageNodesForTreeWithCaps(
    ctx,
    pageId,
    MAX_PAGE_TREE_NODES,
    MAX_PAGE_TREE_NODE_TEXT_CHARS,
  );
}

async function listPageNodesForTreeWithCaps(
  ctx: QueryCtx,
  pageId: Id<"pages">,
  maxNodes: number,
  maxTextChars: number,
) {
  const cappedNodeLimit = Math.max(0, Math.min(maxNodes, MAX_PAGE_TREE_NODES));
  const cappedTextLimit = Math.max(0, Math.min(maxTextChars, MAX_PAGE_TREE_NODE_TEXT_CHARS));
  if (cappedNodeLimit === 0 || cappedTextLimit <= 0) {
    return {
      nodes: [] as Doc<"nodes">[],
      truncated: true,
    };
  }

  const fetchedNodes = await ctx.db
    .query("nodes")
    .withIndex("by_page_archived", (query) =>
      query.eq("pageId", pageId).eq("archived", false),
    )
    .take(cappedNodeLimit + 1);

  const nodes: Doc<"nodes">[] = [];
  let textChars = 0;

  for (const node of fetchedNodes) {
    const nextTextChars = textChars + node.text.length;
    if (nodes.length >= cappedNodeLimit || nextTextChars > cappedTextLimit) {
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
    truncated: fetchedNodes.length > cappedNodeLimit,
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

function getNodeSourceMeta(node: Pick<Doc<"nodes">, "sourceMeta"> | null | undefined) {
  return node && typeof node.sourceMeta === "object" && node.sourceMeta
    ? (node.sourceMeta as Record<string, unknown>)
    : {};
}

function hidesChildrenFromLinkAutocomplete(node: Pick<Doc<"nodes">, "sourceMeta">) {
  return getNodeSourceMeta(node).hideChildrenFromLinkAutocomplete === true;
}

function isHiddenByLinkAutocompleteAncestor(
  node: Doc<"nodes">,
  nodeMap: Map<string, Doc<"nodes">>,
) {
  const visitedNodeIds = new Set<string>();
  let parentNodeId = node.parentNodeId as string | null;

  while (parentNodeId) {
    if (visitedNodeIds.has(parentNodeId)) {
      break;
    }
    visitedNodeIds.add(parentNodeId);

    const parentNode = nodeMap.get(parentNodeId);
    if (!parentNode) {
      break;
    }
    if (hidesChildrenFromLinkAutocomplete(parentNode)) {
      return true;
    }
    parentNodeId = parentNode.parentNodeId as string | null;
  }

  return false;
}

const MIN_WORKSPACE_TEXT_BOX_COUNT = 2;

function normalizeWorkspaceTextBoxes(
  sourceMeta: Record<string, unknown>,
  textsKey: "workspaceInboxTexts" | "workspaceRandomBoxTexts",
  legacyTextKey: "workspaceInboxText" | "workspaceRandomBoxText",
) {
  const storedTexts = Array.isArray(sourceMeta[textsKey])
    ? sourceMeta[textsKey].filter((value): value is string => typeof value === "string")
    : [];
  const legacyText = typeof sourceMeta[legacyTextKey] === "string" ? sourceMeta[legacyTextKey] : "";
  const nextTexts = storedTexts.length > 0 ? [...storedTexts] : [legacyText];
  while (nextTexts.length < MIN_WORKSPACE_TEXT_BOX_COUNT) {
    nextTexts.push("");
  }
  return nextTexts;
}

function isTaskPageDoneArchiveEnabled(
  page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined,
) {
  return getPageSourceMeta(page).archiveCompletedRootTasksToDone === true;
}

function buildTaskArchiveChildrenByParent(nodes: Doc<"nodes">[]) {
  const map = new Map<string | null, Doc<"nodes">[]>();
  for (const node of nodes) {
    const key = (node.parentNodeId as string | null) ?? null;
    const siblings = map.get(key) ?? [];
    siblings.push(node);
    map.set(key, siblings);
  }

  for (const siblings of map.values()) {
    siblings.sort((left, right) => left.position - right.position);
  }

  return map;
}

function buildTaskArchiveNodeMap(nodes: Doc<"nodes">[]) {
  return new Map(nodes.map((node) => [node._id as string, node]));
}

function isTaskArchiveNodeCompleted(node: Doc<"nodes">) {
  if (node.kind === "task") {
    return node.taskStatus === "done";
  }

  return getNodeSourceMeta(node).noteCompleted === true;
}

function isTaskPageSubtreeCompleted(
  nodeId: Id<"nodes">,
  nodeMap: Map<string, Doc<"nodes">>,
  childrenByParent: Map<string | null, Doc<"nodes">[]>,
  isRoot = true,
) {
  const rootNode = nodeMap.get(nodeId as string);
  if (!rootNode) {
    return false;
  }

  if (
    rootNode.kind === "task"
      ? rootNode.taskStatus !== "done"
      : isRoot && !isTaskArchiveNodeCompleted(rootNode)
  ) {
    return false;
  }

  const descendants = childrenByParent.get(nodeId as string) ?? [];
  for (const child of descendants) {
    if (!isTaskPageSubtreeCompleted(child._id, nodeMap, childrenByParent, false)) {
      return false;
    }
  }

  return true;
}

function findArchivableTaskPageRoot(
  startNode: Doc<"nodes">,
  nodeMap: Map<string, Doc<"nodes">>,
  childrenByParent: Map<string | null, Doc<"nodes">[]>,
) {
  let currentNode: Doc<"nodes"> | null = startNode;
  while (currentNode?.parentNodeId) {
    currentNode = nodeMap.get(currentNode.parentNodeId as string) ?? null;
  }

  if (!currentNode || currentNode.kind !== "task") {
    return null;
  }

  return isTaskPageSubtreeCompleted(currentNode._id, nodeMap, childrenByParent)
    ? currentNode
    : null;
}

async function ensureDoneArchivePage(ctx: MutationCtx) {
  const archivedPages = await ctx.db
    .query("pages")
    .withIndex("by_archived_position", (query) => query.eq("archived", true))
    .take(200);
  const existing = [...archivedPages]
    .filter((page) => page.title === "Done")
    .sort((left, right) => {
      const leftTaskScore = isTaskSourcePage(left) ? 1 : 0;
      const rightTaskScore = isTaskSourcePage(right) ? 1 : 0;
      if (leftTaskScore !== rightTaskScore) {
        return rightTaskScore - leftTaskScore;
      }

      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }

      return right.createdAt - left.createdAt;
    })[0] ?? null;
  if (existing) {
    return existing;
  }

  const slug = await buildUniquePageSlug(ctx.db, "Done");
  const pageId = await ctx.db.insert("pages", {
    title: "Done",
    slug,
    icon: null,
    archived: true,
    position: Date.now(),
    sourceMeta: {
      sourceType: "system",
      pageType: "task",
      archivedPurpose: "taskHistory",
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const page = await ctx.db.get(pageId);
  if (!page) {
    throw new Error("Could not create Done.");
  }
  return page;
}

async function ensureInboxHistoryPage(ctx: MutationCtx) {
  const archivedPages = await ctx.db
    .query("pages")
    .withIndex("by_archived_position", (query) => query.eq("archived", true))
    .take(200);
  const existing = [...archivedPages]
    .filter((page) => page.title === "Inbox History")
    .sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }

      return right.createdAt - left.createdAt;
    })[0] ?? null;
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const slug = await buildUniquePageSlug(ctx.db, "Inbox History");
  const pageId = await ctx.db.insert("pages", {
    title: "Inbox History",
    slug,
    icon: null,
    archived: true,
    position: now,
    sourceMeta: {
      sourceType: "system",
      pageType: "note",
      archivedPurpose: "inboxHistory",
    },
    createdAt: now,
    updatedAt: now,
  });

  const page = await ctx.db.get(pageId);
  if (!page) {
    throw new Error("Could not create Inbox History.");
  }
  return page;
}

const JOURNAL_SECTION_SPECS = [
  {
    slot: "journalThoughts",
    title: "Thoughts/Stuff",
  },
  {
    slot: "journalWhatHappened",
    title: "What happened",
  },
  {
    slot: "journalFeedback",
    title: "Feedback",
  },
] as const;

async function ensureJournalSections(ctx: MutationCtx, page: Doc<"pages">) {
  const nodes = await listPageNodes(ctx.db, page._id);
  const rootNodes = nodes
    .filter((node) => node.parentNodeId === null)
    .sort((left, right) => left.position - right.position);
  const nodesBySlot = new Map<string, Doc<"nodes">>();
  for (const node of rootNodes) {
    const sectionSlot = getNodeSourceMeta(node).sectionSlot;
    if (typeof sectionSlot === "string" && !nodesBySlot.has(sectionSlot)) {
      nodesBySlot.set(sectionSlot, node);
    }
  }

  const now = getTimestamp();
  const sectionIds: {
    thoughtsSectionId: Id<"nodes"> | null;
    whatHappenedSectionId: Id<"nodes"> | null;
    feedbackSectionId: Id<"nodes"> | null;
  } = {
    thoughtsSectionId: null,
    whatHappenedSectionId: null,
    feedbackSectionId: null,
  };
  let afterNodeId: Id<"nodes"> | null = null;

  for (const spec of JOURNAL_SECTION_SPECS) {
    const existingSection = nodesBySlot.get(spec.slot) ?? null;
    if (existingSection) {
      afterNodeId = existingSection._id;
      if (spec.slot === "journalThoughts") {
        sectionIds.thoughtsSectionId = existingSection._id;
      } else if (spec.slot === "journalWhatHappened") {
        sectionIds.whatHappenedSectionId = existingSection._id;
      } else {
        sectionIds.feedbackSectionId = existingSection._id;
      }
      continue;
    }

    const position = await computeNodePosition(ctx.db, page._id, null, afterNodeId);
    const sectionId = await ctx.db.insert("nodes", {
      pageId: page._id,
      parentNodeId: null,
      position,
      text: spec.title,
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "system",
        sectionSlot: spec.slot,
        locked: true,
      },
      createdAt: now,
      updatedAt: now,
    });
    afterNodeId = sectionId;

    if (spec.slot === "journalThoughts") {
      sectionIds.thoughtsSectionId = sectionId;
    } else if (spec.slot === "journalWhatHappened") {
      sectionIds.whatHappenedSectionId = sectionId;
    } else {
      sectionIds.feedbackSectionId = sectionId;
    }
  }

  return sectionIds;
}

function isMultiPageViewPage(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getPageSourceMeta(page).pageType === "multiPage";
}

async function ensureMultiPageSections(ctx: MutationCtx, page: Doc<"pages">) {
  const nodes = await listPageNodes(ctx.db, page._id);
  const existingSection =
    nodes
      .filter((node) => node.parentNodeId === null)
      .find((node) => getNodeSourceMeta(node).sectionSlot === MULTI_PAGE_INCLUDED_PAGES_SLOT) ??
    null;

  if (existingSection) {
    return {
      includedPagesSectionId: existingSection._id,
    };
  }

  const rootNodes = nodes.filter((node) => node.parentNodeId === null);
  const afterNodeId =
    [...rootNodes].sort((left, right) => left.position - right.position)[
      rootNodes.length - 1
    ]?._id ?? null;
  const now = getTimestamp();
  const position = await computeNodePosition(ctx.db, page._id, null, afterNodeId);
  const sectionId = await ctx.db.insert("nodes", {
    pageId: page._id,
    parentNodeId: null,
    position,
    text: "Included Pages",
    kind: "note",
    taskStatus: null,
    priority: null,
    dueAt: null,
    dueEndAt: null,
    archived: false,
    sourceMeta: {
      sourceType: "system",
      sectionSlot: MULTI_PAGE_INCLUDED_PAGES_SLOT,
      locked: true,
    },
    createdAt: now,
    updatedAt: now,
  });

  await enqueuePageRootEmbeddingRefresh(ctx, page._id);
  return {
    includedPagesSectionId: sectionId,
  };
}

async function resolveMultiPageIncludedPage(
  db: DatabaseReader,
  node: Doc<"nodes">,
) {
  const pageLink = getFirstMultiPageIncludedPageLink(node.text);
  if (!pageLink) {
    return {
      page: null as Doc<"pages"> | null,
      reason: "Add a page link to include a page here.",
    };
  }

  if (pageLink.targetPageRef) {
    try {
      return {
        page: await db.get(pageLink.targetPageRef as Id<"pages">),
        reason: null as string | null,
      };
    } catch {
      return {
        page: null as Doc<"pages"> | null,
        reason: "That page link could not be resolved.",
      };
    }
  }

  if (pageLink.targetPageTitle) {
    const slug = slugify(pageLink.targetPageTitle, { lower: true, strict: true }) || "untitled";
    return {
      page: await getPageBySlug(db, slug),
      reason: null as string | null,
    };
  }

  return {
    page: null as Doc<"pages"> | null,
    reason: "That page link could not be resolved.",
  };
}

function getFirstMultiPageIncludedPageLink(text: string) {
  return extractLinks(text).find(
    (link): link is ExtractedLink & { kind: "page" } => link.kind === "page",
  ) ?? null;
}

function getFirstMultiPageIncludedNodeLink(text: string) {
  return extractLinks(text).find(
    (link): link is ExtractedLink & { kind: "node" } => link.kind === "node",
  ) ?? null;
}

async function resolveMultiPageIncludedNode(
  db: DatabaseReader,
  node: Doc<"nodes">,
) {
  const nodeLink = getFirstMultiPageIncludedNodeLink(node.text);
  if (!nodeLink) {
    return {
      node: null as Doc<"nodes"> | null,
      page: null as Doc<"pages"> | null,
      reason: "Add a page or node link to include content here.",
    };
  }

  try {
    const linkedNode = await db.get(nodeLink.targetNodeRef as Id<"nodes">);
    const linkedPage = linkedNode ? await db.get(linkedNode.pageId) : null;
    return {
      node: linkedNode,
      page: linkedPage,
      reason: null as string | null,
    };
  } catch {
    return {
      node: null as Doc<"nodes"> | null,
      page: null as Doc<"pages"> | null,
      reason: "That node link could not be resolved.",
    };
  }
}

function getMultiPageIncludedPageSkipReason(page: Doc<"pages"> | null) {
  if (!page || isPagePendingDeletion(page)) {
    return "That page could not be found.";
  }

  if (page.archived) {
    return "Archived pages are not shown in multi-page views.";
  }

  if (isSidebarSpecialPage(page)) {
    return "System pages are not shown in multi-page views.";
  }

  if (isPlannerPage(page)) {
    return "Planner pages are not supported in multi-page views yet.";
  }

  if (isMultiPageViewPage(page)) {
    return "Multi-page views cannot include other multi-page views.";
  }

  return null;
}

function getMultiPageIncludedNodeSkipReason(
  node: Doc<"nodes"> | null,
  page: Doc<"pages"> | null,
) {
  if (!node || !page || isPagePendingDeletion(page)) {
    return "That node could not be found.";
  }

  if (node.archived) {
    return "Archived nodes are not shown in multi-page views.";
  }

  if (page.archived) {
    return "Nodes from archived pages are not shown in multi-page views.";
  }

  if (isSidebarSpecialPage(page)) {
    return "System page nodes are not shown in multi-page views.";
  }

  if (isPlannerPage(page)) {
    return "Planner page nodes are not supported in multi-page views yet.";
  }

  return null;
}

async function archiveTaskPageSubtreeToDone(
  ctx: MutationCtx,
  taskRootNode: Doc<"nodes">,
  now: number,
) {
  const taskSubtree = await collectNodeTree(ctx.db, taskRootNode._id);
  const donePage = await ensureDoneArchivePage(ctx);
  const existingDoneRoots = (await listPageNodes(ctx.db, donePage._id)).filter(
    (node) => node.parentNodeId === null,
  );
  const afterNodeId =
    existingDoneRoots.sort((left, right) => left.position - right.position)[
      existingDoneRoots.length - 1
    ]?._id ?? null;

  await clonePlannerSubtree(ctx, {
    sourceNodes: taskSubtree,
    rootNodeId: taskRootNode._id,
    targetPageId: donePage._id,
    targetParentNodeId: null,
    targetAfterNodeId: afterNodeId,
    transformSourceMeta: (_sourceNode, sourceMeta) => ({
      ...sourceMeta,
      sourceType: "taskPageArchive",
      archivedFromTaskPageNodeId: taskRootNode._id,
      archivedAt: now,
    }),
  });

  await deleteSidebarFavoritesForNodes(ctx.db, taskSubtree);
  await setNodeTreeArchivedState(ctx.db, taskRootNode._id, true, now);
  await enqueuePageRootEmbeddingRefresh(ctx, taskRootNode.pageId);
  await enqueuePageRootEmbeddingRefresh(ctx, donePage._id);
}

async function deleteSidebarFavoritesForNodes(
  db: DatabaseWriter,
  nodes: Doc<"nodes">[],
) {
  const seenNodeIds = new Set<string>();

  for (const node of nodes) {
    if (seenNodeIds.has(node._id as string)) {
      continue;
    }
    seenNodeIds.add(node._id as string);

    const favorites = await db
      .query("sidebarFavorites")
      .withIndex("by_target", (query) =>
        query
          .eq("targetKind", "node")
          .eq("targetPageId", node.pageId)
          .eq("targetNodeId", node._id),
      )
      .take(20);

    for (const favorite of favorites) {
      await db.delete(favorite._id);
    }
  }
}

export const archiveCompletedTaskPageRootIfReady = internalMutation({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    const node = await ctx.db.get(args.nodeId);
    if (!node || node.archived || node.kind !== "task") {
      return {
        archivedRootNodeId: null as Id<"nodes"> | null,
      };
    }

    const page = await ctx.db.get(node.pageId);
    if (!page || page.archived || !isTaskSourcePage(page) || !isTaskPageDoneArchiveEnabled(page)) {
      return {
        archivedRootNodeId: null as Id<"nodes"> | null,
      };
    }

    const pageNodes = await listPageNodes(ctx.db, node.pageId);
    const nodeMap = buildTaskArchiveNodeMap(pageNodes);
    const childrenByParent = buildTaskArchiveChildrenByParent(pageNodes);
    const currentNode = nodeMap.get(node._id as string);
    if (!currentNode) {
      return {
        archivedRootNodeId: null as Id<"nodes"> | null,
      };
    }

    const archivableRoot = findArchivableTaskPageRoot(
      currentNode,
      nodeMap,
      childrenByParent,
    );
    if (!archivableRoot) {
      return {
        archivedRootNodeId: null as Id<"nodes"> | null,
      };
    }

    await archiveTaskPageSubtreeToDone(ctx, archivableRoot, getTimestamp());
    return {
      archivedRootNodeId: archivableRoot._id,
    };
  },
});

function isSidebarSpecialPage(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getPageSourceMeta(page).specialPage === "sidebar";
}

function isPagePendingDeletion(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getPageSourceMeta(page).deletingForever === true;
}

function normalizeFavoriteNodeText(node: Pick<Doc<"nodes">, "text">) {
  const replacedText = replaceLinkMarkupWithLabels(node.text).trim();
  return replacedText.length > 0 ? replacedText : node.text.trim();
}

async function getSidebarFavoriteByTarget(
  db: DatabaseReader | DatabaseWriter,
  args: {
    targetKind: "page" | "node";
    targetPageId: Id<"pages">;
    targetNodeId: Id<"nodes"> | null;
  },
) {
  return await db
    .query("sidebarFavorites")
    .withIndex("by_target", (query) =>
      query
        .eq("targetKind", args.targetKind)
        .eq("targetPageId", args.targetPageId)
        .eq("targetNodeId", args.targetNodeId),
    )
    .unique();
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

function normalizePlainPageWikiLinkTitle(value: string) {
  return slugify(value, { lower: true, strict: true }) || "untitled";
}

function isPlainUnresolvedPageWikiLink(
  link: Extract<ExtractedLink, { kind: "page" }>,
  activePageSlugs: Set<string>,
) {
  if (link.targetPageRef || !link.targetPageTitle) {
    return false;
  }

  return !activePageSlugs.has(normalizePlainPageWikiLinkTitle(link.targetPageTitle));
}

async function listActiveWorkspacePagesForLinkMaintenance(
  db: DatabaseReader | DatabaseWriter,
) {
  const fetchedPages = await db
    .query("pages")
    .withIndex("by_archived_position", (query) => query.eq("archived", false))
    .take(UNRESOLVED_PAGE_LINK_SCAN_PAGE_LIMIT + 1);
  const pages = fetchedPages
    .slice(0, UNRESOLVED_PAGE_LINK_SCAN_PAGE_LIMIT)
    .filter((page) => !isSidebarSpecialPage(page) && !isPagePendingDeletion(page));

  return {
    pages,
    truncated: fetchedPages.length > UNRESOLVED_PAGE_LINK_SCAN_PAGE_LIMIT,
  };
}

async function listActiveWorkspaceNodesForLinkMaintenance(
  db: DatabaseReader | DatabaseWriter,
  pages: Doc<"pages">[],
  maxNodes: number,
) {
  const nodes: Doc<"nodes">[] = [];
  let truncated = false;

  for (const page of pages) {
    const remaining = maxNodes - nodes.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const pageNodes = await db
      .query("nodes")
      .withIndex("by_page_archived", (query) =>
        query.eq("pageId", page._id).eq("archived", false),
      )
      .take(remaining + 1);
    const visiblePageNodes = pageNodes
      .slice(0, remaining)
      .sort((left, right) => left.position - right.position);
    nodes.push(...visiblePageNodes);

    if (pageNodes.length > remaining) {
      truncated = true;
      break;
    }
  }

  return {
    nodes,
    truncated,
  };
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
    section?: "linked" | "planner" | "backlog" | "anytime";
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

async function buildPageKnowledgeContextEntries(
  ctx: QueryCtx,
  page: Doc<"pages">,
  options?: {
    omitScheduledTaskSubtrees?: boolean;
    section?: "linked" | "planner" | "backlog";
  },
) {
  const baseEntry = await buildPageKnowledgeContextEntry(ctx, page, options);
  if (!isPlannerPage(page)) {
    return [baseEntry];
  }

  const nodes = await listPageNodes(ctx.db, page._id);
  const visibleNodes = filterNodesForKnowledgeContext(
    page,
    nodes.filter((node) => !node.archived),
  );
  const sidebarSection = findPlannerSectionNode(visibleNodes, PLANNER_SIDEBAR_SLOT);
  if (!sidebarSection) {
    return [baseEntry];
  }

  const childrenByParent = groupNodesByParent(visibleNodes);
  const sidebarSubtreeIds = new Set<string>();
  const queue: string[] = [sidebarSection._id as string];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (sidebarSubtreeIds.has(currentId)) {
      continue;
    }
    sidebarSubtreeIds.add(currentId);
    for (const child of childrenByParent.get(currentId) ?? []) {
      queue.push(child._id as string);
    }
  }

  const resolvedNodeTextCache = new Map<string, string>();
  const resolvedTextById = new Map<string, string>();
  const visibleNodeMap = new Map(visibleNodes.map((node) => [node._id as string, node]));
  for (const node of visibleNodes) {
    resolvedTextById.set(
      node._id as string,
      await resolveKnowledgeContextText(
        ctx.db,
        node.text,
        visibleNodeMap,
        resolvedNodeTextCache,
      ),
    );
  }

  const anytimeContent = buildOutlineLines(
    childrenByParent,
    sidebarSection._id,
    0,
    resolvedTextById,
  ).join("\n");

  const anytimeRepresentativeNode =
    (childrenByParent.get(sidebarSection._id as string) ?? []).find(
      (node) =>
        formatNodeForKnowledgeContext(node, resolvedTextById.get(node._id as string)).length > 0,
    ) ?? null;

  const plannerNodesWithoutSidebar = visibleNodes.filter(
    (node) => !sidebarSubtreeIds.has(node._id as string),
  );
  const plannerResolvedTextById = new Map<string, string>();
  for (const node of plannerNodesWithoutSidebar) {
    plannerResolvedTextById.set(node._id as string, resolvedTextById.get(node._id as string) ?? "");
  }
  const plannerChildrenByParent = groupNodesByParent(plannerNodesWithoutSidebar);
  const focusSection = findPlannerSectionNode(plannerNodesWithoutSidebar, PLANNER_FOCUS_SLOT);
  const plannerDayRoots = getPlannerDayRoots(plannerNodesWithoutSidebar);
  const currentDay = plannerDayRoots[0] ?? null;
  const upcomingDays = plannerDayRoots.filter((node) => node._id !== currentDay?._id);

  const focusLines = focusSection
    ? buildOutlineLines(
        plannerChildrenByParent,
        focusSection._id as string,
        0,
        plannerResolvedTextById,
      )
    : [];
  const todayDayLines = currentDay
    ? buildNodeSubtreeLines(plannerChildrenByParent, currentDay, 0, plannerResolvedTextById)
    : [];
  const upcomingLines = upcomingDays.flatMap((node) =>
    buildNodeSubtreeLines(plannerChildrenByParent, node, 0, plannerResolvedTextById),
  );
  const remainingRootLines = (plannerChildrenByParent.get(null) ?? [])
    .filter((node) => node._id !== focusSection?._id && !plannerDayRoots.some((day) => day._id === node._id))
    .flatMap((node) =>
      buildNodeSubtreeLines(plannerChildrenByParent, node, 0, plannerResolvedTextById),
    );

  const plannerContent = [
    ...(focusLines.length > 0 || todayDayLines.length > 0
      ? [
          "# Today",
          ...focusLines,
          ...todayDayLines,
        ]
      : []),
    ...(upcomingLines.length > 0
      ? [
          "# Upcoming",
          ...upcomingLines,
        ]
      : []),
    ...(remainingRootLines.length > 0
      ? [
          "# Other",
          ...remainingRootLines,
        ]
      : []),
  ].join("\n");
  const plannerRepresentativeNode =
    plannerNodesWithoutSidebar.find(
      (node) =>
        formatNodeForKnowledgeContext(node, plannerResolvedTextById.get(node._id as string))
          .length > 0,
    ) ??
    plannerNodesWithoutSidebar[0] ??
    null;

  return [
    {
      ...baseEntry,
      representativeNode: plannerRepresentativeNode,
      content: plannerContent,
      section: "planner" as const,
    },
    ...(anytimeContent.trim().length > 0
      ? [
          {
            page,
            representativeNode: anytimeRepresentativeNode,
            content: anytimeContent,
            section: "anytime" as const,
          },
        ]
      : []),
  ];
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

export const listSidebarFavorites = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const favorites = await ctx.db
      .query("sidebarFavorites")
      .withIndex("by_position")
      .collect();

    const results: Array<{
      favoriteId: Id<"sidebarFavorites">;
      targetKind: "page" | "node";
      pageId: Id<"pages">;
      pageTitle: string;
      nodeId: Id<"nodes"> | null;
      nodeText: string | null;
      isSidebarSpecialPage: boolean;
    }> = [];

    for (const favorite of favorites) {
      const page = await ctx.db.get(favorite.targetPageId);
      if (!page || page.archived || isPagePendingDeletion(page)) {
        continue;
      }

      if (favorite.targetKind === "page") {
        if (isSidebarSpecialPage(page)) {
          continue;
        }

        results.push({
          favoriteId: favorite._id,
          targetKind: "page",
          pageId: page._id,
          pageTitle: page.title,
          nodeId: null,
          nodeText: null,
          isSidebarSpecialPage: false,
        });
        continue;
      }

      if (!favorite.targetNodeId) {
        continue;
      }

      const node = await ctx.db.get(favorite.targetNodeId);
      if (!node || node.archived || node.pageId !== page._id) {
        continue;
      }

      results.push({
        favoriteId: favorite._id,
        targetKind: "node",
        pageId: page._id,
        pageTitle: page.title,
        nodeId: node._id,
        nodeText: normalizeFavoriteNodeText(node),
        isSidebarSpecialPage: isSidebarSpecialPage(page),
      });
    }

    return results;
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

export const getWorkspaceInbox = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const pages = await ctx.db.query("pages").collect();
    const sidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;
    const sourceMeta = getPageSourceMeta(sidebarPage);
    const texts = normalizeWorkspaceTextBoxes(
      sourceMeta,
      "workspaceInboxTexts",
      "workspaceInboxText",
    );

    return {
      text: texts[0] ?? "",
      texts,
      updatedAt: sidebarPage?.updatedAt ?? null,
    };
  },
});

export const getWorkspaceRandomBox = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const pages = await ctx.db.query("pages").collect();
    const sidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;
    const sourceMeta = getPageSourceMeta(sidebarPage);
    const texts = normalizeWorkspaceTextBoxes(
      sourceMeta,
      "workspaceRandomBoxTexts",
      "workspaceRandomBoxText",
    );

    return {
      text: texts[0] ?? "",
      texts,
      updatedAt: sidebarPage?.updatedAt ?? null,
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

export const setWorkspaceInbox = mutation({
  args: {
    ownerKey: v.string(),
    texts: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const texts = [...args.texts];
    while (texts.length < MIN_WORKSPACE_TEXT_BOX_COUNT) {
      texts.push("");
    }

    const pages = await ctx.db.query("pages").collect();
    const sidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;

    if (!sidebarPage) {
      const now = getTimestamp();
      const slug = await buildUniquePageSlug(ctx.db, "Sidebar");
      const sidebarPageId = await ctx.db.insert("pages", {
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
          workspaceInboxText: texts[0] ?? "",
          workspaceInboxTexts: texts,
        },
        createdAt: now,
        updatedAt: now,
      });
      return {
        pageId: sidebarPageId,
        text: texts[0] ?? "",
        texts,
      };
    }

    const nextSourceMeta = {
      ...getPageSourceMeta(sidebarPage),
      workspaceInboxText: texts[0] ?? "",
      workspaceInboxTexts: texts,
      pageType: "note",
      sidebarSection: "Notes",
    };

    await ctx.db.patch(sidebarPage._id, {
      sourceMeta: nextSourceMeta,
      updatedAt: getTimestamp(),
    });

    return {
      pageId: sidebarPage._id,
      text: texts[0] ?? "",
      texts,
    };
  },
});

export const clearWorkspaceInbox = mutation({
  args: {
    ownerKey: v.string(),
    index: v.number(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const pages = await ctx.db.query("pages").collect();
    const sidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;
    const now = getTimestamp();
    let historyPageId: Id<"pages"> | null = null;
    const hasArchivedText = args.text.trim().length > 0;
    const currentSourceMeta = getPageSourceMeta(sidebarPage);
    const nextTexts = normalizeWorkspaceTextBoxes(
      currentSourceMeta,
      "workspaceInboxTexts",
      "workspaceInboxText",
    );
    const safeIndex = Math.max(0, Math.min(Math.floor(args.index), nextTexts.length - 1));
    nextTexts[safeIndex] = "";

    if (hasArchivedText) {
      const inboxHistoryPage = await ensureInboxHistoryPage(ctx);
      historyPageId = inboxHistoryPage._id;
      const historyPageNodes = await listPageNodes(ctx.db, inboxHistoryPage._id);
      const rootNodes = historyPageNodes
        .filter((node) => node.parentNodeId === null)
        .sort((left, right) => left.position - right.position);
      const historyPageSourceMeta = getPageSourceMeta(inboxHistoryPage);
      const targetParentNodeId =
        historyPageSourceMeta.pageType === "scratchpad"
          ? rootNodes.find(
              (node) => getNodeSourceMeta(node).sectionSlot === "scratchpadPrevious",
            )?._id ?? null
          : null;
      const existingRootNodes = historyPageNodes.filter(
        (node) => node.parentNodeId === targetParentNodeId,
      );
      const afterRootNodeId =
        existingRootNodes.sort((left, right) => left.position - right.position)[
          existingRootNodes.length - 1
        ]?._id ?? null;
      const rootPosition = await computeNodePosition(
        ctx.db,
        inboxHistoryPage._id,
        targetParentNodeId,
        afterRootNodeId,
      );
      const rootNodeId = await ctx.db.insert("nodes", {
        pageId: inboxHistoryPage._id,
        parentNodeId: targetParentNodeId,
        position: rootPosition,
        text: `Inbox capture ${new Date(now).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}`,
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        dueEndAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          noteCompleted: false,
          taskKindLocked: false,
          recurrenceFrequency: null,
          inboxCapturedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      });
      const childPosition = await computeNodePosition(
        ctx.db,
        inboxHistoryPage._id,
        rootNodeId,
        null,
      );
      const childNodeId = await ctx.db.insert("nodes", {
        pageId: inboxHistoryPage._id,
        parentNodeId: rootNodeId,
        position: childPosition,
        text: args.text,
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        dueEndAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "system",
          noteCompleted: false,
          taskKindLocked: false,
          recurrenceFrequency: null,
          inboxCapturedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      });

      const rootNode = await ctx.db.get(rootNodeId);
      if (rootNode) {
        await syncLinksForNode(ctx.db, rootNode);
        await enqueueNodeAiWork(ctx, rootNodeId);
      }
      const childNode = await ctx.db.get(childNodeId);
      if (childNode) {
        await syncLinksForNode(ctx.db, childNode);
        await enqueueNodeAiWork(ctx, childNodeId);
      }
      await enqueuePageRootEmbeddingRefresh(ctx, inboxHistoryPage._id);
    }

    if (sidebarPage) {
      await ctx.db.patch(sidebarPage._id, {
        sourceMeta: {
          ...currentSourceMeta,
          workspaceInboxText: nextTexts[0] ?? "",
          workspaceInboxTexts: nextTexts,
          pageType: "note",
          sidebarSection: "Notes",
        },
        updatedAt: now,
      });
    }

    return {
      archived: hasArchivedText,
      historyPageId,
      pageId: sidebarPage?._id ?? null,
      text: nextTexts[0] ?? "",
      texts: nextTexts,
    };
  },
});

export const setWorkspaceRandomBox = mutation({
  args: {
    ownerKey: v.string(),
    texts: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const texts = [...args.texts];
    while (texts.length < MIN_WORKSPACE_TEXT_BOX_COUNT) {
      texts.push("");
    }

    const pages = await ctx.db.query("pages").collect();
    const sidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;

    if (!sidebarPage) {
      const now = getTimestamp();
      const slug = await buildUniquePageSlug(ctx.db, "Sidebar");
      const sidebarPageId = await ctx.db.insert("pages", {
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
          workspaceRandomBoxText: texts[0] ?? "",
          workspaceRandomBoxTexts: texts,
        },
        createdAt: now,
        updatedAt: now,
      });
      return {
        pageId: sidebarPageId,
        text: texts[0] ?? "",
        texts,
      };
    }

    const nextSourceMeta = {
      ...getPageSourceMeta(sidebarPage),
      workspaceRandomBoxText: texts[0] ?? "",
      workspaceRandomBoxTexts: texts,
      pageType: "note",
      sidebarSection: "Notes",
    };

    await ctx.db.patch(sidebarPage._id, {
      sourceMeta: nextSourceMeta,
      updatedAt: getTimestamp(),
    });

    return {
      pageId: sidebarPage._id,
      text: texts[0] ?? "",
      texts,
    };
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

    return await buildPageTreeResult(ctx, page);
  },
});

export const getMultiPageView = query({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || isPagePendingDeletion(page) || !isMultiPageViewPage(page)) {
      return null;
    }

    const nodesResult = await listPageNodesForTree(ctx, page._id);
    const nodes = nodesResult.nodes;
    const includedPagesSection =
      nodes
        .filter((node) => node.parentNodeId === null)
        .find((node) => getNodeSourceMeta(node).sectionSlot === MULTI_PAGE_INCLUDED_PAGES_SLOT) ??
      null;

    if (!includedPagesSection) {
      return {
        includedPages: [],
        includedNodes: [],
        includedItems: [],
        skippedRows: [],
        loadWarning: "Add the Included Pages section to configure this view.",
      };
    }

    const includeRows = nodes
      .filter((node) => node.parentNodeId === includedPagesSection._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    const includedPages: Array<{
      configNodeId: Id<"nodes">;
      pageTree: Awaited<ReturnType<typeof buildPageTreeResult>>;
    }> = [];
    const includedNodes: Array<{
      configNodeId: Id<"nodes">;
      nodeTree: Awaited<ReturnType<typeof buildNodeTreeResult>>;
    }> = [];
    const includedItems: Array<
      | {
          kind: "page";
          configNodeId: Id<"nodes">;
          pageTree: Awaited<ReturnType<typeof buildPageTreeResult>>;
        }
      | {
          kind: "node";
          configNodeId: Id<"nodes">;
          nodeTree: Awaited<ReturnType<typeof buildNodeTreeResult>>;
        }
    > = [];
    const skippedRows: Array<{
      configNodeId: Id<"nodes">;
      text: string;
      reason: string;
    }> = [];
    const includedPageIds = new Set<string>();
    const includedNodeIds = new Set<string>();
    let remainingNodes = MAX_MULTI_PAGE_VIEW_NODES;
    let remainingTextChars = MAX_MULTI_PAGE_VIEW_TEXT_CHARS;
    let reachedPageLimit = false;
    let reachedNodeLimit = false;

    for (const row of includeRows) {
      if (getFirstMultiPageIncludedPageLink(row.text)) {
        if (includedPages.length >= MAX_MULTI_PAGE_VIEW_PAGES) {
          reachedPageLimit = true;
          skippedRows.push({
            configNodeId: row._id,
            text: row.text,
            reason: `Only the first ${MAX_MULTI_PAGE_VIEW_PAGES} included pages are shown.`,
          });
          continue;
        }

        const resolved = await resolveMultiPageIncludedPage(ctx.db, row);
        const skipReason = resolved.page
          ? getMultiPageIncludedPageSkipReason(resolved.page)
          : (resolved.reason ?? "That page link could not be resolved.");
        if (skipReason) {
          skippedRows.push({
            configNodeId: row._id,
            text: row.text,
            reason: skipReason,
          });
          continue;
        }

        const includedPage = resolved.page;
        if (!includedPage) {
          skippedRows.push({
            configNodeId: row._id,
            text: row.text,
            reason: "That page link could not be resolved.",
          });
          continue;
        }

        if (includedPageIds.has(includedPage._id as string)) {
          skippedRows.push({
            configNodeId: row._id,
            text: row.text,
            reason: "This page is already included above.",
          });
          continue;
        }

        const pageTree = await buildPageTreeResult(ctx, includedPage, {
          maxNodes: remainingNodes,
          maxTextChars: remainingTextChars,
        });
        const includedPageEntry = {
          configNodeId: row._id,
          pageTree,
        };
        includedPages.push(includedPageEntry);
        includedItems.push({
          kind: "page",
          ...includedPageEntry,
        });
        includedPageIds.add(includedPage._id as string);
        remainingNodes = Math.max(0, remainingNodes - pageTree.nodes.length);
        remainingTextChars = Math.max(
          0,
          remainingTextChars - pageTree.nodes.reduce((total, node) => total + node.text.length, 0),
        );
        continue;
      }

      if (getFirstMultiPageIncludedNodeLink(row.text)) {
        if (includedNodes.length >= MAX_MULTI_PAGE_VIEW_NODE_SECTIONS) {
          reachedNodeLimit = true;
          skippedRows.push({
            configNodeId: row._id,
            text: row.text,
            reason: `Only the first ${MAX_MULTI_PAGE_VIEW_NODE_SECTIONS} included nodes are shown.`,
          });
          continue;
        }

        const resolved = await resolveMultiPageIncludedNode(ctx.db, row);
        const skipReason = resolved.node
          ? getMultiPageIncludedNodeSkipReason(resolved.node, resolved.page)
          : (resolved.reason ?? "That node link could not be resolved.");
        if (skipReason) {
          skippedRows.push({
            configNodeId: row._id,
            text: row.text,
            reason: skipReason,
          });
          continue;
        }

        const includedNode = resolved.node;
        const sourcePage = resolved.page;
        if (!includedNode || !sourcePage) {
          skippedRows.push({
            configNodeId: row._id,
            text: row.text,
            reason: "That node link could not be resolved.",
          });
          continue;
        }

        if (includedNodeIds.has(includedNode._id as string)) {
          skippedRows.push({
            configNodeId: row._id,
            text: row.text,
            reason: "This node is already included above.",
          });
          continue;
        }

        const nodeTree = await buildNodeTreeResult(ctx, includedNode, sourcePage, {
          maxNodes: remainingNodes,
          maxTextChars: remainingTextChars,
        });
        const includedNodeEntry = {
          configNodeId: row._id,
          nodeTree,
        };
        includedNodes.push(includedNodeEntry);
        includedItems.push({
          kind: "node",
          ...includedNodeEntry,
        });
        includedNodeIds.add(includedNode._id as string);
        remainingNodes = Math.max(0, remainingNodes - nodeTree.nodes.length);
        remainingTextChars = Math.max(
          0,
          remainingTextChars - nodeTree.nodes.reduce((total, node) => total + node.text.length, 0),
        );
        continue;
      }

      skippedRows.push({
        configNodeId: row._id,
        text: row.text,
        reason: "Add a page or node link to include content here.",
      });
    }

    const warningParts = [
      reachedPageLimit ? `Only the first ${MAX_MULTI_PAGE_VIEW_PAGES} pages are shown.` : "",
      reachedNodeLimit
        ? `Only the first ${MAX_MULTI_PAGE_VIEW_NODE_SECTIONS} nodes are shown.`
        : "",
      remainingNodes === 0 || remainingTextChars === 0
        ? "This multi-page view hit its load limit, so later content may be omitted."
        : "",
    ].filter((value) => value.length > 0);

    return {
      includedPages,
      includedNodes,
      includedItems,
      skippedRows,
      loadWarning: warningParts.length > 0 ? warningParts.join(" ") : null,
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

export const listUnresolvedPageLinkGroups = query({
  args: {
    ownerKey: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const limit = Math.max(
      1,
      Math.min(args.limit ?? UNRESOLVED_PAGE_LINK_GROUP_LIMIT, UNRESOLVED_PAGE_LINK_GROUP_LIMIT),
    );
    const pageResult = await listActiveWorkspacePagesForLinkMaintenance(ctx.db);
    const activePageSlugs = new Set(pageResult.pages.map((page) => page.slug));
    const pageMap = new Map(pageResult.pages.map((page) => [page._id, page]));
    const nodeResult = await listActiveWorkspaceNodesForLinkMaintenance(
      ctx.db,
      pageResult.pages,
      UNRESOLVED_PAGE_LINK_SCAN_NODE_LIMIT,
    );
    const groups = new Map<
      string,
      {
        normalizedTitle: string;
        title: string;
        occurrenceCount: number;
        nodeIds: Set<string>;
        samples: Array<{
          nodeId: Id<"nodes">;
          pageId: Id<"pages">;
          pageTitle: string;
          nodeText: string;
          occurrenceCount: number;
        }>;
      }
    >();

    for (const node of nodeResult.nodes) {
      const page = pageMap.get(node.pageId);
      if (!page) {
        continue;
      }

      const occurrencesByTitle = new Map<string, number>();
      const titleByNormalizedTitle = new Map<string, string>();
      for (const match of extractLinkMatches(node.text)) {
        if (
          match.link.kind !== "page" ||
          !isPlainUnresolvedPageWikiLink(match.link, activePageSlugs)
        ) {
          continue;
        }

        const targetPageTitle = match.link.targetPageTitle ?? "";
        const normalizedTitle = normalizePlainPageWikiLinkTitle(targetPageTitle);
        occurrencesByTitle.set(
          normalizedTitle,
          (occurrencesByTitle.get(normalizedTitle) ?? 0) + 1,
        );
        if (!titleByNormalizedTitle.has(normalizedTitle)) {
          titleByNormalizedTitle.set(normalizedTitle, targetPageTitle.trim());
        }
      }

      for (const [normalizedTitle, nodeOccurrenceCount] of occurrencesByTitle) {
        const existing = groups.get(normalizedTitle) ?? {
          normalizedTitle,
          title: titleByNormalizedTitle.get(normalizedTitle) ?? normalizedTitle,
          occurrenceCount: 0,
          nodeIds: new Set<string>(),
          samples: [],
        };

        existing.occurrenceCount += nodeOccurrenceCount;
        existing.nodeIds.add(node._id as string);
        if (existing.samples.length < UNRESOLVED_PAGE_LINK_SAMPLE_LIMIT) {
          existing.samples.push({
            nodeId: node._id,
            pageId: page._id,
            pageTitle: page.title,
            nodeText: node.text,
            occurrenceCount: nodeOccurrenceCount,
          });
        }
        groups.set(normalizedTitle, existing);
      }
    }

    return {
      groups: [...groups.values()]
        .sort((left, right) => {
          if (left.occurrenceCount !== right.occurrenceCount) {
            return right.occurrenceCount - left.occurrenceCount;
          }

          return left.title.localeCompare(right.title);
        })
        .slice(0, limit)
        .map((group) => ({
          normalizedTitle: group.normalizedTitle,
          title: group.title,
          occurrenceCount: group.occurrenceCount,
          nodeCount: group.nodeIds.size,
          samples: group.samples,
        })),
      scanTruncated: pageResult.truncated || nodeResult.truncated,
      scannedNodeCount: nodeResult.nodes.length,
    };
  },
});

type UnresolvedPageLinkReplacementTarget =
  | {
      kind: "node";
      nodeId: Id<"nodes">;
    }
  | {
      kind: "page";
      pageId: Id<"pages">;
    };

async function replaceUnresolvedPageLinksWithTargetBatch(
  ctx: MutationCtx,
  args: {
    normalizedTitle: string;
    target: UnresolvedPageLinkReplacementTarget;
    batchSize?: number;
  },
) {
  let targetNode: Doc<"nodes"> | null = null;
  let targetPage: Doc<"pages"> | null = null;

  if (args.target.kind === "node") {
    targetNode = await ctx.db.get(args.target.nodeId);
    if (!targetNode || targetNode.archived) {
      throw new Error("Target item not found.");
    }
    targetPage = await ctx.db.get(targetNode.pageId);
  } else {
    targetPage = await ctx.db.get(args.target.pageId);
    if (!targetPage) {
      throw new Error("Target page not found.");
    }
  }

  if (
    !targetPage ||
    targetPage.archived ||
    isSidebarSpecialPage(targetPage) ||
    isPagePendingDeletion(targetPage)
  ) {
    throw new Error(
      args.target.kind === "node"
        ? "Target item must be on an active workspace page."
        : "Target page must be an active workspace page.",
    );
  }

  const normalizedTitle = args.normalizedTitle.trim();
  if (normalizedTitle.length === 0) {
    throw new Error("Choose an unresolved link to resolve.");
  }

  const batchSize = Math.max(
    1,
    Math.min(
      args.batchSize ?? UNRESOLVED_PAGE_LINK_REPLACE_BATCH_SIZE,
      UNRESOLVED_PAGE_LINK_REPLACE_BATCH_SIZE,
    ),
  );
  const pageResult = await listActiveWorkspacePagesForLinkMaintenance(ctx.db);
  const activePageSlugs = new Set(pageResult.pages.map((page) => page.slug));
  const nodeResult = await listActiveWorkspaceNodesForLinkMaintenance(
    ctx.db,
    pageResult.pages,
    UNRESOLVED_PAGE_LINK_SCAN_NODE_LIMIT,
  );
  const replacements: Array<{
    nodeId: Id<"nodes">;
    pageId: Id<"pages">;
    text: string;
    occurrenceCount: number;
  }> = [];

  for (const node of nodeResult.nodes) {
    const replacement = rewritePlainPageWikiLinksToTarget(
      node.text,
      (link) =>
        isPlainUnresolvedPageWikiLink(link, activePageSlugs) &&
        normalizePlainPageWikiLinkTitle(link.targetPageTitle ?? "") === normalizedTitle,
      args.target.kind === "node"
        ? {
            kind: "node",
            ref: targetNode!._id as string,
          }
        : {
            kind: "page",
            ref: targetPage._id as string,
          },
    );

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
  const touchedPageIds = new Set<Id<"pages">>();
  const now = getTimestamp();

  for (const replacement of replacements) {
    await ctx.db.patch(replacement.nodeId, {
      text: replacement.text,
      updatedAt: now,
    });
    const refreshedNode = await ctx.db.get(replacement.nodeId);
    if (!refreshedNode) {
      continue;
    }

    replacedOccurrenceCount += replacement.occurrenceCount;
    touchedPageIds.add(replacement.pageId);
    await syncLinksForNode(ctx.db, refreshedNode);
    await enqueueNodeAiWork(ctx, refreshedNode._id);
  }

  for (const pageId of touchedPageIds) {
    await enqueuePageRootEmbeddingRefresh(ctx, pageId);
  }

  const scanTruncated = pageResult.truncated || nodeResult.truncated;
  return {
    replacedNodeCount: replacements.length,
    replacedOccurrenceCount,
    hasMore: replacements.length >= batchSize || (scanTruncated && replacements.length > 0),
    scanTruncated,
    targetKind: args.target.kind,
    targetNodeId: targetNode?._id ?? null,
    targetPageId: targetPage._id,
  };
}

export const replaceUnresolvedPageLinksWithTarget = mutation({
  args: {
    ownerKey: v.string(),
    normalizedTitle: v.string(),
    target: v.union(
      v.object({
        kind: v.literal("node"),
        nodeId: v.id("nodes"),
      }),
      v.object({
        kind: v.literal("page"),
        pageId: v.id("pages"),
      }),
    ),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    return await replaceUnresolvedPageLinksWithTargetBatch(ctx, args);
  },
});

export const replaceUnresolvedPageLinksWithNode = mutation({
  args: {
    ownerKey: v.string(),
    normalizedTitle: v.string(),
    targetNodeId: v.id("nodes"),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    return await replaceUnresolvedPageLinksWithTargetBatch(ctx, {
      normalizedTitle: args.normalizedTitle,
      target: {
        kind: "node",
        nodeId: args.targetNodeId,
      },
      batchSize: args.batchSize,
    });
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
    const limit = Math.max(1, Math.min(args.limit ?? 12, 24));

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
        const lengthDelta = left.title.trim().length - right.title.trim().length;
        if (lengthDelta !== 0) {
          return lengthDelta;
        }
        return left.position - right.position;
      })
      .slice(0, limit);

    const activePageIds = new Set(visiblePages.map((page) => page._id));
    const activeNodes = (await ctx.db.query("nodes").collect()).filter(
      (node) => !node.archived && activePageIds.has(node.pageId),
    );
    const activeNodeMap = new Map(activeNodes.map((node) => [node._id as string, node]));
    const nodes = activeNodes.filter(
      (node) =>
        node._id !== args.excludeNodeId &&
        node.text.trim().length > 0 &&
        node.text.trim() !== "." &&
        !isHiddenByLinkAutocompleteAncestor(node, activeNodeMap),
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
        const lengthDelta = left.text.trim().length - right.text.trim().length;
        if (lengthDelta !== 0) {
          return lengthDelta;
        }
        return right.updatedAt - left.updatedAt;
      })
      .slice(0, limit)
      .map((node) => ({
        node,
        page: pageMap.get(node.pageId) ?? null,
        parentNode: node.parentNodeId
          ? activeNodeMap.get(node.parentNodeId as string) ?? null
          : null,
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
    const parentNodeIds = [
      ...new Set(
        nodes
          .flatMap((node) =>
            node !== null && node.parentNodeId !== null ? [node.parentNodeId] : [],
          ),
      ),
    ];
    const parentNodes = await Promise.all(
      parentNodeIds.map((nodeId) => ctx.db.get(nodeId)),
    );
    const parentNodeMap = new Map(
      parentNodes
        .filter((node): node is Doc<"nodes"> => node !== null)
        .map((node) => [node._id, node]),
    );

    return nodes
      .filter((node): node is Doc<"nodes"> => node !== null)
      .map((node) => {
        const page = pageMap.get(node.pageId) ?? null;
        const parentNode = node.parentNodeId
          ? (parentNodeMap.get(node.parentNodeId) ?? null)
          : null;
        return {
          nodeId: node._id,
          pageId: page?._id ?? null,
          text: node.text,
          archived: node.archived,
          pageArchived: page?.archived ?? false,
          parentNodeId: parentNode?._id ?? null,
          parentText: parentNode && !parentNode.archived ? parentNode.text : null,
          parentArchived: parentNode?.archived ?? false,
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

async function buildPageTreeResult(
  ctx: QueryCtx,
  page: Doc<"pages">,
  options: {
    maxNodes?: number;
    maxTextChars?: number;
  } = {},
) {
  const warnings: string[] = [];

  let nodes: Doc<"nodes">[] = [];
  let nodesTruncated = false;
  try {
    const result =
      options.maxNodes !== undefined || options.maxTextChars !== undefined
        ? await listPageNodesForTreeWithCaps(
            ctx,
            page._id,
            options.maxNodes ?? MAX_PAGE_TREE_NODES,
            options.maxTextChars ?? MAX_PAGE_TREE_NODE_TEXT_CHARS,
          )
        : await listPageNodesForTree(ctx, page._id);
    nodes = result.nodes;
    nodesTruncated = result.truncated;
    if (nodesTruncated) {
      warnings.push(
        "This page is too large to load fully right now, so only the first portion is shown.",
      );
    }
  } catch (error) {
    console.error("Failed to load page-tree nodes", {
      pageId: page._id,
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
      const backlinkResult = await listPageBacklinksForTree(ctx, page._id);
      backlinksTruncated = backlinkResult.truncated;
      if (backlinksTruncated) {
        warnings.push("Backlink counts are partial for this page.");
      }
      visibleBacklinks = (await filterVisibleLinks(ctx, backlinkResult.backlinks)).filter(
        (link) => link.kind === "page",
      );
    } catch (error) {
      console.error("Failed to load page-tree backlinks", {
        pageId: page._id,
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
          { excludeSourcePageId: page._id },
        ),
      );
    } catch (error) {
      console.error("Failed to build page-tree node backlink counts", {
        pageId: page._id,
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
}

async function collectNodeTreeForTreeWithCaps(
  ctx: QueryCtx,
  rootNode: Doc<"nodes">,
  maxNodes: number,
  maxTextChars: number,
) {
  const cappedNodeLimit = Math.max(0, Math.min(maxNodes, MAX_PAGE_TREE_NODES));
  const cappedTextLimit = Math.max(0, Math.min(maxTextChars, MAX_PAGE_TREE_NODE_TEXT_CHARS));
  if (cappedNodeLimit === 0 || cappedTextLimit <= 0) {
    return {
      nodes: [] as Doc<"nodes">[],
      truncated: true,
    };
  }

  const nodes: Doc<"nodes">[] = [];
  const queue: Doc<"nodes">[] = [rootNode];
  let textChars = 0;
  let truncated = false;

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.archived) {
      continue;
    }

    const nextTextChars = textChars + node.text.length;
    if (nodes.length >= cappedNodeLimit || nextTextChars > cappedTextLimit) {
      truncated = true;
      break;
    }

    nodes.push(node);
    textChars = nextTextChars;

    const remainingSlots = cappedNodeLimit - nodes.length;
    if (remainingSlots <= 0) {
      if (queue.length > 0) {
        truncated = true;
      }
      continue;
    }

    const children = await ctx.db
      .query("nodes")
      .withIndex("by_page_parent_position", (query) =>
        query.eq("pageId", node.pageId).eq("parentNodeId", node._id),
      )
      .take(remainingSlots + 1);
    const activeChildren = children.filter((child) => !child.archived);
    if (children.length > remainingSlots || activeChildren.length > remainingSlots) {
      truncated = true;
    }
    queue.push(...activeChildren.slice(0, remainingSlots));
  }

  return {
    nodes,
    truncated: truncated || queue.length > 0,
  };
}

async function buildNodeTreeResult(
  ctx: QueryCtx,
  rootNode: Doc<"nodes">,
  sourcePage: Doc<"pages">,
  options: {
    maxNodes?: number;
    maxTextChars?: number;
  } = {},
) {
  const warnings: string[] = [];
  const result = await collectNodeTreeForTreeWithCaps(
    ctx,
    rootNode,
    options.maxNodes ?? MAX_PAGE_TREE_NODES,
    options.maxTextChars ?? MAX_PAGE_TREE_NODE_TEXT_CHARS,
  );
  const nodes = result.nodes;
  if (result.truncated) {
    warnings.push(
      "This item is too large to load fully right now, so only the first portion is shown.",
    );
  }

  let nodeBacklinkCounts: Record<string, number> = {};
  if (nodes.length > 0 && !result.truncated) {
    try {
      nodeBacklinkCounts = mergeNodeBacklinkCounts(
        buildLocalNodeBacklinkCounts(nodes),
        await buildVisibleNodeBacklinkCounts(
          ctx,
          nodes.map((node) => node._id),
          { excludeSourcePageId: sourcePage._id },
        ),
      );
    } catch (error) {
      console.error("Failed to build multi-page node backlink counts", {
        nodeId: rootNode._id,
        error,
      });
      warnings.push("Some backlink badges were skipped while loading this item.");
    }
  }

  return {
    sourcePage,
    rootNode,
    nodes,
    nodeBacklinkCounts,
    loadWarning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}

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
        v.literal("Views"),
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
        v.literal("multiPage"),
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
      const journalPage = await ctx.db.get(pageId);
      if (journalPage) {
        await ensureJournalSections(ctx, journalPage);
      }
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

    if (args.pageType === "multiPage") {
      const multiPage = await ctx.db.get(pageId);
      if (multiPage) {
        await ensureMultiPageSections(ctx, multiPage);
      }
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

export const ensureJournalPageSections = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || getPageSourceMeta(page).pageType !== "journal") {
      throw new Error("Only journal pages can have journal sections.");
    }

    return await ensureJournalSections(ctx, page);
  },
});

export const ensureMultiPagePageSections = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isMultiPageViewPage(page)) {
      throw new Error("Only multi-page views can have view sections.");
    }

    return await ensureMultiPageSections(ctx, page);
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

export const setTaskPageDoneArchiveEnabled = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || !isTaskSourcePage(page)) {
      throw new Error("Only active task pages can toggle Done archiving.");
    }

    const nextSourceMeta = {
      ...getPageSourceMeta(page),
      archiveCompletedRootTasksToDone: args.enabled,
    };
    await ctx.db.patch(args.pageId, {
      sourceMeta: nextSourceMeta,
      updatedAt: getTimestamp(),
    });

    return args.enabled;
  },
});

export const setPageDataDumpExcluded = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    excluded: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || isSidebarSpecialPage(page) || isPagePendingDeletion(page)) {
      throw new Error("Page not found.");
    }

    const sourceMeta = {
      ...getPageSourceMeta(page),
    };
    if (args.excluded) {
      sourceMeta.excludeFromDataDump = true;
    } else {
      delete sourceMeta.excludeFromDataDump;
    }

    await ctx.db.patch(args.pageId, {
      sourceMeta,
      updatedAt: getTimestamp(),
    });

    return args.excluded;
  },
});

export const setNodeChildrenLinkAutocompleteHidden = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    hidden: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const node = await ctx.db.get(args.nodeId);
    if (!node || node.archived) {
      throw new Error("Item not found.");
    }

    const sourceMeta = {
      ...getNodeSourceMeta(node),
    };
    if (args.hidden) {
      sourceMeta.hideChildrenFromLinkAutocomplete = true;
    } else {
      delete sourceMeta.hideChildrenFromLinkAutocomplete;
    }

    await ctx.db.patch(args.nodeId, {
      sourceMeta,
      updatedAt: getTimestamp(),
    });

    return args.hidden;
  },
});

export const setNodeDataDumpExcluded = mutation({
  args: {
    ownerKey: v.string(),
    nodeIds: v.array(v.id("nodes")),
    excluded: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const uniqueNodeIds = [
      ...new Set(args.nodeIds.map((nodeId) => nodeId as string)),
    ] as Id<"nodes">[];
    const now = getTimestamp();
    let updatedCount = 0;

    for (const nodeId of uniqueNodeIds) {
      const node = await ctx.db.get(nodeId);
      if (!node) {
        throw new Error("Item not found.");
      }

      const sourceMeta = {
        ...getNodeSourceMeta(node),
      };
      if (args.excluded) {
        sourceMeta.excludeFromDataDump = true;
      } else {
        delete sourceMeta.excludeFromDataDump;
      }

      await ctx.db.patch(nodeId, {
        sourceMeta,
        updatedAt: now,
      });
      updatedCount += 1;
    }

    return {
      updatedCount,
      excluded: args.excluded,
    };
  },
});

export const completeTaskPageTask = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    completionMode: v.union(v.literal("dueDate"), v.literal("today")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const node = await ctx.db.get(args.nodeId);
    if (!node || node.archived) {
      throw new Error("Task item not found.");
    }
    if (node.kind !== "task") {
      throw new Error("Only task items can be completed this way.");
    }

    const page = await ctx.db.get(node.pageId);
    if (!page || page.archived || !isTaskSourcePage(page)) {
      throw new Error("Task page not found.");
    }

    const recurrenceFrequency = parseRecurrenceFrequency(
      getNodeSourceMeta(node).recurrenceFrequency,
    );
    const nextPatch: {
      taskStatus: "todo" | "done";
      dueAt?: number | null;
      dueEndAt?: number | null;
      updatedAt: number;
    } = {
      taskStatus: node.taskStatus === "done" ? "todo" : "done",
      updatedAt: getTimestamp(),
    };

    if (recurrenceFrequency && node.dueAt) {
      if (node.taskStatus === "done") {
        nextPatch.taskStatus = "todo";
        nextPatch.dueAt = node.dueAt;
        nextPatch.dueEndAt = node.dueEndAt ?? null;
      } else {
        const nextRange = advanceRecurringDueDateRange({
          dueAt: node.dueAt,
          dueEndAt: node.dueEndAt ?? null,
          frequency: recurrenceFrequency,
          mode: args.completionMode,
        });
        nextPatch.taskStatus = "todo";
        nextPatch.dueAt = nextRange.dueAt;
        nextPatch.dueEndAt = nextRange.dueEndAt;
      }
    }

    await ctx.db.patch(node._id, nextPatch);

    const refreshedNode = await ctx.db.get(node._id);
    if (!refreshedNode) {
      throw new Error("Task item not found after completion.");
    }

    await syncLinksForNode(ctx.db, refreshedNode);
    await enqueueNodeAiWork(ctx, refreshedNode._id);
    await enqueuePageRootEmbeddingRefresh(ctx, refreshedNode.pageId);

    if (!isTaskPageDoneArchiveEnabled(page)) {
      return {
        archivedRootNodeId: null as Id<"nodes"> | null,
      };
    }

    if (refreshedNode.taskStatus === "done") {
      await ctx.scheduler.runAfter(
        0,
        internal.workspace.archiveCompletedTaskPageRootIfReady,
        {
          nodeId: refreshedNode._id,
        },
      );
    }
    return {
      archivedRootNodeId: null as Id<"nodes"> | null,
    };
  },
});

export const setModelPageCustomPrompt = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived) {
      throw new Error("Page not found.");
    }

    const pageSourceMeta = getPageSourceMeta(page);
    if (pageSourceMeta.pageType !== "model") {
      throw new Error("Only model pages can store a custom prompt.");
    }

    await ctx.db.patch(args.pageId, {
      sourceMeta: {
        ...pageSourceMeta,
        modelCustomPrompt: args.prompt,
      },
      updatedAt: getTimestamp(),
    });

    return args.prompt;
  },
});

export const setPagePinnedInAllSidebar = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    pinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || isSidebarSpecialPage(page) || isPagePendingDeletion(page)) {
      throw new Error("Only active workspace pages can be pinned in the All sidebar.");
    }

    const nextSourceMeta = {
      ...getPageSourceMeta(page),
      pinnedInAllSidebar: args.pinned,
    };
    await ctx.db.patch(args.pageId, {
      sourceMeta: nextSourceMeta,
      updatedAt: getTimestamp(),
    });

    return args.pinned;
  },
});

export const mergePinnedPagesInAllSidebar = mutation({
  args: {
    ownerKey: v.string(),
    pageIds: v.array(v.id("pages")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const uniquePageIds = [...new Set(args.pageIds.map((pageId) => pageId as string))] as Id<"pages">[];
    const now = getTimestamp();

    for (const pageId of uniquePageIds) {
      const page = await ctx.db.get(pageId);
      if (!page || page.archived || isSidebarSpecialPage(page) || isPagePendingDeletion(page)) {
        continue;
      }

      const sourceMeta = getPageSourceMeta(page);
      if (sourceMeta.pinnedInAllSidebar === true) {
        continue;
      }

      await ctx.db.patch(pageId, {
        sourceMeta: {
          ...sourceMeta,
          pinnedInAllSidebar: true,
        },
        updatedAt: now,
      });
    }

    return uniquePageIds.length;
  },
});

export const setSidebarFavorite = mutation({
  args: {
    ownerKey: v.string(),
    targetKind: v.union(v.literal("page"), v.literal("node")),
    pageId: v.id("pages"),
    nodeId: v.optional(v.union(v.id("nodes"), v.null())),
    favorited: v.boolean(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const page = await ctx.db.get(args.pageId);
    if (!page || page.archived || isPagePendingDeletion(page)) {
      throw new Error("Favorite target page not found.");
    }

    const targetNodeId =
      args.targetKind === "node" ? (args.nodeId ?? null) : null;
    const existingFavorite = await getSidebarFavoriteByTarget(ctx.db, {
      targetKind: args.targetKind,
      targetPageId: args.pageId,
      targetNodeId,
    });

    if (!args.favorited) {
      if (existingFavorite) {
        await ctx.db.delete(existingFavorite._id);
      }
      return null as Id<"sidebarFavorites"> | null;
    }

    if (args.targetKind === "page") {
      if (isSidebarSpecialPage(page)) {
        throw new Error("The sidebar system page cannot be favorited directly.");
      }
      if (existingFavorite) {
        return existingFavorite._id;
      }
    } else {
      if (!targetNodeId) {
        throw new Error("Node favorites require a node target.");
      }

      const node = await ctx.db.get(targetNodeId);
      if (!node || node.archived || node.pageId !== args.pageId) {
        throw new Error("Favorite target item not found.");
      }

      if (existingFavorite) {
        return existingFavorite._id;
      }
    }

    const lastFavorite = await ctx.db
      .query("sidebarFavorites")
      .withIndex("by_position")
      .order("desc")
      .first();
    const now = getTimestamp();
    return await ctx.db.insert("sidebarFavorites", {
      targetKind: args.targetKind,
      targetPageId: args.pageId,
      targetNodeId,
      position: (lastFavorite?.position ?? 0) + 1,
      createdAt: now,
      updatedAt: now,
    });
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
    const text = args.text?.trim() || "";
    const kind = normalizeNodeKindForText(text, args.kind);

    const nodeId = await ctx.db.insert("nodes", {
      pageId: args.pageId,
      parentNodeId,
      position,
      text,
      kind,
      taskStatus: normalizeTaskStatusForKind(kind, args.taskStatus),
      priority: null,
      dueAt: kind === "task" ? (args.dueAt ?? null) : null,
      dueEndAt: kind === "task" ? (args.dueEndAt ?? null) : null,
      archived: false,
      sourceMeta: {
        sourceType: "manual",
        recurrenceFrequency: kind === "task" ? (args.recurrenceFrequency ?? null) : null,
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
      const text = entry.text?.trim() || "";
      const kind = normalizeNodeKindForText(text, entry.kind);

      const nodeId = await ctx.db.insert("nodes", {
        pageId: args.pageId,
        parentNodeId,
        position,
        text,
        kind,
        taskStatus: normalizeTaskStatusForKind(kind, entry.taskStatus),
        priority: null,
        dueAt: kind === "task" ? (entry.dueAt ?? null) : null,
        dueEndAt: kind === "task" ? (entry.dueEndAt ?? null) : null,
        archived: false,
        sourceMeta: {
          sourceType: "manual",
          taskKindLocked: entry.lockKind ?? false,
          noteCompleted:
            kind === "note"
              ? (entry.noteCompleted ?? false)
              : false,
          recurrenceFrequency: kind === "task" ? (entry.recurrenceFrequency ?? null) : null,
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
    const nextText = args.text !== undefined ? args.text : node.text;
    const nextKind = normalizeNodeKindForText(
      nextText,
      args.kind !== undefined ? args.kind : node.kind,
    );
    const isSeparatorNote = isSeparatorLineText(nextText);

    if (args.text !== undefined) {
      patch.text = args.text;
    }

    if (args.kind !== undefined || (args.text !== undefined && nextKind !== node.kind)) {
      patch.kind = nextKind;
      patch.taskStatus = normalizeTaskStatusForKind(
        nextKind,
        args.taskStatus,
        node.taskStatus,
      );
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

    if (isSeparatorNote) {
      patch.kind = "note";
      patch.taskStatus = null;
      patch.priority = null;
      patch.dueAt = null;
      patch.dueEndAt = null;
    }

    if (
      args.lockKind !== undefined ||
      args.noteCompleted !== undefined ||
      args.kind !== undefined ||
      args.recurrenceFrequency !== undefined ||
      isSeparatorNote
    ) {
      const sourceMeta =
        node.sourceMeta && typeof node.sourceMeta === "object"
          ? { ...(node.sourceMeta as Record<string, unknown>) }
          : {};

      if (args.lockKind !== undefined) {
        sourceMeta.taskKindLocked = args.lockKind;
      }

      if (isSeparatorNote) {
        sourceMeta.noteCompleted = false;
      } else if (args.noteCompleted !== undefined) {
        sourceMeta.noteCompleted = args.noteCompleted;
      } else if (nextKind === "task" && args.kind !== undefined) {
        sourceMeta.noteCompleted = false;
      }

      if (isSeparatorNote) {
        sourceMeta.recurrenceFrequency = null;
      } else if (args.recurrenceFrequency !== undefined) {
        sourceMeta.recurrenceFrequency = args.recurrenceFrequency;
      } else if (nextKind === "note" && args.kind !== undefined) {
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
      const nextText = update.text !== undefined ? update.text : node.text;
      const nextKind = normalizeNodeKindForText(
        nextText,
        update.kind !== undefined ? update.kind : node.kind,
      );
      const isSeparatorNote = isSeparatorLineText(nextText);

      if (update.text !== undefined) {
        patch.text = update.text;
      }

      if (update.kind !== undefined || (update.text !== undefined && nextKind !== node.kind)) {
        patch.kind = nextKind;
        patch.taskStatus = normalizeTaskStatusForKind(
          nextKind,
          update.taskStatus,
          node.taskStatus,
        );
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

      if (isSeparatorNote) {
        patch.kind = "note";
        patch.taskStatus = null;
        patch.priority = null;
        patch.dueAt = null;
        patch.dueEndAt = null;
      }

      if (
        update.lockKind !== undefined ||
        update.noteCompleted !== undefined ||
        update.kind !== undefined ||
        update.recurrenceFrequency !== undefined ||
        isSeparatorNote
      ) {
        const sourceMeta =
          node.sourceMeta && typeof node.sourceMeta === "object"
            ? { ...(node.sourceMeta as Record<string, unknown>) }
            : {};

        if (update.lockKind !== undefined) {
          sourceMeta.taskKindLocked = update.lockKind;
        }

        if (isSeparatorNote) {
          sourceMeta.noteCompleted = false;
        } else if (update.noteCompleted !== undefined) {
          sourceMeta.noteCompleted = update.noteCompleted;
        } else if (nextKind === "task" && update.kind !== undefined) {
          sourceMeta.noteCompleted = false;
        }

        if (isSeparatorNote) {
          sourceMeta.recurrenceFrequency = null;
        } else if (update.recurrenceFrequency !== undefined) {
          sourceMeta.recurrenceFrequency = update.recurrenceFrequency;
        } else if (nextKind === "note" && update.kind !== undefined) {
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

export const insertNodeAbove = mutation({
  args: {
    ownerKey: v.string(),
    nodeId: v.id("nodes"),
    clientId: v.optional(v.string()),
    insertedText: v.string(),
    insertedKind: nodeKindValidator,
    insertedTaskStatus: v.optional(taskStatusValidator),
    shiftedText: v.string(),
    shiftedKind: nodeKindValidator,
    shiftedTaskStatus: v.optional(taskStatusValidator),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      throw new Error("Node not found.");
    }

    const now = getTimestamp();
    const siblings = (await listSiblingNodes(
      ctx.db,
      node.pageId,
      node.parentNodeId,
    )).sort((left, right) => left.position - right.position);
    const currentIndex = siblings.findIndex((sibling) => sibling._id === node._id);
    const previousSibling = currentIndex > 0 ? siblings[currentIndex - 1] ?? null : null;
    const insertedPosition = await computeNodePosition(
      ctx.db,
      node.pageId,
      node.parentNodeId,
      previousSibling?._id ?? null,
    );
    const insertedText = args.insertedText.trim();
    const insertedKind = normalizeNodeKindForText(insertedText, args.insertedKind);
    const shiftedKind = normalizeNodeKindForText(args.shiftedText, args.shiftedKind);

    const insertedNodeId = await ctx.db.insert("nodes", {
      pageId: node.pageId,
      parentNodeId: node.parentNodeId,
      position: insertedPosition,
      text: insertedText,
      kind: insertedKind,
      taskStatus: normalizeTaskStatusForKind(insertedKind, args.insertedTaskStatus),
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "manual",
        taskKindLocked: false,
        noteCompleted: false,
        recurrenceFrequency: null,
      },
      createdAt: now,
      updatedAt: now,
    });

    const nextSourceMeta =
      node.sourceMeta && typeof node.sourceMeta === "object"
        ? { ...(node.sourceMeta as Record<string, unknown>) }
        : {};
    nextSourceMeta.noteCompleted =
      shiftedKind === "note"
        ? Boolean((node.sourceMeta as Record<string, unknown> | null | undefined)?.noteCompleted)
        : false;
    nextSourceMeta.recurrenceFrequency =
      shiftedKind === "task"
        ? ((node.sourceMeta as Record<string, unknown> | null | undefined)
            ?.recurrenceFrequency ?? null)
        : null;

    await ctx.db.patch(args.nodeId, {
      text: args.shiftedText,
      kind: shiftedKind,
      taskStatus: normalizeTaskStatusForKind(shiftedKind, args.shiftedTaskStatus, node.taskStatus),
      priority: isSeparatorLineText(args.shiftedText) ? null : node.priority,
      dueAt: shiftedKind === "task" ? (node.dueAt ?? null) : null,
      dueEndAt: shiftedKind === "task" ? (node.dueEndAt ?? null) : null,
      sourceMeta: nextSourceMeta,
      updatedAt: now,
    });

    const insertedNode = await ctx.db.get(insertedNodeId);
    const shiftedNode = await ctx.db.get(args.nodeId);

    if (insertedNode) {
      await syncLinksForNode(ctx.db, insertedNode);
      await enqueueNodeAiWork(ctx, insertedNode._id);
    }
    if (shiftedNode) {
      await syncLinksForNode(ctx.db, shiftedNode);
      await enqueueNodeAiWork(ctx, shiftedNode._id);
    }

    await enqueuePageRootEmbeddingRefresh(ctx, node.pageId);

    return {
      insertedNode,
      shiftedNode,
    };
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
    const headKind = normalizeNodeKindForText(args.headText, args.headKind);
    const tailKind = normalizeNodeKindForText(args.tailText, args.tailKind);
    const headSourceMeta = {
      ...getNodeSourceMeta(node),
      noteCompleted: headKind === "note" && !isSeparatorLineText(args.headText)
        ? getNodeSourceMeta(node).noteCompleted === true
        : false,
      recurrenceFrequency:
        headKind === "task" ? getNodeSourceMeta(node).recurrenceFrequency ?? null : null,
    };
    await ctx.db.patch(args.nodeId, {
      text: args.headText,
      kind: headKind,
      taskStatus: normalizeTaskStatusForKind(headKind, args.headTaskStatus, node.taskStatus),
      priority: isSeparatorLineText(args.headText) ? null : node.priority,
      dueAt: headKind === "task" ? (node.dueAt ?? null) : null,
      dueEndAt: headKind === "task" ? (node.dueEndAt ?? null) : null,
      sourceMeta: headSourceMeta,
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
      kind: tailKind,
      taskStatus: normalizeTaskStatusForKind(tailKind, args.tailTaskStatus),
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "manual",
        noteCompleted: false,
        recurrenceFrequency: null,
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
    const text = args.text.trim();
    const kind = normalizeNodeKindForText(text, args.kind);
    const nextSourceMeta = {
      ...getNodeSourceMeta(node),
      noteCompleted:
        kind === "note" && !isSeparatorLineText(text)
          ? getNodeSourceMeta(node).noteCompleted === true
          : false,
      recurrenceFrequency:
        kind === "task" ? getNodeSourceMeta(node).recurrenceFrequency ?? null : null,
    };
    await ctx.db.patch(args.nodeId, {
      text,
      kind,
      taskStatus: normalizeTaskStatusForKind(kind, args.taskStatus, node.taskStatus),
      priority: isSeparatorLineText(text) ? null : node.priority,
      dueAt: kind === "task" ? (node.dueAt ?? null) : null,
      dueEndAt: kind === "task" ? (node.dueEndAt ?? null) : null,
      sourceMeta: nextSourceMeta,
      updatedAt: now,
    });

    const createdNodes: Doc<"nodes">[] = [];
    let afterNodeId: Id<"nodes"> | null = node._id;
    for (const sibling of args.siblings) {
      const siblingText = sibling.text.trim();
      const siblingKind = normalizeNodeKindForText(siblingText, sibling.kind);
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
        text: siblingText,
        kind: siblingKind,
        taskStatus: normalizeTaskStatusForKind(siblingKind, sibling.taskStatus),
        priority: null,
        dueAt: null,
        dueEndAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "manual",
          noteCompleted: false,
          recurrenceFrequency: null,
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

export const moveNodeTreesToPage = mutation({
  args: {
    ownerKey: v.string(),
    targetPageId: v.id("pages"),
    nodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    if (args.nodeIds.length === 0) {
      return {
        movedNodeIds: [] as Id<"nodes">[],
      };
    }

    const targetPage = await ctx.db.get(args.targetPageId);
    if (!targetPage || targetPage.archived || isSidebarSpecialPage(targetPage)) {
      throw new Error("Choose an active page as the destination.");
    }

    const now = getTimestamp();
    const touchedPageIds = new Set<Id<"pages">>([args.targetPageId]);
    const existingTargetRoots = (await listSiblingNodes(
      ctx.db,
      args.targetPageId,
      null,
    )).sort((left, right) => left.position - right.position);
    let afterNodeId =
      ((existingTargetRoots[existingTargetRoots.length - 1]?._id as Id<"nodes"> | undefined) ??
        null);

    for (const nodeId of args.nodeIds) {
      const node = await ctx.db.get(nodeId);
      if (!node || node.archived) {
        throw new Error("Node not found.");
      }

      const page = await ctx.db.get(node.pageId);
      if (!page || page.archived) {
        throw new Error("Cannot move items from an archived page.");
      }

      const subtree = await collectNodeTree(ctx.db, nodeId);
      if (subtree.length === 0) {
        continue;
      }

      touchedPageIds.add(node.pageId);
      const nextPosition = await computeNodePosition(
        ctx.db,
        args.targetPageId,
        null,
        afterNodeId,
      );

      await ctx.db.patch(nodeId, {
        pageId: args.targetPageId,
        parentNodeId: null,
        position: nextPosition,
        updatedAt: now,
      });

      for (const descendant of subtree) {
        if (descendant._id === nodeId) {
          continue;
        }
        await ctx.db.patch(descendant._id, {
          pageId: args.targetPageId,
          updatedAt: now,
        });
      }

      const refreshedSubtree = await collectNodeTree(ctx.db, nodeId);
      for (const movedNode of refreshedSubtree) {
        await syncLinksForNode(ctx.db, movedNode);
        await enqueueNodeEmbeddingRefresh(ctx, movedNode._id);
      }

      afterNodeId = nodeId;
    }

    for (const pageId of touchedPageIds) {
      await enqueuePageRootEmbeddingRefresh(ctx, pageId);
    }

    return {
      movedNodeIds: args.nodeIds,
    };
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

    const getSectionNode = (
      slot: "journalThoughts" | "journalWhatHappened" | "journalFeedback",
    ) =>
      rootNodes.find((node) => {
        const sourceMeta =
          node.sourceMeta && typeof node.sourceMeta === "object"
            ? (node.sourceMeta as Record<string, unknown>)
            : null;
        return sourceMeta?.sectionSlot === slot;
      }) ?? null;

    const thoughtsSection = getSectionNode("journalThoughts");
    const whatHappenedSection = getSectionNode("journalWhatHappened");
    const feedbackSection = getSectionNode("journalFeedback");

    const getSectionChildren = (sectionNodeId: Doc<"nodes">["_id"] | null) =>
      nodes
        .filter((node) => node.parentNodeId === sectionNodeId)
        .sort((left, right) => left.position - right.position);

    return {
      page,
      thoughtsSection,
      whatHappenedSection,
      feedbackSection,
      thoughtLines: getSectionChildren(thoughtsSection?._id ?? null),
      whatHappenedLines: getSectionChildren(whatHappenedSection?._id ?? null),
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

    const pageEntryGroups = await Promise.all(
      visiblePages.map((page) =>
        buildPageKnowledgeContextEntries(ctx, page, {
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
    const pageEntries = pageEntryGroups.flat();

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

function normalizeWorkspaceActionCandidateText(text: string) {
  const replacedText = replaceLinkMarkupWithLabels(text).trim() || text.trim();
  return stripNodeDisplaySyntaxMarkers(replacedText).trim() || replacedText;
}

function isWorkspaceActionCandidateNode(
  page: Doc<"pages">,
  node: Doc<"nodes">,
) {
  if (page.archived || isPagePendingDeletion(page) || isSidebarSpecialPage(page)) {
    return false;
  }

  if (node.archived || node.text.trim().length === 0 || node.text.trim() === ".") {
    return false;
  }

  if (!isPlannerPage(page)) {
    return true;
  }

  const sourceMeta = getNodeSourceMeta(node);
  return (
    sourceMeta.locked !== true &&
    sourceMeta.sectionSlot !== PLANNER_TEMPLATE_SLOT &&
    typeof sourceMeta.plannerTemplateWeekday !== "string"
  );
}

async function collectWorkspaceActionCandidateIdsFromLinks(
  db: DatabaseReader,
  args: {
    linkedNodeIds: Id<"nodes">[];
    linkedPageIds: Id<"pages">[];
  },
) {
  const nodeIds: Id<"nodes">[] = [];

  for (const linkedNodeId of args.linkedNodeIds) {
    const [resolvedLinks, refLinks] = await Promise.all([
      db
        .query("links")
        .withIndex("by_target_node", (query) => query.eq("targetNodeId", linkedNodeId))
        .take(MAX_WORKSPACE_ACTION_LINK_BACKLINKS),
      db
        .query("links")
        .withIndex("by_target_node_ref", (query) =>
          query.eq("targetNodeRef", linkedNodeId as string),
        )
        .take(MAX_WORKSPACE_ACTION_LINK_BACKLINKS),
    ]);

    for (const link of [...resolvedLinks, ...refLinks]) {
      if (link.sourceNodeId) {
        nodeIds.push(link.sourceNodeId);
      }
    }
  }

  for (const linkedPageId of args.linkedPageIds) {
    const pageLinks = await db
      .query("links")
      .withIndex("by_target_page", (query) => query.eq("targetPageId", linkedPageId))
      .take(MAX_WORKSPACE_ACTION_LINK_BACKLINKS);

    for (const link of pageLinks) {
      if (link.sourceNodeId) {
        nodeIds.push(link.sourceNodeId);
      }
    }
  }

  return nodeIds;
}

async function buildWorkspaceActionCandidatePath(
  db: DatabaseReader,
  node: Doc<"nodes">,
) {
  const ancestors: string[] = [];
  let parentNodeId = node.parentNodeId;
  let depth = 0;

  while (parentNodeId && depth < MAX_WORKSPACE_ACTION_ANCESTOR_DEPTH) {
    const parent = await db.get(parentNodeId);
    if (!parent) {
      break;
    }

    ancestors.unshift(normalizeWorkspaceActionCandidateText(parent.text));
    parentNodeId = parent.parentNodeId;
    depth += 1;
  }

  return [...ancestors, normalizeWorkspaceActionCandidateText(node.text)]
    .filter((value) => value.length > 0)
    .join(" > ");
}

export const getWorkspaceActionParentCandidates = internalQuery({
  args: {
    nodeIds: v.array(v.id("nodes")),
    linkedNodeIds: v.optional(v.array(v.id("nodes"))),
    linkedPageIds: v.optional(v.array(v.id("pages"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(
      1,
      Math.min(args.limit ?? MAX_WORKSPACE_ACTION_PARENT_CANDIDATES, MAX_WORKSPACE_ACTION_PARENT_CANDIDATES),
    );
    const linkedCandidateNodeIds = await collectWorkspaceActionCandidateIdsFromLinks(ctx.db, {
      linkedNodeIds: args.linkedNodeIds ?? [],
      linkedPageIds: args.linkedPageIds ?? [],
    });
    const orderedNodeIds = [
      ...new Set(
        [...args.nodeIds, ...(args.linkedNodeIds ?? []), ...linkedCandidateNodeIds]
          .map((nodeId) => nodeId as string),
      ),
    ] as Id<"nodes">[];
    const candidates: Array<{
      nodeId: Id<"nodes">;
      pageId: Id<"pages">;
      pageTitle: string;
      text: string;
      rawText: string;
      kind: Doc<"nodes">["kind"];
      taskStatus: Doc<"nodes">["taskStatus"];
      ancestorPath: string;
      childPreview: string[];
    }> = [];

    for (const nodeId of orderedNodeIds) {
      if (candidates.length >= limit) {
        break;
      }

      const node = await ctx.db.get(nodeId);
      if (!node) {
        continue;
      }

      const page = await ctx.db.get(node.pageId);
      if (!page || !isWorkspaceActionCandidateNode(page, node)) {
        continue;
      }

      const childPreviewNodes = await ctx.db
        .query("nodes")
        .withIndex("by_page_parent_position", (query) =>
          query.eq("pageId", node.pageId).eq("parentNodeId", node._id),
        )
        .take(MAX_WORKSPACE_ACTION_CHILD_PREVIEW);
      candidates.push({
        nodeId: node._id,
        pageId: page._id,
        pageTitle: page.title,
        text: normalizeWorkspaceActionCandidateText(node.text),
        rawText: node.text,
        kind: node.kind,
        taskStatus: node.taskStatus,
        ancestorPath: await buildWorkspaceActionCandidatePath(ctx.db, node),
        childPreview: childPreviewNodes
          .filter((child) => !child.archived)
          .map((child) => normalizeWorkspaceActionCandidateText(child.text))
          .filter((text) => text.length > 0),
      });
    }

    return candidates;
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
