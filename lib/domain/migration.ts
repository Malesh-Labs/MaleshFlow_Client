import { z } from "zod";
import type { NodeKind, TaskStatus } from "./constants";
import { extractTagMatches } from "./tags";

export const MIGRATION_SOURCE_TYPES = [
  "dynalist",
  "workflowy",
  "logseq",
] as const;

export const MIGRATION_CHUNK_STATUSES = [
  "pending",
  "ready",
  "needs_review",
  "approved",
  "applied",
  "skipped",
  "error",
] as const;

export const MIGRATION_RUN_STATUSES = [
  "draft",
  "reviewing",
  "completed",
  "error",
] as const;

export const MIGRATION_PAGE_TYPES = [
  "default",
  "note",
  "task",
  "model",
  "journal",
  "scratchpad",
  "template",
] as const;

export const MIGRATION_SECTION_SLOTS = [
  "model",
  "recentExamples",
  "journalThoughts",
  "journalFeedback",
  "scratchpadLive",
  "scratchpadPrevious",
  "taskSidebar",
] as const;

export type MigrationSourceType = (typeof MIGRATION_SOURCE_TYPES)[number];
export type MigrationChunkStatus = (typeof MIGRATION_CHUNK_STATUSES)[number];
export type MigrationRunStatus = (typeof MIGRATION_RUN_STATUSES)[number];
export type MigrationPageType = (typeof MIGRATION_PAGE_TYPES)[number];
export type MigrationSectionSlot = (typeof MIGRATION_SECTION_SLOTS)[number];

export type MigrationNormalizedNode = {
  sourceNodeId: string;
  text: string;
  kind: NodeKind;
  taskStatus: TaskStatus | null;
  headingLevel: 0 | 1 | 2 | 3;
  noteCompleted: boolean;
  children: MigrationNormalizedNode[];
};

export type MigrationSourceDocumentSnapshot = {
  sourceDocumentId: string;
  title: string;
  sourcePath: string;
  detectedJournalDate: string | null;
  roots: MigrationNormalizedNode[];
  metadata?: Record<string, unknown>;
};

export type MigrationChunkAncestor = {
  sourceNodeId: string;
  text: string;
  kind: NodeKind;
  taskStatus: TaskStatus | null;
  headingLevel: 0 | 1 | 2 | 3;
  noteCompleted: boolean;
};

export type MigrationChunkSnapshot = {
  sourceDocumentId: string;
  title: string;
  sourcePath: string;
  order: number;
  lineCount: number;
  ancestorChain: MigrationChunkAncestor[];
  roots: MigrationNormalizedNode[];
};

export const migrationTransformsSchema = z.object({
  stripTags: z.boolean().default(false),
  omitEmptyLines: z.boolean().default(false),
  flattenUnresolvedLinks: z.boolean().default(false),
  forceKind: z.enum(["note", "task"]).nullable().default(null),
});

export const migrationDestinationSchema = z.object({
  pageType: z.enum(MIGRATION_PAGE_TYPES),
  title: z.string(),
  archived: z.boolean().default(true),
  sectionSlot: z.enum(MIGRATION_SECTION_SLOTS).nullable().default(null),
});

export const migrationChunkPlanSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  reviewInstruction: z.string(),
  preview: z.array(z.string()).max(12),
  action: z.enum([
    "create_page",
    "append_to_existing_run_destination",
    "skip",
  ]),
  destination: migrationDestinationSchema.nullable(),
  transforms: migrationTransformsSchema,
});

export type MigrationChunkPlan = z.infer<typeof migrationChunkPlanSchema>;

function cloneNode(node: MigrationNormalizedNode): MigrationNormalizedNode {
  return {
    ...node,
    children: node.children.map(cloneNode),
  };
}

function countVisibleLinesForText(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

function countNodeSubtreeLines(node: MigrationNormalizedNode): number {
  return (
    Math.max(1, countVisibleLinesForText(node.text)) +
    node.children.reduce((total, child) => total + countNodeSubtreeLines(child), 0)
  );
}

function toAncestor(node: MigrationNormalizedNode): MigrationChunkAncestor {
  return {
    sourceNodeId: node.sourceNodeId,
    text: node.text,
    kind: node.kind,
    taskStatus: node.taskStatus,
    headingLevel: node.headingLevel,
    noteCompleted: node.noteCompleted,
  };
}

function flushChunk(
  chunks: MigrationChunkSnapshot[],
  document: MigrationSourceDocumentSnapshot,
  orderRef: { current: number },
  ancestorChain: MigrationChunkAncestor[],
  roots: MigrationNormalizedNode[],
  lineCount: number,
) {
  if (roots.length === 0) {
    return;
  }

  chunks.push({
    sourceDocumentId: document.sourceDocumentId,
    title: document.title,
    sourcePath: document.sourcePath,
    order: orderRef.current,
    lineCount,
    ancestorChain,
    roots: roots.map(cloneNode),
  });
  orderRef.current += 1;
}

function chunkNodesWithAncestors(
  document: MigrationSourceDocumentSnapshot,
  nodes: MigrationNormalizedNode[],
  maxLines: number,
  orderRef: { current: number },
  ancestorChain: MigrationChunkAncestor[] = [],
) {
  const chunks: MigrationChunkSnapshot[] = [];
  let currentRoots: MigrationNormalizedNode[] = [];
  let currentLineCount = 0;

  const flush = () => {
    flushChunk(
      chunks,
      document,
      orderRef,
      ancestorChain,
      currentRoots,
      currentLineCount,
    );
    currentRoots = [];
    currentLineCount = 0;
  };

  for (const node of nodes) {
    const subtreeLines = countNodeSubtreeLines(node);
    if (subtreeLines <= maxLines) {
      if (currentRoots.length > 0 && currentLineCount + subtreeLines > maxLines) {
        flush();
      }
      currentRoots.push(cloneNode(node));
      currentLineCount += subtreeLines;
      continue;
    }

    flush();

    if (node.children.length === 0) {
      flushChunk(
        chunks,
        document,
        orderRef,
        ancestorChain,
        [node],
        subtreeLines,
      );
      continue;
    }

    const childChunks = chunkNodesWithAncestors(
      document,
      node.children,
      maxLines,
      orderRef,
      [...ancestorChain, toAncestor(node)],
    );
    chunks.push(...childChunks);
  }

  flush();
  return chunks;
}

export function chunkMigrationDocument(
  document: MigrationSourceDocumentSnapshot,
  maxLines = 100,
) {
  const safeMaxLines = Math.max(12, maxLines);
  return chunkNodesWithAncestors(
    document,
    document.roots,
    safeMaxLines,
    { current: 0 },
  );
}

export function stripTagSyntax(text: string) {
  const matches = extractTagMatches(text);
  if (matches.length === 0) {
    return text;
  }

  let cursor = 0;
  let nextText = "";
  for (const match of matches) {
    nextText += text.slice(cursor, match.start);
    nextText += match.value;
    cursor = match.end;
  }
  nextText += text.slice(cursor);
  return nextText.replace(/\s{2,}/g, " ").trim();
}

export function detectJournalDateFromPath(path: string) {
  const filename = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
  const match = filename.match(/^(\d{4})[-_](\d{2})[-_](\d{2})$/);
  if (!match) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function withHeadingPrefix(text: string, headingLevel: number) {
  const trimmed = text.trim();
  if (trimmed.length === 0 || headingLevel <= 0) {
    return trimmed;
  }

  return `${"#".repeat(Math.min(3, headingLevel))} ${trimmed}`;
}
