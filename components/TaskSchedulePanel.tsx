"use client";

import { useEffect, useMemo, useState } from "react";
import {
  isRecurrencePreset,
  dateInputValueToTimestamp,
  formatDueDate,
  getRecurrenceLabel,
  getTodayReferenceDate,
  RECURRENCE_FREQUENCIES,
  RECURRENCE_UNITS,
  type RecurrencePreset,
  timestampToDateInputValue,
  type RecurrenceUnit,
  type RecurrenceFrequency,
  type RecurringCompletionMode,
} from "@/lib/domain/recurrence";

type TaskSchedulePanelProps = {
  taskTitle: string;
  dueAt: number | null;
  dueEndAt: number | null;
  recurrenceFrequency: RecurrenceFrequency;
  recurringCompletionMode: RecurringCompletionMode;
  onRecurringCompletionModeChange: (mode: RecurringCompletionMode) => void;
  onSave: (args: {
    dueAt: number | null;
    dueEndAt: number | null;
    recurrenceFrequency: RecurrenceFrequency;
  }) => Promise<void>;
  onSaved: () => void;
};

export function TaskSchedulePanel({
  taskTitle,
  dueAt,
  dueEndAt,
  recurrenceFrequency,
  recurringCompletionMode,
  onRecurringCompletionModeChange,
  onSave,
  onSaved,
}: TaskSchedulePanelProps) {
  const [dueDateDraft, setDueDateDraft] = useState("");
  const [dueEndDateDraft, setDueEndDateDraft] = useState("");
  const [recurrenceModeDraft, setRecurrenceModeDraft] = useState<RecurrencePreset | "custom" | "">("");
  const [customIntervalDraft, setCustomIntervalDraft] = useState("");
  const [customUnitDraft, setCustomUnitDraft] = useState<RecurrenceUnit>("day");
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    setDueDateDraft(timestampToDateInputValue(dueAt));
    setDueEndDateDraft(timestampToDateInputValue(dueEndAt));
    if (!recurrenceFrequency) {
      setRecurrenceModeDraft("");
      setCustomIntervalDraft("");
      setCustomUnitDraft("day");
    } else if (isRecurrencePreset(recurrenceFrequency)) {
      setRecurrenceModeDraft(recurrenceFrequency);
      setCustomIntervalDraft("");
      setCustomUnitDraft("day");
    } else {
      setRecurrenceModeDraft("custom");
      setCustomIntervalDraft(String(recurrenceFrequency.interval));
      setCustomUnitDraft(recurrenceFrequency.unit);
    }
    setErrorMessage("");
  }, [dueAt, dueEndAt, recurrenceFrequency, taskTitle]);

  const recurrenceDraft = useMemo<RecurrenceFrequency>(() => {
    if (recurrenceModeDraft === "") {
      return null;
    }

    if (recurrenceModeDraft !== "custom") {
      return recurrenceModeDraft;
    }

    const interval = Number.parseInt(customIntervalDraft, 10);
    if (!Number.isFinite(interval) || interval <= 0) {
      return null;
    }

    return {
      interval,
      unit: customUnitDraft,
    };
  }, [customIntervalDraft, customUnitDraft, recurrenceModeDraft]);

  const summary = useMemo(() => {
    const parts: string[] = [];
    const draftDueAt = dateInputValueToTimestamp(dueDateDraft);
    const draftDueEndAt = dateInputValueToTimestamp(dueEndDateDraft);
    if (draftDueAt) {
      parts.push(
        `Due ${draftDueEndAt && draftDueEndAt > draftDueAt ? `${formatDueDate(draftDueAt)} - ${formatDueDate(draftDueEndAt)}` : formatDueDate(draftDueAt)}`,
      );
    }
    if (recurrenceDraft) {
      parts.push(getRecurrenceLabel(recurrenceDraft));
    }
    return parts.join(" • ");
  }, [dueDateDraft, dueEndDateDraft, recurrenceDraft]);

  const handleSave = async () => {
    const nextDueAt = dateInputValueToTimestamp(dueDateDraft);
    const nextDueEndAt = dateInputValueToTimestamp(dueEndDateDraft);
    if (recurrenceModeDraft === "custom" && recurrenceDraft === null) {
      setErrorMessage("Enter a valid custom cadence like 10 days.");
      return;
    }

    if (recurrenceDraft && !nextDueAt) {
      setErrorMessage("Recurring tasks need a due date.");
      return;
    }

    if (nextDueAt && nextDueEndAt && nextDueEndAt < nextDueAt) {
      setErrorMessage("The end date should be on or after the start date.");
      return;
    }

    setIsSaving(true);
    setErrorMessage("");
    try {
      await onSave({
        dueAt: nextDueAt,
        dueEndAt: nextDueAt && nextDueEndAt && nextDueEndAt > nextDueAt ? nextDueEndAt : null,
        recurrenceFrequency: recurrenceDraft,
      });
      onSaved();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not save that task schedule.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex h-[min(72vh,640px)] flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
          Task Schedule
        </p>
        <p className="mt-2 text-sm text-[var(--workspace-text)]">
          {taskTitle || "(empty task)"}
        </p>
        {summary ? (
          <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">{summary}</p>
        ) : (
          <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">
            Add a due date and optional recurrence for this task.
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="space-y-6">
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              Start Date
            </span>
            <input
              type="date"
              value={dueDateDraft}
              onChange={(event) => setDueDateDraft(event.target.value)}
              className="mt-3 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
            />
          </label>

          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              End Date
            </span>
            <input
              type="date"
              value={dueEndDateDraft}
              onChange={(event) => setDueEndDateDraft(event.target.value)}
              className="mt-3 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
            />
          </label>

          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              Repeat
            </span>
            <select
              value={recurrenceModeDraft}
              onChange={(event) => {
                const nextValue = event.target.value as RecurrencePreset | "custom" | "";
                setRecurrenceModeDraft(nextValue);
                if (nextValue === "") {
                  setCustomIntervalDraft("");
                  setCustomUnitDraft("day");
                } else if (nextValue !== "custom") {
                  setCustomIntervalDraft("");
                  setCustomUnitDraft("day");
                }
                if (!dueDateDraft && nextValue) {
                  setDueDateDraft(
                    timestampToDateInputValue(getTodayReferenceDate().getTime()),
                  );
                }
              }}
              className="mt-3 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
            >
              <option value="">Does not repeat</option>
              {RECURRENCE_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {getRecurrenceLabel(frequency)}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>

          {recurrenceModeDraft === "custom" ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)]">
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                  Every
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={customIntervalDraft}
                  onChange={(event) => setCustomIntervalDraft(event.target.value)}
                  placeholder="10"
                  className="mt-3 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
                />
              </label>

              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                  Unit
                </span>
                <select
                  value={customUnitDraft}
                  onChange={(event) => setCustomUnitDraft(event.target.value as RecurrenceUnit)}
                  className="mt-3 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
                >
                  {RECURRENCE_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit === "day"
                        ? "Days"
                        : unit === "week"
                          ? "Weeks"
                          : unit === "month"
                            ? "Months"
                            : "Years"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              When a recurring task is completed
            </p>
            <div className="mt-3 space-y-3">
              <label className="flex cursor-pointer items-start gap-3 border border-[var(--workspace-border)] px-3 py-3 transition hover:border-[var(--workspace-accent)]">
                <input
                  type="radio"
                  name="recurring-completion-mode"
                  checked={recurringCompletionMode === "dueDate"}
                  onChange={() => onRecurringCompletionModeChange("dueDate")}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm text-[var(--workspace-text)]">
                    Advance from the original due date
                  </span>
                  <span className="mt-1 block text-sm text-[var(--workspace-text-subtle)]">
                    Keeps the schedule anchored, even if you finish late.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 border border-[var(--workspace-border)] px-3 py-3 transition hover:border-[var(--workspace-accent)]">
                <input
                  type="radio"
                  name="recurring-completion-mode"
                  checked={recurringCompletionMode === "today"}
                  onChange={() => onRecurringCompletionModeChange("today")}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm text-[var(--workspace-text)]">
                    Advance from today
                  </span>
                  <span className="mt-1 block text-sm text-[var(--workspace-text-subtle)]">
                    Resets the cadence based on the day you actually completed it.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {errorMessage ? (
            <p className="text-sm text-[var(--workspace-danger)]">{errorMessage}</p>
          ) : null}
        </div>
      </div>
      <div className="border-t border-[var(--workspace-border-subtle)] px-5 py-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setDueDateDraft("");
              setRecurrenceModeDraft("");
              setCustomIntervalDraft("");
              setCustomUnitDraft("day");
            }}
            disabled={
              isSaving ||
              (!dueDateDraft &&
                recurrenceModeDraft === "" &&
                customIntervalDraft.length === 0)
            }
            className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition enabled:hover:border-[var(--workspace-accent)] enabled:hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition enabled:hover:border-[var(--workspace-accent)] enabled:hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? "Saving…" : "Save Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
