import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
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
import { nodeKindValidator, nullableNodeIdValidator, priorityValidator, taskStatusValidator } from "./lib/validators";

function getTimestamp() {
  return Date.now();
}

function getPageSourceMeta(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return page && typeof page.sourceMeta === "object" && page.sourceMeta
    ? (page.sourceMeta as Record<string, unknown>)
    : {};
}

function isSidebarSpecialPage(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getPageSourceMeta(page).specialPage === "sidebar";
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

const nodeCreateInputValidator = v.object({
  parentNodeId: v.optional(nullableNodeIdValidator),
  afterNodeId: v.optional(nullableNodeIdValidator),
  text: v.optional(v.string()),
  kind: v.optional(nodeKindValidator),
  taskStatus: v.optional(taskStatusValidator),
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

      return [...activePages, ...archivedPages].filter((page) => !isSidebarSpecialPage(page));
    }

    return (await ctx.db
      .query("pages")
      .withIndex("by_archived_position", (query) =>
        query.eq("archived", false),
      )
      .collect()).filter((page) => !isSidebarSpecialPage(page));
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
    const links = await ctx.db
      .query("links")
      .withIndex("by_source_page", (query) => query.eq("sourcePageId", sidebarPage._id))
      .collect();
    return {
      page: sidebarPage,
      nodes,
      linkedPageIds: [
        ...new Set(
          links
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
        pageType: "default",
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

    const nodes = (await ctx.db.query("nodes").collect()).filter(
      (node) => !node.archived,
    );
    const existingJobs = await ctx.db.query("embeddingJobs").collect();
    const jobsByNodeId = new Map(existingJobs.map((job) => [job.nodeId, job]));
    const now = getTimestamp();
    const uniqueNodeIds = [...new Set(nodes.map((node) => node._id))];

    for (const nodeId of uniqueNodeIds) {
      const existingJob = jobsByNodeId.get(nodeId);
      if (existingJob) {
        await ctx.db.patch(existingJob._id, {
          status: "queued",
          lastQueuedAt: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("embeddingJobs", {
          nodeId,
          status: "queued",
          attempts: 0,
          lastQueuedAt: now,
          updatedAt: now,
        });
      }

      await ctx.scheduler.runAfter(0, internal.ai.generateEmbeddingForNode, {
        nodeId,
      });
    }

    return {
      queuedCount: uniqueNodeIds.length,
    };
  },
});

export const getEmbeddingRebuildStatus = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const activeNodes = (await ctx.db.query("nodes").collect()).filter(
      (node) => !node.archived,
    );
    const activeNodeIds = new Set(activeNodes.map((node) => node._id));
    const jobs = (await ctx.db.query("embeddingJobs").collect()).filter((job) =>
      activeNodeIds.has(job.nodeId),
    );
    const jobsByNodeId = new Map(jobs.map((job) => [job.nodeId, job]));

    let queued = 0;
    let running = 0;
    let completed = 0;
    let error = 0;
    let pending = 0;

    for (const node of activeNodes) {
      const job = jobsByNodeId.get(node._id);
      if (!job) {
        pending += 1;
        continue;
      }

      if (job.status === "queued") {
        queued += 1;
      } else if (job.status === "running") {
        running += 1;
      } else if (job.status === "completed") {
        completed += 1;
      } else if (job.status === "error") {
        error += 1;
      }
    }

    const total = activeNodes.length;

    return {
      total,
      queued,
      running,
      completed,
      error,
      pending,
      idle: queued === 0 && running === 0,
      complete: total === 0 ? true : completed === total && queued === 0 && running === 0 && pending === 0 && error === 0,
      lastQueuedAt:
        jobs.length > 0
          ? Math.max(...jobs.map((job) => job.lastQueuedAt))
          : null,
    };
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
    if (!page) {
      return null;
    }

    const nodes = await listPageNodes(ctx.db, args.pageId);
    const backlinks = await ctx.db
      .query("links")
      .withIndex("by_target_page", (query) => query.eq("targetPageId", args.pageId))
      .collect();

    return {
      page,
      nodes,
      backlinks: await filterVisibleLinks(ctx, backlinks),
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

    const pageNodes = await listPageNodes(ctx.db, args.pageId);
    const rootNodes = pageNodes.filter((node) => node.parentNodeId === null);

    for (const rootNode of rootNodes) {
      await deleteNodeTree(ctx.db, rootNode._id);
    }

    const outboundPageLinks = await ctx.db
      .query("links")
      .withIndex("by_source_page", (query) => query.eq("sourcePageId", args.pageId))
      .collect();
    const inboundPageLinks = await ctx.db
      .query("links")
      .withIndex("by_target_page", (query) => query.eq("targetPageId", args.pageId))
      .collect();

    for (const link of [...outboundPageLinks, ...inboundPageLinks]) {
      await ctx.db.delete(link._id);
    }

    const pageThreads = await ctx.db
      .query("chatThreads")
      .withIndex("by_page_updatedAt", (query) => query.eq("pageId", args.pageId))
      .collect();

    for (const thread of pageThreads) {
      const messages = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread_createdAt", (query) => query.eq("threadId", thread._id))
        .collect();

      for (const message of messages) {
        await ctx.db.delete(message._id);
      }

      await ctx.db.delete(thread._id);
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
      const links = await ctx.db
        .query("links")
        .withIndex("by_target_node", (query) =>
          query.eq("targetNodeId", nodeId),
        )
        .collect();
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
      return await filterVisibleLinks(ctx, links);
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
    const visiblePages = pages.filter((page) => !isSidebarSpecialPage(page));

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
        v.literal("Templates"),
        v.literal("Journal"),
        v.literal("Scratchpads"),
      ),
    ),
    pageType: v.optional(
      v.union(v.literal("default"), v.literal("model"), v.literal("journal")),
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

    await enqueuePageRootEmbeddingRefresh(ctx, pageId);

    return pageId;
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

    const slug = await buildUniquePageSlug(ctx.db, args.title, args.pageId);
    await ctx.db.patch(args.pageId, {
      title: args.title.trim() || "Untitled",
      slug,
      updatedAt: getTimestamp(),
    });

    const pageNodes = await listPageNodes(ctx.db, args.pageId);
    for (const node of pageNodes) {
      await ctx.scheduler.runAfter(0, internal.ai.generateEmbeddingForNode, {
        nodeId: node._id,
      });
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
      dueAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "manual",
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

    for (const entry of args.nodes) {
      const parentNodeId = entry.parentNodeId ?? null;
      const afterNodeId =
        entry.afterNodeId !== undefined
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
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "manual",
        },
        createdAt: now,
        updatedAt: now,
      });

      const node = await ctx.db.get(nodeId);
      if (!node) {
        continue;
      }

      createdNodes.push(node);
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
    priority: v.optional(priorityValidator),
    dueAt: v.optional(v.union(v.number(), v.null())),
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

    if (args.lockKind !== undefined) {
      const sourceMeta =
        node.sourceMeta && typeof node.sourceMeta === "object"
          ? { ...(node.sourceMeta as Record<string, unknown>) }
          : {};
      sourceMeta.taskKindLocked = args.lockKind;
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

export const getNodeAiContext = internalQuery({
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

    const allNodes = await listPageNodes(ctx.db, page._id);
    const ancestors: string[] = [];
    const byId = new Map(allNodes.map((entry) => [entry._id, entry]));
    let currentParentId = node.parentNodeId;

    while (currentParentId) {
      const parent = byId.get(currentParentId);
      if (!parent) {
        break;
      }

      ancestors.unshift(parent.text);
      currentParentId = parent.parentNodeId;
    }

    return {
      page,
      node,
      allNodes,
      ancestors,
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
