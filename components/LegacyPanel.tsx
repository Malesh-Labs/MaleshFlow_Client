"use client";

import clsx from "clsx";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

const SKIP = "skip" as const;

type LegacyFile = Doc<"legacyFiles">;
type LegacyPanelView = "upload" | "search";
type LegacySearchMode = "text" | "semantic";

type LegacySearchResult = {
  chunkId: Id<"legacyChunks">;
  fileId: Id<"legacyFiles">;
  fileName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  mode: LegacySearchMode;
};

type LegacyPanelProps = {
  ownerKey: string;
  initialView: LegacyPanelView;
  initialFileId?: Id<"legacyFiles"> | null;
  onUploaded?: (message: string) => void;
};

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function getLegacyFileStatusLabel(file: LegacyFile) {
  if (file.status === "processing") {
    return `Indexing ${file.chunkCount} chunk${file.chunkCount === 1 ? "" : "s"}`;
  }
  if (file.status === "ready") {
    return `${file.chunkCount} chunk${file.chunkCount === 1 ? "" : "s"}`;
  }
  if (file.status === "error") {
    return "Error";
  }
  return "Uploaded";
}

function getSemanticStatusLabel(file: LegacyFile) {
  if (file.semanticStatus === "none") {
    return "Semantic off";
  }
  if (file.semanticStatus === "processing" || file.semanticStatus === "queued") {
    return `Semantic ${file.semanticChunkCount}/${file.chunkCount || "?"}`;
  }
  if (file.semanticStatus === "ready") {
    return `Semantic ready`;
  }
  return "Semantic error";
}

function isSupportedLegacyFile(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".md") || name.endsWith(".txt");
}

function getFilePath(file: File) {
  const withRelativePath = file as File & { webkitRelativePath?: string };
  return withRelativePath.webkitRelativePath || file.name;
}

