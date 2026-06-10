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
import { type ChatPlan } from "../lib/domain/chat";
import {
  AI_WORKING_MEMORY_PAGE_TITLE,
  appendAiMemoryStoreOutlineToMemory,
  appendAiMemoryStoreTextToMemory,
  buildAiWorkingMemoryTextContext,
  completeAiMemoryItemInText,
  extractAiMemoryCompletionText,
  extractAiMemoryImplicitStoreText,
  extractAiMemoryRestoreText,
  extractAiMemoryStoreOutline,
  extractAiMemoryStoreText,
  matchAiMemoryCompletion,
  matchAiMemoryItems,
  restoreAiMemoryItemInText,
} from "../lib/domain/aiMemory";

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

const memoryAnswerSchema = z.object({
  answer: z.string(),
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
const getAiWorkingMemoryContextRef = internal.workspace.getAiWorkingMemoryContext as any;
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

type AiWorkingMemoryContext = {
  text: string;
  liveText: string;
  previousText: string;
  liveItems: Array<{
    nodeId: string;
    text: string;
    rawText: string;
    parentText: string | null;
    path: string;
    noteCompleted: boolean;
  }>;
  previousItems: Array<{
    nodeId: string;
    text: string;
    rawText: string;
    parentText: string | null;
    path: string;
    noteCompleted: boolean;
  }>;
} | null;

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

function buildEmptyChatOperation(type: ChatPlan["operations"][number]["type"]) {
  return {
    type,
    description: "",
    clientId: null,
    pageId: null,
    nodeId: null,
    parentNodeId: null,
    parentClientId: null,
    afterNodeId: null,
    afterClientId: null,
    sourceNodeId: null,
    targetNodeId: null,
    title: null,
    text: null,
    kind: null,
    taskStatus: null,
    noteCompleted: null,
    priority: null,
    dueAt: null,
    archived: null,
  } satisfies ChatPlan["operations"][number];
}

async function storeWorkspaceMemoryNoopResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: {
    threadId: Id<"chatThreads">;
    answer: string;
    model: string;
    request: string;
  },
) {
  await ctx.runMutation(storeAssistantMessageRef, {
    threadId: args.threadId,
    text: args.answer,
    metadata: {
      kind: "workspace_memory_response",
      model: args.model,
      request: args.request,
    },
  });
  return {
    kind: "answer" as const,
    threadId: args.threadId,
    response: buildWorkspaceActionNoopResponse({
      answer: args.answer,
      model: args.model,
      request: args.request,
    }),
  };
}

async function maybePlanAiWorkingMemoryAction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: WorkspaceKnowledgeArgs & {
    threadId: Id<"chatThreads">;
  },
): Promise<WorkspaceChatResult | null> {
  const question = args.question.trim();
  const restoreText = extractAiMemoryRestoreText(question);
  const completionText = restoreText ? null : extractAiMemoryCompletionText(question);
  const storeOutline = completionText || restoreText ? null : extractAiMemoryStoreOutline(question);
  const storeText = completionText || restoreText
    ? null
    : storeOutline
      ? null
      : (extractAiMemoryStoreText(question) ?? extractAiMemoryImplicitStoreText(question));
  if (!restoreText && !completionText && !storeText && !storeOutline) {
    return null;
  }

  const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
  const memoryContext = ((await ctx.runQuery(getAiWorkingMemoryContextRef, {
    limit: 80,
  })) ?? buildAiWorkingMemoryTextContext("")) as NonNullable<AiWorkingMemoryContext>;
  const requestPreview = [
    `Plain text AI Working Memory action for: ${question}`,
    storeOutline
      ? `Store outline: ${storeOutline.items.length} item(s)${
          storeOutline.parentText ? ` under ${storeOutline.parentText}` : ""
        }`
      : null,
    storeText ? `Store text: ${storeText}` : null,
    restoreText ? `Restore text: ${restoreText}` : null,
    completionText ? `Completion text: ${completionText}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");

  if (restoreText) {
    const previousItems = memoryContext.previousItems;
    const restoreMatch = matchAiMemoryItems(
      restoreText,
      previousItems.map((item) => ({
        nodeId: item.nodeId,
        text: [item.text || item.rawText, item.parentText ?? "", item.path]
          .filter((value) => value.trim().length > 0)
          .join(" "),
      })),
      { minimumScore: 45 },
    );

    if (restoreMatch.kind === "none") {
      return await storeWorkspaceMemoryNoopResponse(ctx, {
        threadId: args.threadId,
        answer: `I couldn't find a completed ${AI_WORKING_MEMORY_PAGE_TITLE} item matching "${restoreText}".`,
        model,
        request: requestPreview,
      });
    }

    if (restoreMatch.items.length > 4) {
      const options = restoreMatch.items
        .slice(0, 4)
        .map((item) => {
          const previousItem = previousItems.find((entry) => entry.nodeId === item.nodeId);
          return `"${previousItem?.path || previousItem?.text || item.text}"`;
        })
        .join(", ");
      return await storeWorkspaceMemoryNoopResponse(ctx, {
        threadId: args.threadId,
        answer: `I found several completed memory items that could match "${restoreText}": ${options}. Tell me which one(s) to move back to Live.`,
        model,
        request: requestPreview,
      });
    }

    let nextText = memoryContext.text;
    const restoredItems: typeof previousItems = [];
    for (const matched of restoreMatch.items) {
      const originalItem = previousItems.find((item) => item.nodeId === matched.nodeId) ?? null;
      const currentContext = buildAiWorkingMemoryTextContext(nextText);
      const currentItem =
        currentContext.previousItems.find((item) => item.nodeId === matched.nodeId) ??
        (originalItem
          ? currentContext.previousItems.find(
              (item) =>
                item.text === originalItem.text &&
                item.parentText === originalItem.parentText,
            ) ?? null
          : null);
      if (!currentItem) {
        continue;
      }

      const restored = restoreAiMemoryItemInText(nextText, currentItem.nodeId);
      if (!restored) {
        continue;
      }

      nextText = restored.text;
      restoredItems.push(restored.restoredItem);
    }

    if (restoredItems.length === 0) {
      return await storeWorkspaceMemoryNoopResponse(ctx, {
        threadId: args.threadId,
        answer: `I couldn't prepare that ${AI_WORKING_MEMORY_PAGE_TITLE} restore right now.`,
        model,
        request: requestPreview,
      });
    }

    const updateOperation = {
      ...buildEmptyChatOperation("set_ai_working_memory"),
      description: `Move completed memory back to Live`,
      text: nextText,
    } satisfies ChatPlan["operations"][number];
    const plan: ChatPlan = {
      summary: "Restore memory item",
      rationale: `I can move the matching completed memory item${restoredItems.length === 1 ? "" : "s"} back to Live in the plain text ${AI_WORKING_MEMORY_PAGE_TITLE}.`,
      preview: restoredItems.map((item) =>
        `Move "${item.text}" back to Live${item.parentText ? ` under "${item.parentText}"` : ""}`,
      ),
      operations: [updateOperation],
    };
    const messageId: Id<"chatMessages"> = await ctx.runMutation(storeAssistantPlanRef, {
      threadId: args.threadId,
      text: plan.rationale,
      preview: plan.preview,
      proposedPlan: plan,
      metadata: {
        kind: "workspace_memory_plan",
        model,
        request: requestPreview,
      },
    });

    return {
      kind: "plan",
      threadId: args.threadId,
      messageId,
      plan,
    };
  }

  if (storeOutline) {
    const nextText = appendAiMemoryStoreOutlineToMemory(memoryContext.text, storeOutline);
    const preview = [
      ...(storeOutline.parentText
        ? [`Remember grouped items under "${storeOutline.parentText}"`]
        : []),
      ...storeOutline.items
        .slice(0, 10)
        .map((item) =>
          item.noteCompleted
            ? `Move completed memory "${item.text}" to Previous`
            : `Remember "${item.text}" in Live`,
        ),
    ];
    if (storeOutline.items.length > 10) {
      preview.push(`Plus ${storeOutline.items.length - 10} more item(s)`);
    }
    const updateOperation = {
      ...buildEmptyChatOperation("set_ai_working_memory"),
      description: `Update ${AI_WORKING_MEMORY_PAGE_TITLE}`,
      text: nextText,
    } satisfies ChatPlan["operations"][number];

    const plan: ChatPlan = {
      summary: storeOutline.parentText ? "Remember grouped items" : "Remember items",
      rationale: `I can update the plain text ${AI_WORKING_MEMORY_PAGE_TITLE}.`,
      preview,
      operations: [updateOperation],
    };
    const messageId: Id<"chatMessages"> = await ctx.runMutation(storeAssistantPlanRef, {
      threadId: args.threadId,
      text: plan.rationale,
      preview: plan.preview,
      proposedPlan: plan,
      metadata: {
        kind: "workspace_memory_plan",
        model,
        request: requestPreview,
      },
    });

    return {
      kind: "plan",
      threadId: args.threadId,
      messageId,
      plan,
    };
  }

  if (storeText) {
    const nextText = appendAiMemoryStoreTextToMemory(memoryContext.text, storeText);
    const updateOperation = {
      ...buildEmptyChatOperation("set_ai_working_memory"),
      description: `Remember "${storeText}" in ${AI_WORKING_MEMORY_PAGE_TITLE}`,
      text: nextText,
    } satisfies ChatPlan["operations"][number];
    const plan: ChatPlan = {
      summary: "Remember item",
      rationale: `I can save this in the plain text ${AI_WORKING_MEMORY_PAGE_TITLE}.`,
      preview: [`Remember "${storeText}" in ${AI_WORKING_MEMORY_PAGE_TITLE}`],
      operations: [updateOperation],
    };
    const messageId: Id<"chatMessages"> = await ctx.runMutation(storeAssistantPlanRef, {
      threadId: args.threadId,
      text: plan.rationale,
      preview: plan.preview,
      proposedPlan: plan,
      metadata: {
        kind: "workspace_memory_plan",
        model,
        request: requestPreview,
      },
    });

    return {
      kind: "plan",
      threadId: args.threadId,
      messageId,
      plan,
    };
  }

  const liveItems = (memoryContext?.liveItems ?? []).filter((item) => !item.noteCompleted);
  const match = matchAiMemoryCompletion(
    completionText ?? "",
    liveItems.map((item) => ({
      nodeId: item.nodeId,
      text: [item.text || item.rawText, item.parentText ?? "", item.path]
        .filter((value) => value.trim().length > 0)
        .join(" "),
    })),
  );

  if (match.kind === "none") {
    return await storeWorkspaceMemoryNoopResponse(ctx, {
      threadId: args.threadId,
      answer: `I couldn't find an active ${AI_WORKING_MEMORY_PAGE_TITLE} item matching "${completionText}".`,
      model,
      request: requestPreview,
    });
  }

  if (match.kind === "ambiguous") {
    const options = match.items
      .slice(0, 4)
      .map((item) => `"${item.text}"`)
      .join(", ");
    return await storeWorkspaceMemoryNoopResponse(ctx, {
      threadId: args.threadId,
      answer: `I found multiple active memory items that could match "${completionText}": ${options}. Tell me which one to complete.`,
      model,
      request: requestPreview,
    });
  }

  const matchedItem = liveItems.find((item) => item.nodeId === match.item.nodeId) ?? null;
  if (!matchedItem) {
    return await storeWorkspaceMemoryNoopResponse(ctx, {
      threadId: args.threadId,
      answer: `I couldn't prepare that ${AI_WORKING_MEMORY_PAGE_TITLE} update right now.`,
      model,
      request: requestPreview,
    });
  }

  const displayText = matchedItem.text || matchedItem.rawText;
  const completion = completeAiMemoryItemInText(memoryContext.text, matchedItem.nodeId);
  if (!completion) {
    return await storeWorkspaceMemoryNoopResponse(ctx, {
      threadId: args.threadId,
      answer: `I couldn't prepare that ${AI_WORKING_MEMORY_PAGE_TITLE} update right now.`,
      model,
      request: requestPreview,
    });
  }

  const updateOperation = {
    ...buildEmptyChatOperation("set_ai_working_memory"),
    description: `Mark "${displayText}" complete in ${AI_WORKING_MEMORY_PAGE_TITLE}`,
    text: completion.text,
  } satisfies ChatPlan["operations"][number];
  const plan: ChatPlan = {
    summary: "Complete memory item",
    rationale: `I can mark this memory item complete and move it to Previous in the plain text ${AI_WORKING_MEMORY_PAGE_TITLE}.`,
    preview: [`Mark "${displayText}" complete and move it to Previous`],
    operations: [updateOperation],
  };
  const messageId: Id<"chatMessages"> = await ctx.runMutation(storeAssistantPlanRef, {
    threadId: args.threadId,
    text: plan.rationale,
    preview: plan.preview,
    proposedPlan: plan,
    metadata: {
      kind: "workspace_memory_plan",
      model,
      request: requestPreview,
    },
  });

  return {
    kind: "plan",
    threadId: args.threadId,
    messageId,
    plan,
  };
}

