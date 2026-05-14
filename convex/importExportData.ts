import { v } from "convex/values";
import { internalMutation, internalQuery, type DatabaseReader } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { serializePageToMarkdown } from "../lib/domain/markdown";
import {
  buildDataDumpManifest,
  buildUniqueDataDumpPath,
  filterDataDumpNodes,
  isDataDumpExcluded,
  sanitizeDataDumpPathSegment,
} from "../lib/domain/dataDump";
import { buildUniquePageSlug, enqueueNodeAiWork, syncLinksForNode } from "./lib/workspace";

type DataDumpFile = {
  path: string;
  content: string;
};

type DataDumpLegacyFile = {
  path: string;
  fileName: string;
  filePath: string;
  mimeType: string | null;
  size: number;
  downloadUrl: string | null;
};

type DataDumpCounters = {
  exportedPageCount: number;
  excludedPageCount: number;
  exportedArchivedNodeSubtreeCount: number;
  excludedNodeSubtreeCount: number;
  excludedNodeCount: number;
};

const MIN_WORKSPACE_TEXT_BOX_COUNT = 2;

function getPageSourceMeta(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return page && typeof page.sourceMeta === "object" && page.sourceMeta
    ? (page.sourceMeta as Record<string, unknown>)
    : {};
}

function isSidebarSpecialPage(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getPageSourceMeta(page).specialPage === "sidebar";
}

function isPagePendingDeletion(page: Pick<Doc<"pages">, "sourceMeta"> | null | undefined) {
  return getPageSourceMeta(page).deletingForever === true;
}

function normalizeWorkspaceTextBoxes(
  sourceMeta: Record<string, unknown>,
  textsKey: "workspaceInboxTexts" | "workspaceRandomBoxTexts",
  legacyTextKey: "workspaceInboxText" | "workspaceRandomBoxText",
) {
  const storedTexts = Array.isArray(sourceMeta[textsKey])
    ? sourceMeta[textsKey].filter((value): value is string => typeof value === "string")
    : [];
  const legacyText = typeof sourceMeta[legacyTextKey] === "string" ? sourceMeta[legacyTextKey] : "";
  const nextTexts = storedTexts.length > 0 ? [...storedTexts] : [legacyText];
  while (nextTexts.length < MIN_WORKSPACE_TEXT_BOX_COUNT) {
    nextTexts.push("");
  }
  return nextTexts;
}

function buildWorkspaceBoxMarkdown(title: string, texts: string[]) {
  const lines = [`# ${title}`, ""];

  texts.forEach((text, index) => {
    lines.push(`## Box ${index + 1}`, "", text.trimEnd(), "");
  });

  return lines.join("\n").trimEnd() + "\n";
}

function buildLegacyDumpPath(
  legacyFile: Doc<"legacyFiles">,
  usedPaths: Set<string>,
) {
  const rawSegments = (legacyFile.filePath || legacyFile.fileName)
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const segments = rawSegments.length > 0 ? rawSegments : [legacyFile.fileName];
  const rawFileName = segments[segments.length - 1] || legacyFile.fileName || "legacy-file";
  const directory = ["legacy", ...segments.slice(0, -1)];
  const extensionMatch = rawFileName.match(/\.([A-Za-z0-9]{1,16})$/);
  const extension = extensionMatch?.[1] ?? "";
  const baseName = extension
    ? rawFileName.slice(0, -(extension.length + 1))
    : rawFileName;

  return buildUniqueDataDumpPath({
    directory,
    name: baseName,
    extension,
    usedPaths,
  });
}

async function listAllPageNodes(
  db: DatabaseReader,
  pageId: Id<"pages">,
) {
  const [activeNodes, archivedNodes] = await Promise.all([
    db
      .query("nodes")
      .withIndex("by_page_archived", (query) =>
        query.eq("pageId", pageId).eq("archived", false),
      )
      .collect(),
    db
      .query("nodes")
      .withIndex("by_page_archived", (query) =>
        query.eq("pageId", pageId).eq("archived", true),
      )
      .collect(),
  ]);

  return [...activeNodes, ...archivedNodes].sort((left, right) => {
    if (left.parentNodeId === right.parentNodeId) {
      return left.position - right.position;
    }
    return left.position - right.position;
  });
}

