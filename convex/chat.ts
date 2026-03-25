"use node";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
const replaceModelSectionRef = internal.chatData.replaceModelSection as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getWorkspaceContextRef = internal.workspace.getWorkspaceContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getModelPageContextRef = internal.workspace.getModelPageContext as any;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
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

    const fallbackModelLines =
      existingModelLines.length > 0
        ? existingModelLines
        : [args.prompt.trim()];

    let summary = "Updated the model section.";
    let modelLines = fallbackModelLines;

    const client = getOpenAIClient();
    if (!client) {
      summary = "OpenAI is not configured, so the model section was left unchanged.";
    } else {
      try {
        const response = await client.responses.parse({
          model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
          input: [
            {
              role: "system",
              content:
                "You rewrite only the Model section of a page. Use Recent Examples only as evidence and inspiration. Never rewrite, summarize, or mention the Recent Examples section in the output. Return concise plain-text model lines only. No bullets, no numbering, no markdown headings, no checkbox syntax.",
            },
            {
              role: "user",
              content: [
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
                "",
                "Recent conversation:",
                priorMessages
                  .slice(-6)
                  .map((message: { role: string; text: string }) => `${message.role}: ${message.text}`)
                  .join("\n") || "(none)",
              ].join("\n"),
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
        }
      } catch {
        summary = "OpenAI could not rewrite the model section, so it was left unchanged.";
      }
    }

    if (client && modelLines.length > 0) {
      await ctx.runMutation(replaceModelSectionRef, {
        pageId: args.pageId,
        sectionNodeId: modelContext.modelSection._id,
        lines: modelLines,
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
    };
  },
});
