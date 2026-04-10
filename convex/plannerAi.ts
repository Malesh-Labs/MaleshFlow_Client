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
  findPlannerSectionNode,
  getPlannerDayTimestamp,
  getPlannerLinkedSourceTaskId,
  getPlannerDayRoots,
  PLANNER_FOCUS_SLOT,
} from "./lib/planner";
import {
  comparePlannerTaskOrder,
  getEffectiveTaskDueDateRange,
  plannerDayRollforwardPlanSchema,
} from "../lib/domain/planner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getPlannerPageContextRef = internal.workspace.getPlannerPageContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const suggestRandomPlannerTaskCandidateRef = internal.planner.suggestRandomPlannerTaskCandidate as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolvePlannerSuggestionNodeTextRef = internal.planner.resolvePlannerSuggestionNodeText as any;

const plannerTaskChoiceSchema = z.object({
  nodeId: z.string(),
  rationale: z.string(),
});

const OPENAI_PLANNER_TIMEOUT_MS = 9000;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildPlannerNodeMap(nodes: Doc<"nodes">[]) {
  return new Map(nodes.map((node) => [node._id as string, node]));
}

function isNodeWithinRootSubtree(
  node: Doc<"nodes">,
  rootNodeId: Id<"nodes">,
  nodeMap: Map<string, Doc<"nodes">>,
) {
  let currentNode: Doc<"nodes"> | null = node;
  while (currentNode) {
    if (currentNode._id === rootNodeId) {
      return true;
    }
    const parentNodeId = currentNode.parentNodeId as string | null;
    currentNode = parentNodeId ? (nodeMap.get(parentNodeId) ?? null) : null;
  }
  return false;
}

export const completePlannerDayWithAi = action({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    completedDayNodeId: Id<"nodes">;
    focusSectionId: Id<"nodes">;
    movedCount: number;
    archivedDuplicateCount: number;
  }> => {
    assertOwnerKey(args.ownerKey);

    const plannerContext = (await ctx.runQuery(getPlannerPageContextRef, {
      pageId: args.pageId,
    })) as
      | {
          page: Doc<"pages">;
          nodes: Doc<"nodes">[];
          plannerDays: Doc<"nodes">[];
        }
      | null;

    if (!plannerContext) {
      throw new Error("Planner page context could not be loaded.");
    }

    const plannerDays = getPlannerDayRoots(plannerContext.nodes);
    const topDay = plannerDays[0] ?? null;
    const focusSection = findPlannerSectionNode(plannerContext.nodes, PLANNER_FOCUS_SLOT);

    if (!topDay) {
      throw new Error("Add a planner day before completing one.");
    }

    if (!focusSection) {
      return await ctx.runMutation(api.planner.completePlannerDay, {
        ownerKey: args.ownerKey,
        pageId: args.pageId,
      });
    }

    const topDayChildren = plannerContext.nodes
      .filter((node) => node.parentNodeId === topDay._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    const focusChildren = plannerContext.nodes
      .filter((node) => node.parentNodeId === focusSection._id && !node.archived)
      .sort((left, right) => left.position - right.position);

    const existingFocusSourceIds = new Set(
      focusChildren
        .map((node) => getPlannerLinkedSourceTaskId(node))
        .filter((value): value is Id<"nodes"> => value !== null)
        .map((value) => value as string),
    );
    const carryChildren = topDayChildren.filter((node) => {
      const linkedSourceTaskId = getPlannerLinkedSourceTaskId(node);
      return !linkedSourceTaskId || !existingFocusSourceIds.has(linkedSourceTaskId as string);
    });

    if (carryChildren.length === 0) {
      return await ctx.runMutation(api.planner.completePlannerDay, {
        ownerKey: args.ownerKey,
        pageId: args.pageId,
      });
    }

    let orderedNodeIds: Id<"nodes">[] | undefined;
    const client = getOpenAIClient();
    if (client) {
      try {
        const response = await client.responses.parse({
          model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
          input: [
            {
              role: "system",
              content:
                "You are arranging a daily planner Focus outline. Return a single ordered list of node ids representing the best combined order for the Focus section. Keep all existing Focus node ids and all carried node ids exactly once each. Do not invent ids, omit ids, or duplicate ids. Prefer placing carried items near similar tasks, routines, or sections. If uncertain, preserve the existing Focus order and append carried items in a sensible order near related items.",
            },
            {
              role: "user",
              content: [
                `Planner page: ${plannerContext.page.title}`,
                `Top day being completed: ${topDay.text}`,
                `Top day date: ${getPlannerDayTimestamp(topDay) ?? "(unknown)"}`,
                `Focus section receiving items: ${focusSection.text}`,
                "",
                "Existing Focus root items:",
                focusChildren
                  .map(
                    (node) =>
                      `- ${node._id}: ${node.text} [${node.kind}/${node.taskStatus ?? "n/a"}]`,
                  )
                  .join("\n"),
                "",
                "Carried root items to insert:",
                carryChildren
                  .map(
                    (node) =>
                      `- ${node._id}: ${node.text} [${node.kind}/${node.taskStatus ?? "n/a"}]`,
                  )
                  .join("\n"),
              ].join("\n"),
            },
          ],
          text: {
            format: zodTextFormat(
              plannerDayRollforwardPlanSchema,
              "planner_day_rollforward_plan",
            ),
          },
        });

        const parsed = response.output_parsed;
        const candidateIds = new Set(
          [...focusChildren, ...carryChildren].map((node) => node._id as string),
        );
        if (
          parsed &&
          parsed.orderedNodeIds.length === candidateIds.size &&
          parsed.orderedNodeIds.every((nodeId) => candidateIds.has(nodeId))
        ) {
          orderedNodeIds = parsed.orderedNodeIds as Id<"nodes">[];
        }
      } catch {
        orderedNodeIds = undefined;
      }
    }

    return await ctx.runMutation(api.planner.completePlannerDay, {
      ownerKey: args.ownerKey,
      pageId: args.pageId,
      orderedNodeIds,
    });
  },
});

