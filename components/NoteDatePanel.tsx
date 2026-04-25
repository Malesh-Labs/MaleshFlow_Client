"use client";

import { useEffect, useMemo, useState } from "react";
import {
  dateInputValueToTimestamp,
  formatDueDate,
  timestampToDateInputValue,
} from "@/lib/domain/recurrence";

type NoteDatePanelProps = {
  noteTitle: string;
  dueAt: number | null;
  onSave: (args: {
    dueAt: number | null;
  }) => Promise<void>;
  onSaved: () => void;
};

export function NoteDatePanel({
  noteTitle,
  dueAt,
  onSave,
  onSaved,
}: NoteDatePanelProps) {
  const [dateDraft, setDateDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    setDateDraft(timestampToDateInputValue(dueAt));
    setErrorMessage("");
  }, [dueAt, noteTitle]);

  const summary = useMemo(() => {
    const nextDueAt = dateInputValueToTimestamp(dateDraft);
    return nextDueAt ? `Dated ${formatDueDate(nextDueAt)}` : "";
  }, [dateDraft]);

  const handleSave = async () => {
    setIsSaving(true);
    setErrorMessage("");
    try {
      await onSave({
        dueAt: dateInputValueToTimestamp(dateDraft),
      });
      onSaved();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not save that note date.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setIsSaving(true);
    setErrorMessage("");
    try {
      await onSave({
        dueAt: null,
      });
      setDateDraft("");
      onSaved();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not clear that note date.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex h-[min(52vh,420px)] flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
          Note Date
        </p>
        <p className="mt-2 text-sm text-[var(--workspace-text)]">
          {noteTitle || "(empty note)"}
        </p>
        {summary ? (
          <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">{summary}</p>
        ) : (
          <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">
            Add a calendar date to this note. It will not be treated as overdue.
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
            Date
          </span>
          <input
            type="date"
            value={dateDraft}
            onChange={(event) => setDateDraft(event.target.value)}
            className="mt-3 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
          />
        </label>
        {errorMessage ? (
          <p className="mt-4 text-sm text-[var(--workspace-danger)]">{errorMessage}</p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-[var(--workspace-border-subtle)] px-5 py-4">
        <button
          type="button"
          onClick={() => void handleClear()}
          disabled={isSaving}
          className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:opacity-50"
        >
          {isSaving ? "Clearing…" : "Clear"}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving}
          className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition hover:brightness-110 disabled:opacity-60"
        >
          {isSaving ? "Saving…" : "Save Date"}
        </button>
      </div>
    </div>
  );
}
