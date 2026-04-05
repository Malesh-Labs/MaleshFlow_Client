import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { priorityValidator, taskStatusValidator } from "./lib/validators";

function buildEmbeddingJobReplacement(
  job: Doc<"embeddingJobs">,
  overrides: Partial<{
    status: Doc<"embeddingJobs">["status"];
    attempts: number;
    lastQueuedAt: number;
    updatedAt: number;
    lastError: string | undefined;
    lastEmbeddedHash: string | undefined;
    lastEmbeddedPageId: Doc<"embeddingJobs">["lastEmbeddedPageId"];
    lastEmbeddedAt: number | undefined;
    rebuildRunId: string | undefined;
  }>,
  clears: Partial<Record<"lastError" | "lastEmbeddedHash" | "lastEmbeddedPageId" | "lastEmbeddedAt" | "rebuildRunId", true>> = {},
) {
  const next = {
    nodeId: job.nodeId,
    status: overrides.status ?? job.status,
    attempts: overrides.attempts ?? job.attempts,
    lastQueuedAt: overrides.lastQueuedAt ?? job.lastQueuedAt,
    updatedAt: overrides.updatedAt ?? job.updatedAt,
  } as {
    nodeId: Doc<"embeddingJobs">["nodeId"];
    status: Doc<"embeddingJobs">["status"];
    attempts: number;
    lastQueuedAt: number;
    updatedAt: number;
    lastError?: string;
    lastEmbeddedHash?: string;
    lastEmbeddedPageId?: Doc<"embeddingJobs">["lastEmbeddedPageId"];
    lastEmbeddedAt?: number;
    rebuildRunId?: string;
  };

  const lastError = overrides.lastError ?? job.lastError;
  if (!clears.lastError && lastError !== undefined) {
    next.lastError = lastError;
  }

  const lastEmbeddedHash = overrides.lastEmbeddedHash ?? job.lastEmbeddedHash;
  if (!clears.lastEmbeddedHash && lastEmbeddedHash !== undefined) {
    next.lastEmbeddedHash = lastEmbeddedHash;
  }

  const lastEmbeddedPageId =
    overrides.lastEmbeddedPageId ?? job.lastEmbeddedPageId;
  if (!clears.lastEmbeddedPageId && lastEmbeddedPageId !== undefined) {
    next.lastEmbeddedPageId = lastEmbeddedPageId;
  }

  const lastEmbeddedAt = overrides.lastEmbeddedAt ?? job.lastEmbeddedAt;
  if (!clears.lastEmbeddedAt && lastEmbeddedAt !== undefined) {
    next.lastEmbeddedAt = lastEmbeddedAt;
  }

  const rebuildRunId = overrides.rebuildRunId ?? job.rebuildRunId;
  if (!clears.rebuildRunId && rebuildRunId !== undefined) {
    next.rebuildRunId = rebuildRunId;
  }

  return next;
}

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
    rebuildRunId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("embeddingJobs")
      .withIndex("by_node", (query) => query.eq("nodeId", args.nodeId))
      .first();
    const now = Date.now();
    const nextAttempts = existing
      ? args.status === "running" && existing.status !== "running"
        ? existing.attempts + 1
        : existing.attempts
      : args.status === "running"
        ? 1
        : 0;
    const nextLastQueuedAt =
      args.status === "queued" ? now : existing?.lastQueuedAt ?? now;
    const nextLastError = args.status === "error" ? args.error : undefined;
    const nextRebuildRunId = args.rebuildRunId ?? existing?.rebuildRunId;

    if (existing) {
      const shouldPatch =
        existing.status !== args.status ||
        existing.attempts !== nextAttempts ||
        (existing.lastError ?? undefined) !== nextLastError ||
        existing.lastQueuedAt !== nextLastQueuedAt ||
        (existing.rebuildRunId ?? undefined) !== nextRebuildRunId;

      if (shouldPatch) {
        await ctx.db.replace(
          existing._id,
          buildEmbeddingJobReplacement(
            existing,
            {
              status: args.status,
              attempts: nextAttempts,
              lastQueuedAt: nextLastQueuedAt,
              updatedAt: now,
              lastError: nextLastError,
              rebuildRunId: nextRebuildRunId,
            },
            {
              lastError: nextLastError === undefined ? true : undefined,
              rebuildRunId: nextRebuildRunId === undefined ? true : undefined,
            },
          ),
        );
      }
      return existing._id;
    }

    return await ctx.db.insert("embeddingJobs", {
      nodeId: args.nodeId,
      status: args.status,
      attempts: nextAttempts,
      lastQueuedAt: nextLastQueuedAt,
      updatedAt: now,
      ...(nextLastError ? { lastError: nextLastError } : {}),
      ...(nextRebuildRunId ? { rebuildRunId: nextRebuildRunId } : {}),
    });
  },
});

