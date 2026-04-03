"use client";

import clsx from "clsx";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

const SKIP = "skip" as const;

type ReplaceScope = "page" | "workspace";

type PreviewMatch = {
  node: Doc<"nodes">;
  page: Doc<"pages"> | null;
  occurrenceCount: number;
  replacedText: string;
};

type FindReplacePreview = {
  matches: PreviewMatch[];
  totalNodes: number;
  totalOccurrences: number;
  previewTruncated: boolean;
};

type FindReplacePanelProps = {
  ownerKey: string;
  currentPageId: Id<"pages"> | null;
  currentPageTitle: string | null;
  onSelectResult: (result: { node: Doc<"nodes">; page: Doc<"pages"> | null }) => void;
  onApplied: (message: string) => void;
};

function pluralize(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function FindReplacePanel({
  ownerKey,
  currentPageId,
  currentPageTitle,
  onSelectResult,
  onApplied,
}: FindReplacePanelProps) {
  const [scope, setScope] = useState<ReplaceScope>(currentPageId ? "page" : "workspace");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [debouncedFindText, setDebouncedFindText] = useState("");
  const [debouncedReplaceText, setDebouncedReplaceText] = useState("");
  const [error, setError] = useState("");
  const [isApplying, setIsApplying] = useState(false);
  const findInputRef = useRef<HTMLTextAreaElement>(null);
  const applyFindAndReplaceBatch = useMutation(api.workspace.applyFindAndReplaceBatch);
  const textsIdentical = findText === replaceText;

  useEffect(() => {
    window.setTimeout(() => {
      findInputRef.current?.focus();
    }, 0);
  }, []);

  useEffect(() => {
    if (!currentPageId && scope === "page") {
      setScope("workspace");
    }
  }, [currentPageId, scope]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedFindText(findText);
      setDebouncedReplaceText(replaceText);
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [findText, replaceText]);

  const preview = useQuery(
    api.workspace.previewFindAndReplace,
    ownerKey && debouncedFindText.length > 0
      ? {
          ownerKey,
          find: debouncedFindText,
          replace: debouncedReplaceText,
          pageId: scope === "page" ? currentPageId ?? undefined : undefined,
          limit: 32,
        }
      : SKIP,
  ) as FindReplacePreview | undefined;

  const isDisabled = findText.length === 0 || textsIdentical || isApplying;
  const scopeLabel =
    scope === "page"
      ? currentPageTitle
        ? `Current page: ${currentPageTitle}`
        : "Current page"
      : "Active workspace";
  const summary = useMemo(() => {
    if (findText.length === 0) {
      return "Type the exact text you want to replace.";
    }

    if (textsIdentical) {
      return "Find and replace are identical, so there is nothing to change.";
    }

    if (typeof preview === "undefined") {
      return "Preparing replacement preview…";
    }

    if (preview.totalNodes === 0) {
      return `No exact matches found in ${scopeLabel.toLowerCase()}.`;
    }

    return `${pluralize(preview.totalOccurrences, "replacement")} across ${pluralize(preview.totalNodes, "item")}.`;
  }, [findText.length, preview, scopeLabel, textsIdentical]);

  const handleApply = useCallback(async () => {
    if (isDisabled) {
      return;
    }

    const previewSummary =
      preview && preview.totalNodes > 0
        ? `This will replace ${pluralize(preview.totalOccurrences, "occurrence")} across ${pluralize(preview.totalNodes, "item")} in ${scope === "page" ? "the current page" : "the active workspace"}.`
        : `Replace text in ${scope === "page" ? "the current page" : "the active workspace"}?`;

    if (!window.confirm(previewSummary)) {
      return;
    }

    setIsApplying(true);
    setError("");

    let updatedBefore: number | undefined;
    let totalNodes = 0;
    let totalOccurrences = 0;

    try {
      for (let attempts = 0; attempts < 200; attempts += 1) {
        const result = await applyFindAndReplaceBatch({
          ownerKey,
          find: findText,
          replace: replaceText,
          pageId: scope === "page" ? currentPageId ?? undefined : undefined,
          batchSize: 40,
          updatedBefore,
        });

        updatedBefore = result.updatedBefore;
        totalNodes += result.replacedNodeCount;
        totalOccurrences += result.replacedOccurrenceCount;

        if (!result.hasMore || result.replacedNodeCount === 0) {
          break;
        }
      }

      onApplied(
        totalNodes > 0
          ? `Replaced ${pluralize(totalOccurrences, "occurrence")} across ${pluralize(totalNodes, "item")}`
          : "No matching text needed replacing",
      );
    } catch (applyError) {
      setError(
        applyError instanceof Error
          ? applyError.message
          : "Find and replace failed.",
      );
    } finally {
      setIsApplying(false);
    }
  }, [
    applyFindAndReplaceBatch,
    currentPageId,
    findText,
    isDisabled,
    onApplied,
    ownerKey,
    preview,
    replaceText,
    scope,
  ]);

  return (
    <div className="flex h-[min(72vh,760px)] flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setScope("page")}
            disabled={!currentPageId}
            className={clsx(
              "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
              scope === "page"
                ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
              !currentPageId ? "cursor-not-allowed opacity-50" : "",
            )}
          >
            Current Page
          </button>
          <button
            type="button"
            onClick={() => setScope("workspace")}
            className={clsx(
              "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
              scope === "workspace"
                ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
            )}
          >
            Workspace
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              Find
            </span>
            <textarea
              ref={findInputRef}
              value={findText}
              onChange={(event) => setFindText(event.target.value)}
              rows={3}
              placeholder="Exact text to find…"
              className="w-full resize-none border border-[var(--workspace-border)] bg-[var(--workspace-sidebar-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              Replace
            </span>
            <textarea
              value={replaceText}
              onChange={(event) => setReplaceText(event.target.value)}
              rows={3}
              placeholder="Replacement text…"
              className="w-full resize-none border border-[var(--workspace-border)] bg-[var(--workspace-sidebar-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[var(--workspace-text)]">{summary}</p>
            <p className="mt-1 text-xs text-[var(--workspace-text-subtle)]">
              Workspace replace covers active pages plus the sidebar outline. Matching is exact and case-sensitive.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void handleApply();
            }}
            disabled={isDisabled || (preview?.totalNodes ?? 0) === 0}
            className={clsx(
              "border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] transition",
              isDisabled || (preview?.totalNodes ?? 0) === 0
                ? "cursor-not-allowed border-[var(--workspace-border)] text-[var(--workspace-text-faint)] opacity-60"
                : "border-[var(--workspace-accent)] text-[var(--workspace-accent)] hover:bg-[var(--workspace-accent)]/10",
            )}
          >
            {isApplying
              ? "Replacing…"
              : scope === "page"
                ? "Replace In Page"
                : "Replace In Workspace"}
          </button>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-[var(--workspace-danger)]">{error}</p>
        ) : null}
      </div>
      <div className="max-h-[520px] flex-1 overflow-y-auto py-2">
        {findText.length === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Preview every matching line before you replace it.
          </p>
        ) : typeof preview === "undefined" ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Preparing preview…
          </p>
        ) : preview.totalNodes === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            No matching text found.
          </p>
        ) : (
          <div className="space-y-2 px-3 py-2">
            {preview.matches.map((match) => (
              <button
                key={`${match.node._id}:replace-preview`}
                type="button"
                onClick={() => onSelectResult({ node: match.node, page: match.page })}
                className="block w-full border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-hover)] px-4 py-3 text-left transition hover:border-[var(--workspace-accent)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-xs uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                    {match.page?.title ?? "Unknown page"}
                  </span>
                  <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                    {pluralize(match.occurrenceCount, "match")}
                  </span>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      Before
                    </p>
                    <p className="whitespace-pre-wrap break-words text-sm text-[var(--workspace-text)]">
                      {match.node.text || "(empty line)"}
                    </p>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      After
                    </p>
                    <p className="whitespace-pre-wrap break-words text-sm text-[var(--workspace-text)]">
                      {match.replacedText || "(empty line)"}
                    </p>
                  </div>
                </div>
              </button>
            ))}
            {preview.previewTruncated ? (
              <p className="px-2 pt-2 text-xs text-[var(--workspace-text-subtle)]">
                Showing the first {preview.matches.length} matches.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
