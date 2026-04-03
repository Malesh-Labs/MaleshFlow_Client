"use client";

import clsx from "clsx";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import type { MigrationChunkPlan } from "@/lib/domain/migration";

const EMPTY_MIGRATION_RUNS: Doc<"migrationRuns">[] = [];

type MigrationRunDetails = {
  run: Doc<"migrationRuns">;
  lessonsDoc: string;
  sourceDocuments: Array<{
    document: Doc<"migrationSourceDocuments">;
    totalChunks: number;
    appliedChunks: number;
    skippedChunks: number;
    reviewChunks: number;
  }>;
  nextChunk: Doc<"migrationChunks"> | null;
  recentChunks: Doc<"migrationChunks">[];
};

type RemoteSource = {
  id: string;
  title: string;
  path?: string;
};

type MigrationPanelProps = {
  ownerKey: string;
};

async function readFilesAsText(files: FileList | null) {
  if (!files) {
    return [];
  }

  const entries = await Promise.all(
    [...files].map(async (file) => ({
      path: file.webkitRelativePath || file.name,
      content: await file.text(),
    })),
  );
  return entries;
}

export function MigrationPanel({ ownerKey }: MigrationPanelProps) {
  const [sourceType, setSourceType] = useState<"dynalist" | "workflowy" | "logseq">("logseq");
  const [credential, setCredential] = useState("");
  const [availableSources, setAvailableSources] = useState<RemoteSource[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [logseqFiles, setLogseqFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [activeRunId, setActiveRunId] = useState<Id<"migrationRuns"> | null>(null);
  const [guidanceDraft, setGuidanceDraft] = useState("");
  const [lessonsDraft, setLessonsDraft] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoadingSources, setIsLoadingSources] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isApplyingToRemaining, setIsApplyingToRemaining] = useState(false);
  const [isSavingLessons, setIsSavingLessons] = useState(false);
  const [isAbandoningRun, setIsAbandoningRun] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runs = useQuery(api.migrationData.listMigrationRuns, { ownerKey }) ?? EMPTY_MIGRATION_RUNS;
  const runDetails = useQuery(api.migrationData.getMigrationRun, {
    ownerKey,
    runId: activeRunId ?? undefined,
  }) as MigrationRunDetails | null | undefined;

  const listDynalistSources = useAction(api.migration.listDynalistSources);
  const listWorkflowySources = useAction(api.migration.listWorkflowySources);
  const startDynalistMigration = useAction(api.migration.startDynalistMigration);
  const startWorkflowyMigration = useAction(api.migration.startWorkflowyMigration);
  const startLogseqMigration = useAction(api.migration.startLogseqMigration);
  const suggestMigrationChunk = useAction(api.migration.suggestMigrationChunk);
  const applyMigrationChunk = useAction(api.migration.applyMigrationChunk);
  const applyMigrationChunkToRemaining = useAction(
    api.migration.applyMigrationChunkToRemaining,
  );
  const lessonsDocEntry = useQuery(api.migrationData.getMigrationLessonsDoc, {
    ownerKey,
    sourceType: runDetails?.run.sourceType ?? sourceType,
  });
  const updateMigrationLessonsDoc = useMutation(api.migrationData.updateMigrationLessonsDoc);
  const skipMigrationChunk = useMutation(api.migrationData.skipMigrationChunk);
  const abandonMigrationRun = useMutation(api.migrationData.abandonMigrationRun);

  const latestRunId = runs[0]?._id ?? null;

  useEffect(() => {
    if (!activeRunId && latestRunId) {
      setActiveRunId(latestRunId);
    }
  }, [activeRunId, latestRunId]);

  const nextChunk = runDetails?.nextChunk ?? null;
  const suggestion = nextChunk?.suggestion as MigrationChunkPlan | undefined;

  useEffect(() => {
    if (runDetails?.run) {
      setLessonsDraft(runDetails.lessonsDoc);
      return;
    }

    if (lessonsDocEntry) {
      setLessonsDraft(lessonsDocEntry.lessonsDoc);
    }
  }, [lessonsDocEntry, runDetails?.lessonsDoc, runDetails?.run]);

  useEffect(() => {
    setGuidanceDraft(nextChunk?.guidance ?? suggestion?.reviewInstruction ?? "");
  }, [nextChunk?._id, nextChunk?.guidance, suggestion?.reviewInstruction]);

  const selectedCount = selectedSourceIds.size;
  const runProgressLabel = useMemo(() => {
    if (!runDetails?.run) {
      return "";
    }

    return `${runDetails.run.appliedChunks}/${runDetails.run.totalChunks} applied • ${runDetails.run.reviewChunks} left to review`;
  }, [runDetails?.run]);
  const remainingChunkCount = Math.max((runDetails?.run.reviewChunks ?? 0) - 1, 0);

  const handleToggleSource = (sourceId: string) => {
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  };

  const handleLoadSources = async () => {
    setErrorMessage("");
    setStatusMessage("");
    setIsLoadingSources(true);
    try {
      const sources =
        sourceType === "dynalist"
          ? ((await listDynalistSources({
              ownerKey,
              apiToken: credential.trim(),
            })) as RemoteSource[])
          : ((await listWorkflowySources({
              ownerKey,
              apiKey: credential.trim(),
            })) as RemoteSource[]);
      setAvailableSources(sources);
      setSelectedSourceIds(new Set(sources.map((source) => source.id)));
      setStatusMessage(`Loaded ${sources.length} ${sourceType === "dynalist" ? "Dynalist documents" : "WorkFlowy roots"}.`);
    } catch (error) {
      setAvailableSources([]);
      setSelectedSourceIds(new Set());
      setErrorMessage(
        error instanceof Error ? error.message : "Could not load remote sources.",
      );
    } finally {
      setIsLoadingSources(false);
    }
  };

  const handleChooseLogseqFiles = async (files: FileList | null) => {
    const entries = await readFilesAsText(files);
    setLogseqFiles(entries);
    setStatusMessage(
      entries.length > 0 ? `Loaded ${entries.length} Markdown file${entries.length === 1 ? "" : "s"}.` : "",
    );
    setErrorMessage("");
  };

  const handleStartRun = async () => {
    setErrorMessage("");
    setStatusMessage("");
    setIsStartingRun(true);
    try {
      const result =
        sourceType === "dynalist"
          ? ((await startDynalistMigration({
              ownerKey,
              apiToken: credential.trim(),
              documentIds: [...selectedSourceIds],
            })) as { runId: Id<"migrationRuns"> })
          : sourceType === "workflowy"
            ? ((await startWorkflowyMigration({
                ownerKey,
                apiKey: credential.trim(),
                rootIds: [...selectedSourceIds],
              })) as { runId: Id<"migrationRuns"> })
            : ((await startLogseqMigration({
                ownerKey,
                files: logseqFiles,
              })) as { runId: Id<"migrationRuns"> });

      setActiveRunId(result.runId);
      setStatusMessage("Migration run created.");
      setAvailableSources([]);
      setSelectedSourceIds(new Set());
      setCredential("");
      setLogseqFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not start migration.",
      );
    } finally {
      setIsStartingRun(false);
    }
  };

  const handleSuggest = async () => {
    if (!nextChunk) {
      return;
    }

    setIsSuggesting(true);
    setErrorMessage("");
    try {
      await suggestMigrationChunk({
        ownerKey,
        chunkId: nextChunk._id,
        guidance: guidanceDraft.trim() || undefined,
      });
      setStatusMessage("Suggestion updated.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not generate a migration suggestion.",
      );
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleApply = async () => {
    if (!nextChunk) {
      return;
    }

    setIsApplying(true);
    setErrorMessage("");
    try {
      await applyMigrationChunk({
        ownerKey,
        chunkId: nextChunk._id,
      });
      setStatusMessage("Chunk applied.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not apply the migration chunk.",
      );
    } finally {
      setIsApplying(false);
    }
  };

  const handleSkip = async () => {
    if (!nextChunk) {
      return;
    }

    setErrorMessage("");
    try {
      await skipMigrationChunk({
        ownerKey,
        chunkId: nextChunk._id,
      });
      setStatusMessage("Chunk skipped.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not skip the chunk.",
      );
    }
  };

  const handleApplyToRemaining = async () => {
    if (!nextChunk || !suggestion || remainingChunkCount <= 0) {
      return;
    }

    const confirmed = window.confirm(
      `Apply this same migration principle to the remaining ${remainingChunkCount} chunk${remainingChunkCount === 1 ? "" : "s"} in this run? This will immediately process them using the current approved strategy, while still adapting titles and destinations per source document.`,
    );
    if (!confirmed) {
      return;
    }

    setIsApplyingToRemaining(true);
    setErrorMessage("");
    try {
      const result = (await applyMigrationChunkToRemaining({
        ownerKey,
        chunkId: nextChunk._id,
      })) as {
        appliedChunks: number;
        skippedChunks: number;
        errorChunks: number;
        totalProcessed: number;
      };
      setStatusMessage(
        `Processed ${result.totalProcessed} chunk${result.totalProcessed === 1 ? "" : "s"} • ${result.appliedChunks} applied${result.skippedChunks > 0 ? ` • ${result.skippedChunks} skipped` : ""}${result.errorChunks > 0 ? ` • ${result.errorChunks} errors` : ""}.`,
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not apply this principle to the remaining chunks.",
      );
    } finally {
      setIsApplyingToRemaining(false);
    }
  };

  const handleSaveLessons = async () => {
    setIsSavingLessons(true);
    setErrorMessage("");
    try {
      await updateMigrationLessonsDoc({
        ownerKey,
        sourceType: runDetails?.run.sourceType ?? sourceType,
        runId: runDetails?.run?._id,
        lessonsDoc: lessonsDraft,
      });
      setStatusMessage("Lessons doc saved.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not save the lessons doc.",
      );
    } finally {
      setIsSavingLessons(false);
    }
  };

  const handleAbandonRun = async () => {
    if (!runDetails?.run) {
      return;
    }

    const confirmed = window.confirm(
      `Abandon "${runDetails.run.title}"? You can start a new ${runDetails.run.sourceType} migration afterward, but this run will stop being treated as active.`,
    );
    if (!confirmed) {
      return;
    }

    setIsAbandoningRun(true);
    setErrorMessage("");
    try {
      await abandonMigrationRun({
        ownerKey,
        runId: runDetails.run._id,
      });
      setStatusMessage("Migration run abandoned.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not abandon the migration run.",
      );
    } finally {
      setIsAbandoningRun(false);
    }
  };

  const destinationDetails = suggestion?.destination ?? null;
  const previewContentLines = (nextChunk?.preview ?? []).slice(
    suggestion?.action === "skip" ? 1 : 2,
  );

  return (
    <div className="grid h-[min(82vh,920px)] grid-cols-1 gap-0 overflow-hidden md:grid-cols-[1.1fr_0.9fr]">
      <div className="flex min-h-0 flex-col border-r border-[var(--workspace-border-subtle)]">
        <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
          <p className="text-xs uppercase tracking-[0.22em] text-[var(--workspace-accent)]">
            Migration
          </p>
          <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">
            Snapshot a source, review chunk-by-chunk suggestions, then explicitly approve each change before it touches the workspace.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section className="border border-[var(--workspace-border)] bg-[var(--workspace-surface)] p-4">
            <div className="flex flex-wrap gap-2">
              {(["dynalist", "workflowy", "logseq"] as const).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => {
                    setSourceType(entry);
                    setAvailableSources([]);
                    setSelectedSourceIds(new Set());
                    setStatusMessage("");
                    setErrorMessage("");
                  }}
                  className={clsx(
                    "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    sourceType === entry
                      ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                      : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  {entry}
                </button>
              ))}
            </div>

            {sourceType === "logseq" ? (
              <div className="mt-4 space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md"
                  multiple
                  onChange={(event) => {
                    void handleChooseLogseqFiles(event.target.files);
                  }}
                  className="block w-full text-sm text-[var(--workspace-text-subtle)] file:mr-4 file:border file:border-[var(--workspace-border)] file:bg-transparent file:px-3 file:py-2 file:text-xs file:font-semibold file:uppercase file:tracking-[0.18em] file:text-[var(--workspace-text-muted)]"
                />
                <p className="text-xs uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                  {logseqFiles.length} file{logseqFiles.length === 1 ? "" : "s"} ready
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <input
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  type="password"
                  placeholder={sourceType === "dynalist" ? "Dynalist API token…" : "WorkFlowy API key…"}
                  className="w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
                />
                <button
                  type="button"
                  disabled={credential.trim().length === 0 || isLoadingSources}
                  onClick={() => void handleLoadSources()}
                  className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLoadingSources ? "Loading…" : "Load Sources"}
                </button>
              </div>
            )}

            {availableSources.length > 0 ? (
              <div className="mt-4 max-h-64 overflow-y-auto border border-[var(--workspace-border-subtle)]">
                {availableSources.map((source) => {
                  const selected = selectedSourceIds.has(source.id);
                  return (
                    <label
                      key={source.id}
                      className="flex cursor-pointer items-start gap-3 border-b border-[var(--workspace-border-subtle)] px-3 py-3 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => handleToggleSource(source.id)}
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-[var(--workspace-text)]">
                          {source.title}
                        </span>
                        {source.path ? (
                          <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                            {source.path}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={
                  isStartingRun ||
                  (sourceType === "logseq"
                    ? logseqFiles.length === 0
                    : selectedSourceIds.size === 0 || credential.trim().length === 0)
                }
                onClick={() => void handleStartRun()}
                className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isStartingRun ? "Starting…" : "Start Migration"}
              </button>
              <span className="text-xs uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                {sourceType === "logseq"
                  ? `${logseqFiles.length} selected`
                  : `${selectedCount} selected`}
              </span>
            </div>

            {statusMessage ? (
              <p className="mt-3 text-sm text-[var(--workspace-accent)]">{statusMessage}</p>
            ) : null}
            {errorMessage ? (
              <p className="mt-3 text-sm text-[var(--workspace-danger)]">{errorMessage}</p>
            ) : null}
          </section>

          {runDetails?.run ? (
            <section className="mt-5 border border-[var(--workspace-border)] bg-[var(--workspace-surface)]">
              <div className="border-b border-[var(--workspace-border-subtle)] px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-[var(--workspace-text)]">
                      {runDetails.run.title}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      {runDetails.run.sourceSummary}
                    </p>
                  </div>
                  <select
                    value={activeRunId ?? ""}
                    onChange={(event) =>
                      setActiveRunId((event.target.value || null) as Id<"migrationRuns"> | null)
                    }
                    className="border border-[var(--workspace-border)] bg-transparent px-2 py-1 text-xs uppercase tracking-[0.18em] text-[var(--workspace-text-muted)]"
                  >
                    {runs.map((run) => (
                      <option key={run._id} value={run._id}>
                        {run.title}
                      </option>
                    ))}
                  </select>
                </div>
                    <p className="mt-3 text-xs uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                  {runProgressLabel}
                  {runDetails.run.status === "abandoned" ? " • abandoned" : ""}
                    </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={isAbandoningRun || runDetails.run.status === "abandoned"}
                    onClick={() => void handleAbandonRun()}
                    className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-danger)] hover:text-[var(--workspace-danger)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isAbandoningRun ? "Abandoning…" : "Abandon Run"}
                  </button>
                </div>
              </div>

              {nextChunk ? (
                <div className="space-y-4 px-4 py-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      Next chunk
                    </p>
                    <p className="mt-1 text-sm text-[var(--workspace-text)]">
                      {(runDetails.sourceDocuments.find(
                        (entry) => entry.document._id === nextChunk.sourceDocumentEntryId,
                      )?.document.title ?? "Source document")}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      {nextChunk.lineCount} lines • {nextChunk.status.replace(/_/g, " ")}
                    </p>
                  </div>

                  <div className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-muted)] p-3">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      Chunk preview
                    </p>
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-[var(--workspace-text)]">
                      {nextChunk.chunkText}
                    </pre>
                  </div>

                  <div>
                    <label className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      Guidance for this chunk
                    </label>
                    <textarea
                      value={guidanceDraft}
                      onChange={(event) => setGuidanceDraft(event.target.value)}
                      className="mt-2 h-28 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
                    />
                  </div>

                  {suggestion ? (
                    <div className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-muted)] p-3">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                        Proposed changes
                      </p>
                      <p className="mt-2 text-sm font-medium text-[var(--workspace-text)]">
                        {suggestion.summary}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[var(--workspace-text-subtle)]">
                        {suggestion.rationale}
                      </p>
                      <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <div className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface)] p-3">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                            Target
                          </p>
                          <p className="mt-2 text-sm text-[var(--workspace-text)]">
                            {suggestion.action === "skip"
                              ? "Skip this chunk"
                              : suggestion.action === "create_page"
                                ? "Create page"
                                : "Append to existing run page"}
                          </p>
                          {destinationDetails ? (
                            <div className="mt-3 space-y-2 text-sm text-[var(--workspace-text-subtle)]">
                              <p>Page: {destinationDetails.title}</p>
                              <p>Type: {destinationDetails.pageType}</p>
                              <p>Visibility: {destinationDetails.archived ? "Archived" : "Active"}</p>
                              <p>
                                Section: {destinationDetails.sectionSlot ?? "Main outline"}
                              </p>
                              <p>
                                Transforms:
                                {` ${suggestion.transforms.stripTags ? "strip tags" : "keep tags"}, ${suggestion.transforms.omitEmptyLines ? "omit empty lines" : "keep empty lines"}, ${suggestion.transforms.flattenUnresolvedLinks ? "flatten unresolved links" : "keep unresolved links"}, ${suggestion.transforms.forceKind ? `force ${suggestion.transforms.forceKind}s` : "keep original kinds"}`}
                              </p>
                            </div>
                          ) : (
                            <p className="mt-3 text-sm text-[var(--workspace-text-subtle)]">
                              No destination page will be changed.
                            </p>
                          )}
                        </div>
                        <div className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface)] p-3">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                            Imported preview
                          </p>
                          <div className="mt-2 space-y-2">
                            {previewContentLines.length > 0 ? (
                              previewContentLines.map((line, index) => (
                                <p
                                  key={`${nextChunk._id}:preview:${index}`}
                                  className="whitespace-pre-wrap break-words text-sm text-[var(--workspace-text)]"
                                >
                                  {line}
                                </p>
                              ))
                            ) : (
                              <p className="text-sm text-[var(--workspace-text-subtle)]">
                                No imported lines preview available.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={isSuggesting}
                      onClick={() => void handleSuggest()}
                      className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-wait disabled:opacity-60"
                    >
                      {isSuggesting
                        ? "Generating…"
                        : suggestion
                          ? "Regenerate Suggestion"
                          : "Generate Suggestion"}
                    </button>
                    <button
                      type="button"
                      disabled={!suggestion || isApplying || isApplyingToRemaining}
                      onClick={() => void handleApply()}
                      className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition hover:bg-[var(--workspace-brand-hover)] disabled:cursor-wait disabled:opacity-60"
                    >
                      {isApplying ? "Applying…" : "Approve & Apply"}
                    </button>
                    {remainingChunkCount > 0 ? (
                      <button
                        type="button"
                        disabled={!suggestion || isApplying || isApplyingToRemaining}
                        onClick={() => void handleApplyToRemaining()}
                        className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-wait disabled:opacity-60"
                      >
                        {isApplyingToRemaining
                          ? "Applying to Rest…"
                          : `Apply to Rest (${remainingChunkCount})`}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={isApplying || isApplyingToRemaining}
                      onClick={() => void handleSkip()}
                      className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                    >
                      Deny / Skip
                    </button>
                  </div>
                </div>
              ) : (
                <div className="px-4 py-5">
                  <p className="text-sm text-[var(--workspace-text-subtle)]">
                    {runDetails.run.status === "abandoned"
                      ? "This migration run was abandoned. Start a new run from the same source app whenever you're ready."
                      : "No chunks are waiting for review in this run."}
                  </p>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-col">
        <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
          <p className="text-xs uppercase tracking-[0.22em] text-[var(--workspace-accent)]">
            Lessons + Progress
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section className="border border-[var(--workspace-border)] bg-[var(--workspace-surface)] p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-[var(--workspace-text)]">
                App lessons doc
              </p>
              <button
                type="button"
                disabled={isSavingLessons}
                onClick={() => void handleSaveLessons()}
                className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-wait disabled:opacity-60"
              >
                {isSavingLessons ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              {runDetails?.run?.sourceType ?? sourceType}
            </p>
            <textarea
              value={lessonsDraft}
              onChange={(event) => setLessonsDraft(event.target.value)}
              placeholder="Approved migration lessons will appear here."
              className="mt-3 h-72 w-full border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm leading-6 outline-none transition focus:border-[var(--workspace-accent)]"
            />
          </section>

          {runDetails?.sourceDocuments?.length ? (
            <section className="mt-5 border border-[var(--workspace-border)] bg-[var(--workspace-surface)]">
              <div className="border-b border-[var(--workspace-border-subtle)] px-4 py-3">
                <p className="text-sm font-medium text-[var(--workspace-text)]">
                  Source documents
                </p>
              </div>
              <div className="divide-y divide-[var(--workspace-border-subtle)]">
                {runDetails.sourceDocuments.map((entry) => (
                  <div key={entry.document._id} className="px-4 py-3">
                    <p className="text-sm font-medium text-[var(--workspace-text)]">
                      {entry.document.title}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      {entry.appliedChunks}/{entry.totalChunks} applied • {entry.reviewChunks} left
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {runDetails?.recentChunks?.length ? (
            <section className="mt-5 border border-[var(--workspace-border)] bg-[var(--workspace-surface)]">
              <div className="border-b border-[var(--workspace-border-subtle)] px-4 py-3">
                <p className="text-sm font-medium text-[var(--workspace-text)]">
                  Recent chunks
                </p>
              </div>
              <div className="divide-y divide-[var(--workspace-border-subtle)]">
                {runDetails.recentChunks.map((chunk) => (
                  <div key={chunk._id} className="px-4 py-3">
                    <p className="text-sm text-[var(--workspace-text)]">
                      Chunk {chunk.order + 1}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                      {chunk.status.replace(/_/g, " ")} • {chunk.lineCount} lines
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
