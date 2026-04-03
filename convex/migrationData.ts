import { v } from "convex/values";
import { api } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  computeNodePosition,
  enqueueNodeAiWork,
  enqueuePageRootEmbeddingRefresh,
  listPageNodes,
  syncLinksForNode,
} from "./lib/workspace";
import type {
  MigrationChunkAncestor,
  MigrationChunkPlan,
  MigrationNormalizedNode,
  MigrationSourceType,
} from "../lib/domain/migration";
import {
  buildDefaultMigrationLessonsDoc,
  migrationChunkPlanSchema,
  normalizeImportedOutlineText,
} from "../lib/domain/migration";
import { extractLinkMatches } from "../lib/domain/links";
import { stripTagSyntax } from "../lib/domain/migration";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createPageRef = api.workspace.createPage as any;

function getTimestamp() {
  return Date.now();
}

function normalizeTitleKey(value: string) {
  return value.trim().toLowerCase();
}

function buildChunkText(
  roots: MigrationNormalizedNode[],
  ancestorChain: MigrationChunkAncestor[],
  depth = 0,
) {
  const lines: string[] = [];
  for (const ancestor of ancestorChain) {
    lines.push(`${"  ".repeat(depth)}${ancestor.text}`);
    depth += 1;
  }

  const visit = (nodes: MigrationNormalizedNode[], nodeDepth: number) => {
    for (const node of nodes) {
      lines.push(`${"  ".repeat(nodeDepth)}${node.text}`);
      visit(node.children, nodeDepth + 1);
    }
  };

  visit(roots, depth);
  return lines.join("\n").trim();
}

function getSidebarSection(pageType: string) {
  switch (pageType) {
    case "model":
      return "Models";
    case "task":
      return "Tasks";
    case "journal":
      return "Journal";
    case "scratchpad":
      return "Scratchpads";
    case "template":
      return "Templates";
    case "note":
    case "default":
    default:
      return "Notes";
  }
}

function buildLessonLine(
  sourceDocumentTitle: string,
  plan: MigrationChunkPlan,
  guidance: string,
  destinationTitle: string | null,
) {
  const actionText =
    plan.action === "skip"
      ? "skip this chunk"
      : `${plan.action === "create_page" ? "create" : "append to"} ${plan.destination?.archived ? "archived " : ""}${plan.destination?.pageType ?? "note"} page${destinationTitle ? ` "${destinationTitle}"` : ""}${plan.destination?.sectionSlot ? ` in ${plan.destination.sectionSlot}` : ""}`;
  const reason = guidance.trim().length > 0 ? guidance.trim() : plan.reviewInstruction.trim();
  return `- ${sourceDocumentTitle}: ${reason || plan.summary} -> ${actionText}`;
}

function getMigrationSourceMeta(
  node: Pick<Doc<"nodes">, "sourceMeta"> | null | undefined,
) {
  if (!node || typeof node.sourceMeta !== "object" || !node.sourceMeta) {
    return {};
  }

  return node.sourceMeta as Record<string, unknown>;
}

function getStatusCounters(status: Doc<"migrationChunks">["status"]) {
  return {
    readyChunks: status === "ready" ? 1 : 0,
    reviewChunks:
      status === "pending" ||
      status === "needs_review" ||
      status === "ready" ||
      status === "approved"
        ? 1
        : 0,
    appliedChunks: status === "applied" ? 1 : 0,
    skippedChunks: status === "skipped" ? 1 : 0,
    errorChunks: status === "error" ? 1 : 0,
  };
}

function getRunStatusFromCounts(run: Pick<
  Doc<"migrationRuns">,
  "status" | "totalChunks" | "appliedChunks" | "skippedChunks" | "errorChunks"
>) {
  if (run.status === "abandoned") {
    return "abandoned" as const;
  }

  if (run.errorChunks > 0) {
    return "error" as const;
  }

  if (run.totalChunks > 0 && run.appliedChunks + run.skippedChunks === run.totalChunks) {
    return "completed" as const;
  }

  return "reviewing" as const;
}