function collectSubtreeNodes(
  rootNodeId: Id<"nodes">,
  nodes: Doc<"nodes">[],
) {
  const childrenByParent = new Map<string | null, Doc<"nodes">[]>();
  for (const node of nodes) {
    const parentKey = (node.parentNodeId as string | null) ?? null;
    const bucket = childrenByParent.get(parentKey) ?? [];
    bucket.push(node);
    childrenByParent.set(parentKey, bucket);
  }

  const subtree: Doc<"nodes">[] = [];
  const queue = [rootNodeId as string];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentNodeId = queue.shift()!;
    if (visited.has(currentNodeId)) {
      continue;
    }
    visited.add(currentNodeId);

    const currentNode = nodes.find((node) => node._id === currentNodeId);
    if (currentNode) {
      subtree.push(currentNode);
    }

    for (const child of childrenByParent.get(currentNodeId) ?? []) {
      queue.push(child._id as string);
    }
  }

  return subtree.sort((left, right) => left.position - right.position);
}

function hasDataDumpExcludedAncestor(
  node: Doc<"nodes">,
  nodeById: Map<string, Doc<"nodes">>,
) {
  const visited = new Set<string>();
  let currentParentId = node.parentNodeId as string | null;

  while (currentParentId) {
    if (visited.has(currentParentId)) {
      break;
    }
    visited.add(currentParentId);

    const parentNode = nodeById.get(currentParentId);
    if (!parentNode) {
      break;
    }
    if (isDataDumpExcluded(parentNode)) {
      return true;
    }

    currentParentId = parentNode.parentNodeId as string | null;
  }

  return false;
}

function addPageMarkdownFile({
  files,
  usedPaths,
  page,
  nodes,
  directory,
  title = page.title,
}: {
  files: DataDumpFile[];
  usedPaths: Set<string>;
  page: Pick<Doc<"pages">, "title">;
  nodes: Doc<"nodes">[];
  directory: string[];
  title?: string;
}) {
  files.push({
    path: buildUniqueDataDumpPath({
      directory,
      name: title,
      extension: "md",
      usedPaths,
    }),
    content: serializePageToMarkdown({ title }, nodes),
  });
}

function appendArchivedNodeSubtreeFiles({
  files,
  usedPaths,
  page,
  allNodes,
  counters,
}: {
  files: DataDumpFile[];
  usedPaths: Set<string>;
  page: Doc<"pages">;
  allNodes: Doc<"nodes">[];
  counters: DataDumpCounters;
}) {
  const nodeById = new Map(allNodes.map((node) => [node._id as string, node]));
  const archivedRoots = allNodes
    .filter((node) => {
      if (!node.archived) {
        return false;
      }
      const parentNode = node.parentNodeId
        ? nodeById.get(node.parentNodeId as string) ?? null
        : null;
      return !parentNode || !parentNode.archived;
    })
    .sort((left, right) => left.position - right.position);

  for (const rootNode of archivedRoots) {
    if (hasDataDumpExcludedAncestor(rootNode, nodeById)) {
      continue;
    }

    const subtreeNodes = collectSubtreeNodes(rootNode._id, allNodes);
    const filtered = filterDataDumpNodes(subtreeNodes);
    counters.excludedNodeCount += filtered.excludedNodeCount;
    counters.excludedNodeSubtreeCount += filtered.excludedNodeSubtreeCount;

    if (!filtered.nodes.some((node) => node._id === rootNode._id)) {
      continue;
    }

    const exportNodes = filtered.nodes.map((node) =>
      node._id === rootNode._id ? { ...node, parentNodeId: null } : node,
    );
    const title = rootNode.text.trim() || `Archived item ${rootNode._id}`;
    addPageMarkdownFile({
      files,
      usedPaths,
      page,
      nodes: exportNodes,
      directory: ["archive", "nodes", sanitizeDataDumpPathSegment(page.title, "page")],
      title,
    });
    counters.exportedArchivedNodeSubtreeCount += 1;
  }
}

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

