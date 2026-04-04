"use node";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  getPlannerDayTimestamp,
  getPlannerLinkedSourceTaskId,
  getPlannerDayRoots,
} from "./lib/planner";
import { plannerDayRollforwardPlanSchema } from "../lib/domain/planner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getPlannerPageContextRef = internal.workspace.getPlannerPageContext as any;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
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
    nextDayNodeId: Id<"nodes">;
    movedCount: number;
    archivedDuplicateCount: number;
    createdNextDay: boolean;
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
    const nextDay = plannerDays[1] ?? null;

    if (!topDay) {
      throw new Error("Add a planner day before completing one.");
    }

    if (!nextDay) {
      return await ctx.runMutation(api.planner.completePlannerDay, {
        ownerKey: args.ownerKey,
        pageId: args.pageId,
      });
    }

    const topDayChildren = plannerContext.nodes
      .filter((node) => node.parentNodeId === topDay._id && !node.archived)
      .sort((left, right) => left.position - right.position);
    const nextDayChildren = plannerContext.nodes
      .filter((node) => node.parentNodeId === nextDay._id && !node.archived)
      .sort((left, right) => left.position - right.position);

    const existingNextDaySourceIds = new Set(
      nextDayChildren
        .map((node) => getPlannerLinkedSourceTaskId(node))
        .filter((value): value is Id<"nodes"> => value !== null)
        .map((value) => value as string),
    );
    const carryChildren = topDayChildren.filter((node) => {
      const linkedSourceTaskId = getPlannerLinkedSourceTaskId(node);
      return !linkedSourceTaskId || !existingNextDaySourceIds.has(linkedSourceTaskId as string);
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
                "You are arranging a daily planner outline. Return a single ordered list of node ids representing the best combined order for the next day. Keep all existing next-day node ids and all carried node ids exactly once each. Do not invent ids, omit ids, or duplicate ids. Prefer placing carried items near similar tasks, routines, or sections. If uncertain, preserve the existing next-day order and append carried items in a sensible order near related items.",
            },
            {
              role: "user",
              content: [
                `Planner page: ${plannerContext.page.title}`,
                `Top day being completed: ${topDay.text}`,
                `Top day date: ${getPlannerDayTimestamp(topDay) ?? "(unknown)"}`,
                `Next day receiving items: ${nextDay.text}`,
                `Next day date: ${getPlannerDayTimestamp(nextDay) ?? "(unknown)"}`,
                "",
                "Existing next-day root items:",
                nextDayChildren
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
          [...nextDayChildren, ...carryChildren].map((node) => node._id as string),
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