export const getEmbeddingJobState = internalQuery({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("embeddingJobs")
      .withIndex("by_node", (query) => query.eq("nodeId", args.nodeId))
      .first();
  },
});

export const saveNodeEmbedding = internalMutation({
  args: {
    nodeId: v.id("nodes"),
    pageId: v.id("pages"),
    content: v.string(),
    contentHash: v.string(),
    vector: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("nodeEmbeddings")
      .withIndex("by_node", (query) => query.eq("nodeId", args.nodeId))
      .first();
    const now = Date.now();
    const shouldWriteEmbedding =
      !existing ||
      existing.pageId !== args.pageId ||
      existing.content !== args.content;

    if (existing && shouldWriteEmbedding) {
      await ctx.db.patch(existing._id, {
        pageId: args.pageId,
        content: args.content,
        vector: args.vector,
        updatedAt: now,
      });
    } else if (!existing) {
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
      const shouldPatchJob =
        existingJob.status !== "completed" ||
        existingJob.lastError !== undefined ||
        existingJob.lastEmbeddedHash !== args.contentHash ||
        existingJob.lastEmbeddedPageId !== args.pageId;

      if (shouldPatchJob) {
        await ctx.db.replace(
          existingJob._id,
          buildEmbeddingJobReplacement(
            existingJob,
            {
              status: "completed",
              lastEmbeddedHash: args.contentHash,
              lastEmbeddedPageId: args.pageId,
              lastEmbeddedAt: now,
              updatedAt: now,
            },
            { lastError: true },
          ),
        );
      }
      return;
    }

    await ctx.db.insert("embeddingJobs", {
      nodeId: args.nodeId,
      status: "completed",
      attempts: 0,
      lastQueuedAt: now,
      lastEmbeddedHash: args.contentHash,
      lastEmbeddedPageId: args.pageId,
      lastEmbeddedAt: now,
      updatedAt: now,
    });
  },
});

export const clearNodeEmbedding = internalMutation({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    const embeddingJobs = await ctx.db
      .query("embeddingJobs")
      .withIndex("by_node", (query) => query.eq("nodeId", args.nodeId))
      .collect();
    const embeddings = await ctx.db
      .query("nodeEmbeddings")
      .withIndex("by_node", (query) => query.eq("nodeId", args.nodeId))
      .collect();
    const now = Date.now();

    for (const embedding of embeddings) {
      await ctx.db.delete(embedding._id);
    }

    for (const job of embeddingJobs) {
      const shouldPatchJob =
        job.status !== "completed" ||
        job.lastError !== undefined ||
        job.lastEmbeddedHash !== undefined ||
        job.lastEmbeddedPageId !== undefined;

      if (shouldPatchJob) {
        await ctx.db.replace(
          job._id,
          buildEmbeddingJobReplacement(
            job,
            {
              status: "completed",
              updatedAt: now,
            },
            {
              lastError: true,
              lastEmbeddedHash: true,
              lastEmbeddedPageId: true,
              lastEmbeddedAt: true,
            },
          ),
        );
      }
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
