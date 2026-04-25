import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";

const LEGACY_SEARCH_SNIPPET_RADIUS = 160;

const legacyFileStatusValidator = v.union(
  v.literal("uploaded"),
  v.literal("processing"),
  v.literal("ready"),
  v.literal("error"),
);

const legacySemanticStatusValidator = v.union(
  v.literal("none"),
  v.literal("queued"),
  v.literal("processing"),
  v.literal("ready"),
  v.literal("error"),
);

const legacyChunkInputValidator = v.object({
  chunkIndex: v.number(),
  text: v.string(),
  lineStart: v.number(),
  lineEnd: v.number(),
  charStart: v.number(),
  charEnd: v.number(),
});

function getTimestamp() {
  return Date.now();
}

function normalizeLegacyExtension(fileName: string) {
  const match = fileName.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function assertLegacyTextFile(fileName: string) {
  const extension = normalizeLegacyExtension(fileName);
  if (extension !== "md" && extension !== "txt") {
    throw new Error("Legacy imports currently support .md and .txt files.");
  }
  return extension;
}

function buildLegacySnippet(text: string, query: string) {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= LEGACY_SEARCH_SNIPPET_RADIUS * 2) {
    return normalizedText;
  }

  const lowerText = normalizedText.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const firstMatchIndex = terms.reduce((bestIndex, term) => {
    const index = lowerText.indexOf(term);
    if (index === -1) {
      return bestIndex;
    }
    return bestIndex === -1 ? index : Math.min(bestIndex, index);
  }, -1);
  const center = firstMatchIndex === -1 ? 0 : firstMatchIndex;
  const start = Math.max(0, center - LEGACY_SEARCH_SNIPPET_RADIUS);
  const end = Math.min(normalizedText.length, center + LEGACY_SEARCH_SNIPPET_RADIUS);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < normalizedText.length ? " ..." : "";
  return `${prefix}${normalizedText.slice(start, end)}${suffix}`;
}

export const generateLegacyUploadUrl = mutation({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    return await ctx.storage.generateUploadUrl();
  },
});