export function LegacyPanel({
  ownerKey,
  initialView,
  initialFileId = null,
  onUploaded,
}: LegacyPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<LegacyPanelView>(initialView);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [buildSemanticOnUpload, setBuildSemanticOnUpload] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [searchMode, setSearchMode] = useState<LegacySearchMode>("text");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedFileId, setSelectedFileId] = useState<Id<"legacyFiles"> | "all">(
    initialFileId ?? "all",
  );
  const [semanticResults, setSemanticResults] = useState<LegacySearchResult[]>([]);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const [semanticSearchError, setSemanticSearchError] = useState("");
  const [semanticBuildFileId, setSemanticBuildFileId] = useState<string | null>(null);
  const [semanticBuildError, setSemanticBuildError] = useState("");

  const files = useQuery(
    api.legacy.listLegacyFiles,
    ownerKey ? { ownerKey, limit: 200 } : SKIP,
  ) as LegacyFile[] | undefined;
  const exactResults = useQuery(
    api.legacy.searchLegacyText,
    ownerKey && view === "search" && searchMode === "text" && debouncedQuery.trim().length > 0
      ? {
          ownerKey,
          query: debouncedQuery.trim(),
          fileId: selectedFileId === "all" ? undefined : selectedFileId,
          limit: 20,
        }
      : SKIP,
  ) as LegacySearchResult[] | undefined;
  const generateLegacyUploadUrl = useMutation(api.legacy.generateLegacyUploadUrl);
  const registerLegacyFile = useMutation(api.legacy.registerLegacyFile);
  const processLegacyFile = useAction(api.legacyActions.processLegacyFile);
  const buildLegacySemanticIndex = useAction(api.legacyActions.buildLegacySemanticIndex);
  const searchLegacySemantic = useAction(api.legacyActions.searchLegacySemantic);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  useEffect(() => {
    if (initialFileId) {
      setSelectedFileId(initialFileId);
    }
  }, [initialFileId]);

  useEffect(() => {
    window.setTimeout(() => {
      if (view === "upload") {
        fileInputRef.current?.focus();
      } else {
        searchInputRef.current?.focus();
      }
    }, 0);
  }, [view]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, searchMode === "text" ? 120 : 220);
    return () => window.clearTimeout(timeoutId);
  }, [query, searchMode]);

  useEffect(() => {
    if (view !== "search" || searchMode !== "semantic") {
      setIsSemanticSearching(false);
      return;
    }

    const normalizedQuery = debouncedQuery.trim();
    if (normalizedQuery.length === 0) {
      setSemanticResults([]);
      setSemanticSearchError("");
      setIsSemanticSearching(false);
      return;
    }

    let cancelled = false;
    setIsSemanticSearching(true);
    setSemanticSearchError("");
    void searchLegacySemantic({
      ownerKey,
      query: normalizedQuery,
      fileId: selectedFileId === "all" ? undefined : selectedFileId,
      limit: 20,
    })
      .then((results) => {
        if (!cancelled) {
          setSemanticResults(results as LegacySearchResult[]);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSemanticResults([]);
          setSemanticSearchError(
            error instanceof Error ? error.message : "Legacy semantic search failed.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsSemanticSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    debouncedQuery,
    ownerKey,
    searchLegacySemantic,
    searchMode,
    selectedFileId,
    view,
  ]);

  const sortedFiles = useMemo(
    () =>
      [...(files ?? [])].sort((left, right) =>
        left.fileName.localeCompare(right.fileName, undefined, { sensitivity: "base" }),
      ),
    [files],
  );
  const selectedUploadCount = selectedFiles.length;
  const unsupportedFiles = selectedFiles.filter((file) => !isSupportedLegacyFile(file));
  const uploadDisabled = selectedUploadCount === 0 || unsupportedFiles.length > 0 || isUploading;
  const activeResults =
    searchMode === "text" ? exactResults ?? [] : semanticResults;
  const isSearching =
    query.trim().length > 0 &&
    (searchMode === "text" ? typeof exactResults === "undefined" : isSemanticSearching);

  const handleUpload = async () => {
    if (uploadDisabled) {
      return;
    }

    setIsUploading(true);
    setUploadError("");
    setUploadMessage("");

    let uploadedCount = 0;
    try {
      for (const file of selectedFiles) {
        setUploadMessage(`Uploading ${file.name}...`);
        const uploadUrl = await generateLegacyUploadUrl({ ownerKey });
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": file.type || "text/plain",
          },
          body: file,
        });
        if (!response.ok) {
          throw new Error(`Could not upload ${file.name}.`);
        }
        const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
        const fileId = (await registerLegacyFile({
          ownerKey,
          storageId,
          fileName: file.name,
          filePath: getFilePath(file),
          mimeType: file.type || null,
          size: file.size,
        })) as Id<"legacyFiles">;

        setUploadMessage(`Indexing ${file.name}...`);
        await processLegacyFile({
          ownerKey,
          fileId,
          buildSemantic: buildSemanticOnUpload,
        });
        uploadedCount += 1;
      }

      const message = `Uploaded ${uploadedCount} legacy file${uploadedCount === 1 ? "" : "s"}`;
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setUploadMessage(message);
      onUploaded?.(message);
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "Legacy upload failed.",
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleBuildSemantic = async (fileId: Id<"legacyFiles">) => {
    setSemanticBuildFileId(fileId as string);
    setSemanticBuildError("");
    try {
      await buildLegacySemanticIndex({
        ownerKey,
        fileId,
      });
    } catch (error) {
      setSemanticBuildError(
        error instanceof Error ? error.message : "Could not build semantic index.",
      );
    } finally {
      setSemanticBuildFileId(null);
    }
  };

  return (
    <div className="flex h-[min(72vh,760px)] flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setView("upload")}
            className={clsx(
              "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
              view === "upload"
                ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
            )}
          >
            Upload
          </button>
          <button
            type="button"
            onClick={() => setView("search")}
            className={clsx(
              "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
              view === "search"
                ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
            )}
          >
            Search
          </button>
        </div>

        {view === "upload" ? (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".md,.txt,text/markdown,text/plain"
              onChange={(event) => {
                setSelectedFiles(Array.from(event.target.files ?? []));
                setUploadError("");
                setUploadMessage("");
              }}
              className="block w-full text-sm text-[var(--workspace-text-subtle)] file:mr-4 file:border file:border-[var(--workspace-border)] file:bg-transparent file:px-3 file:py-2 file:text-xs file:font-semibold file:uppercase file:tracking-[0.18em] file:text-[var(--workspace-text-muted)]"
            />
            <label className="flex items-start gap-3 text-sm text-[var(--workspace-text-subtle)]">
              <input
                type="checkbox"
                checked={buildSemanticOnUpload}
                onChange={(event) => setBuildSemanticOnUpload(event.target.checked)}
                className="mt-1"
              />
              <span>
                Build semantic index during upload. Leave this off for large batches until exact search is working.
              </span>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-[var(--workspace-text-subtle)]">
                {selectedUploadCount === 0
                  ? "Choose .md or .txt files."
                  : `${selectedUploadCount} file${selectedUploadCount === 1 ? "" : "s"} selected`}
              </p>
              <button
                type="button"
                onClick={() => void handleUpload()}
                disabled={uploadDisabled}
                className={clsx(
                  "border px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] transition",
                  uploadDisabled
                    ? "cursor-not-allowed border-[var(--workspace-border)] text-[var(--workspace-text-faint)] opacity-60"
                    : "border-[var(--workspace-brand)] text-[var(--workspace-brand)] hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)]",
                )}
              >
                {isUploading ? "Uploading..." : "Upload Legacy Files"}
              </button>
            </div>
            {unsupportedFiles.length > 0 ? (
              <p className="text-sm text-[var(--workspace-danger)]">
                Unsupported: {unsupportedFiles.map((file) => file.name).join(", ")}
              </p>
            ) : null}
            {uploadError ? (
              <p className="text-sm text-[var(--workspace-danger)]">{uploadError}</p>
            ) : uploadMessage ? (
              <p className="text-sm text-[var(--workspace-text-subtle)]">{uploadMessage}</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSearchMode("text")}
                className={clsx(
                  "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                  searchMode === "text"
                    ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                    : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                )}
              >
                Find
              </button>
              <button
                type="button"
                onClick={() => setSearchMode("semantic")}
                className={clsx(
                  "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                  searchMode === "semantic"
                    ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                    : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                )}
              >
                Semantic
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search legacy files..."
                className="w-full border-0 bg-transparent p-0 text-lg outline-none"
              />
              <select
                value={selectedFileId}
                onChange={(event) =>
                  setSelectedFileId(
                    event.target.value === "all"
                      ? "all"
                      : (event.target.value as Id<"legacyFiles">),
                  )
                }
                className="border border-[var(--workspace-border)] bg-[var(--workspace-sidebar-bg)] px-3 py-2 text-sm outline-none"
              >
                <option value="all">All legacy files</option>
                {sortedFiles.map((file) => (
                  <option key={file._id} value={file._id}>
                    {file.fileName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "upload" ? (
          <div className="space-y-2 px-3 py-3">
            {typeof files === "undefined" ? (
              <p className="px-2 py-2 text-sm text-[var(--workspace-text-subtle)]">
                Loading legacy files...
              </p>
            ) : sortedFiles.length === 0 ? (
              <p className="px-2 py-2 text-sm text-[var(--workspace-text-subtle)]">
                No legacy files imported yet.
              </p>
            ) : (
              sortedFiles.map((file) => (
                <div
                  key={file._id}
                  className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-hover)] px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--workspace-text)]">
                        {file.fileName}
                      </p>
                      <p className="mt-1 truncate text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                        {formatFileSize(file.size)} • {getLegacyFileStatusLabel(file)} • {getSemanticStatusLabel(file)}
                      </p>
                      {file.error || file.semanticError ? (
                        <p className="mt-2 text-xs leading-5 text-[var(--workspace-danger)]">
                          {file.error ?? file.semanticError}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleBuildSemantic(file._id)}
                      disabled={
                        file.status !== "ready" ||
                        file.semanticStatus === "processing" ||
                        semanticBuildFileId === (file._id as string)
                      }
                      className="shrink-0 border border-[var(--workspace-border)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {semanticBuildFileId === (file._id as string) ? "Building..." : "Semantic"}
                    </button>
                  </div>
                </div>
              ))
            )}
            {semanticBuildError ? (
              <p className="px-2 py-2 text-sm text-[var(--workspace-danger)]">
                {semanticBuildError}
              </p>
            ) : null}
          </div>
        ) : query.trim().length === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Search original legacy file chunks without loading the full files into the workspace.
          </p>
        ) : isSearching ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Searching legacy files...
          </p>
        ) : semanticSearchError && searchMode === "semantic" ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-danger)]">
            {semanticSearchError}
          </p>
        ) : activeResults.length === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            No legacy matches.
          </p>
        ) : (
          <div className="space-y-2 px-3 py-3">
            {activeResults.map((result) => (
              <div
                key={`${result.chunkId}:${result.mode}`}
                className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-hover)] px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-xs uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                    {result.fileName} • lines {result.lineStart}-{result.lineEnd}
                  </p>
                  <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                    {result.mode === "text" ? "Text" : "Semantic"}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--workspace-text)]">
                  {result.snippet}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