async function patchRunProgressDelta(
  ctx: MutationCtx,
  runId: Id<"migrationRuns">,
  deltas: Partial<
    Pick<
      Doc<"migrationRuns">,
      | "totalChunks"
      | "readyChunks"
      | "reviewChunks"
      | "appliedChunks"
      | "skippedChunks"
      | "errorChunks"
      | "sourceDocumentCount"
    >
  >,
) {
  const run = await ctx.db.get(runId);
  if (!run) {
    return;
  }

  const nextRun = {
    ...run,
    totalChunks: Math.max(0, run.totalChunks + (deltas.totalChunks ?? 0)),
    readyChunks: Math.max(0, run.readyChunks + (deltas.readyChunks ?? 0)),
    reviewChunks: Math.max(0, run.reviewChunks + (deltas.reviewChunks ?? 0)),
    appliedChunks: Math.max(0, run.appliedChunks + (deltas.appliedChunks ?? 0)),
    skippedChunks: Math.max(0, run.skippedChunks + (deltas.skippedChunks ?? 0)),
    errorChunks: Math.max(0, run.errorChunks + (deltas.errorChunks ?? 0)),
    sourceDocumentCount: Math.max(
      0,
      run.sourceDocumentCount + (deltas.sourceDocumentCount ?? 0),
    ),
  };
  const status = getRunStatusFromCounts(nextRun);

  await ctx.db.patch(runId, {
    totalChunks: nextRun.totalChunks,
    readyChunks: nextRun.readyChunks,
    reviewChunks: nextRun.reviewChunks,
    appliedChunks: nextRun.appliedChunks,
    skippedChunks: nextRun.skippedChunks,
    errorChunks: nextRun.errorChunks,
    sourceDocumentCount: nextRun.sourceDocumentCount,
    status,
    updatedAt: getTimestamp(),
    completedAt: status === "completed" ? getTimestamp() : undefined,
    lastError: status === "error" ? run.lastError : undefined,
  });
}

async function transitionChunkStatus(
  ctx: MutationCtx,
  runId: Id<"migrationRuns">,
  previousStatus: Doc<"migrationChunks">["status"],
  nextStatus: Doc<"migrationChunks">["status"],
) {
  if (previousStatus === nextStatus) {
    return;
  }

  const previousCounters = getStatusCounters(previousStatus);
  const nextCounters = getStatusCounters(nextStatus);

  await patchRunProgressDelta(ctx, runId, {
    readyChunks: nextCounters.readyChunks - previousCounters.readyChunks,
    reviewChunks: nextCounters.reviewChunks - previousCounters.reviewChunks,
    appliedChunks: nextCounters.appliedChunks - previousCounters.appliedChunks,
    skippedChunks: nextCounters.skippedChunks - previousCounters.skippedChunks,
    errorChunks: nextCounters.errorChunks - previousCounters.errorChunks,
  });
}

async function recomputeRunProgress(ctx: MutationCtx, runId: Id<"migrationRuns">) {
  const run = await ctx.db.get(runId);
  if (!run) {
    return;
  }

  const status = getRunStatusFromCounts(run);
  await ctx.db.patch(runId, {
    status,
    updatedAt: getTimestamp(),
    completedAt: status === "completed" ? getTimestamp() : undefined,
  });
}

async function getNextChunkNeedingAttention(ctx: QueryCtx, runId: Id<"migrationRuns">) {
  const run = await ctx.db.get(runId);
  if (!run || run.status === "abandoned") {
    return null;
  }

  const statuses: Array<Doc<"migrationChunks">["status"]> = [
    "error",
    "needs_review",
    "ready",
    "pending",
    "approved",
  ];

  for (const status of statuses) {
    const chunk = await ctx.db
      .query("migrationChunks")
      .withIndex("by_run_and_status_and_order", (query) =>
        query.eq("runId", runId).eq("status", status),
      )
      .first();
    if (chunk) {
      return chunk;
    }
  }

  return null;
}

async function readMigrationLessonsDoc(
  ctx: QueryCtx | MutationCtx,
  sourceType: MigrationSourceType,
) {
  return await ctx.db
    .query("migrationLessons")
    .withIndex("by_source_type", (query) => query.eq("sourceType", sourceType))
    .unique();
}

