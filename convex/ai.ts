"use node";

import { createHash } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  buildDeterministicEmbedding,
  buildEmbeddingInput,
  buildRootEmbeddingInput,
  shouldGenerateEmbeddingForNodeText,
} from "../lib/domain/embeddings";
import {
  normalizeScreenshotImportNodes,
  screenshotImportResultSchema,
} from "../lib/domain/screenshotImport";
import { replaceLinkMarkupWithLabels, stripLinkMarkup } from "../lib/domain/links";

const taskMetadataSchema = z.object({
  kind: z.enum(["note", "task"]),
  taskStatus: z.enum(["todo", "in_progress", "done", "cancelled"]).nullable(),
  priority: z.enum(["low", "medium", "high"]).nullable(),
  rationale: z.string(),
});

const knowledgeAnswerSchema = z.object({
  answer: z.string(),
  sourceIndexes: z.array(z.number().int().min(1)).max(8),
});

const screenshotImportOutputSchema = screenshotImportResultSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fallbackTextSearchRef = internal.aiData.fallbackTextSearch as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hydrateEmbeddingMatchesRef = internal.aiData.hydrateEmbeddingMatches as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNodeEmbeddingContextRef = internal.workspace.getNodeEmbeddingContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNodeTaskMetadataContextRef = internal.workspace.getNodeTaskMetadataContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const upsertEmbeddingJobRef = internal.aiData.upsertEmbeddingJob as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getEmbeddingJobStateRef = internal.aiData.getEmbeddingJobState as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const saveNodeEmbeddingRef = internal.aiData.saveNodeEmbedding as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clearNodeEmbeddingRef = internal.aiData.clearNodeEmbedding as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applyTaskMetadataRef = internal.aiData.applyTaskMetadata as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getLinkedKnowledgeContextRef = internal.workspace.getLinkedKnowledgeContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ensureWorkspaceKnowledgeThreadRef = api.chatData.ensureWorkspaceKnowledgeThread as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getThreadMessagesRef = internal.chatData.getThreadMessages as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeUserMessageRef = internal.chatData.storeUserMessage as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeAssistantMessageRef = internal.chatData.storeAssistantMessage as any;

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

function buildEmbeddingContentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function buildTodayPromptLine() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Pacific/Honolulu",
  });
  return `Today is ${formatter.format(new Date())}.`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSemanticSearch(ctx: any, args: {
  query: string;
  pageId?: string;
  limit?: number;
  includeArchived?: boolean;
}) {
  const limit = Math.max(1, Math.min(args.limit ?? 8, 20));
  const vector = await createEmbedding(args.query);

  const matches = await ctx.vectorSearch("nodeEmbeddings", "by_embedding", {
    vector,
    limit,
    filter: args.pageId
      ? (query: { eq: (field: string, value: unknown) => unknown }) =>
          query.eq("pageId", args.pageId!)
      : undefined,
  });

  if (matches.length === 0) {
    return await ctx.runQuery(fallbackTextSearchRef, {
      query: args.query,
      pageId: args.pageId ?? undefined,
      limit,
      includeArchived: args.includeArchived ?? false,
    });
  }

  return await ctx.runQuery(hydrateEmbeddingMatchesRef, {
    embeddingIds: matches.map((match: { _id: string }) => match._id),
    includeArchived: args.includeArchived ?? false,
  });
}

export const searchNodes = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    pageId: v.optional(v.id("pages")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    assertOwnerKey(args.ownerKey);
    return await runSemanticSearch(ctx, {
      query: args.query,
      pageId: args.pageId as string | undefined,
      limit: args.limit,
      includeArchived: false,
    });
  },
});

export const findNodesText = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    pageId: v.optional(v.id("pages")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    assertOwnerKey(args.ownerKey);
    return await ctx.runQuery(fallbackTextSearchRef, {
      query: args.query,
      pageId: args.pageId,
      limit: Math.max(1, Math.min(args.limit ?? 12, 20)),
      includeArchived: false,
    });
  },
});

export const searchArchivedNodes = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    assertOwnerKey(args.ownerKey);
    return await runSemanticSearch(ctx, {
      query: args.query,
      limit: args.limit,
      includeArchived: true,
    });
  },
});