export const registerLegacyFile = mutation({
  args: {
    ownerKey: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    filePath: v.optional(v.string()),
    mimeType: v.optional(v.union(v.string(), v.null())),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const extension = assertLegacyTextFile(args.fileName);
    const now = getTimestamp();
    return await ctx.db.insert("legacyFiles", {
      storageId: args.storageId,
      fileName: args.fileName.trim() || "Untitled legacy file",
      filePath: (args.filePath ?? args.fileName).trim() || args.fileName,
      extension,
      mimeType: args.mimeType ?? null,
      size: Math.max(0, args.size),
      status: "uploaded",
      error: null,
      chunkCount: 0,
      semanticStatus: "none",
      semanticError: null,
      semanticChunkCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listLegacyFiles = query({
  args: {
    ownerKey: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const limit = Math.max(1, Math.min(args.limit ?? 100, 200));
    return await ctx.db
      .query("legacyFiles")
      .withIndex("by_updated_at")
      .order("desc")
      .take(limit);
  },
});

export const searchLegacyText = query({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    fileId: v.optional(v.id("legacyFiles")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const normalizedQuery = args.query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const limit = Math.max(1, Math.min(args.limit ?? 20, 20));
    const chunks = args.fileId
      ? await ctx.db
          .query("legacyChunks")
          .withSearchIndex("search_text", (search) =>
            search.search("text", normalizedQuery).eq("fileId", args.fileId!),
          )
          .take(limit)
      : await ctx.db
          .query("legacyChunks")
          .withSearchIndex("search_text", (search) =>
            search.search("text", normalizedQuery),
          )
          .take(limit);

    const fileIds = [...new Set(chunks.map((chunk) => chunk.fileId))];
    const files = await Promise.all(fileIds.map((fileId) => ctx.db.get(fileId)));
    const fileMap = new Map(
      files
        .filter((file): file is Doc<"legacyFiles"> => file !== null)
        .map((file) => [file._id as string, file]),
    );

    return chunks
      .map((chunk) => {
        const file = fileMap.get(chunk.fileId as string) ?? null;
        if (!file) {
          return null;
        }

        return {
          chunkId: chunk._id,
          fileId: file._id,
          fileName: file.fileName,
          filePath: file.filePath,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          snippet: buildLegacySnippet(chunk.text, normalizedQuery),
          mode: "text" as const,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  },
});

export const getLegacyFileForProcessing = internalQuery({
  args: {
    fileId: v.id("legacyFiles"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.fileId);
  },
});

export const listLegacyChunksForEmbedding = internalQuery({
  args: {
    fileId: v.id("legacyFiles"),
    afterChunkIndex: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit, 64));
    return args.afterChunkIndex === undefined
      ? await ctx.db
          .query("legacyChunks")
          .withIndex("by_file_and_chunk_index", (query) => query.eq("fileId", args.fileId))
          .take(limit)
      : await ctx.db
          .query("legacyChunks")
          .withIndex("by_file_and_chunk_index", (query) =>
            query.eq("fileId", args.fileId).gt("chunkIndex", args.afterChunkIndex!),
          )
          .take(limit);
  },
});

export const hydrateLegacyEmbeddingMatches = internalQuery({
  args: {
    embeddingIds: v.array(v.id("legacyChunkEmbeddings")),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const embeddings = await Promise.all(
      args.embeddingIds.map((embeddingId) => ctx.db.get(embeddingId)),
    );
    const chunks = await Promise.all(
      embeddings.map((embedding) => (embedding ? ctx.db.get(embedding.chunkId) : null)),
    );
    const fileIds = [
      ...new Set(
        embeddings
          .filter((embedding): embedding is Doc<"legacyChunkEmbeddings"> => embedding !== null)
          .map((embedding) => embedding.fileId),
      ),
    ];
    const files = await Promise.all(fileIds.map((fileId) => ctx.db.get(fileId)));
    const fileMap = new Map(
      files
        .filter((file): file is Doc<"legacyFiles"> => file !== null)
        .map((file) => [file._id as string, file]),
    );

    return embeddings
      .map((embedding, index) => {
        const chunk = chunks[index];
        if (!embedding || !chunk) {
          return null;
        }
        const file = fileMap.get(embedding.fileId as string) ?? null;
        if (!file) {
          return null;
        }
        return {
          chunkId: chunk._id,
          fileId: file._id,
          fileName: file.fileName,
          filePath: file.filePath,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          snippet: buildLegacySnippet(chunk.text, args.query),
          mode: "semantic" as const,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  },
});

export const markLegacyFileStatus = internalMutation({
  args: {
    fileId: v.id("legacyFiles"),
    status: v.optional(legacyFileStatusValidator),
    error: v.optional(v.union(v.string(), v.null())),
    chunkCount: v.optional(v.number()),
    semanticStatus: v.optional(legacySemanticStatusValidator),
    semanticError: v.optional(v.union(v.string(), v.null())),
    semanticChunkCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Partial<Doc<"legacyFiles">> = {
      updatedAt: getTimestamp(),
    };
    if (args.status !== undefined) {
      patch.status = args.status;
    }
    if (args.error !== undefined) {
      patch.error = args.error;
    }
    if (args.chunkCount !== undefined) {
      patch.chunkCount = args.chunkCount;
    }
    if (args.semanticStatus !== undefined) {
      patch.semanticStatus = args.semanticStatus;
    }
    if (args.semanticError !== undefined) {
      patch.semanticError = args.semanticError;
    }
    if (args.semanticChunkCount !== undefined) {
      patch.semanticChunkCount = args.semanticChunkCount;
    }
    await ctx.db.patch(args.fileId, patch);
  },
});

export const deleteLegacyChunksBatch = internalMutation({
  args: {
    fileId: v.id("legacyFiles"),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = Math.max(1, Math.min(args.batchSize ?? 100, 200));
    const chunks = await ctx.db
      .query("legacyChunks")
      .withIndex("by_file_and_chunk_index", (query) => query.eq("fileId", args.fileId))
      .take(batchSize);
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }
    return { deleted: chunks.length, hasMore: chunks.length === batchSize };
  },
});

export const deleteLegacyEmbeddingsBatch = internalMutation({
  args: {
    fileId: v.id("legacyFiles"),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = Math.max(1, Math.min(args.batchSize ?? 100, 200));
    const embeddings = await ctx.db
      .query("legacyChunkEmbeddings")
      .withIndex("by_file_and_chunk_index", (query) => query.eq("fileId", args.fileId))
      .take(batchSize);
    for (const embedding of embeddings) {
      await ctx.db.delete(embedding._id);
    }
    return { deleted: embeddings.length, hasMore: embeddings.length === batchSize };
  },
});

export const insertLegacyChunksBatch = internalMutation({
  args: {
    fileId: v.id("legacyFiles"),
    chunks: v.array(legacyChunkInputValidator),
  },
  handler: async (ctx, args) => {
    const now = getTimestamp();
    const inserted = [];
    for (const chunk of args.chunks) {
      const chunkId: Id<"legacyChunks"> = await ctx.db.insert("legacyChunks", {
        fileId: args.fileId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        createdAt: now,
      });
      inserted.push({
        _id: chunkId,
        fileId: args.fileId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
      });
    }
    return inserted;
  },
});

export const saveLegacyEmbeddingsBatch = internalMutation({
  args: {
    fileId: v.id("legacyFiles"),
    model: v.string(),
    embeddings: v.array(
      v.object({
        chunkId: v.id("legacyChunks"),
        chunkIndex: v.number(),
        vector: v.array(v.float64()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = getTimestamp();
    for (const embedding of args.embeddings) {
      await ctx.db.insert("legacyChunkEmbeddings", {
        chunkId: embedding.chunkId,
        fileId: args.fileId,
        chunkIndex: embedding.chunkIndex,
        model: args.model,
        vector: embedding.vector,
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});