async function ensureMigrationLessonsDoc(
  ctx: MutationCtx,
  sourceType: MigrationSourceType,
) {
  const existing = await readMigrationLessonsDoc(ctx, sourceType);

  if (existing) {
    return existing;
  }

  const now = getTimestamp();
  const lessonsDoc = buildDefaultMigrationLessonsDoc(sourceType);
  const lessonId = await ctx.db.insert("migrationLessons", {
    sourceType,
    lessonsDoc,
    createdAt: now,
    updatedAt: now,
  });

  const created = await ctx.db.get(lessonId);
  if (!created) {
    throw new Error("Could not create migration lessons doc.");
  }

  return created;
}

function buildRunSourceDocumentSummaries(
  sourceDocuments: Doc<"migrationSourceDocuments">[],
  chunks: Doc<"migrationChunks">[],
) {
  return sourceDocuments.map((document) => {
    const documentChunks = chunks.filter(
      (chunk) => chunk.sourceDocumentEntryId === document._id,
    );
    return {
      document,
      totalChunks: documentChunks.length,
      appliedChunks: documentChunks.filter((chunk) => chunk.status === "applied").length,
      skippedChunks: documentChunks.filter((chunk) => chunk.status === "skipped").length,
      reviewChunks: documentChunks.filter((chunk) =>
        ["pending", "needs_review", "ready", "approved", "error"].includes(chunk.status),
      ).length,
    };
  });
}

function rewritePageLinksAgainstKnownDestinations(
  text: string,
  knownPageIdsByTitle: Map<string, Id<"pages">>,
  flattenUnresolvedLinks: boolean,
) {
  const matches = extractLinkMatches(text);
  if (matches.length === 0) {
    return text;
  }

  let cursor = 0;
  let nextText = "";

  for (const match of matches) {
    nextText += text.slice(cursor, match.start);

    if (match.link.kind === "page" && !match.link.targetPageRef && match.link.targetPageTitle) {
      const title = match.link.targetPageTitle.trim();
      const knownPageId = knownPageIdsByTitle.get(normalizeTitleKey(title));
      if (knownPageId) {
        nextText += `[[${title}|page:${knownPageId}]]`;
      } else if (flattenUnresolvedLinks) {
        nextText += title;
      } else {
        nextText += text.slice(match.start, match.end);
      }
    } else {
      nextText += text.slice(match.start, match.end);
    }

    cursor = match.end;
  }

  nextText += text.slice(cursor);
  return nextText;
}

function applyTextTransforms(
  text: string,
  transforms: MigrationChunkPlan["transforms"],
  knownPageIdsByTitle: Map<string, Id<"pages">>,
) {
  let nextText = normalizeImportedOutlineText(text);
  if (transforms.stripTags) {
    nextText = stripTagSyntax(nextText);
  }

  nextText = rewritePageLinksAgainstKnownDestinations(
    nextText,
    knownPageIdsByTitle,
    transforms.flattenUnresolvedLinks,
  );

  if (transforms.omitEmptyLines) {
    nextText = nextText
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .join("\n");
  }

  return nextText.trim();
}

function getExistingMigrationNodeId(
  pageNodes: Doc<"nodes">[],
  sourceNodeId: string,
  parentNodeId: Id<"nodes"> | null,
) {
  return (
    pageNodes.find((node) => {
      const sourceMeta = getMigrationSourceMeta(node);
      return (
        sourceMeta.migrationSourceNodeId === sourceNodeId &&
        node.parentNodeId === parentNodeId
      );
    })?._id ?? null
  );
}

