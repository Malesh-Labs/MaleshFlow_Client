"use node";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  buildDeterministicEmbedding,
  buildEmbeddingInput,
  buildRootEmbeddingInput,
} from "../lib/domain/embeddings";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fallbackTextSearchRef = internal.aiData.fallbackTextSearch as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hydrateEmbeddingMatchesRef = internal.aiData.hydrateEmbeddingMatches as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNodeAiContextRef = internal.workspace.getNodeAiContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const upsertEmbeddingJobRef = internal.aiData.upsertEmbeddingJob as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const saveNodeEmbeddingRef = internal.aiData.saveNodeEmbedding as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applyTaskMetadataRef = internal.aiData.applyTaskMetadata as any;

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

function formatNodeForEmbedding(node: {
  text: string;
  kind: string;
  taskStatus: string | null;
}) {
  const text = node.text.trim();
  if (text.length === 0) {
    return "";
  }

  if (node.kind === "task") {
    return `${node.taskStatus === "done" ? "[x]" : "[ ]"} ${text}`;
  }

  return text;
}

function collectRootSubtreeLines(
  rootNodeId: string,
  allNodes: Array<Doc<"nodes">>,
) {
  const sortedNodes = [...allNodes].sort((left, right) => left.position - right.position);
  const childrenByParent = new Map<string | null, Array<Doc<"nodes">>>();

  for (const node of sortedNodes) {
    const key = node.parentNodeId ?? null;
    const bucket = childrenByParent.get(key) ?? [];
    bucket.push(node);
    childrenByParent.set(key, bucket);
  }

  const lines: string[] = [];
  const visit = (nodeId: string, depth: number) => {
    const children = childrenByParent.get(nodeId) ?? [];
    for (const child of children) {
      const formatted = formatNodeForEmbedding(child);
      if (formatted.length > 0) {
        lines.push(`${"  ".repeat(depth)}${formatted}`);
      }
      visit(child._id, depth + 1);
    }
  };

  visit(rootNodeId, 0);
  return lines;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSemanticSearch(ctx: any, args: {
  query: string;
  pageId?: string;
  limit?: number;
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
    });
  }

  return await ctx.runQuery(hydrateEmbeddingMatchesRef, {
    embeddingIds: matches.map((match: { _id: string }) => match._id),
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
    });
  },
});

export const answerWorkspaceQuestion = action({
  args: {
    ownerKey: v.string(),
    question: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    answer: string;
    sources: Array<{
      node: Doc<"nodes">;
      page: Doc<"pages"> | null;
      score?: number;
      content?: string;
    }>;
    model: string;
    error: string | null;
  }> => {
    assertOwnerKey(args.ownerKey);

    const question = args.question.trim();
    const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
    if (question.length === 0) {
      return {
        answer: "Ask a question to search your knowledge base.",
        sources: [],
        model,
        error: null,
      };
    }

    const rawSources = (await runSemanticSearch(ctx, {
      query: question,
      limit: args.limit ?? 10,
    })) as Array<{
      node: Doc<"nodes">;
      page: Doc<"pages"> | null;
      score?: number;
      content?: string;
    }>;
    const sources = rawSources.filter((entry) => entry.page !== null).slice(0, 10);

    if (sources.length === 0) {
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

    try {
      const response = await client.responses.parse({
        model,
        input: [
          {
            role: "system",
            content:
              "Answer the user's question using only the provided knowledge base snippets. If the snippets are insufficient, say so clearly. Keep the answer concise and grounded. Cite source numbers like [1] when helpful.",
          },
          {
            role: "user",
            content: [`Question: ${question}`, "", "Knowledge base snippets:", sourceContext].join(
              "\n",
            ),
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
  },
});

export const generateEmbeddingForNode = internalAction({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.aiData.upsertEmbeddingJob, {
      nodeId: args.nodeId,
      status: "running",
    });

    try {
      const context = await ctx.runQuery(getNodeAiContextRef, {
        nodeId: args.nodeId,
      });

      if (!context || context.node.archived) {
        return;
      }

      const input =
        context.node.parentNodeId === null
          ? buildRootEmbeddingInput({
              pageTitle: context.page.title,
              rootText: context.node.text.trim(),
              subtreeLines: collectRootSubtreeLines(context.node._id, context.allNodes),
            })
          : buildEmbeddingInput({
              pageTitle: context.page.title,
              ancestors: context.ancestors,
              nodeText: context.node.text,
            });

      if (input.trim().length === 0) {
        return;
      }

      const vector = await createEmbedding(input);

      await ctx.runMutation(saveNodeEmbeddingRef, {
        nodeId: context.node._id,
        pageId: context.page._id,
        content: input,
        vector,
      });
    } catch (error) {
      await ctx.runMutation(upsertEmbeddingJobRef, {
        nodeId: args.nodeId,
        status: "error",
        error: error instanceof Error ? error.message : "Embedding generation failed.",
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
    const context = await ctx.runQuery(getNodeAiContextRef, {
      nodeId: args.nodeId,
    });

    if (!context || context.node.archived || context.node.text.trim().length === 0) {
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
            content: `Page: ${context.page.title}\nAncestors: ${context.ancestors.join(" > ") || "(none)"}\nNode: ${context.node.text}\nCurrent kind: ${context.node.kind}`,
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
