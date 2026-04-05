import { extractTags } from "./tags";
import { replaceLinkMarkupWithLabels } from "./links";
import { timestampToDateInputValue } from "./recurrence";

export type TaskCalendarFeedEvent = {
  uid: string;
  summary: string;
  description?: string;
  dueAt: number;
  dueEndAt?: number | null;
  updatedAt: number;
  categories?: string[];
};

export type TaskCalendarFeed = {
  calendarName: string;
  calendarDescription?: string;
  events: TaskCalendarFeedEvent[];
};

function escapeIcsText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldIcsLine(line: string) {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const limit = cursor === 0 ? 75 : 74;
    const slice = line.slice(cursor, cursor + limit);
    chunks.push(cursor === 0 ? slice : ` ${slice}`);
    cursor += limit;
  }

  return chunks;
}

function formatUtcIcsTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");
  const seconds = `${date.getUTCSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function addLocalDays(timestamp: number, dayCount: number) {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayCount,
    12,
    0,
    0,
    0,
  ).getTime();
}

function formatIcsDateValue(timestamp: number) {
  return timestampToDateInputValue(timestamp).replaceAll("-", "");
}

export function normalizeCalendarTaskText(text: string) {
  return replaceLinkMarkupWithLabels(text)
    .replace(/^\s*#{1,6}\s+/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractCalendarTaskCategories(text: string) {
  return extractTags(text).map((tag) => tag.toLowerCase());
}

export function buildTaskCalendarIcs(feed: TaskCalendarFeed) {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "PRODID:-//Malesh Labs//MaleshFlow//EN",
    `X-WR-CALNAME:${escapeIcsText(feed.calendarName)}`,
  ];

  if (feed.calendarDescription) {
    lines.push(`X-WR-CALDESC:${escapeIcsText(feed.calendarDescription)}`);
  }

  const sortedEvents = [...feed.events].sort((left, right) => {
    if (left.dueAt !== right.dueAt) {
      return left.dueAt - right.dueAt;
    }

    return left.summary.localeCompare(right.summary);
  });

  for (const event of sortedEvents) {
    const dueEndAt =
      event.dueEndAt && event.dueEndAt > event.dueAt ? event.dueEndAt : event.dueAt;
    const exclusiveEnd = addLocalDays(dueEndAt, 1);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcsText(event.uid)}`);
    lines.push(`DTSTAMP:${formatUtcIcsTimestamp(event.updatedAt)}`);
    lines.push(`LAST-MODIFIED:${formatUtcIcsTimestamp(event.updatedAt)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDateValue(event.dueAt)}`);
    lines.push(`DTEND;VALUE=DATE:${formatIcsDateValue(exclusiveEnd)}`);

    if (event.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    }

    if (event.categories && event.categories.length > 0) {
      lines.push(`CATEGORIES:${event.categories.map(escapeIcsText).join(",")}`);
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return lines.flatMap(foldIcsLine).join("\r\n") + "\r\n";
}
