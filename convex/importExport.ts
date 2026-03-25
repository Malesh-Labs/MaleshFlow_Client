"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import { parseMarkdownBundle } from "../lib/domain/markdown";
import { internal } from "./_generated/api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const beginImportRunRef = internal.importExportData.beginImportRun as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const persistImportedPagesRef = internal.importExportData.persistImportedPages as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getImportSummaryRef = internal.importExportData.getImportSummary as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildExportBundleRef = internal.importExportData.buildExportBundle as any;

export const importMarkdownBundle = action({
  args: {
    ownerKey: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        content: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<unknown> => {
    assertOwnerKey(args.ownerKey);
    const warnings = args.files
      .filter((file) => !file.path.toLowerCase().endsWith(".md"))
      .map((file) => `Skipped non-Markdown file: ${file.path}`);
    const parsedPages = parseMarkdownBundle(args.files);

    const importId: Id<"imports"> = await ctx.runMutation(beginImportRunRef, {
      sourceType: "markdown",
      originalFiles: args.files.map((file) => file.path),
      warnings,
      fileCount: args.files.length,
    });

    await ctx.runMutation(persistImportedPagesRef, {
      importId,
      pages: parsedPages.map((page) => ({
        title: page.title,
        slug: page.slug,
        sourcePath: page.sourcePath,
        nodes: page.nodes.map((node) => ({
          tempId: node.tempId,
          parentTempId: node.parentTempId,
          text: node.text,
          kind: node.kind,
          taskStatus: node.taskStatus,
          position: node.position,
          sourceMeta: node.sourceMeta,
        })),
      })),
    });

    return await ctx.runQuery(getImportSummaryRef, {
      importId,
    });
  },
});

export const exportWorkspace = action({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args): Promise<Array<{ path: string; content: string }>> => {
    assertOwnerKey(args.ownerKey);
    return await ctx.runQuery(buildExportBundleRef, {});
  },
});