export const findArchivedNodesText = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    assertOwnerKey(args.ownerKey);
    return await ctx.runQuery(fallbackTextSearchRef, {
      query: args.query,
      limit: Math.max(1, Math.min(args.limit ?? 12, 20)),
      includeArchived: true,
    });
  },
});

export const parseOutlineScreenshot = action({
  args: {
    ownerKey: v.string(),
    imageDataUrl: v.string(),
  },
  handler: async (ctx, args): Promise<unknown> => {
    assertOwnerKey(args.ownerKey);
    const client = getOpenAIClient();
    if (!client) {
      throw new Error("Screenshot import requires an OpenAI API key.");
    }

    const response = await client.responses.parse({
      model: process.env.OPENAI_VISION_MODEL ?? "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You convert screenshots of outliner apps into structured outline nodes. " +
                "Return only what is visibly present in the screenshot. Preserve nesting/order. " +
                "Rows with visible checkboxes are tasks. Checked boxes are done; unchecked boxes are todo. " +
                "Rows with regular bullets are notes. If a note row is visually prominent like a section heading, " +
                "encode it as a note whose text starts with '### '. " +
                "Preserve visible inline emphasis using '__double underscores__' for italics and '**double asterisks**' for bold. " +
                "Ignore app chrome like counters, arrows, drag rails, and badges that are not part of the content text. " +
                "Keep inline chip/pill text as plain text when it is clearly content.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Parse this screenshot into outline nodes for import. " +
                "The large bold bullet rows should usually become '###' note headings.",
            },
            {
              type: "input_image",
              image_url: args.imageDataUrl,
              detail: "high",
            },
          ],
        },
      ],
      text: {
        format: zodTextFormat(screenshotImportOutputSchema, "outline_screenshot_import"),
      },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error("Could not parse the screenshot into outline nodes.");
    }

    return {
      summary: parsed.summary,
      warnings: parsed.warnings,
      nodes: normalizeScreenshotImportNodes(parsed.nodes),
    };
  },
});

type WorkspaceKnowledgeAnswer = {
  answer: string;
  sources: Array<{
    node: Doc<"nodes">;
    page: Doc<"pages"> | null;
    score?: number;
    content?: string;
  }>;
  model: string;
  error: string | null;
};

