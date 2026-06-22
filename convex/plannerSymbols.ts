import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type DatabaseReader,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import { isPlannerPage } from "./lib/planner";
import {
  isPlannerSymbolizableText,
  normalizePlannerSymbolSourceText,
  parsePurePlannerNodeReference,
} from "../lib/domain/plannerSymbols";

const MAX_PLANNER_SYMBOL_NODE_COUNT = 160;

type PlannerSymbolSource = {
  nodeId: Id<"nodes">;
  sourceText: string;
};

async function requirePlannerPage(db: DatabaseReader, pageId: Id<"pages">) {
  const page = await db.get(pageId);
  if (!page || !isPlannerPage(page)) {
    throw new Error("Planner page not found.");
  }
  return page;
}

async function resolvePlannerSymbolSourceText(db: DatabaseReader, node: Doc<"nodes">) {
  const pureReference = parsePurePlannerNodeReference(node.text);
  if (pureReference?.explicitLabel) {
    return normalizePlannerSymbolSourceText(pureReference.explicitLabel);
  }

  if (pureReference?.nodeId) {
    const targetNode = await db.get(pureReference.nodeId as Id<"nodes">);
    if (targetNode?.text) {
      const resolvedText = normalizePlannerSymbolSourceText(targetNode.text);
      if (resolvedText) {
        return resolvedText;
      }
    }
  }

  return normalizePlannerSymbolSourceText(node.text);
}

async function getPlannerSymbolSources(
  db: DatabaseReader,
  nodeIds: Id<"nodes">[],
): Promise<PlannerSymbolSource[]> {
  const uniqueNodeIds = [...new Set(nodeIds)].slice(0, MAX_PLANNER_SYMBOL_NODE_COUNT);
  const nodes = await Promise.all(uniqueNodeIds.map((nodeId) => db.get(nodeId)));
  const sources = await Promise.all(
    nodes
      .filter((node): node is Doc<"nodes"> => node !== null && !node.archived)
      .map(async (node) => ({
        nodeId: node._id,
        sourceText: await resolvePlannerSymbolSourceText(db, node),
      })),
  );

  return sources.filter((source) => isPlannerSymbolizableText(source.sourceText));
}

async function getMatchingNodeCache(db: DatabaseReader, source: PlannerSymbolSource) {
  const caches = await db
    .query("nodeSymbolCaches")
    .withIndex("by_node", (index) => index.eq("nodeId", source.nodeId))
    .collect();
  return caches.find((cache) => cache.sourceText === source.sourceText) ?? null;
}

export const getPlannerSymbolLabels = query({
  args: {
    ownerKey: v.string(),
    plannerPageId: v.id("pages"),
    nodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);
    await requirePlannerPage(ctx.db, args.plannerPageId);

    const sources = await getPlannerSymbolSources(ctx.db, args.nodeIds);
    const labelEntries = await Promise.all(
      sources.map(async (source) => ({
        source,
        cache: await getMatchingNodeCache(ctx.db, source),
      })),
    );

    return {
      labels: labelEntries
        .filter((entry) => entry.cache !== null)
        .map((entry) => ({
          nodeId: entry.source.nodeId,
          sourceText: entry.source.sourceText,
          symbols: entry.cache!.symbols,
        })),
      missing: labelEntries
        .filter((entry) => entry.cache === null)
        .map((entry) => ({
          nodeId: entry.source.nodeId,
          sourceText: entry.source.sourceText,
        })),
    };
  },
});

export const getPlannerSymbolGenerationContext = internalQuery({
  args: {
    plannerPageId: v.id("pages"),
    nodeIds: v.array(v.id("nodes")),
  },
  handler: async (ctx, args) => {
    await requirePlannerPage(ctx.db, args.plannerPageId);
    const sources = await getPlannerSymbolSources(ctx.db, args.nodeIds);
    const entries = await Promise.all(
      sources.map(async (source) => ({
        ...source,
        cachedSymbols: (await getMatchingNodeCache(ctx.db, source))?.symbols ?? null,
      })),
    );

    return {
      nodes: entries,
    };
  },
});

export const getPlannerSymbolLabelsByContentHash = internalQuery({
  args: {
    contentHashes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const uniqueHashes = [...new Set(args.contentHashes)];
    const entries = await Promise.all(
      uniqueHashes.map(async (contentHash) => ({
        contentHash,
        cache: await ctx.db
          .query("nodeSymbolCaches")
          .withIndex("by_content_hash", (index) => index.eq("contentHash", contentHash))
          .first(),
      })),
    );

    return entries
      .filter((entry) => entry.cache !== null)
      .map((entry) => ({
        contentHash: entry.contentHash,
        symbols: entry.cache!.symbols,
      }));
  },
});

export const savePlannerSymbolLabels = internalMutation({
  args: {
    labels: v.array(
      v.object({
        nodeId: v.id("nodes"),
        contentHash: v.string(),
        sourceText: v.string(),
        symbols: v.string(),
        model: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const label of args.labels) {
      const existing = await ctx.db
        .query("nodeSymbolCaches")
        .withIndex("by_node", (index) => index.eq("nodeId", label.nodeId))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          contentHash: label.contentHash,
          sourceText: label.sourceText,
          symbols: label.symbols,
          model: label.model,
          updatedAt: now,
        });
        continue;
      }

      await ctx.db.insert("nodeSymbolCaches", {
        nodeId: label.nodeId,
        contentHash: label.contentHash,
        sourceText: label.sourceText,
        symbols: label.symbols,
        model: label.model,
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});
