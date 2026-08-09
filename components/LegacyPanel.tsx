"use client";

import clsx from "clsx";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

const SKIP = "skip" as const;
const LEGACY_VIEWER_PAGE_CHUNKS = 3;
const LEGACY_SMALL_RENDER_CHUNK_LIMIT = 8;
const LEGACY_SMALL_RENDER_SIZE_LIMIT = 256 * 1024;

type LegacyFile = Doc<"legacyFiles">;
type LegacyChunk = Doc<"legacyChunks">;
type LegacyPanelView = "upload" | "search" | "viewer";
type LegacySearchMode = "text" | "semantic";
type LegacyViewerMode = "source" | "rendered";

type LegacySearchResult = {
  chunkId: Id<"legacyChunks">;
  fileId: Id<"legacyFiles">;
  chunkIndex: number;
  fileName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  mode: LegacySearchMode;
};

type LegacyFileViewer = {
  file: LegacyFile;
  downloadUrl: string | null;
};

type LegacyChunksPage = {
  page: LegacyChunk[];
  startChunkIndex: number;
  hasPrevious: boolean;
  hasNext: boolean;
  nextStartChunkIndex: number | null;
  previousStartChunkIndex: number;
  totalChunks: number;
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
    return "Semantic ready";
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

function joinLegacyChunks(chunks: LegacyChunk[]) {
  let text = "";
  let previousCharEnd: number | null = null;

  for (const chunk of chunks) {
    if (previousCharEnd === null) {
      text += chunk.text;
      previousCharEnd = chunk.charEnd;
      continue;
    }

    const overlap = Math.max(0, previousCharEnd - chunk.charStart);
    text += chunk.text.slice(Math.min(overlap, chunk.text.length));
    previousCharEnd = Math.max(previousCharEnd, chunk.charEnd);
  }

  return text;
}

function getLineRange(chunks: LegacyChunk[]) {
  const first = chunks.length > 0 ? chunks[0]! : null;
  const last = chunks.length > 0 ? chunks[chunks.length - 1]! : null;
  if (!first || !last) {
    return null;
  }
  return `${first.lineStart}-${last.lineEnd}`;
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={index}
          className="border border-[var(--workspace-border-subtle)] px-1 py-0.5 text-[0.92em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (
      (part.startsWith("**") && part.endsWith("**")) ||
      (part.startsWith("__") && part.endsWith("__"))
    ) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (
      (part.startsWith("*") && part.endsWith("*")) ||
      (part.startsWith("_") && part.endsWith("_"))
    ) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <span key={index}>{part}</span>;
  });
}

function LegacyMarkdownPreview({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let codeLines: string[] = [];
  let isInCodeBlock = false;

  const flushCodeBlock = (key: string) => {
    if (codeLines.length === 0) {
      return;
    }
    blocks.push(
      <pre
        key={key}
        className="overflow-x-auto border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface)] px-3 py-2 text-xs leading-5"
      >
        {codeLines.join("\n")}
      </pre>,
    );
    codeLines = [];
  };

  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (isInCodeBlock) {
        flushCodeBlock(`code-${index}`);
      }
      isInCodeBlock = !isInCodeBlock;
      return;
    }

    if (isInCodeBlock) {
      codeLines.push(line);
      return;
    }

    if (line.trim().length === 0) {
      blocks.push(<div key={`space-${index}`} className="h-3" />);
      return;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const headingClassName = clsx(
        "font-semibold text-[var(--workspace-text)]",
        level === 1 ? "mt-3 text-xl" : "mt-2 text-lg",
      );
      const headingContent = renderInlineMarkdown(heading[2]!);
      if (level === 1) {
        blocks.push(
          <h2 key={`heading-${index}`} className={headingClassName}>
            {headingContent}
          </h2>,
        );
      } else if (level === 2) {
        blocks.push(
          <h3 key={`heading-${index}`} className={headingClassName}>
            {headingContent}
          </h3>,
        );
      } else if (level === 3) {
        blocks.push(
          <h4 key={`heading-${index}`} className={headingClassName}>
            {headingContent}
          </h4>,
        );
      } else {
        blocks.push(
          <h5 key={`heading-${index}`} className={headingClassName}>
            {headingContent}
          </h5>,
        );
      }
      return;
    }

    const task = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.+)$/);
    if (task) {
      blocks.push(
        <p key={`task-${index}`} className="flex gap-2 text-sm leading-6">
          <span className="text-[var(--workspace-text-faint)]">
            {task[1]?.toLowerCase() === "x" ? "[x]" : "[ ]"}
          </span>
          <span>{renderInlineMarkdown(task[2]!)}</span>
        </p>,
      );
      return;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      blocks.push(
        <p key={`bullet-${index}`} className="flex gap-2 text-sm leading-6">
          <span className="text-[var(--workspace-text-faint)]">-</span>
          <span>{renderInlineMarkdown(bullet[1]!)}</span>
        </p>,
      );
      return;
    }

    if (line.trim().startsWith(">")) {
      blocks.push(
        <blockquote
          key={`quote-${index}`}
          className="border-l-2 border-[var(--workspace-border)] pl-3 text-sm leading-6 text-[var(--workspace-text-subtle)]"
        >
          {renderInlineMarkdown(line.trim().replace(/^>\s?/, ""))}
        </blockquote>,
      );
      return;
    }

    blocks.push(
      <p key={`paragraph-${index}`} className="text-sm leading-6 text-[var(--workspace-text)]">
        {renderInlineMarkdown(line)}
      </p>,
    );
  });

  if (isInCodeBlock) {
    flushCodeBlock("code-tail");
  }

  return <div className="space-y-1">{blocks}</div>;
}

