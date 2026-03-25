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
