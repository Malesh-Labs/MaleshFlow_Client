import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { serializePageToMarkdown } from "../lib/domain/markdown";
import { buildUniquePageSlug, enqueueNodeAiWork, syncLinksForNode } from "./lib/workspace";

export const beginImportRun = internalMutation({
  args: {
    sourceType: v.string(),
    originalFiles: v.array(v.string()),
    warnings: v.array(v.string()),
    fileCount: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("imports", {
      sourceType: args.sourceType,
      status: "processing",
      originalFiles: args.originalFiles,
      warnings: args.warnings,
      fileCount: args.fileCount,
      importedPageCount: 0,
      importedNodeCount: 0,
      createdAt: Date.now(),
    });
  },
});

export const persistImportedPages = internalMutation({
  args: {
    importId: v.id("imports"),
    pages: v.array(
      v.object({
        title: v.string(),
        slug: v.string(),
        sourcePath: v.string(),
        nodes: v.array(
          v.object({
            tempId: v.string(),
            parentTempId: v.union(v.string(), v.null()),
            text: v.string(),
            kind: v.union(v.literal("note"), v.literal("task")),
            taskStatus: v.union(
              v.literal("todo"),
              v.literal("in_progress"),
              v.literal("done"),
              v.literal("cancelled"),
              v.null(),
            ),
            position: v.number(),
            sourceMeta: v.any(),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const pageIdBySourcePath = new Map<string, Id<"pages">>();
    let importedNodeCount = 0;

    for (const page of args.pages) {
      const slug = await buildUniquePageSlug(ctx.db, page.title);
      const pageId = await ctx.db.insert("pages", {
        title: page.title,
        slug,
        icon: null,
        archived: false,
        position: Date.now() + pageIdBySourcePath.size * 1024,
        sourceMeta: {
          sourceType: "import",
          sourcePath: page.sourcePath,
          importRunId: args.importId,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      pageIdBySourcePath.set(page.sourcePath, pageId);
    }

    for (const page of args.pages) {
      const pageId = pageIdBySourcePath.get(page.sourcePath)!;
      const nodeIdByTempId = new Map<string, Id<"nodes">>();

      for (const node of page.nodes) {
        const nodeId = await ctx.db.insert("nodes", {
          pageId,
          parentNodeId: node.parentTempId
            ? (nodeIdByTempId.get(node.parentTempId) as never)
            : null,
          position: node.position,
          text: node.text,
          kind: node.kind,
          taskStatus: node.kind === "task" ? (node.taskStatus ?? "todo") : null,
          priority: null,
          dueAt: null,
          archived: false,
          sourceMeta: {
            ...node.sourceMeta,
            sourceType: "import",
            sourcePath: page.sourcePath,
            importRunId: args.importId,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        importedNodeCount += 1;
        nodeIdByTempId.set(node.tempId, nodeId);
      }

      const insertedNodes = await ctx.db
        .query("nodes")
        .withIndex("by_page_archived", (query) =>
          query.eq("pageId", pageId).eq("archived", false),
        )
        .collect();
      for (const node of insertedNodes) {
        await syncLinksForNode(ctx.db, node);
        await enqueueNodeAiWork(ctx, node._id);
      }
    }

    await ctx.db.patch(args.importId, {
      status: "completed",
      importedPageCount: args.pages.length,
      importedNodeCount,
      summary: `Imported ${args.pages.length} pages and ${importedNodeCount} nodes.`,
      completedAt: Date.now(),
    });
  },
});

export const getImportSummary = internalQuery({
  args: {
    importId: v.id("imports"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.importId);
  },
});

export const buildExportBundle = internalQuery({
  args: {},
  handler: async (ctx) => {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_archived_position", (query) => query.eq("archived", false))
      .collect();

    const bundle: Array<{ path: string; content: string }> = [];
    for (const page of pages) {
      const nodes = await ctx.db
        .query("nodes")
        .withIndex("by_page_archived", (query) =>
          query.eq("pageId", page._id).eq("archived", false),
        )
        .collect();
      bundle.push({
        path: `${page.slug || page.title}.md`,
        content: serializePageToMarkdown(page, nodes),
      });
    }

    return bundle;
  },
});
