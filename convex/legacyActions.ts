"use node";

import OpenAI from "openai";
import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import { buildDeterministicEmbedding } from "../lib/domain/embeddings";

const LEGACY_CHUNK_TARGET_CHARS = 4000;
const LEGACY_CHUNK_OVERLAP_CHARS = 400;
const LEGACY_CHUNK_WRITE_BATCH_SIZE = 32;
const LEGACY_EMBEDDING_BATCH_SIZE = 16;
const LEGACY_CLEANUP_BATCH_SIZE = 200;
const LEGACY_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

type LegacyChunkInput = {
  chunkIndex: number;
  text: string;
  lineStart: number;
  lineEnd: number;
  charStart: number;
  charEnd: number;
};

type InsertedLegacyChunk = {
  _id: Id<"legacyChunks">;
  fileId: Id<"legacyFiles">;
  chunkIndex: number;
  text: string;
};

type CleanupResult = {
  deleted: number;
  hasMore: boolean;
};

type LegacySearchResult = {
  chunkId: Id<"legacyChunks">;
  fileId: Id<"legacyFiles">;
  fileName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  mode: "semantic";
};

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function createEmbeddings(texts: string[]) {
  const client = getOpenAIClient();
  if (!client) {
    return texts.map((text) => buildDeterministicEmbedding(text));
  }

  const response = await client.embeddings.create({
    model: LEGACY_EMBEDDING_MODEL,
    input: texts,
  });

  return texts.map((text, index) => response.data[index]?.embedding ?? buildDeterministicEmbedding(text));
}

function splitLongLine(line: string) {
  if (line.length <= LEGACY_CHUNK_TARGET_CHARS) {
    return [line];
  }

  const segments: string[] = [];
  for (let index = 0; index < line.length; index += LEGACY_CHUNK_TARGET_CHARS) {
    segments.push(line.slice(index, index + LEGACY_CHUNK_TARGET_CHARS));
  }
  return segments;
}

function buildLineEntries(text: string) {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalizedText.split("\n");
  const entries: Array<{
    text: string;
    lineNumber: number;
    charStart: number;
    charEnd: number;
  }> = [];
  let cursor = 0;

  for (const [lineIndex, rawLine] of rawLines.entries()) {
    const lineNumber = lineIndex + 1;
    const suffix = lineIndex === rawLines.length - 1 ? "" : "\n";
    const lineWithSuffix = `${rawLine}${suffix}`;
    if (lineWithSuffix.length <= LEGACY_CHUNK_TARGET_CHARS) {
      entries.push({
        text: lineWithSuffix,
        lineNumber,
        charStart: cursor,
        charEnd: cursor + lineWithSuffix.length,
      });
    } else {
      let segmentCursor = cursor;
      for (const segment of splitLongLine(lineWithSuffix)) {
        entries.push({
          text: segment,
          lineNumber,
          charStart: segmentCursor,
          charEnd: segmentCursor + segment.length,
        });
        segmentCursor += segment.length;
      }
    }
    cursor += lineWithSuffix.length;
  }

  return entries;
}

function chunkLegacyText(text: string): LegacyChunkInput[] {
  const entries = buildLineEntries(text);
  const chunks: LegacyChunkInput[] = [];
  let entryIndex = 0;

  while (entryIndex < entries.length) {
    const startIndex = entryIndex;
    let chunkText = "";

    while (entryIndex < entries.length) {
      const entry = entries[entryIndex]!;
      if (
        chunkText.length > 0 &&
        chunkText.length + entry.text.length > LEGACY_CHUNK_TARGET_CHARS
      ) {
        break;
      }
      chunkText += entry.text;
      entryIndex += 1;
    }

    if (chunkText.trim().length === 0) {
      if (entryIndex === startIndex) {
        entryIndex += 1;
      }
      continue;
    }

    const endIndex = Math.max(startIndex, entryIndex - 1);
    const firstEntry = entries[startIndex]!;
    const lastEntry = entries[endIndex]!;
    chunks.push({
      chunkIndex: chunks.length,
      text: chunkText.trimEnd(),
      lineStart: firstEntry.lineNumber,
      lineEnd: lastEntry.lineNumber,
      charStart: firstEntry.charStart,
      charEnd: lastEntry.charEnd,
    });

    if (entryIndex >= entries.length) {
      break;
    }

    let overlapStart = entryIndex;
    let overlapChars = 0;
    for (let index = entryIndex - 1; index >= startIndex; index -= 1) {
      overlapChars += entries[index]!.text.length;
      overlapStart = index;
      if (overlapChars >= LEGACY_CHUNK_OVERLAP_CHARS) {
        break;
      }
    }

    if (overlapStart > startIndex) {
      entryIndex = overlapStart;
    }
  }

  return chunks;
}

