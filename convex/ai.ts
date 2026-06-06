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
import { isSeparatorLineText } from "../lib/domain/displaySyntax";
import { chatPlanSchema, type ChatPlan } from "../lib/domain/chat";

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
const getWorkspaceActionParentCandidatesRef =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internal.workspace.getWorkspaceActionParentCandidates as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ensureWorkspaceKnowledgeThreadRef = api.chatData.ensureWorkspaceKnowledgeThread as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getThreadMessagesRef = internal.chatData.getThreadMessages as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeUserMessageRef = internal.chatData.storeUserMessage as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeAssistantMessageRef = internal.chatData.storeAssistantMessage as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeAssistantPlanRef = internal.chatData.storeAssistantPlan as any;

const RECENT_CHAT_CONTEXT_MESSAGE_COUNT = 4;
const WORKSPACE_ACTION_PARENT_CANDIDATE_LIMIT = 12;
const WORKSPACE_ACTION_PLAN_OPERATION_LIMIT = 4;

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
  request: string | null;
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

type WorkspaceActionParentCandidate = {
  nodeId: Id<"nodes">;
  pageId: Id<"pages">;
  pageTitle: string;
  text: string;
  rawText: string;
  kind: Doc<"nodes">["kind"];
  taskStatus: Doc<"nodes">["taskStatus"];
  ancestorPath: string;
  childPreview: string[];
};

type WorkspaceChatResult =
  | {
      kind: "answer";
      threadId: Id<"chatThreads">;
      response: WorkspaceKnowledgeAnswer;
    }
  | {
      kind: "plan";
      threadId: Id<"chatThreads">;
      messageId: Id<"chatMessages">;
      plan: ChatPlan;
    };

function isLikelyWorkspaceActionRequest(question: string) {
  const normalized = replaceLinkMarkupWithLabels(question).trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  const explicitActionPattern =
    /\b(add|append|put|save|remember|track|capture|jot|log|create|write down)\b/;
  if (explicitActionPattern.test(normalized)) {
    return true;
  }

  if (/^(what|who|when|where|why|how|which|show|list|find|search|summarize|explain|tell me)\b/.test(normalized)) {
    return false;
  }

  return (
    (/^another\b/.test(normalized) &&
      /\b(idea|option|date|gift|thing|task|todo|reminder)\b/.test(normalized) &&
      normalized.includes(",")) ||
    (/\bidea for\b/.test(normalized) && normalized.includes(","))
  );
}

function buildWorkspaceActionSearchQuery(question: string) {
  const normalized = replaceLinkMarkupWithLabels(question).trim();
  const commaIndex = normalized.indexOf(",");
  if (commaIndex > 0) {
    return normalized.slice(0, commaIndex).trim();
  }

  return normalized;
}