function buildAiWorkingMemoryPromptContext(memoryContext: AiWorkingMemoryContext) {
  if (!memoryContext) {
    return `${AI_WORKING_MEMORY_PAGE_TITLE}: empty`;
  }

  const activeMemoryItems = memoryContext.liveItems.filter((item) => !item.noteCompleted);
  const completedMemoryItems = [
    ...memoryContext.previousItems,
    ...memoryContext.liveItems.filter((item) => item.noteCompleted),
  ];
  const activeLines =
    activeMemoryItems.length > 0
      ? activeMemoryItems.map((item) => `- ${item.path || item.text || item.rawText}`)
      : ["- none"];
  const previousLines =
    completedMemoryItems.length > 0
      ? completedMemoryItems.map((item) => `- ${item.path || item.text || item.rawText}`)
      : ["- none"];

  return [
    `${AI_WORKING_MEMORY_PAGE_TITLE} plain text note:`,
    memoryContext.text.trim(),
    "",
    "Active memory items:",
    ...activeLines,
    "",
    "Completed/history memory items:",
    ...previousLines,
  ].join("\n");
}

function buildDeterministicAiMemoryAnswer(memoryContext: AiWorkingMemoryContext) {
  const activeItems = (memoryContext?.liveItems ?? []).filter((item) => !item.noteCompleted);
  const previousItems = [
    ...(memoryContext?.previousItems ?? []),
    ...(memoryContext?.liveItems ?? []).filter((item) => item.noteCompleted),
  ];

  if (activeItems.length === 0 && previousItems.length === 0) {
    return `${AI_WORKING_MEMORY_PAGE_TITLE} is empty right now.`;
  }

  if (activeItems.length === 0) {
    return `There are no active ${AI_WORKING_MEMORY_PAGE_TITLE} items right now.`;
  }

  return [
    `Active ${AI_WORKING_MEMORY_PAGE_TITLE}:`,
    ...activeItems.slice(0, 12).map((item) => `- ${item.path || item.text || item.rawText}`),
  ].join("\n");
}