export const suggestRandomPlannerTask = action({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    seed: v.number(),
    excludeSourceTaskIds: v.optional(v.array(v.id("nodes"))),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    sourceTaskId: Id<"nodes">;
    text: string;
    dueAt: number | null;
    dueEndAt: number | null;
    sourcePageId: Id<"pages"> | null;
    sourcePageTitle: string | null;
  }> => {
    assertOwnerKey(args.ownerKey);
    return await ctx.runQuery(suggestRandomPlannerTaskCandidateRef, args);
  },
});

export const suggestNextPlannerTask = action({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    excludeNodeIds: v.optional(v.array(v.id("nodes"))),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    plannerNodeId: Id<"nodes">;
    text: string;
    dueAt: number | null;
    dueEndAt: number | null;
    sectionTitle: string;
  }> => {
    assertOwnerKey(args.ownerKey);

    const plannerContext = (await ctx.runQuery(getPlannerPageContextRef, {
      pageId: args.pageId,
    })) as
      | {
          page: Doc<"pages">;
          nodes: Doc<"nodes">[];
          plannerSidebarSection: Doc<"nodes"> | null;
          plannerDays: Doc<"nodes">[];
        }
      | null;

    if (!plannerContext) {
      throw new Error("Planner page context could not be loaded.");
    }

    const topDay = getPlannerDayRoots(plannerContext.nodes)[0] ?? null;
    if (!topDay) {
      throw new Error("Add the first planner day before choosing the next task.");
    }

    const nodeMap = buildPlannerNodeMap(plannerContext.nodes);
    const candidateNodes = plannerContext.nodes
      .filter((node) => !node.archived)
      .filter((node) => node.kind === "task")
      .filter((node) => node.taskStatus !== "done" && node.taskStatus !== "cancelled")
      .filter((node) => node.text.trim() !== "__small__")
      .filter((node) => !(args.excludeNodeIds ?? []).includes(node._id))
      .filter(
        (node) =>
          isNodeWithinRootSubtree(node, topDay._id, nodeMap) ||
          (plannerContext.plannerSidebarSection
            ? isNodeWithinRootSubtree(node, plannerContext.plannerSidebarSection._id, nodeMap)
            : false),
      )
      .map((node) => {
        const effectiveDue = getEffectiveTaskDueDateRange(node, nodeMap);
        const sectionTitle = plannerContext.plannerSidebarSection &&
          isNodeWithinRootSubtree(node, plannerContext.plannerSidebarSection._id, nodeMap)
          ? "Sidebar"
          : topDay.text;
        return {
          ...node,
          dueAt: effectiveDue.dueAt,
          dueEndAt: effectiveDue.dueEndAt ?? null,
          sectionTitle,
        };
      });

    if (candidateNodes.length === 0) {
      throw new Error("No open tasks are in today's plan or the planner sidebar.");
    }

    let chosenNode = [...candidateNodes].sort((left, right) =>
      comparePlannerTaskOrder(left, right),
    )[0]!;

    const client = getOpenAIClient();
    if (client && candidateNodes.length > 1) {
      try {
        const response = await withTimeout(
          client.responses.parse({
            model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
            input: [
              {
                role: "system",
                content:
                  "You are selecting the single best next task to focus on in a personal daily planner. Choose exactly one candidate id. Prefer overdue or due-today items, concrete next actions, blocking work, and tasks that seem most urgent or important. If uncertain, prefer the task that should happen soonest.",
              },
              {
                role: "user",
                content: [
                  `Planner page: ${plannerContext.page.title}`,
                  `Today section: ${topDay.text}`,
                  "",
                  "Candidate tasks:",
                  candidateNodes
                    .map((node) => {
                      const priority = node.priority ?? "none";
                      const dueValue =
                        node.dueAt && node.dueEndAt
                          ? `${node.dueAt} -> ${node.dueEndAt}`
                          : node.dueAt
                            ? `${node.dueAt}`
                            : "none";
                      return `- ${node._id}: ${node.text} [section=${node.sectionTitle}; due=${dueValue}; priority=${priority}]`;
                    })
                    .join("\n"),
                ].join("\n"),
              },
            ],
            text: {
              format: zodTextFormat(plannerTaskChoiceSchema, "planner_task_choice"),
            },
          }),
          OPENAI_PLANNER_TIMEOUT_MS,
        );

        const parsed = response.output_parsed;
        const candidateMap = new Map(candidateNodes.map((node) => [node._id as string, node]));
        if (parsed?.nodeId && candidateMap.has(parsed.nodeId)) {
          chosenNode = candidateMap.get(parsed.nodeId)!;
        }
      } catch {
        // Fall back to the deterministic ranking if AI selection fails.
      }
    }

    return {
      plannerNodeId: chosenNode._id,
      text:
        ((await ctx.runQuery(resolvePlannerSuggestionNodeTextRef, {
          nodeId: chosenNode._id,
        })) as string | null) ?? chosenNode.text,
      dueAt: chosenNode.dueAt,
      dueEndAt: chosenNode.dueEndAt ?? null,
      sectionTitle: chosenNode.sectionTitle,
    };
  },
});

