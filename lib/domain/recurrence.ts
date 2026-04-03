export const RECURRENCE_FREQUENCIES = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;

export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number] | null;
export type RecurringCompletionMode = "dueDate" | "today";

function toLocalNoon(date: Date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    12,
    0,
    0,
    0,
  );
}

export function getTodayReferenceDate(now = new Date()) {
  return toLocalNoon(now);
}

export function timestampToDateInputValue(timestamp: number | null | undefined) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateInputValueToTimestamp(value: string) {
  if (!value) {
    return null;
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

export function formatDueDate(timestamp: number | null | undefined) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

export function isOverdueDueDate(timestamp: number | null | undefined, now = new Date()) {
  if (!timestamp) {
    return false;
  }

  return timestamp < getTodayReferenceDate(now).getTime();
}

export function getRecurrenceLabel(frequency: RecurrenceFrequency) {
  switch (frequency) {
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "yearly":
      return "Yearly";
    default:
      return "";
  }
}

export function advanceRecurringDueDate(args: {
  dueAt: number;
  frequency: Exclude<RecurrenceFrequency, null>;
  mode: RecurringCompletionMode;
  now?: Date;
}) {
  const baseDate =
    args.mode === "today"
      ? getTodayReferenceDate(args.now)
      : toLocalNoon(new Date(args.dueAt));
  const nextDate = new Date(baseDate);

  switch (args.frequency) {
    case "daily":
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case "weekly":
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case "monthly":
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
    case "yearly":
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      break;
  }

  return toLocalNoon(nextDate).getTime();
}