async function deleteAllLegacyIndexData(
  ctx: ActionCtx,
  fileId: Id<"legacyFiles">,
) {
  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const result = (await ctx.runMutation(internal.legacy.deleteLegacyEmbeddingsBatch, {
      fileId,
      batchSize: LEGACY_CLEANUP_BATCH_SIZE,
    })) as CleanupResult;
    if (!result.hasMore) {
      break;
    }
  }

  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const result = (await ctx.runMutation(internal.legacy.deleteLegacyChunksBatch, {
      fileId,
      batchSize: LEGACY_CLEANUP_BATCH_SIZE,
    })) as CleanupResult;
    if (!result.hasMore) {
      break;
    }
  }
}

async function deleteAllLegacyEmbeddings(
  ctx: ActionCtx,
  fileId: Id<"legacyFiles">,
) {
  for (let attempts = 0; attempts < 1000; attempts += 1) {
    const result = (await ctx.runMutation(internal.legacy.deleteLegacyEmbeddingsBatch, {
      fileId,
      batchSize: LEGACY_CLEANUP_BATCH_SIZE,
    })) as CleanupResult;
    if (!result.hasMore) {
      break;
    }
  }
}

async function saveEmbeddingsForChunks(
  ctx: ActionCtx,
  fileId: Id<"legacyFiles">,
  chunks: InsertedLegacyChunk[],
) {
  let embeddedCount = 0;
  for (let index = 0; index < chunks.length; index += LEGACY_EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(index, index + LEGACY_EMBEDDING_BATCH_SIZE);
    const vectors = await createEmbeddings(batch.map((chunk) => chunk.text));
    await ctx.runMutation(internal.legacy.saveLegacyEmbeddingsBatch, {
      fileId,
      model: LEGACY_EMBEDDING_MODEL,
      embeddings: batch.map((chunk, batchIndex) => ({
        chunkId: chunk._id,
        chunkIndex: chunk.chunkIndex,
        vector: vectors[batchIndex] ?? buildDeterministicEmbedding(chunk.text),
      })),
    });
    embeddedCount += batch.length;
    await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
      fileId,
      semanticStatus: "processing",
      semanticChunkCount: embeddedCount,
      semanticError: null,
    });
  }
  return embeddedCount;
}

export const processLegacyFile = action({
  args: {
    ownerKey: v.string(),
    fileId: v.id("legacyFiles"),
    buildSemantic: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const file = (await ctx.runQuery(internal.legacy.getLegacyFileForProcessing, {
      fileId: args.fileId,
    })) as Doc<"legacyFiles"> | null;
    if (!file) {
      throw new Error("Legacy file not found.");
    }

    await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
      fileId: args.fileId,
      status: "processing",
      error: null,
      chunkCount: 0,
      semanticStatus: args.buildSemantic ? "queued" : "none",
      semanticError: null,
      semanticChunkCount: 0,
    });

    let insertedCount = 0;
    let semanticCount = 0;

    try {
      await deleteAllLegacyIndexData(ctx, args.fileId);
      const blob = await ctx.storage.get(file.storageId);
      if (!blob) {
        throw new Error("Uploaded file was not found in storage.");
      }

      const text = await blob.text();
      const chunks = chunkLegacyText(text);

      for (let index = 0; index < chunks.length; index += LEGACY_CHUNK_WRITE_BATCH_SIZE) {
        const batch = chunks.slice(index, index + LEGACY_CHUNK_WRITE_BATCH_SIZE);
        const inserted = (await ctx.runMutation(internal.legacy.insertLegacyChunksBatch, {
          fileId: args.fileId,
          chunks: batch,
        })) as InsertedLegacyChunk[];
        insertedCount += inserted.length;
        await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
          fileId: args.fileId,
          status: "processing",
          chunkCount: insertedCount,
        });

        if (args.buildSemantic && inserted.length > 0) {
          semanticCount += await saveEmbeddingsForChunks(ctx, args.fileId, inserted);
        }
      }

      await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
        fileId: args.fileId,
        status: "ready",
        error: null,
        chunkCount: insertedCount,
        semanticStatus: args.buildSemantic ? "ready" : "none",
        semanticError: null,
        semanticChunkCount: args.buildSemantic ? semanticCount : 0,
      });

      return {
        fileId: args.fileId,
        chunkCount: insertedCount,
        semanticChunkCount: args.buildSemantic ? semanticCount : 0,
      };
    } catch (error) {
      if (args.buildSemantic && insertedCount > 0) {
        await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
          fileId: args.fileId,
          status: "ready",
          error: null,
          chunkCount: insertedCount,
          semanticStatus: "error",
          semanticError:
            error instanceof Error ? error.message : "Could not build semantic index.",
          semanticChunkCount: semanticCount,
        });
        return {
          fileId: args.fileId,
          chunkCount: insertedCount,
          semanticChunkCount: semanticCount,
        };
      }

      await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
        fileId: args.fileId,
        status: "error",
        error: error instanceof Error ? error.message : "Could not process legacy file.",
        semanticStatus: args.buildSemantic ? "error" : "none",
        semanticError:
          args.buildSemantic && error instanceof Error
            ? error.message
            : args.buildSemantic
              ? "Could not process semantic index."
              : null,
      });
      throw error;
    }
  },
});