export function LegacyPanel({
  ownerKey,
  initialView,
  initialFileId = null,
  onUploaded,
}: LegacyPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const viewerScrollRef = useRef<HTMLDivElement>(null);
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
  const [viewerFileId, setViewerFileId] = useState<Id<"legacyFiles"> | null>(initialFileId);
  const [viewerStartChunkIndex, setViewerStartChunkIndex] = useState(0);
  const [viewerMode, setViewerMode] = useState<LegacyViewerMode>("source");
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
  const viewerFileResult = useQuery(
    api.legacy.getLegacyFileViewer,
    ownerKey && view === "viewer" && viewerFileId
      ? { ownerKey, fileId: viewerFileId }
      : SKIP,
  ) as LegacyFileViewer | null | undefined;
  const viewerFile = viewerFileResult?.file ?? null;
  const viewerIsSmallFile =
    viewerFile !== null &&
    viewerFile.status === "ready" &&
    viewerFile.chunkCount > 0 &&
    viewerFile.chunkCount <= LEGACY_SMALL_RENDER_CHUNK_LIMIT &&
    viewerFile.size <= LEGACY_SMALL_RENDER_SIZE_LIMIT;
  const viewerPageSize = viewerIsSmallFile
    ? Math.max(1, viewerFile.chunkCount)
    : LEGACY_VIEWER_PAGE_CHUNKS;
  const viewerChunksPage = useQuery(
    api.legacy.listLegacyFileChunksPage,
    ownerKey && view === "viewer" && viewerFileId && viewerFile?.status === "ready"
      ? {
          ownerKey,
          fileId: viewerFileId,
          startChunkIndex: viewerIsSmallFile ? 0 : viewerStartChunkIndex,
          numChunks: viewerPageSize,
        }
      : SKIP,
  ) as LegacyChunksPage | null | undefined;
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
      setViewerFileId(initialFileId);
      setViewerStartChunkIndex(0);
    }
  }, [initialFileId]);

  useEffect(() => {
    window.setTimeout(() => {
      if (view === "upload") {
        fileInputRef.current?.focus();
      } else if (view === "search") {
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
    viewerScrollRef.current?.scrollTo({ top: 0 });
  }, [viewerFileId, viewerStartChunkIndex, view]);

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
  const activeResults = searchMode === "text" ? exactResults ?? [] : semanticResults;
  const isSearching =
    query.trim().length > 0 &&
    (searchMode === "text" ? typeof exactResults === "undefined" : isSemanticSearching);
  const viewerText = joinLegacyChunks(viewerChunksPage?.page ?? []);
  const viewerLineRange = getLineRange(viewerChunksPage?.page ?? []);
  const canRenderViewerMarkdown =
    viewerIsSmallFile && viewerFile?.extension === "md" && viewerText.trim().length > 0;

  const openViewer = (fileId: Id<"legacyFiles">, startChunkIndex = 0) => {
    setViewerFileId(fileId);
    setSelectedFileId(fileId);
    setViewerStartChunkIndex(Math.max(0, startChunkIndex));
    setView("viewer");
  };

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
      setUploadError(error instanceof Error ? error.message : "Legacy upload failed.");
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
    <div className="flex h-[min(72vh,760px)] max-h-full flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <div className="mb-4 flex flex-wrap gap-2">
          {(["upload", "search", "viewer"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setView(tab)}
              className={clsx(
                "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                view === tab
                  ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                  : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
              )}
            >
              {tab === "viewer" ? "View" : tab[0]!.toUpperCase() + tab.slice(1)}
            </button>
          ))}
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
        ) : view === "search" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {(["text", "semantic"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSearchMode(mode)}
                  className={clsx(
                    "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    searchMode === mode
                      ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                      : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  {mode === "text" ? "Find" : "Semantic"}
                </button>
              ))}
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
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <select
                value={viewerFileId ?? ""}
                onChange={(event) => {
                  const nextFileId = event.target.value as Id<"legacyFiles">;
                  setViewerFileId(nextFileId || null);
                  setSelectedFileId(nextFileId || "all");
                  setViewerStartChunkIndex(0);
                }}
                className="min-w-0 border border-[var(--workspace-border)] bg-[var(--workspace-sidebar-bg)] px-3 py-2 text-sm outline-none"
              >
                <option value="">Choose a legacy file</option>
                {sortedFiles.map((file) => (
                  <option key={file._id} value={file._id}>
                    {file.fileName}
                  </option>
                ))}
              </select>
              {viewerFileResult?.downloadUrl ? (
                <a
                  href={viewerFileResult.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  download={viewerFile?.fileName}
                  className="inline-flex items-center justify-center border border-[var(--workspace-brand)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)]"
                >
                  Download Original
                </a>
              ) : (
                <span className="inline-flex items-center justify-center border border-[var(--workspace-border)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                  Download
                </span>
              )}
            </div>
            {viewerFile ? (
              <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                <span>{formatFileSize(viewerFile.size)}</span>
                <span>{getLegacyFileStatusLabel(viewerFile)}</span>
                <span>{viewerFile.filePath}</span>
              </div>
            ) : null}
            {canRenderViewerMarkdown ? (
              <div className="flex flex-wrap gap-2">
                {(["rendered", "source"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewerMode(mode)}
                    className={clsx(
                      "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                      viewerMode === mode
                        ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                        : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                    )}
                  >
                    {mode === "rendered" ? "Rendered" : "Source"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div ref={viewerScrollRef} className="min-h-0 flex-1 overflow-y-auto">
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
                        {formatFileSize(file.size)} {" • "}
                        {getLegacyFileStatusLabel(file)} {" • "}
                        {getSemanticStatusLabel(file)}
                      </p>
                      {file.error || file.semanticError ? (
                        <p className="mt-2 text-xs leading-5 text-[var(--workspace-danger)]">
                          {file.error ?? file.semanticError}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => openViewer(file._id)}
                        disabled={file.status !== "ready"}
                        className="border border-[var(--workspace-border)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleBuildSemantic(file._id)}
                        disabled={
                          file.status !== "ready" ||
                          file.semanticStatus === "processing" ||
                          semanticBuildFileId === (file._id as string)
                        }
                        className="border border-[var(--workspace-border)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {semanticBuildFileId === (file._id as string) ? "Building..." : "Semantic"}
                      </button>
                    </div>
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
        ) : view === "search" ? (
          query.trim().length === 0 ? (
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
                <button
                  key={`${result.chunkId}:${result.mode}`}
                  type="button"
                  onClick={() => openViewer(result.fileId, result.chunkIndex)}
                  className="block w-full border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-hover)] px-4 py-3 text-left transition hover:border-[var(--workspace-accent)]"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="truncate text-xs uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      {result.fileName} {" • "} lines {result.lineStart}-{result.lineEnd}
                    </span>
                    <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                      {result.mode === "text" ? "Text" : "Semantic"}
                    </span>
                  </span>
                  <span className="mt-2 block whitespace-pre-wrap break-words text-sm leading-6 text-[var(--workspace-text)]">
                    {result.snippet}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : viewerFileId === null ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Choose a legacy file to view.
          </p>
        ) : typeof viewerFileResult === "undefined" ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Loading legacy file...
          </p>
        ) : viewerFileResult === null ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-danger)]">
            Legacy file not found.
          </p>
        ) : viewerFile?.status !== "ready" ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            {viewerFile ? getLegacyFileStatusLabel(viewerFile) : "File is not ready yet."}
          </p>
        ) : typeof viewerChunksPage === "undefined" ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            Loading file text...
          </p>
        ) : viewerChunksPage === null || viewerChunksPage.page.length === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
            No indexed text for this file.
          </p>
        ) : (
          <div className="space-y-3 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3 border border-[var(--workspace-border-subtle)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                {viewerIsSmallFile
                  ? `Full file • ${viewerChunksPage.totalChunks} chunk${viewerChunksPage.totalChunks === 1 ? "" : "s"}`
                  : `Lines ${viewerLineRange ?? "?"} • chunk ${viewerChunksPage.startChunkIndex + 1} of ${viewerChunksPage.totalChunks}`}
              </p>
              {!viewerIsSmallFile ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setViewerStartChunkIndex(viewerChunksPage.previousStartChunkIndex)
                    }
                    disabled={!viewerChunksPage.hasPrevious}
                    className="border border-[var(--workspace-border)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      viewerChunksPage.nextStartChunkIndex !== null &&
                      setViewerStartChunkIndex(viewerChunksPage.nextStartChunkIndex)
                    }
                    disabled={!viewerChunksPage.hasNext || viewerChunksPage.nextStartChunkIndex === null}
                    className="border border-[var(--workspace-border)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>

            <div className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-hover)] px-5 py-4">
              {canRenderViewerMarkdown && viewerMode === "rendered" ? (
                <LegacyMarkdownPreview text={viewerText} />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-[var(--workspace-text)]">
                  {viewerText}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