type WorkspaceKnowledgeArgs = {
  ownerKey: string;
  question: string;
  limit?: number;
  linkedPageIds?: Id<"pages">[];
  linkedNodeIds?: Id<"nodes">[];
  conversation?: Array<{
    role: string;
    text: string;
  }>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function answerWorkspaceQuestionInternal(ctx: any, args: WorkspaceKnowledgeArgs): Promise<WorkspaceKnowledgeAnswer> {
  assertOwnerKey(args.ownerKey);

  const question = args.question.trim();
  const messageOnlyQuestion = stripLinkMarkup(question);
  const semanticQuery = replaceLinkMarkupWithLabels(question);
  const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
  if (question.length === 0) {
    return {
      answer: "Search your knowledge base or pin context with [[...]].",
      sources: [],
      model,
      error: null,
    };
  }

  const linkedContext = (await ctx.runQuery(getLinkedKnowledgeContextRef, {
    pageIds: args.linkedPageIds ?? [],
    nodeIds: args.linkedNodeIds ?? [],
    includeDefaultPlannerAndTaskPages: true,
  })) as {
    pages: Array<{
      page: Doc<"pages">;
      representativeNode: Doc<"nodes"> | null;
      content: string;
    }>;
    nodes: Array<{
      node: Doc<"nodes">;
      page: Doc<"pages">;
      content: string;
    }>;
  };

  const hasExplicitLinkedContext =
    linkedContext.pages.length > 0 || linkedContext.nodes.length > 0;

  const shouldUseSemanticSearch =
    semanticQuery.length > 0 &&
    (!hasExplicitLinkedContext || messageOnlyQuestion.length > 0);

  const rawSources = shouldUseSemanticSearch
    ? ((await runSemanticSearch(ctx, {
        query: semanticQuery,
        limit: args.limit ?? 10,
      })) as Array<{
        node: Doc<"nodes">;
        page: Doc<"pages"> | null;
        score?: number;
        content?: string;
      }>)
    : [];
  const linkedPageSources = linkedContext.pages
    .filter((entry) => entry.representativeNode !== null)
    .map((entry) => ({
      node: entry.representativeNode!,
      page: entry.page,
      content: entry.content,
    }));
  const linkedNodeSources = linkedContext.nodes.map((entry) => ({
    node: entry.node,
    page: entry.page,
    content: entry.content,
  }));

  const dedupedSources = new Map<
    string,
    {
      node: Doc<"nodes">;
      page: Doc<"pages"> | null;
      score?: number;
      content?: string;
    }
  >();
  for (const entry of [...linkedNodeSources, ...linkedPageSources, ...rawSources]) {
    if (!entry.page) {
      continue;
    }

    const key = entry.node._id as string;
    if (!dedupedSources.has(key)) {
      dedupedSources.set(key, entry);
    }
  }
  const sources = [...dedupedSources.values()].slice(0, 10);

  const explicitLinkedContext = [
    ...linkedContext.pages
      .filter((entry) => entry.content.trim().length > 0)
      .map((entry, index) =>
        [
          `Linked page [${index + 1}]: ${entry.page.title}`,
          entry.content,
        ].join("\n"),
      ),
    ...linkedContext.nodes.map((entry, index) =>
      [
        `Linked node [N${index + 1}] on ${entry.page.title}`,
        entry.content.trim().length > 0 ? entry.content : entry.node.text || "(empty line)",
      ].join("\n"),
    ),
  ].join("\n\n");

  if (sources.length === 0 && explicitLinkedContext.trim().length === 0) {
    return {
      answer: "I couldn't find any relevant notes or tasks in your knowledge base yet.",
      sources: [],
      model,
      error: null,
    };
  }

  const client = getOpenAIClient();
  if (!client) {
    return {
      answer:
        "OpenAI is not configured, so I can only show the closest matching notes right now.",
      sources,
      model,
      error: "OPENAI_API_KEY is not configured in Convex.",
    };
  }

  const sourceContext = sources
    .map((entry, index) =>
      [
        `[${index + 1}] Page: ${entry.page?.title ?? "Unknown page"}`,
        `Kind: ${entry.node.kind}`,
        `Text: ${entry.node.text || "(empty line)"}`,
        `Context: ${entry.content?.trim() || entry.node.text || "(empty line)"}`,
      ].join("\n"),
    )
    .join("\n\n");

  const conversationContext =
    args.conversation && args.conversation.length > 0
      ? args.conversation
          .slice(-8)
          .map((message) => `${message.role}: ${message.text}`)
          .join("\n")
      : "";

  try {
    const response = await client.responses.parse({
      model,
      input: [
        {
          role: "system",
          content:
            `${buildTodayPromptLine()} Answer the user's question using only the provided knowledge base snippets. If the snippets are insufficient, say so clearly. Keep the answer concise and grounded. Cite source numbers like [1] when helpful. If no explicit question text is provided, summarize the linked context and surface the most important takeaways.`,
        },
        {
          role: "user",
          content: [
            conversationContext.length > 0 ? "Recent conversation:" : null,
            conversationContext.length > 0 ? conversationContext : null,
            conversationContext.length > 0 ? "" : null,
            messageOnlyQuestion.length > 0 ? `Question: ${semanticQuery}` : null,
            explicitLinkedContext.trim().length > 0 ? "" : null,
            explicitLinkedContext.trim().length > 0 ? "Explicitly linked context:" : null,
            explicitLinkedContext.trim().length > 0 ? explicitLinkedContext : null,
            sourceContext.trim().length > 0 ? "" : null,
            sourceContext.trim().length > 0 ? "Knowledge base snippets:" : null,
            sourceContext.trim().length > 0 ? sourceContext : null,
          ]
            .filter((value): value is string => value !== null)
            .join("\n"),
        },
      ],
      text: {
        format: zodTextFormat(knowledgeAnswerSchema, "knowledge_base_answer"),
      },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      return {
        answer: "OpenAI returned no answer.",
        sources,
        model,
        error: "OpenAI returned no parsed answer.",
      };
    }

    const chosenSources =
      parsed.sourceIndexes.length > 0
        ? parsed.sourceIndexes
            .map((index) => sources[index - 1] ?? null)
            .filter(
              (
                entry,
              ): entry is {
                node: Doc<"nodes">;
                page: Doc<"pages"> | null;
                score?: number;
                content?: string;
              } => entry !== null,
            )
        : sources.slice(0, 4);

    return {
      answer: parsed.answer,
      sources: chosenSources,
      model,
      error: null,
    };
  } catch (error) {
    return {
      answer:
        error instanceof Error
          ? `OpenAI knowledge-base chat failed: ${error.message}`
          : "OpenAI knowledge-base chat failed.",
      sources,
      model,
      error: error instanceof Error ? error.message : "Unknown OpenAI error.",
    };
  }
}

export const answerWorkspaceQuestion = action({
  args: {
    ownerKey: v.string(),
    question: v.string(),
    limit: v.optional(v.number()),
    linkedPageIds: v.optional(v.array(v.id("pages"))),
    linkedNodeIds: v.optional(v.array(v.id("nodes"))),
  },
  handler: async (
    ctx,
    args,
  ): Promise<WorkspaceKnowledgeAnswer> =>
    await answerWorkspaceQuestionInternal(ctx, args),
});

export const chatWithWorkspace = action({
  args: {
    ownerKey: v.string(),
    question: v.string(),
    limit: v.optional(v.number()),
    linkedPageIds: v.optional(v.array(v.id("pages"))),
    linkedNodeIds: v.optional(v.array(v.id("nodes"))),
  },
  handler: async (ctx, args): Promise<{
    threadId: Id<"chatThreads">;
    response: WorkspaceKnowledgeAnswer;
  }> => {
    assertOwnerKey(args.ownerKey);

    const question = args.question.trim();
    if (question.length === 0) {
      throw new Error("Enter a message before searching your workspace.");
    }

    const threadId: Id<"chatThreads"> = await ctx.runMutation(
      ensureWorkspaceKnowledgeThreadRef,
      {
        ownerKey: args.ownerKey,
      },
    );

    await ctx.runMutation(storeUserMessageRef, {
      threadId,
      text: question,
    });

    const priorMessages = (await ctx.runQuery(getThreadMessagesRef, {
      threadId,
    })) as Array<{
      role: string;
      text: string;
    }>;

    let response: WorkspaceKnowledgeAnswer;
    try {
      response = await answerWorkspaceQuestionInternal(ctx, {
        ...args,
        question,
        conversation: priorMessages.slice(0, -1),
      });
    } catch (error) {
      const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
      response = {
        answer:
          error instanceof Error
            ? `Workspace search failed: ${error.message}`
            : "Workspace search failed.",
        sources: [],
        model,
        error: error instanceof Error ? error.message : "Unknown workspace chat error.",
      };
    }

    await ctx.runMutation(storeAssistantMessageRef, {
      threadId,
      text: response.answer,
      metadata: {
        kind: "knowledge_response",
        model: response.model,
        error: response.error,
        sources: response.sources.map((source) => ({
          nodeId: source.node._id,
          pageId: source.page?._id ?? null,
          nodeText: source.node.text,
          pageTitle: source.page?.title ?? null,
          nodeKind: source.node.kind,
          content: source.content ?? null,
        })),
      },
    });

    return {
      threadId,
      response,
    };
  },
});

export const generateEmbeddingForNode = internalAction({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    try {
      const context = await ctx.runQuery(getNodeEmbeddingContextRef, {
        nodeId: args.nodeId,
      });

      if (!context || context.node.archived) {
        await ctx.runMutation(clearNodeEmbeddingRef, {
          nodeId: args.nodeId,
        });
        return;
      }

      if (!shouldGenerateEmbeddingForNodeText(context.node.text)) {
        await ctx.runMutation(clearNodeEmbeddingRef, {
          nodeId: args.nodeId,
        });
        return;
      }

      const input =
        context.node.parentNodeId === null
          ? buildRootEmbeddingInput({
              pageTitle: context.pageTitle,
              rootText: context.node.text.trim(),
              subtreeLines: context.subtreeLines ?? [],
            })
          : buildEmbeddingInput({
              pageTitle: context.pageTitle,
              ancestors: context.ancestors,
              nodeText: context.node.text,
            });

      if (input.trim().length === 0) {
        await ctx.runMutation(clearNodeEmbeddingRef, {
          nodeId: args.nodeId,
        });
        return;
      }

      const contentHash = buildEmbeddingContentHash(input);
      const existingJob = await ctx.runQuery(getEmbeddingJobStateRef, {
        nodeId: args.nodeId,
      });
      const activeRebuildRunId =
        existingJob?.status === "queued" ? existingJob.rebuildRunId ?? undefined : undefined;

      if (
        existingJob?.lastEmbeddedHash === contentHash &&
        existingJob?.lastEmbeddedPageId === context.node.pageId
      ) {
        await ctx.runMutation(upsertEmbeddingJobRef, {
          nodeId: args.nodeId,
          status: "completed",
          rebuildRunId: activeRebuildRunId,
        });
        return;
      }

      await ctx.runMutation(upsertEmbeddingJobRef, {
        nodeId: args.nodeId,
        status: "running",
        rebuildRunId: activeRebuildRunId,
      });

      const vector = await createEmbedding(input);

      await ctx.runMutation(saveNodeEmbeddingRef, {
        nodeId: context.node._id,
        pageId: context.node.pageId,
        content: input,
        contentHash,
        vector,
      });
    } catch (error) {
      const existingJob = await ctx.runQuery(getEmbeddingJobStateRef, {
        nodeId: args.nodeId,
      });
      await ctx.runMutation(upsertEmbeddingJobRef, {
        nodeId: args.nodeId,
        status: "error",
        error: error instanceof Error ? error.message : "Embedding generation failed.",
        rebuildRunId: existingJob?.rebuildRunId ?? undefined,
      });
    }
  },
});

function inferTaskMetadataHeuristically(text: string, existingKind: "note" | "task") {
  const lowered = text.toLowerCase();
  const likelyTask =
    existingKind === "task" ||
    /^(todo|fix|ship|draft|buy|email|call|review|plan|follow up)\b/.test(lowered) ||
    /\b(todo|follow up|next step|action item)\b/.test(lowered);

  return {
    kind: likelyTask ? "task" : "note",
    taskStatus: likelyTask ? "todo" : null,
    priority: /\b(urgent|asap|critical)\b/.test(lowered) ? "high" : null,
  } as const;
}

export const extractTaskMetadata = internalAction({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(getNodeTaskMetadataContextRef, {
      nodeId: args.nodeId,
    });

    if (!context || context.node.archived || context.node.text.trim().length === 0) {
      return;
    }

    const sourceMeta =
      context.node.sourceMeta && typeof context.node.sourceMeta === "object"
        ? (context.node.sourceMeta as Record<string, unknown>)
        : {};

    if (sourceMeta.taskKindLocked === true) {
      return;
    }

    if (context.node.kind === "task") {
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: "task",
        taskStatus: context.node.taskStatus ?? "todo",
        priority: context.node.priority ?? null,
      });
      return;
    }

    const client = getOpenAIClient();
    if (!client) {
      const heuristic = inferTaskMetadataHeuristically(
        context.node.text,
        context.node.kind,
      );
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: heuristic.kind,
        taskStatus: heuristic.taskStatus,
        priority: heuristic.priority,
      });
      return;
    }

    try {
      const response = await client.responses.parse({
        model: process.env.OPENAI_TASK_MODEL ?? "gpt-5-mini",
        input: [
          {
            role: "system",
            content:
              "Classify whether an outline node is a task or a note. Prefer keeping ambiguous content as a note. Only mark obvious action items as tasks.",
          },
          {
            role: "user",
            content: `Page: ${context.pageTitle}\nAncestors: ${context.ancestors.join(" > ") || "(none)"}\nNode: ${context.node.text}\nCurrent kind: ${context.node.kind}`,
          },
        ],
        text: {
          format: zodTextFormat(taskMetadataSchema, "task_metadata"),
        },
      });

      const parsed = response.output_parsed ?? inferTaskMetadataHeuristically(context.node.text, context.node.kind);
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: parsed.kind,
        taskStatus: parsed.kind === "task" ? (parsed.taskStatus ?? "todo") : null,
        priority: parsed.priority,
      });
    } catch {
      const heuristic = inferTaskMetadataHeuristically(
        context.node.text,
        context.node.kind,
      );
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: heuristic.kind,
        taskStatus: heuristic.taskStatus,
        priority: heuristic.priority,
      });
    }
  },
});
