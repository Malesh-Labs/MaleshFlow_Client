"use client";

import clsx from "clsx";
import { useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  parseImportedTextToOutlineNodes,
  type ImportedOutlineNode,
} from "@/lib/domain/importer";
import { filterPagesForCommandPalette } from "@/lib/domain/workspaceUi";
import { getRecurrenceLabel } from "@/lib/domain/recurrence";

const SKIP = "skip" as const;

type ImporterPanelProps = {
  ownerKey: string;
  pages: Doc<"pages">[];
  initialPageId: Id<"pages"> | null;
  onImport: (args: {
    pageId: Id<"pages">;
    pageTitle: string;
    afterNodeId: Id<"nodes"> | null;
    nodes: ImportedOutlineNode[];
  }) => Promise<void>;
  onImported: () => void;
};

function countImportedNodes(nodes: ImportedOutlineNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countImportedNodes(node.children), 0);
}

function ImportPreview({
  nodes,
  depth = 0,
}: {
  nodes: ImportedOutlineNode[];
  depth?: number;
}) {
  return (
    <div className="space-y-2">
      {nodes.map((node, index) => (
        <div key={`${depth}:${index}:${node.text}`}>
          <div
            className="flex items-start gap-2 text-sm text-[var(--workspace-text)]"
            style={{ paddingLeft: depth * 16 }}
          >
            <span className="mt-[0.18rem] text-[var(--workspace-text-faint)]">
              {node.kind === "task" ? (node.taskStatus === "done" ? "[x]" : "[ ]") : "•"}
            </span>
            <div className="min-w-0">
              <div
                className={clsx(
                  "whitespace-pre-wrap break-words",
                  node.kind === "task" && node.taskStatus === "done"
                    ? "text-[var(--workspace-text-faint)] line-through"
                    : "",
                )}
              >
                {node.text}
              </div>
              {node.kind === "task" && (node.dueAt || node.recurrenceFrequency) ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  {node.dueAt ? (
                    <span className="rounded-full border border-[var(--workspace-border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[var(--workspace-text-faint)]">
                      {new Date(node.dueAt).toLocaleDateString()}
                    </span>
                  ) : null}
                  {node.recurrenceFrequency ? (
                    <span className="rounded-full border border-[var(--workspace-border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[var(--workspace-text-faint)]">
                      {getRecurrenceLabel(node.recurrenceFrequency)}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          {node.children.length > 0 ? (
            <div className="mt-1">
              <ImportPreview nodes={node.children} depth={depth + 1} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ImporterPanel({
  ownerKey,
  pages,
  initialPageId,
  onImport,
  onImported,
}: ImporterPanelProps) {
  const [draft, setDraft] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [targetPageId, setTargetPageId] = useState<Id<"pages"> | null>(initialPageId);
  const [errorMessage, setErrorMessage] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  const activePages = useMemo(
    () => pages.filter((page) => !page.archived),
    [pages],
  );

  const pageResults = useMemo(
    () => filterPagesForCommandPalette(activePages, targetQuery, 10),
    [activePages, targetQuery],
  );

  useEffect(() => {
    if (targetPageId && activePages.some((page) => page._id === targetPageId)) {
      return;
    }

    if (initialPageId && activePages.some((page) => page._id === initialPageId)) {
      setTargetPageId(initialPageId);
      return;
    }

    if (activePages.length > 0) {
      setTargetPageId(activePages[0]!._id);
      return;
    }

    setTargetPageId(null);
  }, [activePages, initialPageId, targetPageId]);

  useEffect(() => {
    window.setTimeout(() => {
      draftRef.current?.focus();
    }, 0);
  }, []);

  const targetPage =
    (targetPageId ? activePages.find((page) => page._id === targetPageId) : null) ?? null;
  const appendAfterNodeId = useQuery(
    api.workspace.getPageRootAppendTarget,
    ownerKey && targetPage
      ? {
          ownerKey,
          pageId: targetPage._id,
        }
      : SKIP,
  ) as Id<"nodes"> | null | undefined;

  const parsedNodes = useMemo(
    () => parseImportedTextToOutlineNodes(draft),
    [draft],
  );
  const importedNodeCount = useMemo(
    () => countImportedNodes(parsedNodes),
    [parsedNodes],
  );

  const handleImport = async () => {
    if (!targetPage || parsedNodes.length === 0 || typeof appendAfterNodeId === "undefined") {
      return;
    }

    setIsImporting(true);
    setErrorMessage("");
    try {
      await onImport({
        pageId: targetPage._id,
        pageTitle: targetPage.title,
        afterNodeId: appendAfterNodeId,
        nodes: parsedNodes,
      });
      onImported();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not import that text.",
      );
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="flex h-[min(78vh,820px)] flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <p className="text-sm text-[var(--workspace-text-subtle)]">
          Paste text, choose a target page, preview the parsed nodes, then import them.
          Dynalist markdown links become wiki links, long separator lines become <code>---</code>, and <code>!(YYYY-MM-DD | 6m)</code> becomes real task scheduling metadata.
        </p>
      </div>
      <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <div className="border-b border-[var(--workspace-border-subtle)] p-5 md:border-b-0 md:border-r">
          <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
            Target Page
          </label>
          <input
            value={targetQuery}
            onChange={(event) => setTargetQuery(event.target.value)}
            placeholder="Choose a page..."
            className="mt-3 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
          />
          <div className="mt-3 max-h-44 overflow-y-auto border border-[var(--workspace-border-subtle)]">
            {pageResults.length === 0 ? (
              <p className="px-3 py-3 text-sm text-[var(--workspace-text-subtle)]">
                No matching pages.
              </p>
            ) : (
              pageResults.map((page) => (
                <button
                  key={page._id}
                  type="button"
                  onClick={() => setTargetPageId(page._id)}
                  className={clsx(
                    "block w-full border-b border-[var(--workspace-border-subtle)] px-3 py-2 text-left text-sm transition last:border-b-0",
                    targetPageId === page._id
                      ? "bg-[var(--workspace-sidebar-bg)] text-[var(--workspace-text)]"
                      : "text-[var(--workspace-text-subtle)] hover:bg-[var(--workspace-surface-hover)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  {page.title}
                </button>
              ))
            )}
          </div>
          <label className="mt-5 block text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
            Source Text
          </label>
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Paste text to import..."
            className="mt-3 min-h-[320px] w-full resize-none border border-[var(--workspace-border)] bg-transparent px-3 py-3 text-sm leading-6 outline-none transition focus:border-[var(--workspace-accent)]"
          />
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                  Import Preview
                </p>
                <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">
                  {targetPage
                    ? `Will append ${importedNodeCount} item${importedNodeCount === 1 ? "" : "s"} to ${targetPage.title}.`
                    : "Choose a target page to preview the import destination."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleImport()}
                disabled={
                  !targetPage ||
                  importedNodeCount === 0 ||
                  typeof appendAfterNodeId === "undefined" ||
                  isImporting
                }
                className="border border-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isImporting ? "Importing…" : "Import"}
              </button>
            </div>
            {errorMessage ? (
              <p className="mt-3 text-sm text-[var(--workspace-danger)]">{errorMessage}</p>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {parsedNodes.length === 0 ? (
              <p className="text-sm text-[var(--workspace-text-subtle)]">
                Paste some text to see the parsed outline preview.
              </p>
            ) : (
              <ImportPreview nodes={parsedNodes} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
