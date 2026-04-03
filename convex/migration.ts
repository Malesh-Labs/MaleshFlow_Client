"use node";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import { buildDeterministicEmbedding } from "../lib/domain/embeddings";
import {
  chunkMigrationDocument,
  detectJournalDateFromPath,
  migrationChunkPlanSchema,
  type MigrationChunkPlan,
  type MigrationChunkSnapshot,
  type MigrationNormalizedNode,
  type MigrationSourceDocumentSnapshot,
  type MigrationSourceType,
  withHeadingPrefix,
} from "../lib/domain/migration";
import { parseMarkdownFile } from "../lib/domain/markdown";
import { extractLinkMatches } from "../lib/domain/links";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createMigrationRunRef = internal.migrationData.createMigrationRun as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appendMigrationSourceDocumentRef = internal.migrationData.appendMigrationSourceDocument as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const finalizeMigrationRunRef = internal.migrationData.finalizeMigrationRun as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getMigrationChunkContextRef = internal.migrationData.getMigrationChunkContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getMigrationExamplesByIdsRef = internal.migrationData.getMigrationExamplesByIds as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeMigrationSuggestionRef = internal.migrationData.storeMigrationSuggestion as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const markMigrationChunkErrorRef = internal.migrationData.markMigrationChunkError as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applyMigrationChunkInternalRef = internal.migrationData.applyMigrationChunkInternal as any;

type DynalistFileEntry = {
  id: string;
  title: string;
  type: "document" | "folder";
  children?: DynalistFileEntry[];
};

type DynalistNode = {
  id: string;
  content?: string;
  note?: string;
  checked?: boolean;
  checkbox?: boolean;
  heading?: number;
  children?: string[];
};

type DynalistDocumentResponse = {
  _code: string;
  _msg: string;
  file_id: string;
  title: string;
  nodes: DynalistNode[];
};

type WorkflowyNode = {
  id: string;
  name: string;
  note: string | null;
  priority: number;
  data?: {
    layoutMode?: string;
  };
  completedAt?: number | null;
  parent_id?: string | null;
};

type WorkflowyTreeNode = WorkflowyNode & {
  children: WorkflowyTreeNode[];
};

type WorkflowyNodesListResponse = {
  nodes: WorkflowyNode[];
};

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function createEmbedding(text: string) {
  const client = getOpenAIClient();
  if (!client) {
    return buildDeterministicEmbedding(text);
  }

  const response = await client.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    input: text,
  });

  return response.data[0]?.embedding ?? buildDeterministicEmbedding(text);
}

async function fetchDynalistJson<T>(
  endpoint: string,
  token: string,
  payload: Record<string, unknown>,
) {
  const response = await fetch(`https://dynalist.io/api/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token,
      ...payload,
    }),
  });

  if (!response.ok) {
    throw new Error(`Dynalist request failed with ${response.status}.`);
  }

  const data = (await response.json()) as T & {
    _code?: string;
    _msg?: string;
  };
  if (data._code && data._code !== "OK") {
    throw new Error(data._msg || `Dynalist error: ${data._code}`);
  }

  return data as T;
}

async function fetchWorkflowyJson<T>(
  path: string,
  apiKey: string,
  init?: RequestInit,
) {
  const response = await fetch(`https://workflowy.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`WorkFlowy request failed with ${response.status}.`);
  }

  return (await response.json()) as T;
}

function flattenDynalistEntries(
  entries: DynalistFileEntry[],
  parentPath = "",
): Array<{
  id: string;
  title: string;
  type: "document" | "folder";
  path: string;
}> {
  return entries.flatMap((entry) => {
    const path = parentPath ? `${parentPath} / ${entry.title}` : entry.title;
    return [
      {
        id: entry.id,
        title: entry.title,
        type: entry.type,
        path,
      },
      ...(entry.children ? flattenDynalistEntries(entry.children, path) : []),
    ];
  });
}

