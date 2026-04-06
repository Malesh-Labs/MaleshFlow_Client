"use node";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  buildJournalFeedbackUserPrompt,
  buildModelRewriteUserPrompt,
  JOURNAL_FEEDBACK_SYSTEM_PROMPT,
  MODEL_REWRITE_SYSTEM_PROMPT,
} from "../lib/domain/aiPrompts";
import { chatPlanSchema, type ChatPlan } from "../lib/domain/chat";
import { plannerChatPlanSchema, type PlannerChatPlan } from "../lib/domain/planner";

type PlannerWorkspace = {
  pages: Array<{ _id: string; title: string }>;
  pageNodes: Array<{
    _id: string;
    text: string;
    kind: string;
    taskStatus: string | null;
  }>;
  tasks: Array<{ _id: string; text: string }>;
};

const modelRewriteSchema = z.object({
  summary: z.string(),
  modelLines: z.array(z.string()).min(1).max(24),
});

const journalFeedbackSchema = z.object({
  summary: z.string(),
  feedbackLines: z.array(z.string()).min(1).max(24),
});

type ModelRewriteDebug = {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response:
    | {
        summary: string;
        modelLines: string[];
      }
    | null;
  error: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ensureChatThreadRef = api.chatData.ensureChatThread as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeUserMessageRef = internal.chatData.storeUserMessage as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getThreadMessagesRef = internal.chatData.getThreadMessages as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeAssistantPlanRef = internal.chatData.storeAssistantPlan as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeAssistantMessageRef = internal.chatData.storeAssistantMessage as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const replaceSectionLinesRef = internal.chatData.replaceSectionLines as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getWorkspaceContextRef = internal.workspace.getWorkspaceContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getModelPageContextRef = internal.workspace.getModelPageContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJournalPageContextRef = internal.workspace.getJournalPageContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getPlannerPageContextRef = internal.workspace.getPlannerPageContext as any;
const getResolvedLinkedTargetsForNodesRef =
  internal.workspace.getResolvedLinkedTargetsForNodes as any; // eslint-disable-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getLinkedKnowledgeContextRef = internal.workspace.getLinkedKnowledgeContext as any;

const RECENT_CHAT_CONTEXT_MESSAGE_COUNT = 4;

function buildAiRequestPreview(args: {
  systemPrompt: string;
  userPrompt: string;
}) {
  return `System:\n${args.systemPrompt}\n\nUser:\n${args.userPrompt}`;
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function buildExplicitLinkedContextForNodes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  nodeIds: Id<"nodes">[],
) {
  const uniqueNodeIds = [...new Set(nodeIds)];
  if (uniqueNodeIds.length === 0) {
    return "";
  }

  const linkedTargets = (await ctx.runQuery(getResolvedLinkedTargetsForNodesRef, {
    nodeIds: uniqueNodeIds,
  })) as {
    pageIds: Id<"pages">[];
    nodeIds: Id<"nodes">[];
  };

  if (linkedTargets.pageIds.length === 0 && linkedTargets.nodeIds.length === 0) {
    return "";
  }

  const linkedContext = (await ctx.runQuery(getLinkedKnowledgeContextRef, {
    pageIds: linkedTargets.pageIds,
    nodeIds: linkedTargets.nodeIds,
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

  return [
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
}

function buildHeuristicPlan(input: {
  prompt: string;
  pageId?: string;
  workspace: PlannerWorkspace;
}): ChatPlan {
  const lowered = input.prompt.toLowerCase();
  const pageNodes =
    typeof input.workspace === "object" && input.workspace && "pageNodes" in input.workspace
      ? (input.workspace.pageNodes as Array<{
          _id: string;
          kind: string;
          taskStatus: string | null;
          text: string;
        }>)
      : [];

  const archiveableDoneTasks = pageNodes.filter(
    (node) => node.kind === "task" && node.taskStatus === "done",
  );

  if (lowered.includes("archive") && lowered.includes("done")) {
    return {
      summary: "Archive completed tasks in the current page.",
      rationale:
        "The prompt asked to archive finished work, so the plan targets completed tasks only.",
      preview: archiveableDoneTasks
        .slice(0, 6)
        .map((node) => `Archive done task: ${node.text}`),
      operations: archiveableDoneTasks.slice(0, 12).map((node) => ({
        type: "archive_node" as const,
        description: `Archive task "${node.text}"`,
        nodeId: node._id,
        archived: true,
      })),
    };
  }

  return {
    summary: "No automatic edits proposed yet.",
    rationale:
      "Without a stronger workspace-specific signal, the safest fallback is to return a no-op plan for review.",
    preview: [
      "Review the prompt and workspace context.",
      "Return a no-op plan so nothing changes without a clear deterministic action.",
    ],
    operations: [],
  };
}

export const runChatPlanner = action({
  args: {
    ownerKey: v.string(),
    prompt: v.string(),
    pageId: v.optional(v.id("pages")),
    threadId: v.optional(v.id("chatThreads")),
  },
  handler: async (ctx, args): Promise<{
    threadId: Id<"chatThreads">;
    messageId: Id<"chatMessages">;
    plan: ChatPlan;
  }> => {
    assertOwnerKey(args.ownerKey);
    const threadId: Id<"chatThreads"> =
      args.threadId ??
      (await ctx.runMutation(ensureChatThreadRef, {
        ownerKey: args.ownerKey,
        pageId: args.pageId,
      }));

    await ctx.runMutation(storeUserMessageRef, {
      threadId,
      text: args.prompt,
    });

    const workspace = (await ctx.runQuery(getWorkspaceContextRef, {
      pageId: args.pageId,
    })) as PlannerWorkspace;
    const priorMessages = await ctx.runQuery(getThreadMessagesRef, {
      threadId,
      limit: RECENT_CHAT_CONTEXT_MESSAGE_COUNT + 1,
    });

    let plan: ChatPlan = buildHeuristicPlan({
      prompt: args.prompt,
      pageId: args.pageId as string | undefined,
      workspace: workspace as PlannerWorkspace,
    });
    const systemPrompt =
      "You are planning safe workspace edits for a personal outliner. Only propose operations using real pageId and nodeId values present in the provided context. Never invent ids. If the request is ambiguous, return zero operations and explain why. All edits require later human approval.";
    const userPrompt = [
      `Prompt: ${args.prompt}`,
      "",
      "Pages:",
      workspace.pages
        .slice(0, 40)
        .map((page: { _id: string; title: string }) => `- ${page._id}: ${page.title}`)
        .join("\n"),
      "",
      "Current page nodes:",
      workspace.pageNodes
        .slice(0, 80)
        .map((node: { _id: string; text: string; kind: string; taskStatus: string | null }) => `- ${node._id}: ${node.text} [${node.kind}/${node.taskStatus ?? "n/a"}]`)
        .join("\n"),
      "",
      "Open tasks:",
      workspace.tasks
        .slice(0, 40)
        .map((node: { _id: string; text: string }) => `- ${node._id}: ${node.text}`)
        .join("\n"),
      "",
      "Recent conversation:",
      priorMessages
        .slice(0, -1)
        .map((message: { role: string; text: string }) => `${message.role}: ${message.text}`)
        .join("\n"),
    ].join("\n");
    const requestPreview = buildAiRequestPreview({
      systemPrompt,
      userPrompt,
    });

    const client = getOpenAIClient();
    if (client) {
      try {
        const response = await client.responses.parse({
          model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
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
            format: zodTextFormat(chatPlanSchema, "workspace_plan"),
          },
        });

        if (response.output_parsed) {
          plan = response.output_parsed;
        }
      } catch {
        // Fall back to the heuristic no-op planner.
      }
    }

    const messageId: Id<"chatMessages"> = await ctx.runMutation(storeAssistantPlanRef, {
      threadId,
      text: plan.rationale,
      preview: plan.preview,
      proposedPlan: plan,
      metadata: {
        request: requestPreview,
      },
    });

    return {
      threadId,
      messageId,
      plan,
    };
  },
});

export const runPlannerChat = action({
  args: {
    ownerKey: v.string(),
    prompt: v.string(),
    pageId: v.id("pages"),
    threadId: v.optional(v.id("chatThreads")),
  },
  handler: async (ctx, args): Promise<{
    threadId: Id<"chatThreads">;
    messageId: Id<"chatMessages">;
    plan: PlannerChatPlan;
  }> => {
    assertOwnerKey(args.ownerKey);

    const threadId: Id<"chatThreads"> =
      args.threadId ??
      (await ctx.runMutation(ensureChatThreadRef, {
        ownerKey: args.ownerKey,
        pageId: args.pageId,
      }));

    await ctx.runMutation(storeUserMessageRef, {
      threadId,
      text: args.prompt,
    });

    const plannerContext = await ctx.runQuery(getPlannerPageContextRef, {
      pageId: args.pageId,
    });
    if (!plannerContext) {
      throw new Error("Planner page context could not be loaded.");
    }

    const priorMessages = await ctx.runQuery(getThreadMessagesRef, {
      threadId,
      limit: RECENT_CHAT_CONTEXT_MESSAGE_COUNT + 1,
    });

    const fallbackPlan: PlannerChatPlan = {
      summary: "No planner changes proposed.",
      rationale:
        "The request was too ambiguous to map to a specific planner item safely, so no edits were proposed.",
      preview: [
        "Review the planner page and linked tasks.",
        "No changes will be made until a concrete planner task is identified.",
      ],
      operations: [],
    };

    let plan = fallbackPlan;
    const systemPrompt =
      "You plan safe edits for a personal daily planner. Only return operations using real planner node ids that appear in the provided context. Prefer complete_planner_task when the user clearly finished a linked planner task. Use delete_planner_node only for planner-local items. If the request is ambiguous, return zero operations and explain why. All changes require later human approval.";
    const userPrompt = [
      `Prompt: ${args.prompt}`,
      "",
      `Planner page: ${plannerContext.page.title}`,
      `Current day: ${plannerContext.currentDayTitle ?? "(none)"}`,
      `Current day node id: ${plannerContext.currentDayId ?? "(none)"}`,
      "",
      "Current day lines:",
      plannerContext.currentDayLines.length > 0
        ? plannerContext.currentDayLines
            .map(
              (line: {
                nodeId: string;
                text: string;
                linkedSourceTaskId: string | null;
                status: string | null;
              }) =>
                `- ${line.nodeId}: ${line.text} [${line.status ?? "n/a"}]${line.linkedSourceTaskId ? ` -> ${line.linkedSourceTaskId}` : ""}`,
            )
            .join("\n")
        : "- none",
      "",
      "Anytime:",
      plannerContext.anytimeLines.length > 0
        ? plannerContext.anytimeLines
            .map(
              (line: {
                nodeId: string;
                text: string;
                linkedSourceTaskId: string | null;
                status: string | null;
                depth: number;
              }) =>
                `${"  ".repeat(line.depth)}- ${line.nodeId}: ${line.text} [${line.status ?? "n/a"}]${line.linkedSourceTaskId ? ` -> ${line.linkedSourceTaskId}` : ""}`,
            )
            .join("\n")
        : "- none",
      "",
      "Open source tasks:",
      plannerContext.openSourceTasks.length > 0
        ? plannerContext.openSourceTasks
            .map(
              (task: {
                nodeId: string;
                text: string;
                dueAt: number | null;
                dueEndAt: number | null;
              }) =>
                `- ${task.nodeId}: ${task.text} [${task.dueAt ?? "no due"}${task.dueEndAt ? ` -> ${task.dueEndAt}` : ""}]`,
            )
            .join("\n")
        : "- none",
      "",
      "Recent conversation:",
      priorMessages
        .slice(0, -1)
        .map((message: { role: string; text: string }) => `${message.role}: ${message.text}`)
        .join("\n"),
    ].join("\n");
    const requestPreview = buildAiRequestPreview({
      systemPrompt,
      userPrompt,
    });
    const client = getOpenAIClient();
    if (client) {
      try {
        const response = await client.responses.parse({
          model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
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
            format: zodTextFormat(plannerChatPlanSchema, "planner_chat_plan"),
          },
        });

        if (response.output_parsed) {
          plan = response.output_parsed;
        }
      } catch {
        // Fall back to the safe no-op plan.
      }
    }

    const messageId: Id<"chatMessages"> = await ctx.runMutation(storeAssistantPlanRef, {
      threadId,
      text: plan.rationale,
      preview: plan.preview,
      proposedPlan: plan,
      metadata: {
        request: requestPreview,
      },
    });

    return {
      threadId,
      messageId,
      plan,
    };
  },
});

export const rewriteModelSection = action({
  args: {
    ownerKey: v.string(),
    prompt: v.string(),
    pageId: v.id("pages"),
    threadId: v.optional(v.id("chatThreads")),
    userNote: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    threadId: Id<"chatThreads">;
    messageId: Id<"chatMessages">;
    summary: string;
    modelLines: string[];
    debug: ModelRewriteDebug;
  }> => {
    assertOwnerKey(args.ownerKey);

    const threadId: Id<"chatThreads"> =
      args.threadId ??
      (await ctx.runMutation(ensureChatThreadRef, {
        ownerKey: args.ownerKey,
        pageId: args.pageId,
      }));

    await ctx.runMutation(storeUserMessageRef, {
      threadId,
      text:
        args.userNote && args.userNote.trim().length > 0
          ? `${args.userNote.trim()}\n\n${args.prompt}`
          : args.prompt,
    });

    const modelContext = await ctx.runQuery(getModelPageContextRef, {
      pageId: args.pageId,
    });
    if (!modelContext?.modelSection) {
      throw new Error("Model section not found for this page.");
    }

    const priorMessages = await ctx.runQuery(getThreadMessagesRef, {
      threadId,
      limit: RECENT_CHAT_CONTEXT_MESSAGE_COUNT + 1,
    });

    const existingModelLines = modelContext.modelLines.map(
      (node: { text: string }) => node.text,
    );
    const recentExampleLines = modelContext.recentExampleLines.map(
      (node: { text: string }) => node.text,
    );
    const explicitLinkedContext = await buildExplicitLinkedContextForNodes(
      ctx,
      [
        ...modelContext.modelLines.map((node: { _id: Id<"nodes"> }) => node._id),
        ...modelContext.recentExampleLines.map((node: { _id: Id<"nodes"> }) => node._id),
      ],
    );

    const fallbackModelLines =
      existingModelLines.length > 0
        ? existingModelLines
        : [args.prompt.trim()];

    let summary = "Updated the model section.";
    let modelLines = fallbackModelLines;
    let shouldApplyModelLines = false;
    const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
    const systemPrompt = MODEL_REWRITE_SYSTEM_PROMPT;
    const userPrompt = buildModelRewriteUserPrompt({
      pageTitle: modelContext.page.title,
      request: args.prompt,
      userNote: args.userNote,
      existingModelLines,
      recentExampleLines,
      explicitLinkedContext,
      recentConversationLines: priorMessages
        .slice(0, -1)
        .map((message: { role: string; text: string }) => `${message.role}: ${message.text}`),
    });
    const debug: ModelRewriteDebug = {
      model,
      systemPrompt,
      userPrompt,
      response: null,
      error: null,
    };

    const client = getOpenAIClient();
    if (!client) {
      summary = "OpenAI is not configured, so the model section was left unchanged.";
      debug.error = "OPENAI_API_KEY is not configured in Convex.";
    } else {
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
            format: zodTextFormat(modelRewriteSchema, "model_section_rewrite"),
          },
        });

        const parsed = response.output_parsed;
        if (parsed) {
          summary = parsed.summary;
          modelLines = parsed.modelLines
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          shouldApplyModelLines = modelLines.length > 0;
          debug.response = {
            summary: parsed.summary,
            modelLines,
          };
        }
      } catch (error) {
        summary =
          error instanceof Error
            ? `OpenAI rewrite failed: ${error.message}`
            : "OpenAI could not rewrite the model section, so it was left unchanged.";
        debug.error = error instanceof Error ? error.message : "Unknown OpenAI error.";
      }
    }

    if (shouldApplyModelLines && modelLines.length > 0) {
      await ctx.runMutation(replaceSectionLinesRef, {
        pageId: args.pageId,
        sectionNodeId: modelContext.modelSection._id,
        lines: modelLines,
        generatedFrom: "model_chat",
      });
    }

    const messageId: Id<"chatMessages"> = await ctx.runMutation(
      storeAssistantMessageRef,
      {
        threadId,
        text: summary,
        metadata: {
          request: buildAiRequestPreview({
            systemPrompt,
            userPrompt,
          }),
        },
      },
    );

    return {
      threadId,
      messageId,
      summary,
      modelLines,
      debug,
    };
  },
});

