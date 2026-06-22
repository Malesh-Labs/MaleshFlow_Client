"use node";

import { createHash } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  normalizeGeneratedPlannerSymbols,
  PLANNER_EMOJI_CACHE_STYLE,
} from "../lib/domain/plannerSymbols";

const OPENAI_PLANNER_SYMBOL_TIMEOUT_MS = 9000;
const PLANNER_SYMBOL_BATCH_SIZE = 24;
const PLANNER_SYMBOL_MODEL = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";

const plannerSymbolOutputSchema = z.object({
  labels: z
    .array(
      z.object({
        nodeId: z.string(),
        symbols: z.string(),
      }),
    )
    .max(PLANNER_SYMBOL_BATCH_SIZE),
});

const getPlannerSymbolGenerationContextRef = internal.plannerSymbols
  .getPlannerSymbolGenerationContext;
const getPlannerSymbolLabelsByContentHashRef = internal.plannerSymbols
  .getPlannerSymbolLabelsByContentHash;
const savePlannerSymbolLabelsRef = internal.plannerSymbols.savePlannerSymbolLabels;

type PlannerSymbolGenerationNode = {
  nodeId: Id<"nodes">;
  sourceText: string;
  cachedSymbols: string | null;
};

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
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

function buildPlannerSymbolContentHash(sourceText: string) {
  return createHash("sha256")
    .update(`${PLANNER_EMOJI_CACHE_STYLE}\n${sourceText}`)
    .digest("hex");
}

async function generateBatchWithOpenAI(
  client: OpenAI,
  nodes: Array<PlannerSymbolGenerationNode & { contentHash: string }>,
) {
  const response = await withTimeout(
    client.responses.parse({
      model: PLANNER_SYMBOL_MODEL,
      input: [
        {
          role: "system",
          content:
            "You convert personal planner items into tiny visual labels. For each item, return 1 to 3 emoji characters that make the item recognizable. Use emoji only. Do not return symbolic glyphs, words, letters, numbers, punctuation-separated descriptions, markdown, or explanations. Prefer concrete memorable emoji over generic marks.",
        },
        {
          role: "user",
          content: [
            "Return a label for every item id exactly once.",
            "Items:",
            nodes.map((node) => `- ${node.nodeId}: ${node.sourceText}`).join("\n"),
          ].join("\n"),
        },
      ],
      text: {
        format: zodTextFormat(plannerSymbolOutputSchema, "planner_symbol_labels"),
      },
    }),
    OPENAI_PLANNER_SYMBOL_TIMEOUT_MS,
  );

  const parsed = response.output_parsed;
  const labelsByNodeId = new Map<string, string>();
  const expectedNodeIds = new Set(nodes.map((node) => node.nodeId as string));
  for (const label of parsed?.labels ?? []) {
    if (!expectedNodeIds.has(label.nodeId)) {
      continue;
    }

    const normalized = normalizeGeneratedPlannerSymbols(label.symbols);
    if (normalized) {
      labelsByNodeId.set(label.nodeId, normalized);
    }
  }

  const missingCount = nodes.filter((node) => !labelsByNodeId.has(node.nodeId)).length;
  if (missingCount > 0) {
    throw new Error(
      `OpenAI returned missing or invalid emoji labels for ${missingCount} planner item${missingCount === 1 ? "" : "s"}.`,
    );
  }

  return labelsByNodeId;
}

export const generatePlannerSymbolLabels = action({
  args: {
    ownerKey: v.string(),
    plannerPageId: v.id("pages"),
    nodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    const context = (await ctx.runQuery(getPlannerSymbolGenerationContextRef, {
      plannerPageId: args.plannerPageId,
      nodeIds: args.nodeIds,
    })) as { nodes: PlannerSymbolGenerationNode[] };

    const nodesWithHashes = context.nodes.map((node) => ({
      ...node,
      contentHash: buildPlannerSymbolContentHash(node.sourceText),
    }));
    if (nodesWithHashes.length === 0) {
      return {
        labels: [],
        generatedCount: 0,
        reusedCount: 0,
      };
    }

    const cachedByHashEntries = (await ctx.runQuery(
      getPlannerSymbolLabelsByContentHashRef,
      {
        contentHashes: nodesWithHashes.map((node) => node.contentHash),
      },
    )) as Array<{ contentHash: string; symbols: string }>;
    const cachedByHash = new Map(
      cachedByHashEntries.map((entry) => [entry.contentHash, entry.symbols]),
    );
    const labels = new Map<string, string>();
    let reusedCount = 0;

    for (const node of nodesWithHashes) {
      const cachedSymbols = node.cachedSymbols ?? cachedByHash.get(node.contentHash) ?? null;
      if (cachedSymbols) {
        labels.set(node.nodeId, cachedSymbols);
        reusedCount += 1;
      }
    }

    const nodesToGenerate = nodesWithHashes.filter((node) => !labels.has(node.nodeId));
    const client = getOpenAIClient();
    if (nodesToGenerate.length > 0) {
      if (!client) {
        throw new Error("OpenAI emoji generation failed: OPENAI_API_KEY is not configured.");
      }

      for (let index = 0; index < nodesToGenerate.length; index += PLANNER_SYMBOL_BATCH_SIZE) {
        const batch = nodesToGenerate.slice(index, index + PLANNER_SYMBOL_BATCH_SIZE);
        let generated: Map<string, string>;
        try {
          generated = await generateBatchWithOpenAI(client, batch);
        } catch (error) {
          throw new Error(`OpenAI emoji generation failed: ${getErrorMessage(error)}`);
        }

        for (const node of batch) {
          labels.set(node.nodeId, generated.get(node.nodeId)!);
        }
      }
    }

    const labelsToSave = nodesWithHashes
      .map((node) => {
        const symbols = labels.get(node.nodeId);
        return symbols
          ? {
              nodeId: node.nodeId,
              contentHash: node.contentHash,
              sourceText: node.sourceText,
              symbols,
              style: PLANNER_EMOJI_CACHE_STYLE,
              model: PLANNER_SYMBOL_MODEL,
            }
          : null;
      })
      .filter((label): label is NonNullable<typeof label> => label !== null);

    if (labelsToSave.length > 0) {
      await ctx.runMutation(savePlannerSymbolLabelsRef, {
        labels: labelsToSave,
      });
    }

    return {
      labels: labelsToSave.map((label) => ({
        nodeId: label.nodeId,
        symbols: label.symbols,
      })),
      generatedCount: nodesToGenerate.length,
      reusedCount,
    };
  },
});
