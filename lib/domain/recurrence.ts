export const RECURRENCE_FREQUENCIES = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;

export const RECURRENCE_UNITS = [
  "day",
  "week",
  "month",
  "year",
] as const;

export type RecurrencePreset = (typeof RECURRENCE_FREQUENCIES)[number];
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];
export type CustomRecurrenceFrequency = {
  interval: number;
  unit: RecurrenceUnit;
};
export type RecurrenceFrequency = RecurrencePreset | CustomRecurrenceFrequency | null;
export type RecurringCompletionMode = "dueDate" | "today";

function pluralizeRecurrenceUnit(unit: RecurrenceUnit, interval: number) {
  return interval === 1 ? unit : `${unit}s`;
}

export function isRecurrencePreset(
  frequency: RecurrenceFrequency,
): frequency is RecurrencePreset {
  return typeof frequency === "string";
}

export function isCustomRecurrenceFrequency(
  value: unknown,
): value is CustomRecurrenceFrequency {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.interval === "number" &&
    Number.isInteger(record.interval) &&
    record.interval > 0 &&
    RECURRENCE_UNITS.includes(record.unit as RecurrenceUnit)
  );
}

export function parseRecurrenceFrequency(value: unknown): RecurrenceFrequency {
  if (value === null || value === undefined) {
    return null;
  }

  if (RECURRENCE_FREQUENCIES.includes(value as RecurrencePreset)) {
    return value as RecurrencePreset;
  }

  if (isCustomRecurrenceFrequency(value)) {
    return {
      interval: value.interval,
      unit: value.unit,
    };
  }

  return null;
}

export function areRecurrenceFrequenciesEqual(
  left: RecurrenceFrequency,
  right: RecurrenceFrequency,
) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (isRecurrencePreset(left) || isRecurrencePreset(right)) {
    return false;
  }

  return left.interval === right.interval && left.unit === right.unit;
}

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
  if (!frequency) {
    return "";
  }

  if (!isRecurrencePreset(frequency)) {
    return `Every ${frequency.interval} ${pluralizeRecurrenceUnit(
      frequency.unit,
      frequency.interval,
    )}`;
  }

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

  if (isRecurrencePreset(args.frequency)) {
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
  } else {
    switch (args.frequency.unit) {
      case "day":
        nextDate.setDate(nextDate.getDate() + args.frequency.interval);
        break;
      case "week":
        nextDate.setDate(nextDate.getDate() + args.frequency.interval * 7);
        break;
      case "month":
        nextDate.setMonth(nextDate.getMonth() + args.frequency.interval);
        break;
      case "year":
        nextDate.setFullYear(nextDate.getFullYear() + args.frequency.interval);
        break;
    }
  }

  return toLocalNoon(nextDate).getTime();
}