function buildWorkspaceActionTextSearchQueries(question: string) {
  const baseQuery = buildWorkspaceActionSearchQuery(question)
    .replace(/[?!.].*$/, "")
    .trim();
  if (baseQuery.length === 0) {
    return [];
  }

  const queries = [baseQuery];
  const destinationMatch = baseQuery.match(
    /\b(?:to|under|beneath|below|inside|into|in|on)\s+(?:the\s+)?(.+)$/i,
  );
  const destinationQuery = destinationMatch?.[1]
    ?.replace(/\b(?:list|section|item|node|page)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (destinationQuery && destinationQuery.length > 0) {
    queries.push(destinationQuery);
  }

  return [...new Set(queries)].slice(0, 3);
}

function buildWorkspaceActionNoopResponse(args: {
  answer: string;
  model: string;
  request: string | null;
  error?: string | null;
}): WorkspaceKnowledgeAnswer {
  return {
    answer: args.answer,
    sources: [],
    model: args.model,
    error: args.error ?? null,
    request: args.request,
  };
}

function sanitizeWorkspaceChildActionPlan(
  plan: ChatPlan,
  candidates: WorkspaceActionParentCandidate[],
) {
  const candidateByNodeId = new Map(candidates.map((candidate) => [candidate.nodeId as string, candidate]));
  const operations: ChatPlan["operations"] = [];
  const preview: string[] = [];

  for (const operation of plan.operations) {
    if (operation.type !== "create_node") {
      continue;
    }

    const parentNodeId = operation.parentNodeId ?? operation.nodeId ?? null;
    const parent = parentNodeId ? candidateByNodeId.get(parentNodeId) ?? null : null;
    const text = operation.text?.trim() ?? "";
    if (!parent || text.length === 0) {
      continue;
    }

    const kind = operation.kind === "task" ? "task" : "note";
    operations.push({
      type: "create_node",
      description:
        operation.description?.trim() ||
        `Add "${text}" under "${parent.text || parent.rawText}"`,
      pageId: parent.pageId,
      nodeId: null,
      parentNodeId: parent.nodeId,
      afterNodeId: null,
      sourceNodeId: null,
      targetNodeId: null,
      title: null,
      text,
      kind,
      taskStatus: kind === "task" ? (operation.taskStatus ?? "todo") : null,
      priority: operation.priority ?? null,
      dueAt: operation.dueAt ?? null,
      archived: null,
    });
    preview.push(`Add "${text}" under "${parent.text || parent.rawText}"`);

    if (operations.length >= WORKSPACE_ACTION_PLAN_OPERATION_LIMIT) {
      break;
    }
  }

  return {
    summary:
      operations.length > 0
        ? (plan.summary.trim() || "Add child item")
        : (plan.summary.trim() || "No safe workspace edit found"),
    rationale:
      operations.length > 0
        ? (plan.rationale.trim() || "I found a likely parent item and prepared the child item for approval.")
        : (plan.rationale.trim() || "I could not confidently map the request to one parent item."),
    preview: preview.length > 0 ? preview : plan.preview.slice(0, 4),
    operations,
  } satisfies ChatPlan;
}

async function buildWorkspaceActionParentCandidates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: {
    question: string;
    linkedPageIds?: Id<"pages">[];
    linkedNodeIds?: Id<"nodes">[];
  },
) {
  const searchQuery = buildWorkspaceActionSearchQuery(args.question);
  const textSearchQueries = buildWorkspaceActionTextSearchQueries(args.question);
  const semanticMatches =
    searchQuery.length > 0
      ? ((await runSemanticSearch(ctx, {
          query: searchQuery,
          limit: WORKSPACE_ACTION_PARENT_CANDIDATE_LIMIT,
        })) as Array<{
          node: Doc<"nodes">;
          page: Doc<"pages"> | null;
        }>)
      : [];
  const textMatches = (
    await Promise.all(
      textSearchQueries.map((query) =>
        ctx.runQuery(fallbackTextSearchRef, {
          query,
          limit: WORKSPACE_ACTION_PARENT_CANDIDATE_LIMIT,
          includeArchived: false,
        }),
      ),
    )
  ).flat() as Array<{
    node: Doc<"nodes">;
    page: Doc<"pages"> | null;
  }>;

  return (await ctx.runQuery(getWorkspaceActionParentCandidatesRef, {
    nodeIds: [...semanticMatches, ...textMatches].map((match) => match.node._id),
    linkedPageIds: args.linkedPageIds ?? [],
    linkedNodeIds: args.linkedNodeIds ?? [],
    limit: WORKSPACE_ACTION_PARENT_CANDIDATE_LIMIT,
  })) as WorkspaceActionParentCandidate[];
}

