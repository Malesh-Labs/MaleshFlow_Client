import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import {
  isPlannerDerivedSourceTask,
  isPlannerPage,
  isPlannerPlaceholderTaskText,
} from "./lib/planner";
import {
  extractCalendarTaskCategories,
  normalizeCalendarTaskText,
  type TaskCalendarFeed,
  type TaskCalendarFeedEvent,
} from "../lib/domain/calendar";
import { extractLinks } from "../lib/domain/links";

const TASK_CALENDAR_FEED_KIND = "task_ics";

function getTimestamp() {
  return Date.now();
}

function generateCalendarFeedToken() {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function getTaskCalendarFeedUrl(token: string) {
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!siteUrl) {
    throw new Error("CONVEX_SITE_URL is not configured for HTTP actions.");
  }

  const url = new URL("/task-calendar.ics", siteUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

async function resolveCalendarTaskSummary(
  db: {
    get: (id: Id<"nodes">) => Promise<Doc<"nodes"> | null>;
  },
  text: string,
) {
  const normalized = normalizeCalendarTaskText(text);
  if (normalized.length > 0) {
    return normalized;
  }

  const links = extractLinks(text.trim());
  if (links.length !== 1 || links[0]?.kind !== "node" || !links[0].targetNodeRef) {
    return "Untitled Task";
  }

  const referencedNode = await db.get(links[0].targetNodeRef as Id<"nodes">);
  if (!referencedNode) {
    return "Untitled Task";
  }

  return normalizeCalendarTaskText(referencedNode.text) || "Untitled Task";
}

function buildCalendarTaskDescription(args: {
  pageTitle: string;
  tags: string[];
}) {
  const lines = [`Page: ${args.pageTitle}`];
  if (args.tags.length > 0) {
    lines.push(`Tags: ${args.tags.map((tag) => `#${tag}`).join(" ")}`);
  }
  return lines.join("\n");
}

function isCalendarNoteCompleted(node: Pick<Doc<"nodes">, "sourceMeta">) {
  return (
    node.sourceMeta &&
    typeof node.sourceMeta === "object" &&
    (node.sourceMeta as Record<string, unknown>).noteCompleted === true
  );
}

export const ensureTaskCalendarFeed = mutation({
  args: {
    ownerKey: v.string(),
  },
  handler: async (ctx, args) => {
    assertOwnerKey(args.ownerKey);

    const now = getTimestamp();
    const existingFeed = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_kind", (query) => query.eq("kind", TASK_CALENDAR_FEED_KIND))
      .unique();

    const token = existingFeed?.token ?? generateCalendarFeedToken();
    if (!existingFeed) {
      await ctx.db.insert("calendarFeeds", {
        kind: TASK_CALENDAR_FEED_KIND,
        token,
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      url: getTaskCalendarFeedUrl(token),
      created: existingFeed === null,
    };
  },
});

export const getTaskCalendarFeedByToken = internalQuery({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args): Promise<TaskCalendarFeed | null> => {
    const feed = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_token", (query) => query.eq("token", args.token))
      .unique();
    if (!feed || feed.kind !== TASK_CALENDAR_FEED_KIND) {
      return null;
    }

    const datedNodesByPageId = new Map<string, Doc<"nodes">[]>();
    for await (const task of ctx.db
      .query("nodes")
      .withIndex("by_kind_status", (query) => query.eq("kind", "task"))) {
      if (
        task.archived ||
        task.taskStatus === "done" ||
        task.taskStatus === "cancelled" ||
        isPlannerPlaceholderTaskText(task.text) ||
        isPlannerDerivedSourceTask(task)
      ) {
        continue;
      }

      const pageNodes = datedNodesByPageId.get(task.pageId as string);
      if (pageNodes) {
        pageNodes.push(task);
      } else {
        datedNodesByPageId.set(task.pageId as string, [task]);
      }
    }

    for await (const note of ctx.db
      .query("nodes")
      .withIndex("by_kind_status", (query) =>
        query.eq("kind", "note").eq("taskStatus", null).eq("archived", false),
      )) {
      if (
        !note.dueAt ||
        isCalendarNoteCompleted(note)
      ) {
        continue;
      }

      const pageNodes = datedNodesByPageId.get(note.pageId as string);
      if (pageNodes) {
        pageNodes.push(note);
      } else {
        datedNodesByPageId.set(note.pageId as string, [note]);
      }
    }

    const pageIds = [...datedNodesByPageId.keys()] as Id<"pages">[];
    const pages = await Promise.all(pageIds.map((pageId) => ctx.db.get(pageId)));
    const pageMap = new Map(
      pages
        .filter((page): page is Doc<"pages"> => page !== null)
        .map((page) => [page._id as string, page]),
    );

    const events: TaskCalendarFeedEvent[] = [];
    for (const pageId of pageIds) {
      const page = pageMap.get(pageId as string);
      if (!page || page.archived || isPlannerPage(page)) {
        continue;
      }

      const pageNodes = datedNodesByPageId.get(pageId as string) ?? [];
      for (const node of pageNodes) {
        if (!node.dueAt) {
          continue;
        }

        const summary = await resolveCalendarTaskSummary(ctx.db, node.text);
        const tags = extractCalendarTaskCategories(node.text);
        events.push({
          uid: `${node._id}@maleshflow.tasks`,
          summary,
          description: buildCalendarTaskDescription({
            pageTitle: page.title,
            tags,
          }),
          dueAt: node.dueAt,
          dueEndAt: node.dueEndAt ?? null,
          updatedAt: node.updatedAt,
          categories: tags,
        });
      }
    }

    return {
      calendarName: "MaleshFlow Tasks",
      calendarDescription:
        "Incomplete MaleshFlow tasks and dated notes. Subscribe in Google Calendar using this URL.",
      events,
    };
  },
});