export const buildLegacySemanticIndex = action({
  args: {
    ownerKey: v.string(),
    fileId: v.id("legacyFiles"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const file = (await ctx.runQuery(internal.legacy.getLegacyFileForProcessing, {
      fileId: args.fileId,
    })) as Doc<"legacyFiles"> | null;
    if (!file) {
      throw new Error("Legacy file not found.");
    }
    if (file.status !== "ready") {
      throw new Error("Wait for this file to finish processing before building semantic search.");
    }

    await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
      fileId: args.fileId,
      semanticStatus: "processing",
      semanticError: null,
      semanticChunkCount: 0,
    });

    try {
      await deleteAllLegacyEmbeddings(ctx, args.fileId);
      let afterChunkIndex: number | undefined;
      let embeddedCount = 0;

      for (let attempts = 0; attempts < 1000; attempts += 1) {
        const chunks = (await ctx.runQuery(internal.legacy.listLegacyChunksForEmbedding, {
          fileId: args.fileId,
          afterChunkIndex,
          limit: LEGACY_CHUNK_WRITE_BATCH_SIZE,
        })) as Doc<"legacyChunks">[];
        if (chunks.length === 0) {
          break;
        }

        const insertedChunks = chunks.map((chunk) => ({
          _id: chunk._id,
          fileId: chunk.fileId,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
        }));
        embeddedCount += await saveEmbeddingsForChunks(ctx, args.fileId, insertedChunks);
        afterChunkIndex = chunks[chunks.length - 1]!.chunkIndex;
      }

      await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
        fileId: args.fileId,
        semanticStatus: "ready",
        semanticError: null,
        semanticChunkCount: embeddedCount,
      });

      return {
        fileId: args.fileId,
        semanticChunkCount: embeddedCount,
      };
    } catch (error) {
      await ctx.runMutation(internal.legacy.markLegacyFileStatus, {
        fileId: args.fileId,
        semanticStatus: "error",
        semanticError:
          error instanceof Error ? error.message : "Could not build semantic index.",
      });
      throw error;
    }
  },
});

export const searchLegacySemantic = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    fileId: v.optional(v.id("legacyFiles")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<LegacySearchResult[]> => {
    assertOwnerKey(args.ownerKey);
    const normalizedQuery = args.query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const limit = Math.max(1, Math.min(args.limit ?? 20, 20));
    const [vector] = await createEmbeddings([normalizedQuery]);
    const matches = await ctx.vectorSearch("legacyChunkEmbeddings", "by_embedding", {
      vector,
      limit,
      filter: args.fileId
        ? (query) => query.eq("fileId", args.fileId!)
        : undefined,
    });

    if (matches.length === 0) {
      return [];
    }

    return (await ctx.runQuery(internal.legacy.hydrateLegacyEmbeddingMatches, {
      embeddingIds: matches.map((match) => match._id),
      query: normalizedQuery,
    })) as LegacySearchResult[];
  },
});