async function ensureAncestorChain(
  ctx: MutationCtx,
  args: {
    pageId: Id<"pages">;
    runId: Id<"migrationRuns">;
    chunkId: Id<"migrationChunks">;
    sourceDocumentId: string;
    ancestorChain: MigrationChunkAncestor[];
    pageNodes: Doc<"nodes">[];
    parentNodeId: Id<"nodes"> | null;
    ownerKey: string;
  },
) {
  let currentParentId = args.parentNodeId;
  let createdNodeCount = 0;

  for (const ancestor of args.ancestorChain) {
    const existingNodeId = getExistingMigrationNodeId(
      args.pageNodes,
      ancestor.sourceNodeId,
      currentParentId,
    );
    if (existingNodeId) {
      currentParentId = existingNodeId;
      continue;
    }

    const position = await computeNodePosition(
      ctx.db,
      args.pageId,
      currentParentId,
      undefined,
    );
    const text = ancestor.text.trim();
    const nodeId = await ctx.db.insert("nodes", {
      pageId: args.pageId,
      parentNodeId: currentParentId,
      position,
      text,
      kind: ancestor.kind,
      taskStatus: ancestor.kind === "task" ? (ancestor.taskStatus ?? "todo") : null,
      priority: null,
      dueAt: null,
      archived: false,
      sourceMeta: {
        sourceType: "migration",
        migrationRunId: args.runId,
        migrationChunkId: args.chunkId,
        migrationSourceDocumentId: args.sourceDocumentId,
        migrationSourceNodeId: ancestor.sourceNodeId,
        taskKindLocked: true,
        noteCompleted: ancestor.noteCompleted,
      },
      createdAt: getTimestamp(),
      updatedAt: getTimestamp(),
    });
    const node = await ctx.db.get(nodeId);
    if (node) {
      args.pageNodes.push(node);
      await syncLinksForNode(ctx.db, node);
      await enqueueNodeAiWork(ctx, node._id);
    }
    createdNodeCount += 1;
    currentParentId = nodeId;
  }

  return {
    parentNodeId: currentParentId,
    createdNodeCount,
  };
}

async function insertMigrationNodes(
  ctx: MutationCtx,
  args: {
    pageId: Id<"pages">;
    runId: Id<"migrationRuns">;
    chunkId: Id<"migrationChunks">;
    sourceDocumentId: string;
    nodes: MigrationNormalizedNode[];
    pageNodes: Doc<"nodes">[];
    parentNodeId: Id<"nodes"> | null;
    knownPageIdsByTitle: Map<string, Id<"pages">>;
    transforms: MigrationChunkPlan["transforms"];
  },
) {
  let afterNodeId: Id<"nodes"> | null = null;
  let createdNodeCount = 0;

  for (const entry of args.nodes) {
    let nodeId = getExistingMigrationNodeId(
      args.pageNodes,
      entry.sourceNodeId,
      args.parentNodeId,
    );

    if (!nodeId) {
      const position = await computeNodePosition(
        ctx.db,
        args.pageId,
        args.parentNodeId,
        afterNodeId ?? undefined,
      );
      const text = applyTextTransforms(
        entry.text,
        args.transforms,
        args.knownPageIdsByTitle,
      );
      const effectiveKind = args.transforms.forceKind ?? entry.kind;
      const createdNodeId = await ctx.db.insert("nodes", {
        pageId: args.pageId,
        parentNodeId: args.parentNodeId,
        position,
        text,
        kind: effectiveKind,
        taskStatus:
          effectiveKind === "task"
            ? entry.kind === "task"
              ? (entry.taskStatus ?? "todo")
              : "todo"
            : null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "migration",
          migrationRunId: args.runId,
          migrationChunkId: args.chunkId,
          migrationSourceDocumentId: args.sourceDocumentId,
          migrationSourceNodeId: entry.sourceNodeId,
          taskKindLocked: true,
          noteCompleted: effectiveKind === "note" ? entry.noteCompleted : false,
        },
        createdAt: getTimestamp(),
        updatedAt: getTimestamp(),
      });
      const node = await ctx.db.get(createdNodeId);
      if (node) {
        args.pageNodes.push(node);
        await syncLinksForNode(ctx.db, node);
        await enqueueNodeAiWork(ctx, node._id);
      }
      nodeId = createdNodeId;
      createdNodeCount += 1;
    }

    const childResult = await insertMigrationNodes(ctx, {
      ...args,
      nodes: entry.children,
      parentNodeId: nodeId,
    });
    createdNodeCount += childResult.createdNodeCount;
    afterNodeId = nodeId;
  }

  return { createdNodeCount };
}

