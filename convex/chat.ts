"use node";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import { chatPlanSchema, type ChatPlan } from "../lib/domain/chat";

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
const getResolvedLinkedTargetsForNodesRef =
  internal.workspace.getResolvedLinkedTargetsForNodes as any; // eslint-disable-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getLinkedKnowledgeContextRef = internal.workspace.getLinkedKnowledgeContext as any;

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
    });

    let plan: ChatPlan = buildHeuristicPlan({
      prompt: args.prompt,
      pageId: args.pageId as string | undefined,
      workspace: workspace as PlannerWorkspace,
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
                "You are planning safe workspace edits for a personal outliner. Only propose operations using real pageId and nodeId values present in the provided context. Never invent ids. If the request is ambiguous, return zero operations and explain why. All edits require later human approval.",
            },
            {
              role: "user",
              content: [
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
                  .slice(-6)
                  .map((message: { role: string; text: string }) => `${message.role}: ${message.text}`)
                  .join("\n"),
              ].join("\n"),
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
      text: args.prompt,
    });

    const modelContext = await ctx.runQuery(getModelPageContextRef, {
      pageId: args.pageId,
    });
    if (!modelContext?.modelSection) {
      throw new Error("Model section not found for this page.");
    }

    const priorMessages = await ctx.runQuery(getThreadMessagesRef, {
      threadId,
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
    const systemPrompt =
      "You rewrite only the Model section of a page. Use Recent Examples only as evidence and inspiration. Never rewrite, summarize, or mention the Recent Examples section in the output. Return concise plain-text model lines only. No bullets, no numbering, no markdown headings, no checkbox syntax.";
    const userPrompt = [
      `Page title: ${modelContext.page.title}`,
      `Request: ${args.prompt}`,
      "",
      "Current Model lines:",
      existingModelLines.length > 0
        ? existingModelLines.map((line: string) => `- ${line}`).join("\n")
        : "(empty)",
      "",
      "Recent Examples for context only:",
      recentExampleLines.length > 0
        ? recentExampleLines.map((line: string) => `- ${line}`).join("\n")
        : "(empty)",
      explicitLinkedContext.trim().length > 0
        ? ["", "Dereferenced linked context from Current Model and Recent Examples:", explicitLinkedContext].join("\n")
        : "",
      "",
      "Recent conversation:",
      priorMessages
        .slice(-6)
        .map((message: { role: string; text: string }) => `${message.role}: ${message.text}`)
        .join("\n") || "(none)",
    ].join("\n");
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
            content:
              "You generate the Feedback section for a personal journal. Read the Thoughts/Stuff section and return concise plain-text feedback lines that summarize patterns, add perspective, and offer grounded guidance. Be supportive, practical, and non-judgmental. No bullets, no numbering, no markdown headings, no checkbox syntax.",
          },
          {
            role: "user",
            content: [
              `Journal date/title: ${journalContext.page.title}`,
              "",
              "Thoughts/Stuff:",
              thoughtLines.map((line: string) => `- ${line}`).join("\n"),
              explicitLinkedContext.trim().length > 0
                ? [
                    "",
                    "Dereferenced linked context from Thoughts/Stuff:",
                    explicitLinkedContext,
                  ].join("\n")
                : "",
            ].join("\n"),
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
