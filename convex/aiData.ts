import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { priorityValidator, taskStatusValidator } from "./lib/validators";

export const fallbackTextSearch = internalQuery({
  args: {
    query: v.string(),
    pageId: v.optional(v.id("pages")),
    limit: v.number(),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const rawNodes = args.pageId
      ? await ctx.db
          .query("nodes")
          .withIndex("by_page_archived", (query) =>
            query.eq("pageId", args.pageId!).eq("archived", args.includeArchived === true),
          )
          .collect()
      : (await ctx.db.query("nodes").collect()).filter((node) =>
          args.includeArchived === true ? node.archived : !node.archived,
        );
    const pageIds = [...new Set(rawNodes.map((node) => node.pageId))];
    const pages = await Promise.all(pageIds.map((pageId) => ctx.db.get(pageId)));
    const pageMap = new Map(
      pages
        .filter(
          (page): page is Doc<"pages"> =>
            Boolean(page) &&
            (args.includeArchived === true ? page!.archived : !page!.archived),
        )
        .map((page) => [page._id, page]),
    );
    const nodes = rawNodes.filter((node) => pageMap.has(node.pageId));
    const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);

    return nodes
      .map((node: Doc<"nodes">) => {
        const haystack = node.text.toLowerCase();
        const score = terms.reduce((total, term) => {
          if (!haystack.includes(term)) {
            return total;
          }
          return total + 1;
        }, 0);

        return {
          score,
          node,
          page: pageMap.get(node.pageId) ?? null,
          content: node.text,
        };
      })
      .filter((entry: { score: number }) => entry.score > 0)
      .sort(
        (left: { score: number }, right: { score: number }) =>
          right.score - left.score,
      )
      .slice(0, args.limit);
  },
});

export const hydrateEmbeddingMatches = internalQuery({
  args: {
    embeddingIds: v.array(v.id("nodeEmbeddings")),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const embeddings = await Promise.all(args.embeddingIds.map((embeddingId) => ctx.db.get(embeddingId)));
    const hydrated = await Promise.all(
      embeddings
        .filter((embedding): embedding is NonNullable<typeof embedding> => Boolean(embedding))
        .map(async (embedding) => ({
          embedding,
          node: await ctx.db.get(embedding.nodeId),
        })),
    );
    const presentNodes = hydrated
      .map((entry) => entry.node)
      .filter(Boolean);
    const pages = await Promise.all(
      presentNodes.map((node) => ctx.db.get(node!.pageId)),
    );
    const pageMap = new Map(
      pages
        .filter(
          (page): page is Doc<"pages"> =>
            Boolean(page) &&
            (args.includeArchived === true ? page!.archived : !page!.archived),
        )
        .map((page) => [page._id, page]),
    );

    return hydrated
      .filter(
        (entry): entry is { embedding: NonNullable<(typeof hydrated)[number]["embedding"]>; node: Doc<"nodes"> } =>
          Boolean(entry.node) &&
          (args.includeArchived === true ? entry.node!.archived : !entry.node!.archived),
      )
      .map((entry) => ({
        node: entry.node,
        page: pageMap.get(entry.node.pageId) ?? null,
        content: entry.embedding.content,
      }))
      .filter((entry) => entry.page !== null);
  },
});

export const upsertEmbeddingJob = internalMutation({
  args: {
    nodeId: v.id("nodes"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("embeddingJobs")
      .withIndex("by_node", (query) => query.eq("nodeId", args.nodeId))
      .first();
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        attempts: existing.attempts + (args.status === "running" ? 1 : 0),
        lastError: args.error,
        lastQueuedAt: args.status === "queued" ? now : existing.lastQueuedAt,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("embeddingJobs", {
      nodeId: args.nodeId,
      status: args.status,
      attempts: args.status === "running" ? 1 : 0,
      lastError: args.error,
      lastQueuedAt: now,
      updatedAt: now,
    });
  },
});

export const saveNodeEmbedding = internalMutation({
  args: {
    nodeId: v.id("nodes"),
    pageId: v.id("pages"),
    content: v.string(),
    vector: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("nodeEmbeddings")
      .withIndex("by_node", (query) => query.eq("nodeId", args.nodeId))
      .first();
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        pageId: args.pageId,
        content: args.content,
        vector: args.vector,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("nodeEmbeddings", {
        nodeId: args.nodeId,
        pageId: args.pageId,
        content: args.content,
        vector: args.vector,
        createdAt: now,
        updatedAt: now,
      });
    }

    const existingJob = await ctx.db
      .query("embeddingJobs")
      .withIndex("by_node", (query) => query.eq("nodeId", args.nodeId))
      .first();
    if (existingJob) {
      await ctx.db.patch(existingJob._id, {
        status: "completed",
        updatedAt: now,
      });
    }
  },
});

export const applyTaskMetadata = internalMutation({
  args: {
    nodeId: v.id("nodes"),
    kind: v.union(v.literal("note"), v.literal("task")),
    taskStatus: taskStatusValidator,
    priority: priorityValidator,
  },
  handler: async (ctx, args) => {
    const node = await ctx.db.get(args.nodeId);
    if (!node) {
      return;
    }

    await ctx.db.patch(args.nodeId, {
      kind: args.kind,
      taskStatus:
        args.kind === "task"
          ? (args.taskStatus ?? node.taskStatus ?? "todo")
          : null,
      priority: args.priority ?? node.priority,
      updatedAt: Date.now(),
    });
  },
});
