"use client";

import clsx from "clsx";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";

type ArchiveSearchResult = {
  node: Doc<"nodes">;
  page: Doc<"pages"> | null;
  score?: number;
  content?: string;
};

type ArchiveSearchPanelProps = {
  ownerKey: string;
  onSelectResult: (result: ArchiveSearchResult) => void;
};

function normalizeResults(results: unknown[]): ArchiveSearchResult[] {
  const normalized = results.map((entry): ArchiveSearchResult | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const record = entry as {
        node?: Doc<"nodes">;
        page?: Doc<"pages"> | null;
        score?: number;
        content?: string;
      };
      if (!record.node) {
        return null;
      }

      return {
        node: record.node,
        page: record.page ?? null,
        score: record.score,
        content: record.content,
      };
    });

  return normalized.filter((entry): entry is ArchiveSearchResult => entry !== null);
}

export function ArchiveSearchPanel({
  ownerKey,
  onSelectResult,
}: ArchiveSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"text" | "semantic">("text");
  const [results, setResults] = useState<ArchiveSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const findArchivedNodesText = useAction(api.ai.findArchivedNodesText);
  const searchArchivedNodes = useAction(api.ai.searchArchivedNodes);

  useEffect(() => {
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  }, []);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      setResults([]);
      setError("");
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    const timeoutId = window.setTimeout(async () => {
      try {
        const rawResults =
          mode === "text"
            ? ((await findArchivedNodesText({
                ownerKey,
                query: normalizedQuery,
                limit: 12,
              })) as unknown[])
            : ((await searchArchivedNodes({
                ownerKey,
                query: normalizedQuery,
                limit: 12,
              })) as unknown[]);

        if (cancelled) {
          return;
        }

        setResults(normalizeResults(rawResults));
        setError("");
      } catch (searchError) {
        if (cancelled) {
          return;
        }

        setResults([]);
        setError(
          searchError instanceof Error
            ? searchError.message
            : "Archive search failed.",
        );
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }, mode === "text" ? 120 : 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [findArchivedNodesText, mode, ownerKey, query, searchArchivedNodes]);

  return (
    <div className="flex h-[min(72vh,760px)] flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode("text")}
            className={clsx(
              "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
              mode === "text"
                ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
            )}
          >
            Find
          </button>
          <button
            type="button"
            onClick={() => setMode("semantic")}
            className={clsx(
              "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
              mode === "semantic"
                ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
            )}
          >
            Semantic
          </button>
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search archived pages and nodes..."
          className="w-full border-0 bg-transparent p-0 text-lg outline-none"
        />
      </div>
      <div className="max-h-[520px] flex-1 overflow-y-auto py-2">
        {query.trim().length === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Search only archived pages and nodes without mixing them into your active workspace results.
          </p>
        ) : isLoading ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Searching archive…
          </p>
        ) : error ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-danger)]">{error}</p>
        ) : results.length === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            No archived matches.
          </p>
        ) : (
          results.map((result) => (
            <button
              key={`${result.node._id}:${result.page?._id ?? "page"}:archive`}
              type="button"
              onClick={() => onSelectResult(result)}
              className="flex w-full items-start justify-between gap-3 px-5 py-3 text-left transition hover:bg-[var(--workspace-surface-hover)]"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                  {result.node.text || "(empty line)"}
                </span>
                <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                  {result.page?.title ?? "Unknown archived page"} • Archived
                </span>
              </span>
              <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                {mode === "text" ? "Text" : "Semantic"}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