export const buildDataDumpBundle = internalQuery({
  args: {},
  handler: async (ctx): Promise<{
    files: DataDumpFile[];
    legacyFiles: DataDumpLegacyFile[];
  }> => {
    const generatedAt = new Date().toISOString();
    const usedPaths = new Set<string>();
    const files: DataDumpFile[] = [];
    const counters: DataDumpCounters = {
      exportedPageCount: 0,
      excludedPageCount: 0,
      exportedArchivedNodeSubtreeCount: 0,
      excludedNodeSubtreeCount: 0,
      excludedNodeCount: 0,
    };

    const pages = await ctx.db.query("pages").collect();
    const exportablePages = pages
      .filter((page) => !isSidebarSpecialPage(page) && !isPagePendingDeletion(page))
      .sort((left, right) => {
        if (left.archived !== right.archived) {
          return left.archived ? 1 : -1;
        }
        return left.position - right.position;
      });

    for (const page of exportablePages) {
      if (isDataDumpExcluded(page)) {
        counters.excludedPageCount += 1;
        continue;
      }

      const allNodes = await listAllPageNodes(ctx.db, page._id);
      const pageNodes = page.archived
        ? allNodes
        : allNodes.filter((node) => !node.archived);
      const filtered = filterDataDumpNodes(pageNodes);
      counters.excludedNodeCount += filtered.excludedNodeCount;
      counters.excludedNodeSubtreeCount += filtered.excludedNodeSubtreeCount;

      addPageMarkdownFile({
        files,
        usedPaths,
        page,
        nodes: filtered.nodes,
        directory: page.archived ? ["archive", "pages"] : ["pages"],
      });
      counters.exportedPageCount += 1;

      if (!page.archived) {
        appendArchivedNodeSubtreeFiles({
          files,
          usedPaths,
          page,
          allNodes,
          counters,
        });
      }
    }

    const sidebarPage = pages.find((page) => isSidebarSpecialPage(page)) ?? null;
    const sidebarSourceMeta = getPageSourceMeta(sidebarPage);
    files.push({
      path: buildUniqueDataDumpPath({
        directory: ["workspace"],
        name: "inbox",
        extension: "md",
        usedPaths,
      }),
      content: buildWorkspaceBoxMarkdown(
        "Workspace Inbox",
        normalizeWorkspaceTextBoxes(
          sidebarSourceMeta,
          "workspaceInboxTexts",
          "workspaceInboxText",
        ),
      ),
    });
    files.push({
      path: buildUniqueDataDumpPath({
        directory: ["workspace"],
        name: "random-box",
        extension: "md",
        usedPaths,
      }),
      content: buildWorkspaceBoxMarkdown(
        "Workspace Random Box",
        normalizeWorkspaceTextBoxes(
          sidebarSourceMeta,
          "workspaceRandomBoxTexts",
          "workspaceRandomBoxText",
        ),
      ),
    });

    const legacyFiles = await ctx.db
      .query("legacyFiles")
      .withIndex("by_updated_at")
      .order("desc")
      .collect();
    const legacyDumpFiles: DataDumpLegacyFile[] = [];
    for (const legacyFile of legacyFiles) {
      legacyDumpFiles.push({
        path: buildLegacyDumpPath(legacyFile, usedPaths),
        fileName: legacyFile.fileName,
        filePath: legacyFile.filePath,
        mimeType: legacyFile.mimeType,
        size: legacyFile.size,
        downloadUrl: await ctx.storage.getUrl(legacyFile.storageId),
      });
    }

    const manifest = buildDataDumpManifest({
      generatedAt,
      exportedPageCount: counters.exportedPageCount,
      excludedPageCount: counters.excludedPageCount,
      exportedArchivedNodeSubtreeCount: counters.exportedArchivedNodeSubtreeCount,
      excludedNodeSubtreeCount: counters.excludedNodeSubtreeCount,
      excludedNodeCount: counters.excludedNodeCount,
      legacyFileCount: legacyDumpFiles.length,
      contentFileCount: files.length + 1,
    });
    files.push({
      path: buildUniqueDataDumpPath({
        name: "manifest",
        extension: "json",
        usedPaths,
      }),
      content: JSON.stringify(manifest, null, 2) + "\n",
    });

    return {
      files,
      legacyFiles: legacyDumpFiles,
    };
  },
});