async function createMigrationPage(
  ctx: MutationCtx,
  args: {
    ownerKey: string;
    title: string;
    pageType: NonNullable<MigrationChunkPlan["destination"]>["pageType"];
    archived: boolean;
  },
) {
  const sidebarSection = getSidebarSection(args.pageType);
  const pageId = (await ctx.runMutation(createPageRef, {
    ownerKey: args.ownerKey,
    title: args.title,
    sidebarSection,
    pageType: args.pageType === "template" ? "default" : args.pageType,
  })) as Id<"pages">;
  const page = await ctx.db.get(pageId);
  if (!page) {
    throw new Error("Created page was not found.");
  }

  const sourceMeta =
    page.sourceMeta && typeof page.sourceMeta === "object"
      ? { ...(page.sourceMeta as Record<string, unknown>) }
      : {};
  if (args.pageType === "template") {
    sourceMeta.sidebarSection = "Templates";
  }
  sourceMeta.sourceType = "migration";

  await ctx.db.patch(pageId, {
    archived: args.archived,
    sourceMeta,
    updatedAt: getTimestamp(),
  });

  return pageId;
}

function findSectionRootId(
  pageNodes: Doc<"nodes">[],
  sectionSlot: string | null,
) {
  if (!sectionSlot) {
    return null;
  }

  return (
    pageNodes.find((node) => {
      const sourceMeta = getMigrationSourceMeta(node);
      return sourceMeta.sectionSlot === sectionSlot;
    })?._id ?? null
  );
}

export const listMigrationRuns = query({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    return await ctx.db
      .query("migrationRuns")
      .withIndex("by_createdAt")
      .order("desc")
      .take(8);
  },
});

export const getMigrationLessonsDoc = query({
  args: {
    ownerKey: v.string(),
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const entry = await readMigrationLessonsDoc(ctx, args.sourceType);
    return {
      sourceType: args.sourceType,
      lessonsDoc: entry?.lessonsDoc ?? buildDefaultMigrationLessonsDoc(args.sourceType),
    };
  },
});