async function maybePlanWorkspaceChildAction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: WorkspaceKnowledgeArgs & {
    threadId: Id<"chatThreads">;
    conversation: Array<{ role: string; text: string }>;
  },
): Promise<WorkspaceChatResult | null> {
  const question = args.question.trim();
  if (!isLikelyWorkspaceActionRequest(question)) {
    return null;
  }

  const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
  const candidates = await buildWorkspaceActionParentCandidates(ctx, {
    question,
    linkedPageIds: args.linkedPageIds,
    linkedNodeIds: args.linkedNodeIds,
  });
  const candidateContext = candidates
    .map((candidate, index) =>
      [
        `[${index + 1}] parentNodeId: ${candidate.nodeId}`,
        `pageId: ${candidate.pageId}`,
        `pageTitle: ${candidate.pageTitle}`,
        `text: ${candidate.text || candidate.rawText}`,
        candidate.ancestorPath ? `path: ${candidate.ancestorPath}` : null,
        candidate.childPreview.length > 0
          ? `existing children: ${candidate.childPreview.join(" | ")}`
          : "existing children: none shown",
      ]
        .filter((value): value is string => value !== null)
        .join("\n"),
    )
    .join("\n\n");
  const conversationContext =
    args.conversation.length > 0
      ? args.conversation
          .slice(-RECENT_CHAT_CONTEXT_MESSAGE_COUNT)
          .map((message) => `${message.role}: ${message.text}`)
          .join("\n")
      : "";
  const systemPrompt =
    `${buildTodayPromptLine()} You plan safe edits for a personal outliner. V1 only supports adding child items under an existing parent node. Return a plan with only create_node operations. Each operation must use a parentNodeId and pageId from the candidate list. Never invent ids. Every operation object must include every schema field; use null for fields that do not apply. Do not propose updates, moves, deletes, archives, or new pages. Default new items to kind "note"; use kind "task" only when the user clearly asks for a todo, task, reminder, or checkbox. If there is not exactly one clearly best parent, return zero operations and explain what needs clarification. All edits require human approval later.`;
  const userPrompt = [
    conversationContext.length > 0 ? "Recent conversation:" : null,
    conversationContext.length > 0 ? conversationContext : null,
    conversationContext.length > 0 ? "" : null,
    `User request: ${question}`,
    "",
    candidates.length > 0 ? "Candidate parent nodes:" : "Candidate parent nodes: none",
    candidates.length > 0 ? candidateContext : null,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
  const requestPreview = `System:\n${systemPrompt}\n\nUser:\n${userPrompt}`;

  if (candidates.length === 0) {
    const answer =
      "I can help add that, but I couldn't find a likely parent item. Try naming or linking the parent item you want it under.";
    await ctx.runMutation(storeAssistantMessageRef, {
      threadId: args.threadId,
      text: answer,
      metadata: {
        kind: "workspace_action_response",
        model,
        request: requestPreview,
      },
    });
    return {
      kind: "answer",
      threadId: args.threadId,
      response: buildWorkspaceActionNoopResponse({ answer, model, request: requestPreview }),
    };
  }

  const client = getOpenAIClient();
  if (!client) {
    const answer =
      "OpenAI is not configured, so I can't safely plan workspace edits yet.";
    await ctx.runMutation(storeAssistantMessageRef, {
      threadId: args.threadId,
      text: answer,
      metadata: {
        kind: "workspace_action_response",
        model,
        error: "OPENAI_API_KEY is not configured in Convex.",
        request: requestPreview,
      },
    });
    return {
      kind: "answer",
      threadId: args.threadId,
      response: buildWorkspaceActionNoopResponse({
        answer,
        model,
        error: "OPENAI_API_KEY is not configured in Convex.",
        request: requestPreview,
      }),
    };
  }

  let plan: ChatPlan | null = null;
  try {
    const response = await client.responses.parse({
      model,
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      text: {
        format: zodTextFormat(chatPlanSchema, "workspace_child_action_plan"),
      },
    });
    plan = response.output_parsed ?? null;
  } catch (error) {
    const answer =
      error instanceof Error
        ? `I couldn't plan that workspace edit: ${error.message}`
        : "I couldn't plan that workspace edit.";
    await ctx.runMutation(storeAssistantMessageRef, {
      threadId: args.threadId,
      text: answer,
      metadata: {
        kind: "workspace_action_response",
        model,
        error: error instanceof Error ? error.message : "Unknown OpenAI error.",
        request: requestPreview,
      },
    });
    return {
      kind: "answer",
      threadId: args.threadId,
      response: buildWorkspaceActionNoopResponse({
        answer,
        model,
        error: error instanceof Error ? error.message : "Unknown OpenAI error.",
        request: requestPreview,
      }),
    };
  }

  const safePlan = sanitizeWorkspaceChildActionPlan(
    plan ?? {
      summary: "No safe workspace edit found",
      rationale: "OpenAI did not return a parsed plan.",
      preview: [],
      operations: [],
    },
    candidates,
  );

  if (safePlan.operations.length === 0) {
    const answer =
      safePlan.rationale ||
      "I can help add that, but I couldn't confidently choose one parent item.";
    await ctx.runMutation(storeAssistantMessageRef, {
      threadId: args.threadId,
      text: answer,
      metadata: {
        kind: "workspace_action_response",
        model,
        request: requestPreview,
      },
    });
    return {
      kind: "answer",
      threadId: args.threadId,
      response: buildWorkspaceActionNoopResponse({ answer, model, request: requestPreview }),
    };
  }

  const messageId: Id<"chatMessages"> = await ctx.runMutation(storeAssistantPlanRef, {
    threadId: args.threadId,
    text: safePlan.rationale,
    preview: safePlan.preview,
    proposedPlan: safePlan,
    metadata: {
      kind: "workspace_action_plan",
      model,
      request: requestPreview,
    },
  });

  return {
    kind: "plan",
    threadId: args.threadId,
    messageId,
    plan: safePlan,
  };
}

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
      request: null,
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
      section: "linked" | "planner" | "backlog" | "anytime";
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

  const plannerPageContext = linkedContext.pages
    .filter((entry) => entry.section === "planner" && entry.content.trim().length > 0)
    .map((entry, index) =>
      [
        `Planner page [P${index + 1}]: ${entry.page.title}`,
        entry.content,
      ].join("\n"),
    );
  const backlogPageContext = linkedContext.pages
    .filter((entry) => entry.section === "backlog" && entry.content.trim().length > 0)
    .map((entry, index) =>
      [
        `Backlog page [B${index + 1}]: ${entry.page.title}`,
        entry.content,
      ].join("\n"),
    );
  const anytimePageContext = linkedContext.pages
    .filter((entry) => entry.section === "anytime" && entry.content.trim().length > 0)
    .map((entry, index) =>
      [
        `Anytime page [A${index + 1}]: ${entry.page.title}`,
        entry.content,
      ].join("\n"),
    );
  const explicitlyLinkedPageContext = linkedContext.pages
    .filter((entry) => entry.section === "linked" && entry.content.trim().length > 0)
    .map((entry, index) =>
      [
        `Linked page [${index + 1}]: ${entry.page.title}`,
        entry.content,
      ].join("\n"),
    );

  const explicitLinkedContext = [
    ...plannerPageContext,
    ...(anytimePageContext.length > 0
      ? [["# Anytime", ...anytimePageContext].join("\n\n")]
      : []),
    ...(backlogPageContext.length > 0
      ? [["# Backlog", ...backlogPageContext].join("\n\n")]
      : []),
    ...explicitlyLinkedPageContext,
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
      request: null,
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
      request: null,
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
          .slice(-RECENT_CHAT_CONTEXT_MESSAGE_COUNT)
          .map((message) => `${message.role}: ${message.text}`)
          .join("\n")
      : "";

  const systemPrompt =
    `${buildTodayPromptLine()} Answer the user's question using only the provided knowledge base snippets. If the snippets are insufficient, say so clearly. Keep the answer concise and grounded. Cite source numbers like [1] when helpful. If no explicit question text is provided, summarize the linked context and surface the most important takeaways.`;
  const userPrompt = [
    conversationContext.length > 0 ? "Recent conversation:" : null,
    conversationContext.length > 0 ? conversationContext : null,
    conversationContext.length > 0 ? "" : null,
    messageOnlyQuestion.length > 0 ? `Question: ${semanticQuery}` : null,
    explicitLinkedContext.trim().length > 0 ? "" : null,
    explicitLinkedContext.trim().length > 0 ? "Explicitly linked context:" : null,
    explicitLinkedContext.trim().length > 0 ? explicitLinkedContext : null,
    sourceContext.trim().length > 0 ? "" : null,
    sourceContext.trim().length > 0 ? "Knowledge base snippets via semantic search:" : null,
    sourceContext.trim().length > 0 ? sourceContext : null,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
  const requestPreview = `System:\n${systemPrompt}\n\nUser:\n${userPrompt}`;

  try {
    const response = await client.responses.parse({
      model,
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
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
        request: requestPreview,
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
      request: requestPreview,
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
      request: requestPreview,
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
  handler: async (ctx, args): Promise<WorkspaceChatResult> => {
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
      limit: RECENT_CHAT_CONTEXT_MESSAGE_COUNT + 1,
    })) as Array<{
      role: string;
      text: string;
    }>;

    const actionResult = await maybePlanWorkspaceChildAction(ctx, {
      ...args,
      question,
      threadId,
      conversation: priorMessages.slice(0, -1),
    });
    if (actionResult) {
      return actionResult;
    }

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
        request: null,
      };
    }

    await ctx.runMutation(storeAssistantMessageRef, {
      threadId,
      text: response.answer,
      metadata: {
        kind: "knowledge_response",
        model: response.model,
        error: response.error,
        request: response.request,
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
      kind: "answer",
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
  if (isSeparatorLineText(text)) {
    return {
      kind: "note",
      taskStatus: null,
      priority: null,
    } as const;
  }

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

    if (isSeparatorLineText(context.node.text)) {
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: "note",
        taskStatus: null,
        priority: null,
      });
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