export const addRandomPlannerTaskWithAi = action({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    seed: v.number(),
    sourceTaskId: v.optional(v.id("nodes")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    plannerNodeId: Id<"nodes">;
    text: string;
    dueAt: number | null;
    dueEndAt: number | null;
    sourcePageId: Id<"pages"> | null;
    sourcePageTitle: string | null;
    linkedSourceTaskId: Id<"nodes"> | null;
    created: boolean;
  }> => {
    assertOwnerKey(args.ownerKey);

    const inserted = (await ctx.runMutation(
      args.sourceTaskId ? api.planner.addPlannerSourceTask : api.planner.addRandomPlannerTask,
      args.sourceTaskId
        ? {
            ownerKey: args.ownerKey,
            pageId: args.pageId,
            sourceTaskId: args.sourceTaskId,
          }
        : {
            ownerKey: args.ownerKey,
            pageId: args.pageId,
            seed: args.seed,
          },
    )) as {
      plannerNodeId: Id<"nodes">;
      text: string;
      dueAt: number | null;
      dueEndAt: number | null;
      sourcePageId: Id<"pages"> | null;
      sourcePageTitle: string | null;
      linkedSourceTaskId: Id<"nodes"> | null;
      created: boolean;
      dayNodeId: Id<"nodes">;
    };

    const plannerContext = (await ctx.runQuery(getPlannerPageContextRef, {
      pageId: args.pageId,
    })) as
      | {
          page: Doc<"pages">;
          nodes: Doc<"nodes">[];
        }
      | null;

    if (!plannerContext) {
      return inserted;
    }

    const dayNode = plannerContext.nodes.find((node) => node._id === inserted.dayNodeId) ?? null;
    if (!dayNode) {
      return inserted;
    }

    const dayChildren = plannerContext.nodes
      .filter((node) => node.parentNodeId === dayNode._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    if (dayChildren.length <= 1) {
      return inserted;
    }

    let orderedNodeIds: Id<"nodes">[] | undefined;
    const client = getOpenAIClient();
    if (client) {
      try {
        const response = await withTimeout(
          client.responses.parse({
            model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
            input: [
              {
                role: "system",
                content:
                  "You are arranging a single day's planner outline. Return a single ordered list of the provided root node ids. Keep every id exactly once, do not invent ids, and place the newly inserted task where it fits best among routines, sections, and related work. If uncertain, preserve the current order.",
              },
              {
                role: "user",
                content: [
                  `Planner page: ${plannerContext.page.title}`,
                  `Planner day: ${dayNode.text}`,
                  `Newly inserted task id: ${inserted.plannerNodeId}`,
                  "",
                  "Current day root items:",
                  dayChildren
                    .map(
                      (node) =>
                        `- ${node._id}: ${node.text} [${node.kind}/${node.taskStatus ?? "n/a"}]`,
                    )
                    .join("\n"),
                ].join("\n"),
              },
            ],
            text: {
              format: zodTextFormat(
                plannerDayRollforwardPlanSchema,
                "planner_day_insert_plan",
              ),
            },
          }),
          OPENAI_PLANNER_TIMEOUT_MS,
        );

        const parsed = response.output_parsed;
        const candidateIds = new Set(dayChildren.map((node) => node._id as string));
        if (
          parsed &&
          parsed.orderedNodeIds.length === candidateIds.size &&
          parsed.orderedNodeIds.every((nodeId) => candidateIds.has(nodeId))
        ) {
          orderedNodeIds = parsed.orderedNodeIds as Id<"nodes">[];
        }
      } catch {
        orderedNodeIds = undefined;
      }
    }

    if (orderedNodeIds) {
      await ctx.runMutation(api.planner.reorderPlannerDay, {
        ownerKey: args.ownerKey,
        pageId: args.pageId,
        dayNodeId: inserted.dayNodeId,
        orderedNodeIds,
      });
    }

    return inserted;
  },
});