export const getMigrationRun = query({
  args: {
    ownerKey: v.string(),
    runId: v.optional(v.id("migrationRuns")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const run = args.runId
      ? await ctx.db.get(args.runId)
      : await ctx.db
          .query("migrationRuns")
          .withIndex("by_createdAt")
          .order("desc")
          .first();
    if (!run) {
      return null;
    }

    const sourceDocuments = await ctx.db
      .query("migrationSourceDocuments")
      .withIndex("by_run_and_order", (query) => query.eq("runId", run._id))
      .collect();
    const chunks = await ctx.db
      .query("migrationChunks")
      .withIndex("by_run_and_order", (query) => query.eq("runId", run._id))
      .collect();
    const nextChunk = await getNextChunkNeedingAttention(ctx, run._id);
    const recentChunks = [...chunks]
      .sort((left, right) => right.order - left.order)
      .slice(0, 24);

    return {
      run,
      lessonsDoc:
        (await readMigrationLessonsDoc(ctx, run.sourceType))?.lessonsDoc ?? run.lessonsDoc,
      sourceDocuments: buildRunSourceDocumentSummaries(sourceDocuments, chunks),
      nextChunk,
      recentChunks,
    };
  },
});

export const updateMigrationLessonsDoc = mutation({
  args: {
    ownerKey: v.string(),
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    runId: v.optional(v.id("migrationRuns")),
    lessonsDoc: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const lessonsEntry = await ensureMigrationLessonsDoc(ctx, args.sourceType);
    await ctx.db.patch(lessonsEntry._id, {
      lessonsDoc: args.lessonsDoc,
      updatedAt: getTimestamp(),
    });
    if (args.runId) {
      const run = await ctx.db.get(args.runId);
      if (run) {
        await ctx.db.patch(args.runId, {
          lessonsDoc: args.lessonsDoc,
          updatedAt: getTimestamp(),
        });
      }
    }
  },
});

export const abandonMigrationRun = mutation({
  args: {
    ownerKey: v.string(),
    runId: v.id("migrationRuns"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const run = await ctx.db.get(args.runId);
    if (!run) {
      throw new Error("Migration run not found.");
    }

    await ctx.db.patch(args.runId, {
      status: "abandoned",
      updatedAt: getTimestamp(),
      completedAt: getTimestamp(),
    });
  },
});

export const skipMigrationChunk = mutation({
  args: {
    ownerKey: v.string(),
    chunkId: v.id("migrationChunks"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const chunk = await ctx.db.get(args.chunkId);
    if (!chunk) {
      throw new Error("Chunk not found.");
    }

    await transitionChunkStatus(ctx, chunk.runId, chunk.status, "skipped");
    await ctx.db.patch(args.chunkId, {
      status: "skipped",
      updatedAt: getTimestamp(),
    });
  },
});

export const getMigrationChunkContext = internalQuery({
  args: {
    chunkId: v.id("migrationChunks"),
  },
  handler: async (ctx, args) => {
    const chunk = await ctx.db.get(args.chunkId);
    if (!chunk) {
      return null;
    }

    const run = await ctx.db.get(chunk.runId);
    const sourceDocument = await ctx.db.get(chunk.sourceDocumentEntryId);
    if (!run || !sourceDocument) {
      return null;
    }

    const allSourceDocuments = await ctx.db
      .query("migrationSourceDocuments")
      .withIndex("by_run_and_order", (query) => query.eq("runId", run._id))
      .collect();
    const allChunks = await ctx.db
      .query("migrationChunks")
      .withIndex("by_run_and_order", (query) => query.eq("runId", run._id))
      .collect();

    return {
      run,
      sourceDocument,
      chunk,
      allSourceDocuments,
      allChunks,
    };
  },
});

export const getMigrationExamplesByIds = internalQuery({
  args: {
    exampleIds: v.array(v.id("migrationExamples")),
  },
  handler: async (ctx, args) => {
    const examples = await Promise.all(args.exampleIds.map((exampleId) => ctx.db.get(exampleId)));
    return examples.filter(
      (example): example is Doc<"migrationExamples"> => example !== null,
    );
  },
});

export const createMigrationRun = internalMutation({
  args: {
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    title: v.string(),
    sourceSummary: v.string(),
    lessonsDoc: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = getTimestamp();
    const lessonsEntry = await ensureMigrationLessonsDoc(ctx, args.sourceType);
    return await ctx.db.insert("migrationRuns", {
      sourceType: args.sourceType,
      status: "draft",
      title: args.title,
      sourceSummary: args.sourceSummary,
      lessonsDoc: args.lessonsDoc ?? lessonsEntry.lessonsDoc,
      totalChunks: 0,
      readyChunks: 0,
      reviewChunks: 0,
      appliedChunks: 0,
      skippedChunks: 0,
      errorChunks: 0,
      sourceDocumentCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const appendMigrationSourceDocument = internalMutation({
  args: {
    runId: v.id("migrationRuns"),
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    order: v.number(),
    document: v.object({
      sourceDocumentId: v.string(),
      title: v.string(),
      sourcePath: v.string(),
      detectedJournalDate: v.union(v.string(), v.null()),
      metadata: v.optional(v.any()),
      chunks: v.array(
        v.object({
          order: v.number(),
          lineCount: v.number(),
          ancestorChain: v.any(),
          roots: v.any(),
        }),
      ),
    }),
  },
  handler: async (ctx, args) => {
    const now = getTimestamp();
    const sourceDocumentEntryId = await ctx.db.insert("migrationSourceDocuments", {
      runId: args.runId,
      sourceType: args.sourceType,
      sourceDocumentId: args.document.sourceDocumentId,
      title: args.document.title,
      sourcePath: args.document.sourcePath,
      detectedJournalDate: args.document.detectedJournalDate,
      order: args.order,
      metadata: args.document.metadata,
      destinationPageId: null,
      destinationPageTitle: null,
      createdAt: now,
      updatedAt: now,
    });

    for (const chunk of args.document.chunks) {
      await ctx.db.insert("migrationChunks", {
        runId: args.runId,
        sourceDocumentEntryId,
        sourceDocumentId: args.document.sourceDocumentId,
        order: chunk.order,
        lineCount: chunk.lineCount,
        ancestorChain: chunk.ancestorChain,
        roots: chunk.roots,
        status: "pending",
        chunkText: buildChunkText(
          chunk.roots as MigrationNormalizedNode[],
          chunk.ancestorChain as MigrationChunkAncestor[],
        ),
        preview: [],
        matchedExampleId: null,
        createdPageId: null,
        createdNodeCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    await patchRunProgressDelta(ctx, args.runId, {
      sourceDocumentCount: 1,
      totalChunks: args.document.chunks.length,
      reviewChunks: args.document.chunks.length,
    });
  },
});

export const finalizeMigrationRun = internalMutation({
  args: {
    runId: v.id("migrationRuns"),
  },
  handler: async (ctx, args) => {
    await recomputeRunProgress(ctx, args.runId);
  },
});

export const storeMigrationSuggestion = internalMutation({
  args: {
    chunkId: v.id("migrationChunks"),
    status: v.union(v.literal("ready"), v.literal("needs_review")),
    preview: v.array(v.string()),
    suggestion: v.any(),
    guidance: v.string(),
    matchedExampleId: v.union(v.id("migrationExamples"), v.null()),
  },
  handler: async (ctx, args) => {
    const chunk = await ctx.db.get(args.chunkId);
    if (!chunk) {
      throw new Error("Chunk not found.");
    }

    await transitionChunkStatus(ctx, chunk.runId, chunk.status, args.status);
    await ctx.db.patch(args.chunkId, {
      status: args.status,
      preview: args.preview,
      suggestion: args.suggestion,
      guidance: args.guidance,
      matchedExampleId: args.matchedExampleId,
      updatedAt: getTimestamp(),
    });
  },
});

export const markMigrationChunkError = internalMutation({
  args: {
    chunkId: v.id("migrationChunks"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const chunk = await ctx.db.get(args.chunkId);
    if (!chunk) {
      return;
    }

    await transitionChunkStatus(ctx, chunk.runId, chunk.status, "error");
    await ctx.db.patch(args.chunkId, {
      status: "error",
      lastError: args.error,
      updatedAt: getTimestamp(),
    });
    await ctx.db.patch(chunk.runId, {
      lastError: args.error,
      updatedAt: getTimestamp(),
    });
  },
});

export const applyMigrationChunkInternal = internalMutation({
  args: {
    ownerKey: v.string(),
    chunkId: v.id("migrationChunks"),
    plan: v.any(),
    guidance: v.string(),
    exampleVector: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const parsedPlan = migrationChunkPlanSchema.safeParse(args.plan);
    if (!parsedPlan.success) {
      throw new Error("Invalid migration plan.");
    }

    const plan = parsedPlan.data;
    const chunk = await ctx.db.get(args.chunkId);
    if (!chunk) {
      throw new Error("Chunk not found.");
    }
    if (chunk.status === "applied") {
      return chunk;
    }

    const run = await ctx.db.get(chunk.runId);
    const sourceDocument = await ctx.db.get(chunk.sourceDocumentEntryId);
    if (!run || !sourceDocument) {
      throw new Error("Migration context not found.");
    }

    const now = getTimestamp();

    if (plan.action === "skip") {
      await transitionChunkStatus(ctx, chunk.runId, chunk.status, "skipped");
      await ctx.db.patch(args.chunkId, {
        status: "skipped",
        approvedPlan: plan,
        guidance: args.guidance,
        updatedAt: now,
        appliedAt: now,
      });
      return chunk;
    }

    let destinationPageId = sourceDocument.destinationPageId;
    if (!destinationPageId || plan.action === "create_page") {
      if (!plan.destination) {
        throw new Error("Migration destination is required.");
      }
      destinationPageId = await createMigrationPage(ctx, {
        ownerKey: args.ownerKey,
        title: plan.destination.title,
        pageType: plan.destination.pageType,
        archived: plan.destination.archived,
      });
    }

    const destinationPage = await ctx.db.get(destinationPageId);
    if (!destinationPage) {
      throw new Error("Destination page not found.");
    }

    const pageNodes = await listPageNodes(ctx.db, destinationPageId);
    const sectionRootId = findSectionRootId(
      pageNodes,
      plan.destination?.sectionSlot ?? null,
    );
    const allSourceDocuments = await ctx.db
      .query("migrationSourceDocuments")
      .withIndex("by_run_and_order", (query) => query.eq("runId", chunk.runId))
      .collect();
    const knownPageIdsByTitle = new Map<string, Id<"pages">>();
    for (const document of allSourceDocuments) {
      if (document.destinationPageId) {
        knownPageIdsByTitle.set(
          normalizeTitleKey(document.title),
          document.destinationPageId,
        );
      }
    }

    const ancestorResult = await ensureAncestorChain(ctx, {
      pageId: destinationPageId,
      runId: chunk.runId,
      chunkId: chunk._id,
      sourceDocumentId: sourceDocument.sourceDocumentId,
      ancestorChain: chunk.ancestorChain as MigrationChunkAncestor[],
      pageNodes,
      parentNodeId: sectionRootId,
      ownerKey: args.ownerKey,
    });

    const insertResult = await insertMigrationNodes(ctx, {
      pageId: destinationPageId,
      runId: chunk.runId,
      chunkId: chunk._id,
      sourceDocumentId: sourceDocument.sourceDocumentId,
      nodes: chunk.roots as MigrationNormalizedNode[],
      pageNodes,
      parentNodeId: ancestorResult.parentNodeId,
      knownPageIdsByTitle,
      transforms: plan.transforms,
    });

    const destinationTitle = plan.destination?.title ?? destinationPage.title;
    const existingLessonsDoc = run.lessonsDoc.trimEnd();
    const lessonLine = buildLessonLine(
      sourceDocument.title,
      plan,
      args.guidance,
      destinationTitle,
    );
    const lessonsDoc = existingLessonsDoc.includes(lessonLine)
      ? existingLessonsDoc
      : `${existingLessonsDoc.length > 0 ? `${existingLessonsDoc}\n` : ""}${lessonLine}`;
    const lessonsEntry = await ensureMigrationLessonsDoc(ctx, run.sourceType);
    const nextPersistentLessons = lessonsEntry.lessonsDoc.trimEnd().includes(lessonLine)
      ? lessonsEntry.lessonsDoc.trimEnd()
      : `${lessonsEntry.lessonsDoc.trimEnd().length > 0 ? `${lessonsEntry.lessonsDoc.trimEnd()}\n` : ""}${lessonLine}`;

    await transitionChunkStatus(ctx, chunk.runId, chunk.status, "applied");
    await ctx.db.patch(args.chunkId, {
      status: "applied",
      approvedPlan: plan,
      guidance: args.guidance,
      createdPageId: destinationPageId,
      createdNodeCount: ancestorResult.createdNodeCount + insertResult.createdNodeCount,
      updatedAt: now,
      appliedAt: now,
    });
    await ctx.db.patch(sourceDocument._id, {
      carryForwardPlan: plan,
      destinationPageId,
      destinationPageTitle: destinationTitle,
      updatedAt: now,
    });
    await ctx.db.patch(run._id, {
      lessonsDoc,
      updatedAt: now,
      lastError: undefined,
    });
    await ctx.db.patch(lessonsEntry._id, {
      lessonsDoc: nextPersistentLessons,
      updatedAt: now,
    });
    await ctx.db.insert("migrationExamples", {
      sourceType: run.sourceType,
      summary: plan.summary,
      chunkText: chunk.chunkText,
      guidance: args.guidance.trim() || plan.reviewInstruction,
      approvedPlan: plan,
      vector: args.exampleVector,
      createdAt: now,
      updatedAt: now,
    });

    await enqueuePageRootEmbeddingRefresh(ctx, destinationPageId);

    return {
      destinationPageId,
      createdNodeCount: ancestorResult.createdNodeCount + insertResult.createdNodeCount,
    };
  },
});
