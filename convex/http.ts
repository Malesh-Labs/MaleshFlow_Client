import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildTaskCalendarIcs, type TaskCalendarFeed } from "../lib/domain/calendar";

const http = httpRouter();

http.route({
  path: "/task-calendar.ics",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const token = url.searchParams.get("token")?.trim() ?? "";
    if (token.length === 0) {
      return new Response("Missing task calendar token.", {
        status: 400,
      });
    }

    const feed: TaskCalendarFeed | null = await ctx.runQuery(
      internal.calendar.getTaskCalendarFeedByToken,
      { token },
    );
    if (!feed) {
      return new Response("Task calendar feed not found.", {
        status: 404,
      });
    }

    return new Response(buildTaskCalendarIcs(feed), {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="maleshflow-tasks.ics"',
        "Cache-Control": "no-store",
      },
    });
  }),
});

export default http;
