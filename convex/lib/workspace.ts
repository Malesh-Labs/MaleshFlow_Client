import slugify from "slugify";
import { internal } from "../_generated/api";
import type { DatabaseReader, DatabaseWriter, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { extractLinks } from "../../lib/domain/links";
import {
  buildRenormalizedPositions,
  getAppendPosition,
  getPositionBetween,
  needsSiblingRenormalization,
} from "../../lib/domain/positions";

export async function getPageBySlug(
  db: DatabaseReader,
  slug: string,
  excludePageId?: Id<"pages">,
) {
  const matches = await db
    .query("pages")
    .withIndex("by_slug", (query) => query.eq("slug", slug))
    .collect();

  return matches.find((page) => page._id !== excludePageId) ?? null;
}

export async function buildUniquePageSlug(
  db: DatabaseReader,
  title: string,
  excludePageId?: Id<"pages">,
) {
  const baseSlug = slugify(title, { lower: true, strict: true }) || "untitled";
  let candidate = baseSlug;
  let index = 1;

  while (await getPageBySlug(db, candidate, excludePageId)) {
    index += 1;
    candidate = `${baseSlug}-${index}`;
  }

  return candidate;
}

export async function listSiblingNodes(
  db: DatabaseReader,
  pageId: Id<"pages">,
  parentNodeId: Id<"nodes"> | null,
) {
  return await db
    .query("nodes")
    .withIndex("by_page_parent_position", (query) =>
      query.eq("pageId", pageId).eq("parentNodeId", parentNodeId),
    )
    .collect();
}

export async function listPageNodes(db: DatabaseReader, pageId: Id<"pages">) {
  return await db
    .query("nodes")
    .withIndex("by_page_archived", (query) =>
      query.eq("pageId", pageId).eq("archived", false),
    )
    .collect();
}

export async function renormalizeSiblingPositions(
  db: DatabaseWriter,
  pageId: Id<"pages">,
  parentNodeId: Id<"nodes"> | null,
) {
  const siblings = await listSiblingNodes(db, pageId, parentNodeId);
  const normalized = buildRenormalizedPositions(siblings.map((sibling) => sibling._id));

  for (const entry of normalized) {
    await db.patch(entry.id as Id<"nodes">, { position: entry.position });
  }

  return await listSiblingNodes(db, pageId, parentNodeId);
}

export async function computeNodePosition(
  db: DatabaseWriter,
  pageId: Id<"pages">,
  parentNodeId: Id<"nodes"> | null,
  afterNodeId?: Id<"nodes"> | null,
) {
  let siblings = await listSiblingNodes(db, pageId, parentNodeId);

  if (afterNodeId === undefined) {
    return getAppendPosition(siblings[siblings.length - 1]?.position ?? null);
  }

  if (afterNodeId === null) {
    const firstSibling = siblings.sort((left, right) => left.position - right.position)[0];
    return getPositionBetween(null, firstSibling?.position ?? null);
  }

  const sorted = [...siblings].sort((left, right) => left.position - right.position);
  const afterIndex = sorted.findIndex((sibling) => sibling._id === afterNodeId);
  if (afterIndex === -1) {
    return getAppendPosition(sorted[sorted.length - 1]?.position ?? null);
  }

  const before = sorted[afterIndex]?.position ?? null;
  const after = sorted[afterIndex + 1]?.position ?? null;

  if (needsSiblingRenormalization(before, after)) {
    siblings = await renormalizeSiblingPositions(db, pageId, parentNodeId);
    const normalized = [...siblings].sort((left, right) => left.position - right.position);
    const normalizedAfterIndex = normalized.findIndex(
      (sibling) => sibling._id === afterNodeId,
    );

    return getPositionBetween(
      normalized[normalizedAfterIndex]?.position ?? null,
      normalized[normalizedAfterIndex + 1]?.position ?? null,
    );
  }

  return getPositionBetween(before, after);
}

export async function syncLinksForNode(
  db: DatabaseWriter,
  node: Doc<"nodes">,
) {
  const existingLinks = await db
    .query("links")
    .withIndex("by_source_node", (query) => query.eq("sourceNodeId", node._id))
    .collect();

  for (const link of existingLinks) {
    await db.delete(link._id);
  }

  const links = extractLinks(node.text);
  const timestamp = Date.now();

  for (const link of links) {
    if (link.kind === "page") {
      const slug = slugify(link.targetPageTitle, { lower: true, strict: true }) || "untitled";
      const targetPage = await getPageBySlug(db, slug);
      await db.insert("links", {
        sourcePageId: node.pageId,
        sourceNodeId: node._id,
        targetPageId: targetPage?._id ?? null,
        targetNodeId: null,
        targetPageTitle: link.targetPageTitle,
        targetNodeRef: null,
        label: link.label,
        kind: "page",
        resolved: Boolean(targetPage),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      continue;
    }

    const targetNode =
      link.targetNodeRef === node._id
        ? node
        : await db
            .query("nodes")
            .filter((query) => query.eq(query.field("_id"), link.targetNodeRef))
            .first();

    await db.insert("links", {
      sourcePageId: node.pageId,
      sourceNodeId: node._id,
      targetPageId: targetNode?.pageId ?? null,
      targetNodeId: targetNode?._id ?? null,
      targetPageTitle: null,
      targetNodeRef: link.targetNodeRef,
      label: link.label,
      kind: "node",
      resolved: Boolean(targetNode),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

export async function enqueueNodeAiWork(
  ctx: MutationCtx,
  nodeId: Id<"nodes">,
) {
  await ctx.scheduler.runAfter(0, internal.ai.extractTaskMetadata, { nodeId });
  await ctx.scheduler.runAfter(0, internal.ai.generateEmbeddingForNode, { nodeId });
}

export async function enqueueNodeEmbeddingRefresh(
  ctx: MutationCtx,
  nodeId: Id<"nodes">,
) {
  await ctx.scheduler.runAfter(0, internal.ai.generateEmbeddingForNode, { nodeId });
}

export async function deleteNodeTree(
  db: DatabaseWriter,
  nodeId: Id<"nodes">,
) {
  const descendants = await collectNodeTree(db, nodeId);
  const idsToDelete = descendants.map((node) => node._id);

  for (const id of idsToDelete) {
    const outboundLinks = await db
      .query("links")
      .withIndex("by_source_node", (query) => query.eq("sourceNodeId", id))
      .collect();
    const inboundLinks = await db
      .query("links")
      .withIndex("by_target_node", (query) => query.eq("targetNodeId", id))
      .collect();
    const embeddingJobs = await db
      .query("embeddingJobs")
      .withIndex("by_node", (query) => query.eq("nodeId", id))
      .collect();
    const embeddings = await db
      .query("nodeEmbeddings")
      .withIndex("by_node", (query) => query.eq("nodeId", id))
      .collect();

    for (const link of [...outboundLinks, ...inboundLinks]) {
      await db.delete(link._id);
    }

    for (const job of embeddingJobs) {
      await db.delete(job._id);
    }

    for (const embedding of embeddings) {
      await db.delete(embedding._id);
    }
  }

  for (const node of idsToDelete.reverse()) {
    await db.delete(node);
  }
}

export async function setNodeTreeArchivedState(
  db: DatabaseWriter,
  nodeId: Id<"nodes">,
  archived: boolean,
  updatedAt = Date.now(),
) {
  const descendants = await collectNodeTree(db, nodeId);

  for (const node of descendants) {
    await db.patch(node._id, {
      archived,
      updatedAt,
    });
  }

  return descendants;
}

export async function collectNodeTree(
  db: DatabaseReader,
  rootNodeId: Id<"nodes">,
): Promise<Array<Doc<"nodes">>> {
  const root = await db.get(rootNodeId);
  if (!root) {
    return [];
  }

  const collected: Array<Doc<"nodes">> = [];
  const queue: Array<Doc<"nodes">> = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    collected.push(node);

    const children = await db
      .query("nodes")
      .withIndex("by_page_parent_position", (query) =>
        query.eq("pageId", node.pageId).eq("parentNodeId", node._id),
      )
      .collect();

    queue.push(...children);
  }

  return collected;
}
