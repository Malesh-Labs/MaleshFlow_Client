"use client";

import clsx from "clsx";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { replaceLinkMarkupWithLabels } from "@/lib/domain/links";

const SKIP = "skip" as const;

type UnresolvedPageLinkGroup = {
  normalizedTitle: string;
  title: string;
  occurrenceCount: number;
  nodeCount: number;
  samples: Array<{
    nodeId: Id<"nodes">;
    pageId: Id<"pages">;
    pageTitle: string;
    nodeText: string;
    occurrenceCount: number;
  }>;
};

const EMPTY_UNRESOLVED_PAGE_LINK_GROUPS: UnresolvedPageLinkGroup[] = [];

type UnresolvedPageLinkGroupsResult = {
  groups: UnresolvedPageLinkGroup[];
  scanTruncated: boolean;
  scannedNodeCount: number;
};

type LinkTargetSearchResults = {
  pages: Doc<"pages">[];
  nodes: Array<{
    node: Doc<"nodes">;
    page: Doc<"pages"> | null;
  }>;
};

type SelectedNodeTarget = {
  node: Doc<"nodes">;
  page: Doc<"pages"> | null;
};

type ApplyProgress = {
  nodeCount: number;
  occurrenceCount: number;
};

type UnresolvedLinksPanelProps = {
  ownerKey: string;
  onApplied: (message: string) => void;
};

