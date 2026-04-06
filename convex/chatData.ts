import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  buildUniquePageSlug,
  computeNodePosition,
  deleteNodeTree,
  enqueueNodeAiWork,
  syncLinksForNode,
} from "./lib/workspace";
import { chatPlanSchema, type ChatOperation } from "../lib/domain/chat";
import {
  plannerChatPlanSchema,
  type PlannerChatOperation,
} from "../lib/domain/planner";
import { completePlannerLinkedTask } from "./lib/planner";

const WORKSPACE_KNOWLEDGE_SCOPE = "workspaceKnowledge";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findWorkspaceKnowledgeThread(ctx: any) {
  const workspaceThreads = await ctx.db
    .query("chatThreads")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withIndex("by_page_updatedAt", (query: any) => query.eq("pageId", null))
    .order("desc")
    .collect();

  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaceThreads.find((thread: any) => thread.scope === WORKSPACE_KNOWLEDGE_SCOPE) ??
    null
  );
}

export const ensureChatThread = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.optional(v.id("pages")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const existing = args.pageId
      ? await ctx.db
          .query("chatThreads")
          .withIndex("by_page_updatedAt", (query) =>
            query.eq("pageId", args.pageId!),
          )
          .order("desc")
          .first()
      : await ctx.db
          .query("chatThreads")
          .withIndex("by_updatedAt")
          .order("desc")
          .first();

    if (existing) {
      return existing._id;
    }

    const now = Date.now();
    return await ctx.db.insert("chatThreads", {
      pageId: args.pageId ?? null,
      title: args.pageId ? "Page Chat" : "Workspace Chat",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const ensureWorkspaceKnowledgeThread = mutation({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const existing = await findWorkspaceKnowledgeThread(ctx);
    if (existing) {
      return existing._id;
    }

    const now = Date.now();
    return await ctx.db.insert("chatThreads", {
      pageId: null,
      title: "Workspace Knowledge Chat",
      scope: WORKSPACE_KNOWLEDGE_SCOPE,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getChatThread = query({
  args: {
    ownerKey: v.string(),
    threadId: v.optional(v.id("chatThreads")),
    pageId: v.optional(v.id("pages")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const thread = args.threadId
      ? await ctx.db.get(args.threadId)
      : args.pageId
        ? await ctx.db
            .query("chatThreads")
            .withIndex("by_page_updatedAt", (query) =>
              query.eq("pageId", args.pageId!),
            )
            .order("desc")
            .first()
        : await ctx.db
            .query("chatThreads")
            .withIndex("by_updatedAt")
            .order("desc")
            .first();

    if (!thread) {
      return null;
    }

    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread_createdAt", (query) =>
        query.eq("threadId", thread._id),
      )
      .collect();

    return {
      thread,
      messages,
    };
  },
});

export const getWorkspaceKnowledgeThread = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const thread = await findWorkspaceKnowledgeThread(ctx);
    if (!thread) {
      return null;
    }

    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread_createdAt", (query) =>
        query.eq("threadId", thread._id),
      )
      .collect();

    return {
      thread,
      messages,
    };
  },
});

export const getThreadMessages = internalQuery({
  args: {
    threadId: v.id("chatThreads"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const query = ctx.db
      .query("chatMessages")
      .withIndex("by_thread_createdAt", (query) =>
        query.eq("threadId", args.threadId),
      );

    if (args.limit && args.limit > 0) {
      const recentMessages = await query
        .order("desc")
        .take(Math.max(1, Math.floor(args.limit)));
      return recentMessages.reverse();
    }

    return await query.collect();
  },
});

export const storeUserMessage = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.threadId, {
      updatedAt: now,
    });
    return await ctx.db.insert("chatMessages", {
      threadId: args.threadId,
      role: "user",
      text: args.text,
      status: "ready",
      createdAt: now,
    });
  },
});

export const storeAssistantPlan = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    text: v.string(),
    preview: v.array(v.string()),
    proposedPlan: v.any(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.threadId, {
      updatedAt: now,
    });
    return await ctx.db.insert("chatMessages", {
      threadId: args.threadId,
      role: "assistant",
      text: args.text,
      preview: args.preview,
      proposedPlan: args.proposedPlan,
      status: "pending_approval",
      createdAt: now,
    });
  },
});

export const storeAssistantMessage = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    text: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.threadId, {
      updatedAt: now,
    });
    return await ctx.db.insert("chatMessages", {
      threadId: args.threadId,
      role: "assistant",
      text: args.text,
      metadata: args.metadata,
      status: "ready",
      createdAt: now,
    });
  },
});