function parseDynalistNodeTargetId(url: string) {
  const match = url.match(/[#?&](?:z|node)=([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

function cleanDynalistInternalLinks(text: string, nodeLabelsById: Map<string, string>) {
  const matches = extractLinkMatches(text);
  if (matches.length === 0 && !text.includes("dynalist.io")) {
    return text.trim();
  }

  let cursor = 0;
  let nextText = "";
  for (const match of matches) {
    nextText += text.slice(cursor, match.start);
    if (
      match.link.kind === "external" &&
      match.link.targetUrl.includes("dynalist.io")
    ) {
      const targetNodeId = parseDynalistNodeTargetId(match.link.targetUrl);
      nextText += nodeLabelsById.get(targetNodeId ?? "") ?? match.link.text;
    } else {
      nextText += text.slice(match.start, match.end);
    }
    cursor = match.end;
  }
  nextText += text.slice(cursor);

  nextText = nextText.replace(
    /https?:\/\/dynalist\.io\/[^\s)]+/g,
    (url) => nodeLabelsById.get(parseDynalistNodeTargetId(url) ?? "") ?? "",
  );

  return nextText.replace(/\s{2,}/g, " ").trim();
}

function normalizeDynalistDocument(
  document: DynalistDocumentResponse,
): MigrationSourceDocumentSnapshot {
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const childIds = new Set(
    document.nodes.flatMap((node) => node.children ?? []),
  );
  const rootIds = document.nodes
    .map((node) => node.id)
    .filter((nodeId) => !childIds.has(nodeId));

  const nodeLabelsById = new Map(
    document.nodes.map((node) => [node.id, node.content?.trim() ?? ""]),
  );

  const buildNode = (nodeId: string): MigrationNormalizedNode => {
    const node = nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Dynalist node ${nodeId} was not found.`);
    }

    const content = cleanDynalistInternalLinks(node.content?.trim() ?? "", nodeLabelsById);
    const note = cleanDynalistInternalLinks(node.note?.trim() ?? "", nodeLabelsById);
    const baseText = [content, note].filter((value) => value.length > 0).join("\n");
    const headingLevel = Math.max(0, Math.min(3, node.heading ?? 0)) as 0 | 1 | 2 | 3;

    return {
      sourceNodeId: node.id,
      text: withHeadingPrefix(baseText, headingLevel),
      kind: node.checkbox ? "task" : "note",
      taskStatus: node.checkbox ? (node.checked ? "done" : "todo") : null,
      headingLevel,
      noteCompleted: !node.checkbox && !!node.checked,
      children: (node.children ?? []).map(buildNode),
    };
  };

  return {
    sourceDocumentId: document.file_id,
    title: document.title,
    sourcePath: document.title,
    detectedJournalDate: null,
    roots: rootIds.map(buildNode),
  };
}

async function fetchWorkflowyNodeSubtree(
  apiKey: string,
  rootId: string,
): Promise<WorkflowyTreeNode> {
  const root = await fetchWorkflowyJson<WorkflowyNode>(`/api/v1/nodes/${rootId}`, apiKey);

  const visit = async (parentId: string): Promise<WorkflowyTreeNode[]> => {
    const response = await fetchWorkflowyJson<WorkflowyNodesListResponse>(
      `/api/v1/nodes?parent_id=${encodeURIComponent(parentId)}`,
      apiKey,
    );
    const children = [...(response.nodes ?? [])].sort(
      (left, right) => left.priority - right.priority,
    );

    return await Promise.all(
      children.map(async (child) => ({
        ...child,
        children: await visit(child.id),
      })),
    );
  };

  return {
    ...root,
    children: await visit(root.id),
  };
}

function normalizeWorkflowyNode(
  node: WorkflowyTreeNode,
): MigrationNormalizedNode {
  const layoutMode = node.data?.layoutMode ?? "bullets";
  const headingLevel =
    layoutMode === "h1" ? 1 : layoutMode === "h2" ? 2 : layoutMode === "h3" ? 3 : 0;
  const kind = layoutMode === "todo" ? "task" : "note";
  const note = node.note?.trim() ?? "";
  const baseText = [node.name.trim(), note].filter((value) => value.length > 0).join("\n");

  return {
    sourceNodeId: node.id,
    text: withHeadingPrefix(baseText, headingLevel),
    kind,
    taskStatus: kind === "task" ? (node.completedAt ? "done" : "todo") : null,
    headingLevel: headingLevel as 0 | 1 | 2 | 3,
    noteCompleted: kind === "note" ? Boolean(node.completedAt) : false,
    children: (node.children ?? []).map((child) => normalizeWorkflowyNode(child)),
  };
}

function normalizeWorkflowyDocument(
  root: WorkflowyTreeNode,
): MigrationSourceDocumentSnapshot {
  return {
    sourceDocumentId: root.id,
    title: root.name.trim() || "Untitled",
    sourcePath: root.name.trim() || root.id,
    detectedJournalDate: null,
    roots: [normalizeWorkflowyNode(root)],
  };
}

function normalizeLogseqFile(path: string, content: string): MigrationSourceDocumentSnapshot {
  const parsed = parseMarkdownFile({
    path,
    content,
  });
  const nodeMap = new Map(
    parsed.nodes.map((node) => [
      node.tempId,
      {
        sourceNodeId: `${parsed.sourcePath}:${node.tempId}`,
        text:
          typeof node.sourceMeta?.headingDepth === "number" && node.sourceMeta.headingDepth > 0
            ? withHeadingPrefix(node.text, node.sourceMeta.headingDepth)
            : node.text,
        kind: node.kind,
        taskStatus: node.taskStatus,
        headingLevel:
          typeof node.sourceMeta?.headingDepth === "number"
            ? (Math.max(0, Math.min(3, node.sourceMeta.headingDepth)) as 0 | 1 | 2 | 3)
            : 0,
        noteCompleted: false,
        children: [] as MigrationNormalizedNode[],
      },
    ]),
  );

  const roots: MigrationNormalizedNode[] = [];
  for (const node of parsed.nodes) {
    const normalized = nodeMap.get(node.tempId)!;
    if (node.parentTempId) {
      nodeMap.get(node.parentTempId)?.children.push(normalized);
    } else {
      roots.push(normalized);
    }
  }

  return {
    sourceDocumentId: parsed.sourcePath,
    title: detectJournalDateFromPath(parsed.sourcePath) ?? parsed.title,
    sourcePath: parsed.sourcePath,
    detectedJournalDate: detectJournalDateFromPath(parsed.sourcePath),
    roots,
  };
}

function buildInitialLessonsDoc(sourceType: MigrationSourceType) {
  return [
    "# Migration Lessons",
    "",
    `Source app: ${sourceType}`,
    "- Approved chunk decisions will accumulate here.",
    "- Edit this document as needed before generating the next suggestion.",
  ].join("\n");
}

function buildSuggestionPreview(
  plan: MigrationChunkPlan,
  sourceDocumentTitle: string,
) {
  if (plan.preview.length > 0) {
    return plan.preview;
  }

  if (plan.action === "skip") {
    return [`Skip this chunk from ${sourceDocumentTitle}.`];
  }

  return [
    `${plan.action === "create_page" ? "Create" : "Append to"} ${plan.destination?.archived ? "archived " : ""}${plan.destination?.pageType ?? "note"} page "${plan.destination?.title ?? sourceDocumentTitle}".`,
    plan.destination?.sectionSlot
      ? `Place imported content in ${plan.destination.sectionSlot}.`
      : "Place imported content in the main outline.",
  ];
}

function buildHeuristicPlan(args: {
  sourceType: MigrationSourceType;
  sourceDocument: {
    title: string;
    detectedJournalDate: string | null;
    destinationPageId: string | null;
    destinationPageTitle: string | null;
    carryForwardPlan?: MigrationChunkPlan | null;
  };
}): MigrationChunkPlan {
  if (args.sourceDocument.carryForwardPlan) {
    return {
      ...args.sourceDocument.carryForwardPlan,
      summary: `Continue importing ${args.sourceDocument.title}.`,
      rationale: "The same source document already had an approved destination, so carry that forward by default.",
      reviewInstruction: args.sourceDocument.carryForwardPlan.reviewInstruction,
      action: args.sourceDocument.destinationPageId
        ? "append_to_existing_run_destination"
        : args.sourceDocument.carryForwardPlan.action,
    };
  }

  if (args.sourceDocument.detectedJournalDate) {
    return {
      summary: `Import ${args.sourceDocument.title} as a journal page.`,
      rationale: "The source document looks like a dated journal entry, so the safest default is an archived journal page with the imported lines placed into Thoughts/Stuff.",
      reviewInstruction: "Create an archived journal page for this dated entry and keep the imported lines in Thoughts/Stuff.",
      preview: [],
      action: "create_page",
      destination: {
        pageType: "journal",
        title: args.sourceDocument.detectedJournalDate,
        archived: true,
        sectionSlot: "journalThoughts",
      },
      transforms: {
        stripTags: false,
        omitEmptyLines: true,
        flattenUnresolvedLinks: args.sourceType === "logseq",
        forceKind: null,
      },
    };
  }

  return {
    summary: `Import ${args.sourceDocument.title} as an archived note page.`,
    rationale: "Without a stronger example match, the safest fallback is to create an archived note page and preserve the outline content there.",
    reviewInstruction: "Create an archived note page with this chunk's content.",
    preview: [],
    action: args.sourceDocument.destinationPageId
      ? "append_to_existing_run_destination"
      : "create_page",
    destination: {
      pageType: "note",
      title: args.sourceDocument.destinationPageTitle ?? args.sourceDocument.title,
      archived: true,
      sectionSlot: null,
    },
    transforms: {
      stripTags: false,
      omitEmptyLines: true,
      flattenUnresolvedLinks: args.sourceType === "logseq",
      forceKind: null,
    },
  };
}

async function createMigrationRunFromDocuments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  sourceType: MigrationSourceType,
  documents: MigrationSourceDocumentSnapshot[],
) {
  const runId = (await ctx.runMutation(createMigrationRunRef, {
    sourceType,
    title: `${sourceType[0]?.toUpperCase() ?? ""}${sourceType.slice(1)} migration`,
    sourceSummary: `${documents.length} source document${documents.length === 1 ? "" : "s"}`,
    lessonsDoc: buildInitialLessonsDoc(sourceType),
  })) as Id<"migrationRuns">;

  for (const [index, document] of documents.entries()) {
    const chunks = chunkMigrationDocument(document, 100);
    await ctx.runMutation(appendMigrationSourceDocumentRef, {
      runId,
      sourceType,
      order: index,
      document: {
        sourceDocumentId: document.sourceDocumentId,
        title: document.title,
        sourcePath: document.sourcePath,
        detectedJournalDate: document.detectedJournalDate,
        metadata: document.metadata,
        chunks: chunks.map((chunk: MigrationChunkSnapshot) => ({
          order: chunk.order,
          lineCount: chunk.lineCount,
          ancestorChain: chunk.ancestorChain,
          roots: chunk.roots,
        })),
      },
    });
  }

  await ctx.runMutation(finalizeMigrationRunRef, {
    runId,
  });

  return runId;
}

export const listDynalistSources = action({
  args: {
    ownerKey: v.string(),
    apiToken: v.string(),
  },
  handler: async (_ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const response = await fetchDynalistJson<{ files: DynalistFileEntry[] }>(
      "file/list",
      args.apiToken,
      {},
    );

    return flattenDynalistEntries(response.files ?? []).filter(
      (entry) => entry.type === "document",
    );
  },
});

export const listWorkflowySources = action({
  args: {
    ownerKey: v.string(),
    apiKey: v.string(),
  },
  handler: async (_ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const response = await fetchWorkflowyJson<WorkflowyNodesListResponse>(
      "/api/v1/nodes?parent_id=None",
      args.apiKey,
    );

    return [...(response.nodes ?? [])]
      .sort((left, right) => left.priority - right.priority)
      .map((node) => ({
        id: node.id,
        title: node.name,
      }));
  },
});

export const startDynalistMigration = action({
  args: {
    ownerKey: v.string(),
    apiToken: v.string(),
    documentIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const documents: MigrationSourceDocumentSnapshot[] = [];

    for (const documentId of args.documentIds) {
      const document = await fetchDynalistJson<DynalistDocumentResponse>(
        "doc/read",
        args.apiToken,
        { file_id: documentId },
      );
      documents.push(normalizeDynalistDocument(document));
    }

    const runId = await createMigrationRunFromDocuments(ctx, "dynalist", documents);
    return { runId };
  },
});

export const startWorkflowyMigration = action({
  args: {
    ownerKey: v.string(),
    apiKey: v.string(),
    rootIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const documents: MigrationSourceDocumentSnapshot[] = [];

    for (const rootId of args.rootIds) {
      const root = await fetchWorkflowyNodeSubtree(args.apiKey, rootId);
      documents.push(normalizeWorkflowyDocument(root));
    }

    const runId = await createMigrationRunFromDocuments(ctx, "workflowy", documents);
    return { runId };
  },
});

export const startLogseqMigration = action({
  args: {
    ownerKey: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        content: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const documents = args.files
      .filter((file) => file.path.toLowerCase().endsWith(".md"))
      .map((file) => normalizeLogseqFile(file.path, file.content));

    const runId = await createMigrationRunFromDocuments(ctx, "logseq", documents);
    return { runId };
  },
});

export const suggestMigrationChunk = action({
  args: {
    ownerKey: v.string(),
    chunkId: v.id("migrationChunks"),
    guidance: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const context = (await ctx.runQuery(getMigrationChunkContextRef, {
      chunkId: args.chunkId,
    })) as
      | {
          run: {
            _id: Id<"migrationRuns">;
            sourceType: MigrationSourceType;
            lessonsDoc: string;
          };
          sourceDocument: {
            title: string;
            sourcePath: string;
            detectedJournalDate: string | null;
            destinationPageId: Id<"pages"> | null;
            destinationPageTitle: string | null;
            carryForwardPlan?: MigrationChunkPlan | null;
          };
          chunk: {
            chunkText: string;
            matchedExampleId: Id<"migrationExamples"> | null;
          };
        }
      | null;
    if (!context) {
      throw new Error("Migration chunk not found.");
    }

    const vector = await createEmbedding(context.chunk.chunkText);
    const matches = await ctx.vectorSearch("migrationExamples", "by_embedding", {
      vector,
      limit: 4,
      filter: (query) => query.eq("sourceType", context.run.sourceType),
    });
    const examples = ((await ctx.runQuery(getMigrationExamplesByIdsRef, {
      exampleIds: matches.map((match: { _id: Id<"migrationExamples"> }) => match._id),
    })) as Array<{
      _id: Id<"migrationExamples">;
      summary: string;
      guidance: string;
      approvedPlan: MigrationChunkPlan;
      chunkText: string;
    }>).slice(0, 4);

    let plan = buildHeuristicPlan({
      sourceType: context.run.sourceType,
      sourceDocument: context.sourceDocument,
    });

    const client = getOpenAIClient();
    if (client) {
      try {
        const response = await client.responses.parse({
          model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
          input: [
            {
              role: "system",
              content:
                "You plan safe staged imports into a personal outliner. Return a structured migration plan only. The user will explicitly approve the plan before any changes are applied. Prefer reusing an existing run destination when one already exists for this source document. Default new destinations to archived pages. Keep transformations minimal unless examples or the lessons doc clearly call for something else.",
            },
            {
              role: "user",
              content: [
                `Source app: ${context.run.sourceType}`,
                `Source document title: ${context.sourceDocument.title}`,
                `Source path: ${context.sourceDocument.sourcePath}`,
                context.sourceDocument.detectedJournalDate
                  ? `Detected journal date: ${context.sourceDocument.detectedJournalDate}`
                  : "",
                context.sourceDocument.destinationPageTitle
                  ? `Existing destination page for this source document: ${context.sourceDocument.destinationPageTitle}`
                  : "No destination page exists yet for this source document.",
                "",
                "Editable lessons doc:",
                context.run.lessonsDoc || "(empty)",
                "",
                "Suggested carry-forward plan from earlier approved chunks of the same source document:",
                context.sourceDocument.carryForwardPlan
                  ? JSON.stringify(context.sourceDocument.carryForwardPlan, null, 2)
                  : "(none)",
                "",
                "Nearest approved examples from the same source app:",
                examples.length > 0
                  ? examples
                      .map(
                        (example, index) =>
                          `[Example ${index + 1}] ${example.summary}\nGuidance: ${example.guidance}\nPlan: ${JSON.stringify(example.approvedPlan)}`,
                      )
                      .join("\n\n")
                  : "(none)",
                "",
                args.guidance?.trim()
                  ? `Extra user guidance for this chunk: ${args.guidance.trim()}`
                  : "",
                "",
                "Chunk content to classify and import:",
                context.chunk.chunkText,
              ]
                .filter((line) => line.length > 0)
                .join("\n"),
            },
          ],
          text: {
            format: zodTextFormat(migrationChunkPlanSchema, "migration_chunk_plan"),
          },
        });

        if (response.output_parsed) {
          plan = response.output_parsed;
        }
      } catch {
        // Keep the heuristic plan.
      }
    }

    const preview = buildSuggestionPreview(plan, context.sourceDocument.title);
    const status = examples.length > 0 ? "ready" : "needs_review";

    await ctx.runMutation(storeMigrationSuggestionRef, {
      chunkId: args.chunkId,
      status,
      preview,
      suggestion: plan,
      guidance: args.guidance?.trim() ?? "",
      matchedExampleId: matches[0]?._id ?? null,
    });

    return {
      plan,
      preview,
      status,
    };
  },
});

export const applyMigrationChunk = action({
  args: {
    ownerKey: v.string(),
    chunkId: v.id("migrationChunks"),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const context = (await ctx.runQuery(getMigrationChunkContextRef, {
      chunkId: args.chunkId,
    })) as
      | {
          chunk: {
            chunkText: string;
            suggestion?: MigrationChunkPlan;
            guidance?: string;
          };
        }
      | null;
    if (!context) {
      throw new Error("Migration chunk not found.");
    }

    const plan = context.chunk.suggestion;
    if (!plan) {
      throw new Error("Generate a suggestion before applying this chunk.");
    }

    try {
      const exampleVector = await createEmbedding(
        `${context.chunk.guidance ?? ""}\n\n${context.chunk.chunkText}`.trim(),
      );
      return await ctx.runMutation(applyMigrationChunkInternalRef, {
        ownerKey: args.ownerKey,
        chunkId: args.chunkId,
        plan,
        guidance: context.chunk.guidance ?? "",
        exampleVector,
      });
    } catch (error) {
      await ctx.runMutation(markMigrationChunkErrorRef, {
        chunkId: args.chunkId,
        error: error instanceof Error ? error.message : "Migration apply failed.",
      });
      throw error;
    }
  },
});
