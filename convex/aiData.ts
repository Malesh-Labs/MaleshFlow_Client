import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { priorityValidator, taskStatusValidator } from "./lib/validators";
import { isSeparatorLineText } from "../lib/domain/displaySyntax";
import { linkSearchScore, normalizeLinkSearchQuery } from "../lib/domain/linkSearch";

const TEXT_SEARCH_NODE_CANDIDATE_LIMIT = 128;

async function hydrateSearchResultParentNodes<T extends { node: Doc<"nodes"> }>(
  db: QueryCtx["db"],
  results: T[],
  includeArchived: boolean,
) {
  const parentNodeIds = [
    ...new Set(
      results
        .map((result) => result.node.parentNodeId)
        .filter((nodeId): nodeId is Doc<"nodes">["_id"] => nodeId !== null),
    ),
  ];
  const parentNodes = await Promise.all(parentNodeIds.map((nodeId) => db.get(nodeId)));
  const parentNodeMap = new Map(
    parentNodes
      .filter(
        (node): node is Doc<"nodes"> =>
          Boolean(node) && (includeArchived || !node!.archived),
      )
      .map((node) => [node._id, node]),
  );

  return results.map((result) => ({
    ...result,
    parentNode: result.node.parentNodeId
      ? parentNodeMap.get(result.node.parentNodeId) ?? null
      : null,
  }));
}

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
    const includeArchived = args.includeArchived === true;
    const normalizedQuery = normalizeLinkSearchQuery(args.query);
    if (normalizedQuery.length === 0) {
      return [];
    }

    // Candidates come from the search index instead of a full table scan
    // (which exceeds Convex's read limit on large workspaces): one search
    // with the raw query (word-prefix semantics cover multi-word input) plus
    // a short first-word prefix probe so fuzzy in-order-letter queries like
    // "cofsho" still surface "coffee shop" candidates.
    const candidates: Doc<"nodes">[] = [];
    const seenCandidateIds = new Set<string>();
    const addCandidates = (batch: Doc<"nodes">[]) => {
      for (const node of batch) {
        if (!seenCandidateIds.has(node._id as string)) {
          seenCandidateIds.add(node._id as string);
          candidates.push(node);
        }
      }
    };
    const runSearch = async (searchQuery: string) =>
      await ctx.db
        .query("nodes")
        .withSearchIndex("search_text", (search) => {
          const withText = search.search("text", searchQuery).eq("archived", includeArchived);
          return args.pageId ? withText.eq("pageId", args.pageId!) : withText;
        })
        .take(TEXT_SEARCH_NODE_CANDIDATE_LIMIT);

    addCandidates(await runSearch(normalizedQuery));
    const firstWord = normalizedQuery.split(" ")[0] ?? "";
    const prefixProbe = firstWord.slice(0, 3);
    if (prefixProbe.length >= 2 && prefixProbe !== normalizedQuery) {
      addCandidates(await runSearch(prefixProbe));
    }

    const pageIds = [...new Set(candidates.map((node) => node.pageId))];
    const pages = await Promise.all(pageIds.map((pageId) => ctx.db.get(pageId)));
    const pageMap = new Map(
      pages
        .filter(
          (page): page is Doc<"pages"> =>
            Boolean(page) && (includeArchived ? page!.archived : !page!.archived),
        )
        .map((page) => [page._id, page]),
    );
    const terms = normalizedQuery.split(" ").filter(Boolean);

    // A candidate is kept when it matches the fuzzy tiers (prefix, word
    // start, substring, all-words, scattered letters) or contains at least
    // one query term; ranking prefers better fuzzy tiers, then more matched
    // terms, then shorter text.
    const results = candidates
      .filter((node) => pageMap.has(node.pageId))
      .map((node: Doc<"nodes">) => {
        const haystack = node.text.toLowerCase();
        const termScore = terms.reduce(
          (total, term) => (haystack.includes(term) ? total + 1 : total),
          0,
        );
        const fuzzyScore = linkSearchScore(node.text, normalizedQuery);

        return {
          score: termScore,
          fuzzyScore,
          node,
          page: pageMap.get(node.pageId) ?? null,
          content: node.text,
        };
      })
      .filter(
        (entry) => entry.score > 0 || entry.fuzzyScore !== Number.POSITIVE_INFINITY,
      )
      .sort((left, right) => {
        const leftTier =
          left.fuzzyScore === Number.POSITIVE_INFINITY ? 5 : left.fuzzyScore;
        const rightTier =
          right.fuzzyScore === Number.POSITIVE_INFINITY ? 5 : right.fuzzyScore;
        if (leftTier !== rightTier) {
          return leftTier - rightTier;
        }
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.node.text.trim().length - right.node.text.trim().length;
      })
      .slice(0, args.limit)
      .map((entry) => ({
        score: entry.score,
        node: entry.node,
        page: entry.page,
        content: entry.content,
      }));

    return await hydrateSearchResultParentNodes(
      ctx.db,
      results,
      includeArchived,
    );
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

    const results = hydrated
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

    return await hydrateSearchResultParentNodes(
      ctx.db,
      results,
      args.includeArchived === true,
    );
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
    const nextRebuildRunId = args.rebuildRunId;

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
    const separatorNote = isSeparatorLineText(node.text);
    const kind = separatorNote ? "note" : args.kind;

    await ctx.db.patch(args.nodeId, {
      kind,
      taskStatus:
        kind === "task"
          ? (args.taskStatus ?? node.taskStatus ?? "todo")
          : null,
      priority: separatorNote ? null : (args.priority ?? node.priority),
      updatedAt: Date.now(),
    });
  },
});