export const replaceSectionLines = internalMutation({
  args: {
    pageId: v.id("pages"),
    sectionNodeId: v.id("nodes"),
    lines: v.array(v.string()),
    generatedFrom: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedLines = args.lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const lockKind = args.generatedFrom === "journal_feedback";

    const existingChildren = await ctx.db
      .query("nodes")
      .withIndex("by_page_parent_position", (query) =>
        query.eq("pageId", args.pageId).eq("parentNodeId", args.sectionNodeId),
      )
      .collect();

    for (const child of existingChildren) {
      await deleteNodeTree(ctx.db, child._id);
    }

    let lastNodeId: Id<"nodes"> | null = null;
    let insertedCount = 0;

    for (const line of normalizedLines) {
      const nodeId: Id<"nodes"> = await ctx.db.insert("nodes", {
        pageId: args.pageId,
        parentNodeId: args.sectionNodeId,
        position: await computeNodePosition(
          ctx.db,
          args.pageId,
          args.sectionNodeId,
          lastNodeId,
        ),
        text: line,
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "chat",
          generatedFrom: args.generatedFrom ?? "chat_section",
          ...(lockKind ? { taskKindLocked: true } : {}),
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      lastNodeId = nodeId;
      insertedCount += 1;

      const inserted = (await ctx.db.get(nodeId)) as Doc<"nodes"> | null;
      if (inserted) {
        await syncLinksForNode(ctx.db, inserted);
        await enqueueNodeAiWork(ctx, inserted._id);
      }
    }

    await ctx.db.patch(args.sectionNodeId, {
      updatedAt: Date.now(),
    });

    return {
      insertedCount,
    };
  },
});

async function applyOperation(ctx: MutationCtx, operation: ChatOperation) {
  switch (operation.type) {
    case "create_page": {
      const title = operation.title?.trim();
      if (!title) {
        return;
      }

      const slug = await buildUniquePageSlug(ctx.db, title);
      await ctx.db.insert("pages", {
        title,
        slug,
        icon: null,
        archived: false,
        position: Date.now(),
        sourceMeta: {
          sourceType: "chat",
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return;
    }
    case "rename_page": {
      if (!operation.pageId || !operation.title) {
        return;
      }

      const pageId = operation.pageId as Id<"pages">;
      const slug = await buildUniquePageSlug(ctx.db, operation.title, pageId);
      await ctx.db.patch(pageId, {
        title: operation.title,
        slug,
        updatedAt: Date.now(),
      });
      return;
    }
    case "create_node": {
      if (!operation.pageId || !operation.text) {
        return;
      }

      const pageId = operation.pageId as Id<"pages">;
      const parentNodeId =
        (operation.parentNodeId as Id<"nodes"> | null | undefined) ?? null;
      const afterNodeId =
        (operation.afterNodeId as Id<"nodes"> | null | undefined) ?? null;
      const position = await computeNodePosition(
        ctx.db,
        pageId,
        parentNodeId,
        afterNodeId,
      );
      const nodeId = await ctx.db.insert("nodes", {
        pageId,
        parentNodeId,
        position,
        text: operation.text,
        kind: operation.kind ?? "note",
        taskStatus:
          operation.kind === "task" ? (operation.taskStatus ?? "todo") : null,
        priority: operation.priority ?? null,
        dueAt: operation.dueAt ?? null,
        archived: false,
        sourceMeta: {
          sourceType: "chat",
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const node = await ctx.db.get(nodeId);
      if (node) {
        await syncLinksForNode(ctx.db, node);
        await enqueueNodeAiWork(ctx, nodeId);
      }
      return;
    }
    case "update_node": {
      if (!operation.nodeId) {
        return;
      }

      const nodeId = operation.nodeId as Id<"nodes">;
      await ctx.db.patch(nodeId, {
        text: operation.text ?? undefined,
        kind: operation.kind ?? undefined,
        taskStatus:
          operation.kind === "task"
            ? (operation.taskStatus ?? "todo")
            : operation.kind === "note"
              ? null
              : undefined,
        priority: operation.priority ?? undefined,
        dueAt: operation.dueAt ?? undefined,
        updatedAt: Date.now(),
      });
      const updated = await ctx.db.get(nodeId);
      if (updated) {
        await syncLinksForNode(ctx.db, updated);
        await enqueueNodeAiWork(ctx, updated._id);
      }
      return;
    }
    case "move_node": {
      if (!operation.nodeId) {
        return;
      }

      const nodeId = operation.nodeId as Id<"nodes">;
      const node = await ctx.db.get(nodeId);
      if (!node) {
        return;
      }

      const nextPageId =
        (operation.pageId as Id<"pages"> | undefined) ?? node.pageId;
      const nextParentId =
        operation.parentNodeId === undefined
          ? node.parentNodeId
          : ((operation.parentNodeId as Id<"nodes"> | null) ?? null);
      const position = await computeNodePosition(
        ctx.db,
        nextPageId,
        nextParentId,
        ((operation.afterNodeId as Id<"nodes"> | null | undefined) ?? null),
      );
      await ctx.db.patch(nodeId, {
        pageId: nextPageId,
        parentNodeId: nextParentId,
        position,
        updatedAt: Date.now(),
      });
      await enqueueNodeAiWork(ctx, nodeId);
      return;
    }
    case "archive_node": {
      if (!operation.nodeId) {
        return;
      }
      await ctx.db.patch(operation.nodeId as Id<"nodes">, {
        archived: operation.archived ?? true,
        updatedAt: Date.now(),
      });
      return;
    }
    case "delete_node": {
      if (!operation.nodeId) {
        return;
      }
      await deleteNodeTree(ctx.db, operation.nodeId as Id<"nodes">);
      return;
    }
    case "merge_node": {
      if (!operation.sourceNodeId || !operation.targetNodeId) {
        return;
      }

      const sourceNodeId = operation.sourceNodeId as Id<"nodes">;
      const targetNodeId = operation.targetNodeId as Id<"nodes">;
      const source = await ctx.db.get(sourceNodeId);
      const target = await ctx.db.get(targetNodeId);
      if (!source || !target) {
        return;
      }

      await ctx.db.patch(target._id, {
        text: `${target.text}\n${source.text}`.trim(),
        updatedAt: Date.now(),
      });
      const refreshed = await ctx.db.get(target._id);
      if (refreshed) {
        await syncLinksForNode(ctx.db, refreshed);
        await enqueueNodeAiWork(ctx, refreshed._id);
      }
      await deleteNodeTree(ctx.db, source._id);
      return;
    }
  }
}

async function applyPlannerOperation(
  ctx: MutationCtx,
  operation: PlannerChatOperation,
  completionMode: "dueDate" | "today",
) {
  switch (operation.type) {
    case "complete_planner_task": {
      await completePlannerLinkedTask(ctx, {
        plannerNodeId: operation.nodeId as Id<"nodes">,
        completionMode,
      });
      return;
    }
    case "delete_planner_node": {
      await deleteNodeTree(ctx.db, operation.nodeId as Id<"nodes">);
      return;
    }
    case "update_planner_node": {
      await ctx.db.patch(operation.nodeId as Id<"nodes">, {
        text: operation.text ?? undefined,
        updatedAt: Date.now(),
      });
      const updated = await ctx.db.get(operation.nodeId as Id<"nodes">);
      if (updated) {
        await syncLinksForNode(ctx.db, updated);
        await enqueueNodeAiWork(ctx, updated._id);
      }
      return;
    }
    case "move_planner_node": {
      const node = await ctx.db.get(operation.nodeId as Id<"nodes">);
      if (!node) {
        return;
      }

      const parentNodeId =
        operation.parentNodeId === undefined
          ? node.parentNodeId
          : ((operation.parentNodeId as Id<"nodes"> | null) ?? null);
      const afterNodeId = (operation.afterNodeId as Id<"nodes"> | null | undefined) ?? null;
      const position = await computeNodePosition(
        ctx.db,
        node.pageId,
        parentNodeId,
        afterNodeId,
      );
      await ctx.db.patch(node._id, {
        parentNodeId,
        position,
        updatedAt: Date.now(),
      });
      return;
    }
  }
}

export const applyApprovedChatPlan = mutation({
  args: {
    ownerKey: v.string(),
    messageId: v.id("chatMessages"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const message = await ctx.db.get(args.messageId);
    if (!message || message.role !== "assistant" || !message.proposedPlan) {
      throw new Error("No proposed plan found.");
    }

    const parsedPlan = chatPlanSchema.safeParse(message.proposedPlan);
    if (!parsedPlan.success) {
      throw new Error("Stored plan is invalid.");
    }

    for (const operation of parsedPlan.data.operations) {
      await applyOperation(ctx, operation);
    }

    await ctx.db.patch(args.messageId, {
      status: "applied",
      appliedAt: Date.now(),
    });
    await ctx.db.patch(message.threadId, {
      updatedAt: Date.now(),
    });

    return parsedPlan.data;
  },
});

export const applyApprovedPlannerPlan = mutation({
  args: {
    ownerKey: v.string(),
    messageId: v.id("chatMessages"),
    completionMode: v.union(v.literal("dueDate"), v.literal("today")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const message = await ctx.db.get(args.messageId);
    if (!message || message.role !== "assistant" || !message.proposedPlan) {
      throw new Error("No proposed planner plan found.");
    }

    const parsedPlan = plannerChatPlanSchema.safeParse(message.proposedPlan);
    if (!parsedPlan.success) {
      throw new Error("Stored planner plan is invalid.");
    }

    for (const operation of parsedPlan.data.operations) {
      await applyPlannerOperation(ctx, operation, args.completionMode);
    }

    await ctx.db.patch(args.messageId, {
      status: "applied",
      appliedAt: Date.now(),
    });
    await ctx.db.patch(message.threadId, {
      updatedAt: Date.now(),
    });

    return parsedPlan.data;
  },
});