export const generateJournalFeedback = action({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    userNote: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    summary: string;
    feedbackLines: string[];
  }> => {
    assertOwnerKey(args.ownerKey);

    const journalContext = await ctx.runQuery(getJournalPageContextRef, {
      pageId: args.pageId,
    });
    if (!journalContext?.thoughtsSection || !journalContext.feedbackSection) {
      throw new Error("Journal sections were not found for this page.");
    }

    const thoughtLines = journalContext.thoughtLines.map(
      (node: { text: string }) => node.text.trim(),
    ).filter((line: string) => line.length > 0);
    const explicitLinkedContext = await buildExplicitLinkedContextForNodes(
      ctx,
      journalContext.thoughtLines.map((node: { _id: Id<"nodes"> }) => node._id),
    );

    if (thoughtLines.length === 0) {
      return {
        summary: "Add some thoughts first, then generate feedback.",
        feedbackLines: [],
      };
    }

    const client = getOpenAIClient();
    if (!client) {
      return {
        summary: "OpenAI is not configured, so the Feedback section was left unchanged.",
        feedbackLines: [],
      };
    }

    try {
      const response = await client.responses.parse({
        model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
        input: [
          {
            role: "system",
            content: JOURNAL_FEEDBACK_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: buildJournalFeedbackUserPrompt({
              pageTitle: journalContext.page.title,
              userNote: args.userNote,
              thoughtLines,
              explicitLinkedContext,
            }),
          },
        ],
        text: {
          format: zodTextFormat(journalFeedbackSchema, "journal_feedback"),
        },
      });

      const parsed = response.output_parsed;
      if (!parsed) {
        return {
          summary: "OpenAI returned no feedback, so the Feedback section was left unchanged.",
          feedbackLines: [],
        };
      }

      const feedbackLines = parsed.feedbackLines
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (feedbackLines.length === 0) {
        return {
          summary: parsed.summary,
          feedbackLines: [],
        };
      }

      await ctx.runMutation(replaceSectionLinesRef, {
        pageId: args.pageId,
        sectionNodeId: journalContext.feedbackSection._id,
        lines: feedbackLines,
        generatedFrom: "journal_feedback",
      });

      return {
        summary: parsed.summary,
        feedbackLines,
      };
    } catch (error) {
      return {
        summary:
          error instanceof Error
            ? `OpenAI feedback failed: ${error.message}`
            : "OpenAI could not generate feedback, so the Feedback section was left unchanged.",
        feedbackLines: [],
      };
    }
  },
});
