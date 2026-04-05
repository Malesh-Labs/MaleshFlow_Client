import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKey } from "./lib/auth";
import { listPageNodes } from "./lib/workspace";
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
import { getEffectiveTaskDueDateRange } from "../lib/domain/planner";
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

function buildPageNodeMap(nodes: Doc<"nodes">[]) {
  return new Map(nodes.map((node) => [node._id as string, node]));
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

    const tasksByPageId = new Map<string, Doc<"nodes">[]>();
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

      const pageTasks = tasksByPageId.get(task.pageId as string);
      if (pageTasks) {
        pageTasks.push(task);
      } else {
        tasksByPageId.set(task.pageId as string, [task]);
      }
    }

    const pageIds = [...tasksByPageId.keys()] as Id<"pages">[];
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

      const pageTasks = tasksByPageId.get(pageId as string) ?? [];
      const shouldLoadPageNodes = pageTasks.some((task) => !task.dueAt);
      const pageNodeMap = shouldLoadPageNodes
        ? buildPageNodeMap(await listPageNodes(ctx.db, pageId))
        : new Map(pageTasks.map((task) => [task._id as string, task]));

      for (const task of pageTasks) {
        const effectiveDueRange = task.dueAt
          ? {
              dueAt: task.dueAt,
              dueEndAt: task.dueEndAt ?? null,
            }
          : getEffectiveTaskDueDateRange(task, pageNodeMap);
        if (!effectiveDueRange.dueAt) {
          continue;
        }

        const summary = await resolveCalendarTaskSummary(ctx.db, task.text);
        const tags = extractCalendarTaskCategories(task.text);
        events.push({
          uid: `${task._id}@maleshflow.tasks`,
          summary,
          description: buildCalendarTaskDescription({
            pageTitle: page.title,
            tags,
          }),
          dueAt: effectiveDueRange.dueAt,
          dueEndAt: effectiveDueRange.dueEndAt ?? null,
          updatedAt: task.updatedAt,
          categories: tags,
        });
      }
    }

    return {
      calendarName: "MaleshFlow Tasks",
      calendarDescription:
        "Incomplete MaleshFlow tasks with due dates. Subscribe in Google Calendar using this URL.",
      events,
    };
  },
});