async function answerAiWorkingMemoryQuestionInternal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: WorkspaceKnowledgeArgs,
): Promise<WorkspaceKnowledgeAnswer> {
  assertOwnerKey(args.ownerKey);

  const question = args.question.trim();
  const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
  if (question.length === 0) {
    return {
      answer: `Tell me what to remember in ${AI_WORKING_MEMORY_PAGE_TITLE}, or ask about what is already there.`,
      sources: [],
      model,
      error: null,
      request: null,
    };
  }

  const memoryContext = (await ctx.runQuery(getAiWorkingMemoryContextRef, {
    limit: 80,
  })) as AiWorkingMemoryContext;
  const conversationContext =
    args.conversation && args.conversation.length > 0
      ? args.conversation
          .slice(-RECENT_CHAT_CONTEXT_MESSAGE_COUNT)
          .map((message) => `${message.role}: ${message.text}`)
          .join("\n")
      : "";
  const memoryPromptContext = buildAiWorkingMemoryPromptContext(memoryContext);
  const systemPrompt =
    `${buildTodayPromptLine()} You are the AI Working Memory chat. Your only accessible workspace data is the AI Working Memory plain text note below. Answer using only that memory. Treat # Live items as current preferences, intentions, or things to remember. Treat # Previous items as done and do not recommend them as active unless the user asks about completed memory. If the memory is insufficient, say so clearly. Keep the answer concise.`;
  const userPrompt = [
    conversationContext.length > 0 ? "Recent conversation:" : null,
    conversationContext.length > 0 ? conversationContext : null,
    conversationContext.length > 0 ? "" : null,
    `User message: ${question}`,
    "",
    memoryPromptContext,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
  const requestPreview = `System:\n${systemPrompt}\n\nUser:\n${userPrompt}`;

  const client = getOpenAIClient();
  if (!client) {
    return {
      answer: buildDeterministicAiMemoryAnswer(memoryContext),
      sources: [],
      model,
      error: "OPENAI_API_KEY is not configured in Convex.",
      request: requestPreview,
    };
  }

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
        format: zodTextFormat(memoryAnswerSchema, "ai_working_memory_answer"),
      },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      return {
        answer: "OpenAI returned no answer.",
        sources: [],
        model,
        error: "OpenAI returned no parsed answer.",
        request: requestPreview,
      };
    }

    return {
      answer: parsed.answer,
      sources: [],
      model,
      error: null,
      request: requestPreview,
    };
  } catch (error) {
    return {
      answer:
        error instanceof Error
          ? `AI Working Memory chat failed: ${error.message}`
          : "AI Working Memory chat failed.",
      sources: [],
      model,
      error: error instanceof Error ? error.message : "Unknown OpenAI error.",
      request: requestPreview,
    };
  }
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
  const aiWorkingMemoryContext = (await ctx.runQuery(getAiWorkingMemoryContextRef, {
    limit: 40,
  })) as AiWorkingMemoryContext;

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
  const aiWorkingMemoryPromptContext =
    aiWorkingMemoryContext &&
    (aiWorkingMemoryContext.liveItems.length > 0 ||
      aiWorkingMemoryContext.previousItems.length > 0)
      ? (() => {
          const activeMemoryItems = aiWorkingMemoryContext.liveItems.filter(
            (item) => !item.noteCompleted,
          );
          const completedMemoryItems = [
            ...aiWorkingMemoryContext.previousItems,
            ...aiWorkingMemoryContext.liveItems.filter((item) => item.noteCompleted),
          ];
          return [
            "AI Working Memory plain text note:",
            aiWorkingMemoryContext.text.trim(),
            "",
            activeMemoryItems.length > 0
              ? [
                  "Active memory items:",
                  ...activeMemoryItems.map(
                    (item) => `- ${item.path || item.text || item.rawText}`,
                  ),
                ].join("\n")
              : "Active memory items: none",
            completedMemoryItems.length > 0
              ? [
                  "Completed/history memory items (do not recommend as active unless the user asks about completed memory):",
                  ...completedMemoryItems.map(
                    (item) => `- ${item.path || item.text || item.rawText}`,
                  ),
                ].join("\n")
              : null,
          ]
            .filter((value): value is string => value !== null)
            .join("\n");
        })()
      : "";

  const explicitLinkedContext = [
    aiWorkingMemoryPromptContext.trim().length > 0 ? aiWorkingMemoryPromptContext : null,
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
  ]
    .filter((value): value is string => value !== null)
    .join("\n\n");

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
    `${buildTodayPromptLine()} Answer the user's question using only the provided knowledge base snippets. Treat AI Working Memory active items as current remembered preferences or intentions; treat completed/history memory as done unless the user asks about completed memory. If the snippets are insufficient, say so clearly. Keep the answer concise and grounded. Cite source numbers like [1] when helpful. If no explicit question text is provided, summarize the linked context and surface the most important takeaways.`;
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

    const memoryActionResult = await maybePlanAiWorkingMemoryAction(ctx, {
      ...args,
      question,
      threadId,
    });
    if (memoryActionResult) {
      return memoryActionResult;
    }

    let response: WorkspaceKnowledgeAnswer;
    try {
      response = await answerAiWorkingMemoryQuestionInternal(ctx, {
        ...args,
        question,
        conversation: priorMessages.slice(0, -1),
      });
    } catch (error) {
      const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
      response = {
        answer:
          error instanceof Error
            ? `AI Working Memory chat failed: ${error.message}`
            : "AI Working Memory chat failed.",
        sources: [],
        model,
        error: error instanceof Error ? error.message : "Unknown AI Working Memory chat error.",
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
