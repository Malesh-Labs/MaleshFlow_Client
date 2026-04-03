"use client";

import clsx from "clsx";
import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { api } from "@/convex/_generated/api";
import type { ScreenshotImportNode, ScreenshotImportResult } from "@/lib/domain/screenshotImport";

type ScreenshotImportPanelProps = {
  ownerKey: string;
  canImport: boolean;
  targetLabel: string;
  onImport: (nodes: ScreenshotImportNode[]) => Promise<void>;
  onImported: () => void;
};

const IMAGE_MAX_DIMENSION = 1600;
const IMAGE_QUALITY = 0.82;

async function fileToDataUrl(file: Blob) {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read the image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error("Could not decode the pasted image."));
    nextImage.src = rawDataUrl;
  });

  const scale = Math.min(
    1,
    IMAGE_MAX_DIMENSION / Math.max(image.width, image.height),
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return rawDataUrl;
  }

  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
}

function countImportedNodes(nodes: ScreenshotImportNode[]): number {
  return nodes.reduce(
    (count, node) => count + 1 + countImportedNodes(node.children),
    0,
  );
}

function ScreenshotImportPreview({
  nodes,
  depth = 0,
}: {
  nodes: ScreenshotImportNode[];
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
            <span className="min-w-0 whitespace-pre-wrap break-words">
              {node.text}
            </span>
          </div>
          {node.children.length > 0 ? (
            <div className="mt-1">
              <ScreenshotImportPreview nodes={node.children} depth={depth + 1} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ScreenshotImportPanel({
  ownerKey,
  canImport,
  targetLabel,
  onImport,
  onImported,
}: ScreenshotImportPanelProps) {
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [parseResult, setParseResult] = useState<ScreenshotImportResult | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteZoneRef = useRef<HTMLDivElement>(null);
  const parseOutlineScreenshot = useAction(api.ai.parseOutlineScreenshot);

  useEffect(() => {
    window.setTimeout(() => {
      pasteZoneRef.current?.focus();
    }, 0);
  }, []);

  const parsedNodeCount = useMemo(
    () => countImportedNodes(parseResult?.nodes ?? []),
    [parseResult],
  );

  const applyImageFile = async (file: Blob | null) => {
    if (!file) {
      return;
    }

    setErrorMessage("");
    setStatusMessage("");
    setParseResult(null);
    try {
      const nextDataUrl = await fileToDataUrl(file);
      setImageDataUrl(nextDataUrl);
      setStatusMessage("Screenshot ready to parse.");
    } catch (error) {
      setImageDataUrl("");
      setErrorMessage(
        error instanceof Error ? error.message : "Could not read that image.",
      );
    }
  };

  const handlePaste = async (event: ClipboardEvent<HTMLDivElement>) => {
    const imageItem = [...event.clipboardData.items].find((item) =>
      item.type.startsWith("image/"),
    );
    if (!imageItem) {
      return;
    }

    event.preventDefault();
    await applyImageFile(imageItem.getAsFile());
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const imageFile =
      [...event.dataTransfer.files].find((file) => file.type.startsWith("image/")) ??
      null;
    await applyImageFile(imageFile);
  };

  const handleParse = async () => {
    if (!imageDataUrl) {
      return;
    }

    setIsParsing(true);
    setErrorMessage("");
    setStatusMessage("");
    try {
      const result = (await parseOutlineScreenshot({
        ownerKey,
        imageDataUrl,
      })) as ScreenshotImportResult;
      setParseResult(result);
      setStatusMessage("Screenshot translated into outline nodes.");
    } catch (error) {
      setParseResult(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not translate that screenshot right now.",
      );
    } finally {
      setIsParsing(false);
    }
  };

  const handleImport = async () => {
    if (!parseResult || parseResult.nodes.length === 0 || !canImport) {
      return;
    }

    setIsImporting(true);
    setErrorMessage("");
    try {
      await onImport(parseResult.nodes);
      onImported();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not import those nodes.",
      );
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="flex h-[min(78vh,820px)] flex-col">
      <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
        <p className="text-sm text-[var(--workspace-text-subtle)]">
          Paste or drop an outliner screenshot, preview the translated hierarchy, then import it into {targetLabel}.
        </p>
      </div>
      <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="border-b border-[var(--workspace-border-subtle)] p-5 md:border-b-0 md:border-r">
          <div
            ref={pasteZoneRef}
            tabIndex={0}
            onPaste={(event) => void handlePaste(event)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => void handleDrop(event)}
            className={clsx(
              "flex min-h-[260px] cursor-copy flex-col items-center justify-center border border-dashed px-5 py-6 text-center outline-none transition",
              imageDataUrl
                ? "border-[var(--workspace-border)] bg-[var(--workspace-surface)]"
                : "border-[var(--workspace-border)] text-[var(--workspace-text-subtle)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] focus:border-[var(--workspace-accent)] focus:text-[var(--workspace-text)]",
            )}
          >
            {imageDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageDataUrl}
                alt="Pasted outliner screenshot"
                className="max-h-[320px] w-auto max-w-full object-contain"
              />
            ) : (
              <>
                <p className="text-sm font-medium text-[var(--workspace-text)]">
                  Paste a screenshot here
                </p>
                <p className="mt-2 max-w-sm text-sm text-[var(--workspace-text-subtle)]">
                  Use paste, drag and drop, or choose an image file. The importer will turn visible rows into outline nodes.
                </p>
              </>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
            >
              Choose Image
            </button>
            <button
              type="button"
              onClick={() => void handleParse()}
              disabled={!imageDataUrl || isParsing}
              className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition enabled:hover:border-[var(--workspace-accent)] enabled:hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isParsing ? "Parsing…" : "Translate Screenshot"}
            </button>
            <button
              type="button"
              onClick={() => {
                setImageDataUrl("");
                setParseResult(null);
                setStatusMessage("");
                setErrorMessage("");
                if (fileInputRef.current) {
                  fileInputRef.current.value = "";
                }
              }}
              disabled={!imageDataUrl && !parseResult}
              className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition enabled:hover:border-[var(--workspace-accent)] enabled:hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void applyImageFile(event.target.files?.[0] ?? null);
              }}
            />
          </div>
          {statusMessage ? (
            <p className="mt-4 text-sm text-[var(--workspace-text-subtle)]">{statusMessage}</p>
          ) : null}
          {errorMessage ? (
            <p className="mt-4 text-sm text-[var(--workspace-danger)]">{errorMessage}</p>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              Preview
            </p>
            <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">
              {parseResult
                ? `${parsedNodeCount} node${parsedNodeCount === 1 ? "" : "s"} ready to import.`
                : "The translated outline will appear here before anything is inserted."}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {!parseResult ? (
              <p className="text-sm text-[var(--workspace-text-subtle)]">
                Large bold bullet rows will be turned into `###` heading lines, checkbox rows into tasks, and visible italic/bold emphasis into `__...__` and `**...**`.
              </p>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-[var(--workspace-text)]">
                    {parseResult.summary}
                  </p>
                  {parseResult.warnings.length > 0 ? (
                    <ul className="mt-3 space-y-2 text-sm text-[var(--workspace-text-subtle)]">
                      {parseResult.warnings.map((warning) => (
                        <li key={warning}>• {warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <ScreenshotImportPreview nodes={parseResult.nodes} />
              </div>
            )}
          </div>
          <div className="border-t border-[var(--workspace-border-subtle)] px-5 py-4">
            {!canImport ? (
              <p className="mb-3 text-sm text-[var(--workspace-text-subtle)]">
                Open a page or highlight an existing item first so the imported nodes know where to go.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleImport()}
                disabled={!parseResult || parseResult.nodes.length === 0 || !canImport || isImporting}
                className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition enabled:hover:border-[var(--workspace-accent)] enabled:hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isImporting ? "Importing…" : "Import Nodes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