function pluralize(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function getNodeDisplayText(node: Pick<Doc<"nodes">, "text">) {
  return replaceLinkMarkupWithLabels(node.text).trim() || node.text.trim() || "(empty item)";
}

export function UnresolvedLinksPanel({
  ownerKey,
  onApplied,
}: UnresolvedLinksPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [selectedTarget, setSelectedTarget] = useState<SelectedNodeTarget | null>(null);
  const [error, setError] = useState("");
  const [isApplying, setIsApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);
  const lastActiveGroupKeyRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceUnresolvedPageLinksWithNode = useMutation(
    api.workspace.replaceUnresolvedPageLinksWithNode,
  );
  const groupsResult = useQuery(
    api.workspace.listUnresolvedPageLinkGroups,
    ownerKey
      ? {
          ownerKey,
          limit: 100,
        }
      : SKIP,
  ) as UnresolvedPageLinkGroupsResult | undefined;
  const groups = groupsResult?.groups ?? EMPTY_UNRESOLVED_PAGE_LINK_GROUPS;
  const activeGroup = groups[Math.min(activeIndex, Math.max(groups.length - 1, 0))] ?? null;

  useEffect(() => {
    window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);
  }, []);

  useEffect(() => {
    if (activeIndex >= groups.length && groups.length > 0) {
      setActiveIndex(0);
    }
  }, [activeIndex, groups.length]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 140);

    return () => window.clearTimeout(timeoutId);
  }, [searchQuery]);

  useEffect(() => {
    const activeGroupKey = activeGroup?.normalizedTitle ?? null;
    if (activeGroupKey === lastActiveGroupKeyRef.current) {
      return;
    }

    lastActiveGroupKeyRef.current = activeGroupKey;
    setSearchQuery(activeGroup?.title ?? "");
    setSelectedTarget(null);
    setError("");
    setApplyProgress(null);
  }, [activeGroup]);

  const targetResults = useQuery(
    api.workspace.searchLinkTargets,
    ownerKey && activeGroup && debouncedSearchQuery.trim().length > 0
      ? {
          ownerKey,
          query: debouncedSearchQuery,
          limit: 12,
        }
      : SKIP,
  ) as LinkTargetSearchResults | undefined;
  const nodeResults = useMemo(
    () => (targetResults?.nodes ?? []).filter((entry) => entry.page !== null),
    [targetResults],
  );

  const summary = useMemo(() => {
    if (typeof groupsResult === "undefined") {
      return "Scanning active pages for empty wiki links.";
    }

    if (groups.length === 0) {
      return "No empty wiki links found in active pages.";
    }

    const totalOccurrences = groups.reduce(
      (sum, group) => sum + group.occurrenceCount,
      0,
    );
    return `${pluralize(totalOccurrences, "empty link")} across ${pluralize(groups.length, "label")}.`;
  }, [groups, groupsResult]);

  const handleApply = useCallback(async () => {
    if (!activeGroup || !selectedTarget || isApplying) {
      return;
    }

    const targetText = getNodeDisplayText(selectedTarget.node);
    const confirmation = `Replace every unresolved [[${activeGroup.title}]] with [[${activeGroup.title}|node:${selectedTarget.node._id}]] pointing to "${targetText}"?`;
    if (!window.confirm(confirmation)) {
      return;
    }

    setIsApplying(true);
    setError("");
    setApplyProgress({ nodeCount: 0, occurrenceCount: 0 });

    let totalNodes = 0;
    let totalOccurrences = 0;

    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await replaceUnresolvedPageLinksWithNode({
          ownerKey,
          normalizedTitle: activeGroup.normalizedTitle,
          targetNodeId: selectedTarget.node._id as Id<"nodes">,
          batchSize: 40,
        });

        totalNodes += result.replacedNodeCount;
        totalOccurrences += result.replacedOccurrenceCount;
        setApplyProgress({
          nodeCount: totalNodes,
          occurrenceCount: totalOccurrences,
        });

        if (!result.hasMore || result.replacedNodeCount === 0) {
          break;
        }
      }

      onApplied(
        totalNodes > 0
          ? `Resolved ${pluralize(totalOccurrences, "empty link")} across ${pluralize(totalNodes, "item")}`
          : "No empty links needed replacing",
      );
      setSelectedTarget(null);
    } catch (applyError) {
      setError(
        applyError instanceof Error
          ? applyError.message
          : "Could not resolve empty links.",
      );
    } finally {
      setIsApplying(false);
    }
  }, [
    activeGroup,
    isApplying,
    onApplied,
    ownerKey,
    replaceUnresolvedPageLinksWithNode,
    selectedTarget,
  ]);

  return (
    <div className="flex h-[min(72vh,760px)] flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-[var(--workspace-text)]">{summary}</p>
            <p className="mt-1 text-xs text-[var(--workspace-text-subtle)]">
              Choose one empty label, search for the target item, then replace every matching unresolved wiki link.
            </p>
            {groupsResult?.scanTruncated ? (
              <p className="mt-2 text-xs text-[var(--workspace-danger)]">
                Scan limit reached after {pluralize(groupsResult.scannedNodeCount, "item")}; some links may not be listed yet.
              </p>
            ) : null}
          </div>
          <div className="text-right text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
            {typeof groupsResult === "undefined"
              ? "Scanning"
              : pluralize(groupsResult.scannedNodeCount, "item")}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(13rem,0.85fr)_minmax(0,1.35fr)]">
        <div className="min-h-0 border-b border-[var(--workspace-border-subtle)] md:border-b-0 md:border-r">
          <div className="max-h-full overflow-y-auto py-2">
            {typeof groupsResult === "undefined" ? (
              <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
                Looking through active pages…
              </p>
            ) : groups.length === 0 ? (
              <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
                Nothing to resolve right now.
              </p>
            ) : (
              groups.map((group, index) => (
                <button
                  key={group.normalizedTitle}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  className={clsx(
                    "block w-full px-5 py-3 text-left transition",
                    index === activeIndex
                      ? "bg-[var(--workspace-sidebar-bg)]"
                      : "hover:bg-[var(--workspace-surface-hover)]",
                  )}
                >
                  <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                    [[{group.title}]]
                  </span>
                  <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                    {pluralize(group.occurrenceCount, "use")} · {pluralize(group.nodeCount, "item")}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {!activeGroup ? (
            <p className="text-sm text-[var(--workspace-text-subtle)]">
              Select an unresolved label to start.
            </p>
          ) : (
            <div className="space-y-5">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      Resolving
                    </p>
                    <p className="mt-1 truncate text-lg font-medium text-[var(--workspace-text)]">
                      [[{activeGroup.title}]]
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveIndex((index) => Math.min(index + 1, groups.length - 1))}
                    disabled={groups.length <= 1 || activeIndex >= groups.length - 1}
                    className="border border-[var(--workspace-border)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Skip
                  </button>
                </div>
                <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">
                  {pluralize(activeGroup.occurrenceCount, "occurrence")} in {pluralize(activeGroup.nodeCount, "item")}.
                </p>
              </div>

              <label className="block">
                <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                  Search Target Item
                </span>
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setSelectedTarget(null);
                  }}
                  placeholder="Search notes and tasks…"
                  className="w-full border border-[var(--workspace-border)] bg-[var(--workspace-sidebar-bg)] px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
                />
              </label>

              <div className="space-y-2">
                {debouncedSearchQuery.trim().length === 0 ? (
                  <p className="text-sm text-[var(--workspace-text-subtle)]">
                    Type to search for a node target.
                  </p>
                ) : typeof targetResults === "undefined" ? (
                  <p className="text-sm text-[var(--workspace-text-subtle)]">
                    Searching items…
                  </p>
                ) : nodeResults.length === 0 ? (
                  <p className="text-sm text-[var(--workspace-text-subtle)]">
                    No matching items.
                  </p>
                ) : (
                  nodeResults.map((result) => {
                    const isSelected = selectedTarget?.node._id === result.node._id;
                    return (
                      <button
                        key={result.node._id}
                        type="button"
                        onClick={() => setSelectedTarget(result)}
                        className={clsx(
                          "block w-full border px-4 py-3 text-left transition",
                          isSelected
                            ? "border-[var(--workspace-accent)] bg-[var(--workspace-accent)]/10"
                            : "border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-hover)] hover:border-[var(--workspace-accent)]",
                        )}
                      >
                        <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                          {getNodeDisplayText(result.node)}
                        </span>
                        <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                          {result.node.kind === "task" ? "Task" : "Note"} · {result.page?.title ?? "Unknown page"}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              {activeGroup.samples.length > 0 ? (
                <div>
                  <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                    Samples
                  </p>
                  <div className="space-y-2">
                    {activeGroup.samples.map((sample) => (
                      <div
                        key={`${sample.nodeId}:${sample.pageId}`}
                        className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-hover)] px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                            {sample.pageTitle}
                          </span>
                          <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                            {pluralize(sample.occurrenceCount, "use")}
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--workspace-text)]">
                          {sample.nodeText || "(empty item)"}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedTarget ? (
                <div className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-sidebar-bg)] px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                    Replacement
                  </p>
                  <p className="mt-2 text-sm leading-6 text-[var(--workspace-text)] [overflow-wrap:anywhere]">
                    [[{activeGroup.title}|node:{selectedTarget.node._id}]]
                  </p>
                </div>
              ) : null}

              {applyProgress ? (
                <p className="text-sm text-[var(--workspace-text-subtle)]">
                  Replaced {pluralize(applyProgress.occurrenceCount, "occurrence")} across {pluralize(applyProgress.nodeCount, "item")}.
                </p>
              ) : null}
              {error ? (
                <p className="text-sm text-[var(--workspace-danger)]">{error}</p>
              ) : null}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    void handleApply();
                  }}
                  disabled={!selectedTarget || isApplying}
                  className={clsx(
                    "border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    !selectedTarget || isApplying
                      ? "cursor-not-allowed border-[var(--workspace-border)] text-[var(--workspace-text-faint)] opacity-60"
                      : "border-[var(--workspace-accent)] text-[var(--workspace-accent)] hover:bg-[var(--workspace-accent)]/10",
                  )}
                >
                  {isApplying ? "Resolving…" : "Resolve All Uses"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
