import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  nodeKindValidator,
  nullableNodeIdValidator,
  nullablePageIdValidator,
  priorityValidator,
  taskStatusValidator,
} from "./lib/validators";

export default defineSchema({
  pages: defineTable({
    title: v.string(),
    slug: v.string(),
    icon: v.union(v.string(), v.null()),
    archived: v.boolean(),
    position: v.number(),
    sourceMeta: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_archived_position", ["archived", "position"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["archived"],
    }),

  nodes: defineTable({
    pageId: v.id("pages"),
    parentNodeId: nullableNodeIdValidator,
    position: v.number(),
    text: v.string(),
    kind: nodeKindValidator,
    taskStatus: taskStatusValidator,
    priority: priorityValidator,
    dueAt: v.union(v.number(), v.null()),
    archived: v.boolean(),
    sourceMeta: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_page_parent_position", ["pageId", "parentNodeId", "position"])
    .index("by_page_archived", ["pageId", "archived"])
    .index("by_kind_status", ["kind", "taskStatus", "archived"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["pageId", "archived", "kind"],
    }),

  links: defineTable({
    sourcePageId: nullablePageIdValidator,
    sourceNodeId: nullableNodeIdValidator,
    targetPageId: nullablePageIdValidator,
    targetNodeId: nullableNodeIdValidator,
    targetPageTitle: v.union(v.string(), v.null()),
    targetNodeRef: v.union(v.string(), v.null()),
    label: v.string(),
    kind: v.union(v.literal("page"), v.literal("node")),
    resolved: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_page", ["sourcePageId"])
    .index("by_source_node", ["sourceNodeId"])
    .index("by_target_page", ["targetPageId"])
    .index("by_target_node", ["targetNodeId"]),

  chatThreads: defineTable({
    pageId: nullablePageIdValidator,
    title: v.string(),
    scope: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_page_updatedAt", ["pageId", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

  chatMessages: defineTable({
    threadId: v.id("chatThreads"),
    role: v.union(
      v.literal("system"),
      v.literal("user"),
      v.literal("assistant"),
    ),
    text: v.string(),
    preview: v.optional(v.array(v.string())),
    proposedPlan: v.optional(v.any()),
    metadata: v.optional(v.any()),
    status: v.union(
      v.literal("ready"),
      v.literal("pending_approval"),
      v.literal("applied"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    createdAt: v.number(),
    appliedAt: v.optional(v.number()),
  })
    .index("by_thread_createdAt", ["threadId", "createdAt"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  imports: defineTable({
    sourceType: v.string(),
    status: v.union(
      v.literal("processing"),
      v.literal("completed"),
      v.literal("error"),
    ),
    originalFiles: v.array(v.string()),
    warnings: v.array(v.string()),
    fileCount: v.number(),
    importedPageCount: v.number(),
    importedNodeCount: v.number(),
    summary: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_createdAt", ["createdAt"]),

  migrationRuns: defineTable({
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    status: v.union(
      v.literal("draft"),
      v.literal("reviewing"),
      v.literal("completed"),
      v.literal("abandoned"),
      v.literal("error"),
    ),
    title: v.string(),
    sourceSummary: v.string(),
    lessonsDoc: v.string(),
    totalChunks: v.number(),
    readyChunks: v.number(),
    reviewChunks: v.number(),
    appliedChunks: v.number(),
    skippedChunks: v.number(),
    errorChunks: v.number(),
    sourceDocumentCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_status_updatedAt", ["status", "updatedAt"]),

  migrationLessons: defineTable({
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    lessonsDoc: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_source_type", ["sourceType"]),

  migrationSourceDocuments: defineTable({
    runId: v.id("migrationRuns"),
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    sourceDocumentId: v.string(),
    title: v.string(),
    sourcePath: v.string(),
    detectedJournalDate: v.union(v.string(), v.null()),
    order: v.number(),
    metadata: v.optional(v.any()),
    carryForwardPlan: v.optional(v.any()),
    destinationPageId: v.union(v.id("pages"), v.null()),
    destinationPageTitle: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run_and_order", ["runId", "order"])
    .index("by_run_and_source_document_id", ["runId", "sourceDocumentId"]),

  migrationChunks: defineTable({
    runId: v.id("migrationRuns"),
    sourceDocumentEntryId: v.id("migrationSourceDocuments"),
    sourceDocumentId: v.string(),
    order: v.number(),
    lineCount: v.number(),
    ancestorChain: v.any(),
    roots: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("needs_review"),
      v.literal("approved"),
      v.literal("applied"),
      v.literal("skipped"),
      v.literal("error"),
    ),
    chunkText: v.string(),
    preview: v.array(v.string()),
    suggestion: v.optional(v.any()),
    approvedPlan: v.optional(v.any()),
    guidance: v.optional(v.string()),
    matchedExampleId: v.union(v.id("migrationExamples"), v.null()),
    createdPageId: v.union(v.id("pages"), v.null()),
    createdNodeCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    appliedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_run_and_order", ["runId", "order"])
    .index("by_run_and_status_and_order", ["runId", "status", "order"])
    .index("by_source_document_entry_and_order", ["sourceDocumentEntryId", "order"]),

  migrationExamples: defineTable({
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    summary: v.string(),
    chunkText: v.string(),
    guidance: v.string(),
    approvedPlan: v.any(),
    vector: v.array(v.float64()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_type_createdAt", ["sourceType", "createdAt"])
    .vectorIndex("by_embedding", {
      vectorField: "vector",
      dimensions: 1536,
      filterFields: ["sourceType"],
    }),

  embeddingJobs: defineTable({
    nodeId: v.id("nodes"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("error"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    lastQueuedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_node", ["nodeId"])
    .index("by_status_updatedAt", ["status", "updatedAt"]),

  nodeEmbeddings: defineTable({
    nodeId: v.id("nodes"),
    pageId: v.id("pages"),
    content: v.string(),
    vector: v.array(v.float64()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_node", ["nodeId"])
    .index("by_page", ["pageId"])
    .vectorIndex("by_embedding", {
      vectorField: "vector",
      dimensions: 1536,
      filterFields: ["pageId"],
    }),
});
