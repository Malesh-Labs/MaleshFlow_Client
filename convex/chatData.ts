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

export const getThreadMessages = internalQuery({
  args: {
    threadId: v.id("chatThreads"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("chatMessages")
      .withIndex("by_thread_createdAt", (query) =>
        query.eq("threadId", args.threadId),
      )
      .collect();
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
