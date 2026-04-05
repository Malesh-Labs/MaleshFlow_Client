import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";

export const EMBEDDING_REBUILD_STATE_KEY = "global";

export type EmbeddingJobStatus = "queued" | "running" | "completed" | "error";

export async function getEmbeddingRebuildState(
  db: DatabaseReader | DatabaseWriter,
) {
  return await db
    .query("embeddingRebuildState")
    .withIndex("by_key", (query) => query.eq("key", EMBEDDING_REBUILD_STATE_KEY))
    .unique();
}

export function buildEmptyEmbeddingRebuildStatus() {
  return {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    error: 0,
    pending: 0,
    idle: true,
    complete: true,
    cancelled: false,
    lastQueuedAt: null as number | null,
    status: "idle" as const,
    updatedAt: null as number | null,
    scannedNodes: 0,
    skippedNodes: 0,
    lastError: null as string | null,
  };
}

export function buildEmbeddingRebuildStatus(
  state: Doc<"embeddingRebuildState"> | null,
  overrides?: Partial<
    Pick<Doc<"embeddingRebuildState">, "queued" | "running" | "completed" | "error" | "status"> & {
      lastError: string | null;
    }
  >,
) {
  if (!state) {
    return buildEmptyEmbeddingRebuildStatus();
  }

  const total = state.eligibleNodes;
  const queued = overrides?.queued ?? state.queued;
  const running = overrides?.running ?? state.running;
  const completed = overrides?.completed ?? state.completed;
  const error = overrides?.error ?? state.error;
  const status = overrides?.status ?? state.status;
  const pending = Math.max(
    0,
    total - queued - running - completed - error,
  );
  const idle = status !== "running" && queued === 0 && running === 0;
  const complete =
    total === 0
      ? status !== "running" && status !== "cancelled"
      : completed === total &&
        queued === 0 &&
        running === 0 &&
        pending === 0 &&
        error === 0;

  return {
    total,
    queued,
    running,
    completed,
    error,
    pending,
    idle,
    complete,
    cancelled: status === "cancelled",
    lastQueuedAt: state.lastQueuedAt,
    status,
    updatedAt: state.updatedAt,
    scannedNodes: state.scannedNodes,
    skippedNodes: state.skippedNodes,
    lastError: overrides?.lastError ?? state.lastError ?? null,
  };
}

export function applyEmbeddingJobStatusTransition(
  counts: Pick<Doc<"embeddingRebuildState">, "queued" | "running" | "completed" | "error">,
  previousStatus: EmbeddingJobStatus | null,
  nextStatus: EmbeddingJobStatus,
) {
  let queued = counts.queued;
  let running = counts.running;
  let completed = counts.completed;
  let error = counts.error;

  if (previousStatus === "queued") {
    queued = Math.max(0, queued - 1);
  } else if (previousStatus === "running") {
    running = Math.max(0, running - 1);
  } else if (previousStatus === "completed") {
    completed = Math.max(0, completed - 1);
  } else if (previousStatus === "error") {
    error = Math.max(0, error - 1);
  }

  if (nextStatus === "queued") {
    queued += 1;
  } else if (nextStatus === "running") {
    running += 1;
  } else if (nextStatus === "completed") {
    completed += 1;
  } else if (nextStatus === "error") {
    error += 1;
  }

  return {
    queued,
    running,
    completed,
    error,
  };
}

export function shouldFinalizeEmbeddingRebuild(
  state: Pick<Doc<"embeddingRebuildState">, "scanComplete" | "queued" | "running">,
) {
  return state.scanComplete && state.queued === 0 && state.running === 0;
}
