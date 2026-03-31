"use client";

import clsx from "clsx";
import { useAction, useConvexConnectionState, useMutation, useQuery } from "convex/react";
import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ErrorInfo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type ReactNode,
  type KeyboardEvent as TextareaKeyboardEvent,
  type ClipboardEvent as TextareaClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import { createPortal } from "react-dom";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { buildOutlineTree, type OutlineTreeNode } from "@/lib/domain/outline";
import { extractLinkMatches } from "@/lib/domain/links";
import {
  buildNodeSelectionIds,
  filterPagesForCommandPalette,
} from "@/lib/domain/workspaceUi";
import {
  WorkspaceHistoryProvider,
  focusElementAtEnd,
  getComposerEditorId,
  getNodeEditorId,
  getPageTitleEditorId,
  type CreatedNodeSnapshot,
  type HistoryEntry,
  type NodePlacement,
  type NodeValueSnapshot,
  type TrackedEditorTarget,
  useWorkspaceHistory,
  useWorkspaceHistoryController,
} from "@/components/workspaceHistory";

const SKIP = "skip" as const;
const SIDEBAR_SECTIONS = [
  "Models",
  "Tasks",
  "Templates",
  "Journal",
  "Scratchpads",
] as const;
const OWNER_KEY_STORAGE_KEY = "maleshflow-owner-key";
const OWNER_KEY_EVENT = "maleshflow-owner-key-change";
const LAST_PAGE_STORAGE_KEY = "maleshflow-last-page-id";
const SIDEBAR_COLLAPSE_STORAGE_KEY = "maleshflow-sidebar-collapsed";
const COLLAPSED_NODES_STORAGE_KEY = "maleshflow-collapsed-node-ids";
const WORKSPACE_AI_DOCK_COLLAPSE_STORAGE_KEY = "maleshflow-workspace-ai-dock-collapsed";
const NODE_DRAG_MIME_TYPE = "application/x-maleshflow-node";
const WORKSPACE_AI_DOCK_TEXTAREA_ID = "workspace-ai-dock-textarea";
const MODEL_REGENERATE_PROMPT =
  "Regenerate the Model section using the current Model lines and the Recent section as context. Refine it into a concise, useful model while preserving important intent and signal.";
const SIDEBAR_MOBILE_INDENT_STEP = 12;

type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
type PageType = "default" | "task" | "model" | "journal" | "scratchpad";
type PageDoc = Doc<"pages">;
type PageTreeResult = {
  page: PageDoc;
  nodes: Doc<"nodes">[];
  backlinks: Doc<"links">[];
};
type PaletteMode = "pages" | "find" | "nodes";
const PALETTE_MODE_ORDER: PaletteMode[] = ["pages", "find", "nodes"];
type NodeSearchResult = {
  node: Doc<"nodes">;
  page: PageDoc | null;
  score?: number;
  content?: string;
};
type LinkTargetSearchResults = {
  pages: PageDoc[];
  nodes: Array<{
    node: Doc<"nodes">;
    page: PageDoc | null;
  }>;
};
type NodeLinkTargetResolution = {
  nodeId: Id<"nodes">;
  pageId: Id<"pages"> | null;
  text: string;
  archived: boolean;
  pageArchived: boolean;
};
type LinkSuggestion =
  | {
      key: string;
      kind: "page";
      title: string;
      subtitle: string;
      insertText: string;
    }
  | {
      key: string;
      kind: "node";
      title: string;
      subtitle: string;
      insertText: string;
    };
type LinkPreviewSegment =
  | {
      key: string;
      kind: "text";
      text: string;
    }
  | {
      key: string;
      kind: "link";
      text: string;
      pageId: Id<"pages"> | null;
      nodeId: Id<"nodes"> | null;
      archived: boolean;
      resolved: boolean;
      linkKind: "page" | "node";
      pageTypeLabel?: string | null;
    };
type WorkspaceKnowledgeSourceSnapshot = {
  nodeId: string;
  pageId: string | null;
  nodeText: string;
  pageTitle: string | null;
  nodeKind: string;
  content: string | null;
};
type WorkspaceKnowledgeMessageMetadata = {
  kind: "knowledge_response";
  model: string;
  error: string | null;
  sources: WorkspaceKnowledgeSourceSnapshot[];
};
type DraggedNodePayload = {
  nodeId: string;
  pageId: string;
  parentNodeId: string | null;
  previousSiblingId: string | null;
};
type PendingInsertedComposer = {
  pageId: string;
  parentNodeId: string | null;
  afterNodeId: string;
  focusToken: number;
};
type NodeDropTarget = {
  placement: "before" | "after" | "nest";
  parentNodeId: Id<"nodes"> | null;
  afterNodeId: Id<"nodes"> | null;
  lineSide: "top" | "bottom";
  lineIndentOffset: number;
};
type UpdateNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.updateNode>>;
type CreateNodesBatchMutation = ReturnType<typeof useMutation<typeof api.workspace.createNodesBatch>>;
type MoveNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.moveNode>>;
type SplitNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.splitNode>>;
type ReplaceNodeAndInsertSiblingsMutation = ReturnType<
  typeof useMutation<typeof api.workspace.replaceNodeAndInsertSiblings>
>;
type SetNodeTreeArchivedMutation = ReturnType<
  typeof useMutation<typeof api.workspace.setNodeTreeArchived>
>;

type WorkspaceErrorBoundaryProps = {
  ownerKey: string;
  onLockWorkspace: () => void;
  children: ReactNode;
};

type WorkspaceErrorBoundaryState = {
  error: Error | null;
  componentStack: string;
  resetKey: number;
};

type SectionSlot =
  | "taskSidebar"
  | "model"
  | "recentExamples"
  | "journalThoughts"
  | "journalFeedback"
  | "scratchpadLive"
  | "scratchpadPrevious";

type TreeNode = OutlineTreeNode<{
  _id: string;
  pageId: string;
  parentNodeId: string | null;
  position: number;
  updatedAt: number;
  text: string;
  kind: string;
  taskStatus: string | null;
  priority: string | null;
  dueAt: number | null;
  archived: boolean;
  sourceMeta?: Record<string, unknown> | null;
}>;

function useOwnerKey() {
  const ownerKey = useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined") {
        return () => undefined;
      }

      const listener = () => onChange();
      window.addEventListener("storage", listener);
      window.addEventListener(OWNER_KEY_EVENT, listener);

      return () => {
        window.removeEventListener("storage", listener);
        window.removeEventListener(OWNER_KEY_EVENT, listener);
      };
    },
    () => {
      if (typeof window === "undefined") {
        return "";
      }

      return window.localStorage.getItem(OWNER_KEY_STORAGE_KEY) ?? "";
    },
    () => "",
  );

  const updateOwnerKey = (nextValue: string) => {
    if (typeof window === "undefined") {
      return;
    }

    if (nextValue.trim().length > 0) {
      window.localStorage.setItem(OWNER_KEY_STORAGE_KEY, nextValue);
    } else {
      window.localStorage.removeItem(OWNER_KEY_STORAGE_KEY);
    }

    window.dispatchEvent(new Event(OWNER_KEY_EVENT));
  };

  return { ownerKey, setOwnerKey: updateOwnerKey };
}

function useIsMobileLayout() {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined") {
        return () => {};
      }

      const mediaQuery = window.matchMedia("(max-width: 767px)");
      const handleChange = () => onStoreChange();

      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handleChange);
        return () => mediaQuery.removeEventListener("change", handleChange);
      }

      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    },
    () =>
      typeof window !== "undefined"
        ? window.matchMedia("(max-width: 767px)").matches
        : false,
    () => false,
  );
}

function toTreeNodes(nodes: Doc<"nodes">[]) {
  return buildOutlineTree(
    nodes.map((node) => ({
      ...node,
      _id: node._id as string,
      pageId: node.pageId as string,
      parentNodeId: node.parentNodeId ? (node.parentNodeId as string) : null,
    })),
  ) as TreeNode[];
}

class WorkspaceErrorBoundary extends Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  state: WorkspaceErrorBoundaryState = {
    error: null,
    componentStack: "",
    resetKey: 0,
  };

  static getDerivedStateFromError(error: Error): Partial<WorkspaceErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Workspace render failed", error, errorInfo);
    this.setState({
      error,
      componentStack: errorInfo.componentStack ?? "",
    });
  }

  componentDidUpdate(prevProps: WorkspaceErrorBoundaryProps) {
    if (prevProps.ownerKey !== this.props.ownerKey && this.state.error) {
      this.handleReset();
    }
  }

  handleReset = () => {
    this.setState((currentState) => ({
      error: null,
      componentStack: "",
      resetKey: currentState.resetKey + 1,
    }));
  };

  render() {
    if (this.state.error) {
      return (
        <main className="min-h-screen bg-[var(--workspace-bg)] px-6 py-8 text-[var(--workspace-text)]">
          <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-4xl items-center">
            <div className="w-full border border-[var(--workspace-danger)] bg-[var(--workspace-surface)] p-6 shadow-[0_24px_80px_-40px_rgba(0,0,0,0.45)]">
              <p className="text-xs uppercase tracking-[0.22em] text-[var(--workspace-danger)]">
                Workspace Error
              </p>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight">
                Something crashed while loading the workspace
              </h1>
              <p className="mt-3 text-sm leading-6 text-[var(--workspace-text-subtle)]">
                The real error is surfaced below so we can debug it quickly.
              </p>

              <div className="mt-5 space-y-4">
                <div className="border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-subtle)]">
                    Message
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm leading-6 text-[var(--workspace-text)]">
                    {this.state.error.message || String(this.state.error)}
                  </pre>
                </div>

                {this.state.error.stack ? (
                  <div className="border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-subtle)]">
                      Stack
                    </p>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[var(--workspace-text-subtle)]">
                      {this.state.error.stack}
                    </pre>
                  </div>
                ) : null}

                {this.state.componentStack ? (
                  <div className="border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-subtle)]">
                      Component Stack
                    </p>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-[var(--workspace-text-subtle)]">
                      {this.state.componentStack.trim()}
                    </pre>
                  </div>
                ) : null}
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={this.handleReset}
                  className="border border-[var(--workspace-border)] px-4 py-2 text-sm transition hover:bg-[var(--workspace-surface-muted)]"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => {
                    this.handleReset();
                    this.props.onLockWorkspace();
                  }}
                  className="border border-[var(--workspace-border)] px-4 py-2 text-sm transition hover:bg-[var(--workspace-surface-muted)]"
                >
                  Lock workspace
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      window.location.reload();
                    }
                  }}
                  className="bg-[var(--workspace-brand)] px-4 py-2 text-sm font-medium text-[var(--workspace-inverse-text)] transition hover:bg-[var(--workspace-brand-hover)]"
                >
                  Reload page
                </button>
              </div>
            </div>
          </div>
        </main>
      );
    }

    return <div key={this.state.resetKey}>{this.props.children}</div>;
  }
}

function getPageMeta(page: Doc<"pages"> | null | undefined) {
  const sourceMeta =
    page && typeof page.sourceMeta === "object" && page.sourceMeta
      ? (page.sourceMeta as Record<string, unknown>)
      : {};

  const sidebarSection = SIDEBAR_SECTIONS.includes(sourceMeta.sidebarSection as SidebarSection)
    ? (sourceMeta.sidebarSection as SidebarSection)
    : "Tasks";
  const pageType: PageType =
    sourceMeta.pageType === "model"
      ? "model"
      : sourceMeta.pageType === "journal"
        ? "journal"
        : sourceMeta.pageType === "scratchpad"
          ? "scratchpad"
          : sourceMeta.pageType === "task" || sourceMeta.sidebarSection === "Tasks"
            ? "task"
          : "default";

  return { sidebarSection, pageType };
}

function getPageTypeLabel(page: Doc<"pages"> | null | undefined) {
  return getPageTypeLabelForSection(getPageMeta(page).sidebarSection);
}

function getPageTypeLabelForSection(sidebarSection: SidebarSection) {
  switch (sidebarSection) {
    case "Models":
      return "Model";
    case "Tasks":
      return "Task";
    case "Templates":
      return "Template";
    case "Journal":
      return "Journal";
    case "Scratchpads":
      return "Scratchpad";
    default:
      return "Page";
  }
}

function getPageTypeDisplayLabel(page: Doc<"pages"> | null | undefined) {
  if (!page) {
    return "Page";
  }

  const baseLabel = getPageTypeLabel(page);
  return page.archived ? `${baseLabel} (archived)` : baseLabel;
}

function isTextEntryElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.closest("input, textarea, [contenteditable='true']") !== null
  );
}

function flattenTreeNodes(nodes: TreeNode[], collapsedNodeIds?: Set<string>): TreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(collapsedNodeIds?.has(node._id)
      ? []
      : flattenTreeNodes(node.children, collapsedNodeIds)),
  ]);
}

function getNodeMeta(node: Doc<"nodes"> | TreeNode | null | undefined) {
  if (!node || typeof node.sourceMeta !== "object" || !node.sourceMeta) {
    return {};
  }

  return node.sourceMeta as Record<string, unknown>;
}

function findSectionNode(nodes: TreeNode[], slot: SectionSlot) {
  return nodes.find((node) => getNodeMeta(node).sectionSlot === slot) ?? null;
}

function formatLocalDateTitle(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeNodeSearchResults(results: unknown[]): NodeSearchResult[] {
  const normalizedResults: Array<NodeSearchResult | null> = results.map((result) => {
    if (!result || typeof result !== "object") {
      return null;
    }

    const record = result as {
      node?: Doc<"nodes">;
      page?: PageDoc | null;
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

  return normalizedResults.filter(
    (result): result is NodeSearchResult => result !== null,
  );
}

function sanitizeLinkLabel(value: string) {
  return value.replace(/\|/g, "/").replace(/\]\]/g, "] ]").trim() || "Untitled node";
}

function normalizePageTitleKey(value: string) {
  return value.trim().toLowerCase();
}

function readPageIdFromLocation() {
  if (typeof window === "undefined") {
    return null;
  }

  const url = new URL(window.location.href);
  return url.searchParams.get("page");
}

function focusWorkspaceAiDock() {
  if (typeof document === "undefined") {
    return;
  }

  const input = document.getElementById(WORKSPACE_AI_DOCK_TEXTAREA_ID);
  if (input instanceof HTMLTextAreaElement) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

function writePageIdToHistory(pageId: string | null, mode: "push" | "replace" = "push") {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("node");
  if (pageId) {
    url.searchParams.set("page", pageId);
  } else {
    url.searchParams.delete("page");
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (mode === "replace") {
    window.history.replaceState({}, "", nextUrl);
    return;
  }

  window.history.pushState({}, "", nextUrl);
}

function buildNodeLinkInsertText(node: Doc<"nodes">) {
  return `[[${sanitizeLinkLabel(node.text)}|node:${node._id}]]`;
}

function buildNodeClipboardLink(node: Pick<Doc<"nodes">, "_id" | "text">) {
  return `[[${sanitizeLinkLabel(node.text)}|node:${node._id}]]`;
}

function getNodeIdFromTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  return target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? null;
}

function resolveExplicitKnowledgeLinkTargets(
  value: string,
  pagesByTitle: Map<string, PageDoc>,
) {
  const linkedPageIds = new Set<Id<"pages">>();
  const linkedNodeIds = new Set<Id<"nodes">>();

  for (const match of extractLinkMatches(value)) {
    if (match.link.kind === "page") {
      const page = pagesByTitle.get(normalizePageTitleKey(match.link.targetPageTitle));
      if (page && !page.archived) {
        linkedPageIds.add(page._id);
      }
      continue;
    }

    linkedNodeIds.add(match.link.targetNodeRef as Id<"nodes">);
  }

  return {
    linkedPageIds: [...linkedPageIds],
    linkedNodeIds: [...linkedNodeIds],
  };
}

function readWorkspaceKnowledgeMessageMetadata(
  message: Doc<"chatMessages">,
): WorkspaceKnowledgeMessageMetadata | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  if (record.kind !== "knowledge_response") {
    return null;
  }

  const rawSources = Array.isArray(record.sources) ? record.sources : [];
  const sources = rawSources
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const sourceRecord = entry as Record<string, unknown>;
      if (typeof sourceRecord.nodeId !== "string") {
        return null;
      }

      return {
        nodeId: sourceRecord.nodeId,
        pageId: typeof sourceRecord.pageId === "string" ? sourceRecord.pageId : null,
        nodeText: typeof sourceRecord.nodeText === "string" ? sourceRecord.nodeText : "",
        pageTitle:
          typeof sourceRecord.pageTitle === "string" ? sourceRecord.pageTitle : null,
        nodeKind:
          typeof sourceRecord.nodeKind === "string" ? sourceRecord.nodeKind : "note",
        content: typeof sourceRecord.content === "string" ? sourceRecord.content : null,
      } satisfies WorkspaceKnowledgeSourceSnapshot;
    })
    .filter(
      (entry): entry is WorkspaceKnowledgeSourceSnapshot => entry !== null,
    );

  return {
    kind: "knowledge_response",
    model: typeof record.model === "string" ? record.model : "gpt-5-mini",
    error: typeof record.error === "string" ? record.error : null,
    sources,
  };
}

function getActiveLinkToken(value: string, caretPosition: number | null) {
  if (caretPosition === null) {
    return null;
  }

  const beforeCaret = value.slice(0, caretPosition);
  const startIndex = beforeCaret.lastIndexOf("[[");
  if (startIndex === -1) {
    return null;
  }

  const inner = beforeCaret.slice(startIndex + 2);
  if (inner.includes("]]") || inner.includes("\n") || inner.includes("|node:")) {
    return null;
  }

  return {
    startIndex,
    endIndex: caretPosition,
    query: inner,
  };
}

function buildLinkSuggestions(results: LinkTargetSearchResults | undefined): LinkSuggestion[] {
  if (!results) {
    return [];
  }

  const pageSuggestions: LinkSuggestion[] = results.pages.map((page) => ({
    key: `page:${page._id}`,
    kind: "page",
    title: page.title,
    subtitle: "Page",
    insertText: `[[${page.title}]]`,
  }));

  const nodeSuggestions: LinkSuggestion[] = results.nodes
    .filter((entry) => entry.page !== null)
    .map((entry) => ({
      key: `node:${entry.node._id}`,
      kind: "node",
      title: sanitizeLinkLabel(entry.node.text),
      subtitle: entry.page ? `Node • ${entry.page.title}` : "Node",
      insertText: buildNodeLinkInsertText(entry.node),
    }));

  return [...pageSuggestions, ...nodeSuggestions];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function useFloatingMenuPosition(
  anchorRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    if (!isOpen || typeof window === "undefined" || !anchorRef.current) {
      setPosition(null);
      return;
    }

    const rect = anchorRef.current.getBoundingClientRect();
    const viewportPadding = 16;
    const width = Math.min(
      460,
      Math.max(280, Math.min(rect.width, window.innerWidth - viewportPadding * 2)),
    );
    const left = clamp(
      rect.left,
      viewportPadding,
      window.innerWidth - width - viewportPadding,
    );
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const placeAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      160,
      Math.min(360, (placeAbove ? spaceAbove : spaceBelow) - 8),
    );
    const top = placeAbove
      ? Math.max(viewportPadding, rect.top - maxHeight - 8)
      : Math.min(window.innerHeight - viewportPadding, rect.bottom + 8);

    setPosition({
      left,
      top,
      width,
      maxHeight,
    });
  }, [anchorRef, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      updatePosition();
    });

    const handleScroll = () => updatePosition();
    const handleResize = () => updatePosition();

    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [isOpen, updatePosition]);

  return isOpen ? position : null;
}

function buildLinkPreviewSegments(
  value: string,
  pagesByTitle: Map<string, PageDoc>,
  nodeTargetsById: Map<string, NodeLinkTargetResolution>,
): LinkPreviewSegment[] {
  const matches = extractLinkMatches(value);
  if (matches.length === 0) {
    return [];
  }

  const segments: LinkPreviewSegment[] = [];
  let cursor = 0;
  let hasRenderableLink = false;

  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({
        key: `text:${cursor}`,
        kind: "text",
        text: value.slice(cursor, match.start),
      });
    }

    hasRenderableLink = true;
    if (match.link.kind === "page") {
      const page = pagesByTitle.get(normalizePageTitleKey(match.link.targetPageTitle));
      segments.push({
        key: `page:${match.start}`,
        kind: "link",
        text: match.link.targetPageTitle,
        pageId: page?._id ?? null,
        nodeId: null,
        archived: page?.archived ?? false,
        resolved: Boolean(page),
        linkKind: "page",
        pageTypeLabel: page ? getPageTypeDisplayLabel(page) : null,
      });
    } else {
      const targetNode = nodeTargetsById.get(match.link.targetNodeRef);
      const nodeLabel = match.link.label.startsWith("[[")
        ? match.link.label
            .slice(2, -2)
            .replace(/\|node:[a-zA-Z0-9_-]+$/, "")
            .trim()
        : targetNode?.text.trim() || "Linked node";
      segments.push({
        key: `node:${match.start}`,
        kind: "link",
        text: nodeLabel || "Linked node",
        pageId: targetNode?.pageId ?? null,
        nodeId: targetNode?.nodeId ?? null,
        archived: targetNode?.pageArchived ?? false,
        resolved: Boolean(targetNode?.pageId),
        linkKind: "node",
        pageTypeLabel: null,
      });
    }

    cursor = match.end;
  }

  if (cursor < value.length) {
    segments.push({
      key: `text:${cursor}`,
      kind: "text",
      text: value.slice(cursor),
    });
  }

  return hasRenderableLink ? segments : [];
}

function collectChildren(nodes: TreeNode[], excludedIds: Set<string>) {
  return nodes.filter((node) => !excludedIds.has(node._id));
}

function getLastChildNodeId(node: TreeNode | null) {
  const lastChild = node?.children[node.children.length - 1] ?? null;
  return (lastChild?._id as Id<"nodes"> | null) ?? null;
}

function findNodeContextInTree(
  nodes: TreeNode[],
  targetNodeId: string,
  parentNodeId: Id<"nodes"> | null = null,
): {
  node: TreeNode;
  siblings: TreeNode[];
  siblingIndex: number;
  previousSibling: TreeNode | null;
  parentNodeId: Id<"nodes"> | null;
  pageId: Id<"pages">;
} | null {
  const siblingIndex = nodes.findIndex((node) => node._id === targetNodeId);
  if (siblingIndex !== -1) {
    const node = nodes[siblingIndex]!;
    return {
      node,
      siblings: nodes,
      siblingIndex,
      previousSibling: siblingIndex > 0 ? nodes[siblingIndex - 1]! : null,
      parentNodeId,
      pageId: node.pageId as Id<"pages">,
    };
  }

  for (const node of nodes) {
    const match = findNodeContextInTree(
      node.children,
      targetNodeId,
      node._id as Id<"nodes">,
    );
    if (match) {
      return match;
    }
  }

  return null;
}

function findNodeContext(
  sidebarNodes: TreeNode[],
  pageNodes: TreeNode[],
  targetNodeId: string,
) {
  return (
    findNodeContextInTree(sidebarNodes, targetNodeId) ??
    findNodeContextInTree(pageNodes, targetNodeId)
  );
}

function isNodeWithinSelectedSubtree(
  nodeId: string,
  selectedNodeIds: Set<string>,
  nodeMap: Map<string, Doc<"nodes">>,
) {
  if (selectedNodeIds.has(nodeId)) {
    return true;
  }

  let currentNode = nodeMap.get(nodeId) ?? null;
  while (currentNode?.parentNodeId) {
    const parentNodeId = currentNode.parentNodeId as string;
    if (selectedNodeIds.has(parentNodeId)) {
      return true;
    }

    currentNode = nodeMap.get(parentNodeId) ?? null;
  }

  return false;
}

function findRevealTargetElement(
  targetNodeId: string,
  nodes: Doc<"nodes">[],
): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  const directTarget = document.querySelector<HTMLElement>(
    `[data-node-id="${targetNodeId}"]`,
  );
  if (directTarget) {
    return directTarget;
  }

  const nodesById = new Map(nodes.map((node) => [node._id as string, node]));
  let currentNode = nodesById.get(targetNodeId) ?? null;
  while (currentNode) {
    const sectionSlot = getNodeMeta(currentNode).sectionSlot;
    if (typeof sectionSlot === "string" && sectionSlot.length > 0) {
      return document.querySelector<HTMLElement>(
        `[data-section-slot="${sectionSlot}"]`,
      );
    }

    currentNode = currentNode.parentNodeId
      ? (nodesById.get(currentNode.parentNodeId as string) ?? null)
      : null;
  }

  return null;
}

function getAncestorNodeIds(
  targetNodeId: string,
  nodeMap: Map<string, Doc<"nodes">>,
) {
  const ancestorNodeIds: string[] = [];
  let currentNode = nodeMap.get(targetNodeId) ?? null;

  while (currentNode?.parentNodeId) {
    const parentNodeId = currentNode.parentNodeId as string;
    ancestorNodeIds.push(parentNodeId);
    currentNode = nodeMap.get(parentNodeId) ?? null;
  }

  return ancestorNodeIds;
}

function parseNodeDraft(draft: string) {
  const trimmed = draft.trim();

  if (trimmed.length === 0) {
    return { shouldDelete: true as const };
  }

  const dimPrefix = trimmed.match(/^%%\s*/)?.[0] ?? "";
  const content = dimPrefix ? trimmed.slice(dimPrefix.length) : trimmed;

  if (content.trim().length === 0) {
    return { shouldDelete: true as const };
  }

  const doneMatch = content.match(/^\[x\]\s*(.*)$/i);
  if (doneMatch) {
    const text = doneMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true as const }
      : {
          shouldDelete: false as const,
          text: `${dimPrefix}${text}`,
          kind: "task" as const,
          taskStatus: "done" as const,
        };
  }

  const todoMatch = content.match(/^\[\s\]\s*(.*)$/);
  if (todoMatch) {
    const text = todoMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true as const }
      : {
          shouldDelete: false as const,
          text: `${dimPrefix}${text}`,
          kind: "task" as const,
          taskStatus: "todo" as const,
        };
  }

  return {
    shouldDelete: false as const,
    text: trimmed,
    kind: "note" as const,
    taskStatus: null,
  };
}

function parseNodeDraftWithFallback(
  draft: string,
  fallback: {
    kind: "note" | "task";
    taskStatus: "todo" | "in_progress" | "done" | "cancelled" | null;
  },
) {
  const trimmed = draft.trim();
  if (trimmed.length === 0) {
    return { shouldDelete: true as const };
  }

  const dimPrefix = trimmed.match(/^%%\s*/)?.[0] ?? "";
  const content = dimPrefix ? trimmed.slice(dimPrefix.length) : trimmed;
  if (content.trim().length === 0) {
    return { shouldDelete: true as const };
  }

  const doneMatch = content.match(/^\[x\]\s*(.*)$/i);
  if (doneMatch) {
    const text = doneMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true as const }
      : {
          shouldDelete: false as const,
          text: `${dimPrefix}${text}`,
          kind: "task" as const,
          taskStatus: "done" as const,
        };
  }

  const todoMatch = content.match(/^\[\s\]\s*(.*)$/);
  if (todoMatch) {
    const text = todoMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true as const }
      : {
          shouldDelete: false as const,
          text: `${dimPrefix}${text}`,
          kind: "task" as const,
          taskStatus: "todo" as const,
        };
  }

  return {
    shouldDelete: false as const,
    text: trimmed,
    kind: fallback.kind,
    taskStatus:
      fallback.kind === "task"
        ? ((fallback.taskStatus ?? "todo") as "todo" | "in_progress" | "done" | "cancelled")
        : null,
  };
}

function parseSplitSegmentDraft(
  draft: string,
  fallback: {
    kind: "note" | "task";
    taskStatus: "todo" | "in_progress" | "done" | "cancelled" | null;
  },
) {
  const dimPrefix = draft.match(/^%%\s*/)?.[0] ?? "";
  const content = dimPrefix ? draft.slice(dimPrefix.length) : draft;

  const doneMatch = content.match(/^\[x\]\s?(.*)$/i);
  if (doneMatch) {
    return {
      text: `${dimPrefix}${doneMatch[1] ?? ""}`,
      kind: "task" as const,
      taskStatus: "done" as const,
    };
  }

  const todoMatch = content.match(/^\[\s\]\s?(.*)$/);
  if (todoMatch) {
    return {
      text: `${dimPrefix}${todoMatch[1] ?? ""}`,
      kind: "task" as const,
      taskStatus: "todo" as const,
    };
  }

  return {
    text: draft,
    kind: fallback.kind,
    taskStatus:
      fallback.kind === "task"
        ? ((fallback.taskStatus ?? "todo") as "todo" | "in_progress" | "done" | "cancelled")
        : null,
  };
}

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) {
    return;
  }

  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

function splitPastedLines(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function toNodeValueSnapshot(
  value:
    | Pick<Doc<"nodes">, "text" | "kind" | "taskStatus">
    | {
        text: string;
        kind: "note" | "task";
        taskStatus: "todo" | "in_progress" | "done" | "cancelled" | null;
      },
): NodeValueSnapshot {
  return {
    text: value.text,
    kind: value.kind as "note" | "task",
    taskStatus: (value.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
  };
}

function isDimmedSyntaxLine(value: string) {
  return value.trim().startsWith("%%");
}

function stripDimmedSyntaxPrefix(value: string) {
  return value.replace(/^(\s*)%%\s*/, "$1");
}

function stripDimPrefixFromSegments(segments: LinkPreviewSegment[]) {
  let shouldStripPrefix = true;

  return segments
    .map((segment) => {
      if (!shouldStripPrefix) {
        return segment;
      }

      if (segment.kind !== "text") {
        return segment;
      }

      const nextText = stripDimmedSyntaxPrefix(segment.text);
      if (nextText !== segment.text) {
        shouldStripPrefix = false;
        if (nextText.length === 0) {
          return null;
        }

        return {
          ...segment,
          text: nextText,
        } satisfies LinkPreviewSegment;
      }

      if (segment.text.length > 0) {
        shouldStripPrefix = false;
      }

      return segment;
    })
    .filter((segment): segment is LinkPreviewSegment => segment !== null);
}

function buildNodePlacement(
  pageId: Id<"pages">,
  parentNodeId: Id<"nodes"> | null,
  afterNodeId: Id<"nodes"> | null = null,
): NodePlacement {
  return {
    pageId,
    parentNodeId,
    afterNodeId,
  };
}

function toCreatedNodeSnapshot(
  node: Doc<"nodes">,
  afterNodeId: Id<"nodes"> | null,
): CreatedNodeSnapshot {
  return {
    nodeId: node._id,
    pageId: node.pageId,
    parentNodeId: node.parentNodeId,
    afterNodeId,
    text: node.text,
    kind: node.kind as "note" | "task",
    taskStatus: (node.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
  };
}

export default function WorkspaceApp() {
  const convexConfigured = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);
  const { ownerKey, setOwnerKey } = useOwnerKey();
  const [draftOwnerKey, setDraftOwnerKey] = useState("");

  if (!convexConfigured) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--workspace-bg)] p-6 text-[var(--workspace-text)]">
        <div className="w-full max-w-xl rounded-[2rem] border border-[var(--workspace-border)] bg-[var(--workspace-surface)] p-8 shadow-[0_30px_90px_-45px_rgba(53,41,24,0.45)]">
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--workspace-accent)]">
            Configuration Needed
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">
            Connect Convex to load the workspace
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-7 text-[var(--workspace-text-subtle)]">
            Set `NEXT_PUBLIC_CONVEX_URL` for the Next.js app and connect the
            matching Convex deployment before using the editor.
          </p>
        </div>
      </main>
    );
  }

  if (!ownerKey) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--workspace-bg)] p-6 text-[var(--workspace-text)]">
        <div className="w-full max-w-md border border-[var(--workspace-border)] bg-[var(--workspace-surface)] p-8 shadow-[0_30px_90px_-45px_rgba(53,41,24,0.45)]">
          <p className="text-xs uppercase tracking-[0.3em] text-[var(--workspace-accent)]">
            Owner Access
          </p>
          <p className="mt-3 text-sm leading-6 text-[var(--workspace-text-subtle)]">
            Enter the owner access token to unlock the workspace.
          </p>
          <form
            className="mt-8 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setOwnerKey(draftOwnerKey.trim());
            }}
          >
            <input
              type="password"
              value={draftOwnerKey}
              onChange={(event) => setDraftOwnerKey(event.target.value)}
              placeholder="Owner access token"
              className="w-full border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] px-4 py-3 text-sm outline-none transition focus:border-[var(--workspace-accent)]"
            />
            <button
              type="submit"
              className="w-full bg-[var(--workspace-brand)] px-4 py-3 text-sm font-semibold text-[var(--workspace-inverse-text)] transition hover:bg-[var(--workspace-brand-hover)]"
            >
              Unlock Workspace
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <WorkspaceErrorBoundary
      ownerKey={ownerKey}
      onLockWorkspace={() => setOwnerKey("")}
    >
      <ConfiguredWorkspace ownerKey={ownerKey} setOwnerKey={setOwnerKey} />
    </WorkspaceErrorBoundary>
  );
}

function ConfiguredWorkspace({
  ownerKey,
  setOwnerKey,
}: {
  ownerKey: string;
  setOwnerKey: (nextValue: string) => void;
}) {
  const isMobileLayout = useIsMobileLayout();
  const [selectedPageId, setSelectedPageId] = useState<Id<"pages"> | null>(null);
  const [pageTitleDraft, setPageTitleDraft] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const [journalFeedbackStatus, setJournalFeedbackStatus] = useState("");
  const [embeddingRebuildStatus, setEmbeddingRebuildStatus] = useState("");
  const [isCreatingPage, setIsCreatingPage] = useState<SidebarSection | null>(null);
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [isGeneratingJournalFeedback, setIsGeneratingJournalFeedback] = useState(false);
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const [isRefreshingSidebarLinks, setIsRefreshingSidebarLinks] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("pages");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteHighlightIndex, setPaletteHighlightIndex] = useState(0);
  const [textSearchResults, setTextSearchResults] = useState<NodeSearchResult[]>([]);
  const [nodeSearchResults, setNodeSearchResults] = useState<NodeSearchResult[]>([]);
  const [isTextSearchLoading, setIsTextSearchLoading] = useState(false);
  const [isNodeSearchLoading, setIsNodeSearchLoading] = useState(false);
  const [workspaceChatDraft, setWorkspaceChatDraft] = useState("");
  const [workspaceChatError, setWorkspaceChatError] = useState("");
  const [isWorkspaceChatLoading, setIsWorkspaceChatLoading] = useState(false);
  const [lastResolvedPageTree, setLastResolvedPageTree] = useState<PageTreeResult | null>(null);
  const [activeDraggedNodeId, setActiveDraggedNodeId] = useState<string | null>(null);
  const [activeDraggedNodePayload, setActiveDraggedNodePayload] = useState<DraggedNodePayload | null>(null);
  const [pendingRevealNodeId, setPendingRevealNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isWorkspaceAiDockCollapsed, setIsWorkspaceAiDockCollapsed] = useState(false);
  const [showSidebarDiagnostics, setShowSidebarDiagnostics] = useState(false);
  const [sidebarBootstrapError, setSidebarBootstrapError] = useState<string>("");
  const [dragSelection, setDragSelection] = useState<{
    anchorNodeId: string;
    currentNodeId: string;
  } | null>(null);
  const [pendingInsertedComposer, setPendingInsertedComposer] =
    useState<PendingInsertedComposer | null>(null);
  const [locationPageId, setLocationPageId] = useState<string | null>(null);
  const connectionState = useConvexConnectionState();

  const isOwnerKeyValid = useQuery(
    api.workspace.validateOwnerKey,
    ownerKey ? { ownerKey } : SKIP,
  );
  const pages = useQuery(
    api.workspace.listPages,
    ownerKey && isOwnerKeyValid ? { ownerKey, includeArchived: true } : SKIP,
  );
  const embeddingRebuildProgress = useQuery(
    api.workspace.getEmbeddingRebuildStatus,
    ownerKey && isOwnerKeyValid ? { ownerKey } : SKIP,
  );
  const workspaceKnowledgeThread = useQuery(
    api.chatData.getWorkspaceKnowledgeThread,
    ownerKey && isOwnerKeyValid ? { ownerKey } : SKIP,
  );
  const pageTree = useQuery(
    api.workspace.getPageTree,
    ownerKey && isOwnerKeyValid && selectedPageId
      ? { ownerKey, pageId: selectedPageId }
      : SKIP,
  );
  const sidebarTree = useQuery(
    api.workspace.getSidebarTree,
    ownerKey && isOwnerKeyValid ? { ownerKey } : SKIP,
  );

  const createPage = useMutation(api.workspace.createPage);
  const ensureSidebarPage = useMutation(api.workspace.ensureSidebarPage);
  const ensureTaskPageSidebarSection = useMutation(
    api.workspace.ensureTaskPageSidebarSection,
  );
  const renamePage = useMutation(api.workspace.renamePage);
  const archivePage = useMutation(api.workspace.archivePage);
  const deletePageForever = useMutation(api.workspace.deletePageForever);
  const rebuildEmbeddings = useMutation(api.workspace.rebuildEmbeddings);
  const refreshSidebarLinks = useMutation(api.workspace.refreshSidebarLinks);
  const createNodesBatch = useMutation(api.workspace.createNodesBatch);
  const updateNode = useMutation(api.workspace.updateNode);
  const moveNode = useMutation(api.workspace.moveNode);
  const splitNode = useMutation(api.workspace.splitNode);
  const replaceNodeAndInsertSiblings = useMutation(
    api.workspace.replaceNodeAndInsertSiblings,
  );
  const setNodeTreeArchived = useMutation(api.workspace.setNodeTreeArchived);
  const rewriteModelSection = useAction(api.chat.rewriteModelSection);
  const generateJournalFeedback = useAction(api.chat.generateJournalFeedback);
  const findNodesText = useAction(api.ai.findNodesText);
  const searchNodes = useAction(api.ai.searchNodes);
  const chatWithWorkspace = useAction(api.ai.chatWithWorkspace);
  const pageTitleInputRef = useRef<HTMLInputElement>(null);
  const pageTitleDraftRef = useRef(pageTitleDraft);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const lastPaletteModeRef = useRef<PaletteMode>("pages");
  const hasResolvedInitialPageSelection = useRef(false);
  const hasRequestedSidebarPage = useRef(false);
  const hasRequestedTaskSidebarSection = useRef(new Set<string>());

  const clearNodeSelection = useCallback(() => {
    setSelectedNodeIds(new Set());
    setDragSelection(null);
  }, []);

  const focusWorkspaceAiDockInput = useCallback(() => {
    setIsWorkspaceAiDockCollapsed(false);
    window.requestAnimationFrame(() => {
      focusWorkspaceAiDock();
    });
  }, []);

  const selectSingleNode = useCallback((nodeId: string) => {
    setSelectedNodeIds(new Set([nodeId]));
    setDragSelection(null);
  }, []);

  const toggleNodeCollapsed = useCallback((nodeId: string) => {
    setCollapsedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const switchPaletteMode = useCallback((mode: PaletteMode) => {
    lastPaletteModeRef.current = mode;
    setPaletteMode(mode);
    setPaletteQuery("");
    setPaletteHighlightIndex(0);
    setTextSearchResults([]);
    setNodeSearchResults([]);
  }, []);

  const openPalette = useCallback((mode: PaletteMode) => {
    switchPaletteMode(mode);
    setPaletteOpen(true);
  }, [switchPaletteMode]);

  const isSidebarQueryLoading =
    Boolean(ownerKey) && isOwnerKeyValid === true && typeof sidebarTree === "undefined";
  const isMainPaneLoading =
    (Boolean(ownerKey) && isOwnerKeyValid === true && typeof pages === "undefined") ||
    (selectedPageId !== null && typeof pageTree === "undefined");
  const activePageTree =
    pageTree ?? (selectedPageId !== null && isMainPaneLoading ? lastResolvedPageTree : null);

  const history = useWorkspaceHistoryController({
    ownerKey,
    selectedPageId,
    setSelectedPageId,
    auxiliaryPageIds: sidebarTree?.page ? [sidebarTree.page._id] : [],
    renamePage,
    updateNode,
    moveNode,
    setNodeTreeArchived,
    isDisabled: activePageTree?.page?.archived ?? false,
  });

  const selectedPage = activePageTree?.page ?? null;
  const pageMeta = getPageMeta(selectedPage);
  const isPageArchived = selectedPage?.archived ?? false;
  const pageTitleEditorId = selectedPage ? getPageTitleEditorId(selectedPage._id) : null;
  const pageTitleTarget = useMemo(
    () =>
      selectedPage
        ? ({
            kind: "page_title",
            pageId: selectedPage._id,
          } satisfies TrackedEditorTarget)
        : null,
    [selectedPage],
  );
  const tree = useMemo(
    () => (activePageTree ? toTreeNodes(activePageTree.nodes) : []),
    [activePageTree],
  );
  const nodeMap = new Map(
    (activePageTree?.nodes ?? []).map((node) => [node._id as string, node]),
  );
  const sidebarNodes = useMemo(
    () => (sidebarTree ? toTreeNodes(sidebarTree.nodes) : []),
    [sidebarTree],
  );
  const sidebarNodeMap = new Map(
    (sidebarTree?.nodes ?? []).map((node) => [node._id as string, node]),
  );
  const sidebarLinkedPageIds = new Set((sidebarTree?.linkedPageIds ?? []).map((pageId) => pageId as string));

  const modelSection = findSectionNode(tree, "model");
  const recentExamplesSection = findSectionNode(tree, "recentExamples");
  const taskSidebarSection = findSectionNode(tree, "taskSidebar");
  const journalThoughtsSection = findSectionNode(tree, "journalThoughts");
  const journalFeedbackSection = findSectionNode(tree, "journalFeedback");
  const scratchpadLiveSection = findSectionNode(tree, "scratchpadLive");
  const scratchpadPreviousSection = findSectionNode(tree, "scratchpadPrevious");
  const genericRoots =
    pageMeta.pageType === "task"
      ? collectChildren(
          tree,
          new Set([taskSidebarSection?._id].filter(Boolean) as string[]),
        )
      : pageMeta.pageType === "model"
      ? collectChildren(
          tree,
          new Set([modelSection?._id, recentExamplesSection?._id].filter(Boolean) as string[]),
        )
      : pageMeta.pageType === "journal"
        ? collectChildren(
            tree,
            new Set(
              [journalThoughtsSection?._id, journalFeedbackSection?._id].filter(Boolean) as string[],
            ),
          )
        : pageMeta.pageType === "scratchpad"
          ? collectChildren(
              tree,
              new Set(
                [scratchpadLiveSection?._id, scratchpadPreviousSection?._id].filter(Boolean) as string[],
              ),
            )
          : tree;
  const sectionDepthOffset = isMobileLayout ? 0 : 1;
  const taskVisibleRoots = [taskSidebarSection].filter(
    (node): node is TreeNode => Boolean(node),
  );
  const modelVisibleRoots = [modelSection, recentExamplesSection].filter(
    (node): node is TreeNode => Boolean(node),
  );
  const journalVisibleRoots = [journalThoughtsSection, journalFeedbackSection].filter(
    (node): node is TreeNode => Boolean(node),
  );
  const scratchpadVisibleRoots = [scratchpadLiveSection, scratchpadPreviousSection].filter(
    (node): node is TreeNode => Boolean(node),
  );
  const pageVisibleRows =
    pageMeta.pageType === "task"
      ? flattenTreeNodes([...genericRoots, ...taskVisibleRoots], collapsedNodeIds)
      : pageMeta.pageType === "model"
      ? flattenTreeNodes([...modelVisibleRoots, ...genericRoots], collapsedNodeIds)
      : pageMeta.pageType === "journal"
        ? flattenTreeNodes([...journalVisibleRoots, ...genericRoots], collapsedNodeIds)
        : pageMeta.pageType === "scratchpad"
          ? flattenTreeNodes([...scratchpadVisibleRoots, ...genericRoots], collapsedNodeIds)
        : flattenTreeNodes(genericRoots, collapsedNodeIds);
  const sidebarVisibleRows = flattenTreeNodes(sidebarNodes, collapsedNodeIds);
  const visibleNodeOrder = [...sidebarVisibleRows, ...pageVisibleRows].map((node) => node._id);
  const uncategorizedPages =
    (pages ?? []).filter((page) => !page.archived && !sidebarLinkedPageIds.has(page._id as string));
  const archivedPages = (pages ?? []).filter((page) => page.archived);
  const pagesByTitle = useMemo(() => {
    const next = new Map<string, PageDoc>();
    for (const page of pages ?? []) {
      const key = normalizePageTitleKey(page.title);
      if (!key || next.has(key)) {
        continue;
      }
      next.set(key, page);
    }
    return next;
  }, [pages]);
  const pagesById = useMemo(
    () => new Map((pages ?? []).map((page) => [page._id as string, page])),
    [pages],
  );
  const workspaceNodeMap = useMemo(() => {
    const next = new Map<string, Doc<"nodes">>();
    for (const node of sidebarTree?.nodes ?? []) {
      next.set(node._id as string, node);
    }
    for (const node of activePageTree?.nodes ?? []) {
      next.set(node._id as string, node);
    }
    return next;
  }, [activePageTree?.nodes, sidebarTree?.nodes]);
  const copyNodeLinkToClipboard = useCallback(async (target: EventTarget | null) => {
    const targetNodeId =
      getNodeIdFromTarget(target) ??
      (selectedNodeIds.size === 1 ? [...selectedNodeIds][0]! : null);
    if (!targetNodeId) {
      return;
    }

    const node = workspaceNodeMap.get(targetNodeId);
    if (!node) {
      return;
    }

    const link = buildNodeClipboardLink(node);
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = link;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  }, [selectedNodeIds, workspaceNodeMap]);
  const paletteResults = filterPagesForCommandPalette(
    pages ?? [],
    paletteQuery,
    14,
  );
  const activePaletteResultsCount =
    paletteMode === "pages"
      ? paletteResults.length
      : paletteMode === "find"
        ? textSearchResults.length
      : paletteMode === "nodes"
        ? nodeSearchResults.length
        : 0;
  const workspaceChatMessages = workspaceKnowledgeThread?.messages ?? [];
  const embeddingProgressLabel = useMemo(() => {
    if (!embeddingRebuildProgress) {
      return "Embedding status unavailable.";
    }

    if (embeddingRebuildProgress.total === 0) {
      return "No active nodes to embed.";
    }

    if (embeddingRebuildProgress.queued > 0 || embeddingRebuildProgress.running > 0) {
      return `Embeddings: ${embeddingRebuildProgress.completed}/${embeddingRebuildProgress.total} complete • ${embeddingRebuildProgress.queued} queued • ${embeddingRebuildProgress.running} running${embeddingRebuildProgress.error > 0 ? ` • ${embeddingRebuildProgress.error} errors` : ""}`;
    }

    if (embeddingRebuildProgress.error > 0) {
      return `Embeddings: ${embeddingRebuildProgress.completed}/${embeddingRebuildProgress.total} complete • ${embeddingRebuildProgress.error} errors`;
    }

    if (embeddingRebuildProgress.complete) {
      return `Embeddings: ${embeddingRebuildProgress.completed}/${embeddingRebuildProgress.total} complete`;
    }

    return `Embeddings: ${embeddingRebuildProgress.completed}/${embeddingRebuildProgress.total} complete • ${embeddingRebuildProgress.pending} pending`;
  }, [embeddingRebuildProgress]);

  useEffect(() => {
    pageTitleDraftRef.current = pageTitleDraft;
  }, [pageTitleDraft]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setIsSidebarCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) === "true");
    setIsWorkspaceAiDockCollapsed(
      window.localStorage.getItem(WORKSPACE_AI_DOCK_COLLAPSE_STORAGE_KEY) === "true",
    );
    try {
      const storedCollapsedNodeIds = JSON.parse(
        window.localStorage.getItem(COLLAPSED_NODES_STORAGE_KEY) ?? "[]",
      );
      if (Array.isArray(storedCollapsedNodeIds)) {
        setCollapsedNodeIds(
          new Set(
            storedCollapsedNodeIds.filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            ),
          ),
        );
      }
    } catch {
      setCollapsedNodeIds(new Set());
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      SIDEBAR_COLLAPSE_STORAGE_KEY,
      isSidebarCollapsed ? "true" : "false",
    );
  }, [isSidebarCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      WORKSPACE_AI_DOCK_COLLAPSE_STORAGE_KEY,
      isWorkspaceAiDockCollapsed ? "true" : "false",
    );
  }, [isWorkspaceAiDockCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      COLLAPSED_NODES_STORAGE_KEY,
      JSON.stringify([...collapsedNodeIds]),
    );
  }, [collapsedNodeIds]);

  useEffect(() => {
    setLocationPageId(readPageIdFromLocation());

    const handlePopState = () => {
      setLocationPageId(readPageIdFromLocation());
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (isOwnerKeyValid === false) {
      setOwnerKey("");
    }
  }, [isOwnerKeyValid, setOwnerKey]);

  useEffect(() => {
    if (pageTree?.page) {
      setLastResolvedPageTree(pageTree);
      return;
    }

    if (selectedPageId === null) {
      setLastResolvedPageTree(null);
    }
  }, [pageTree, selectedPageId]);

  useEffect(() => {
    if (!ownerKey || !isOwnerKeyValid) {
      hasRequestedSidebarPage.current = false;
      hasRequestedTaskSidebarSection.current.clear();
      setSidebarBootstrapError("");
      setShowSidebarDiagnostics(false);
      return;
    }

    if (sidebarTree === null && !hasRequestedSidebarPage.current) {
      hasRequestedSidebarPage.current = true;
      setSidebarBootstrapError("");
      void ensureSidebarPage({ ownerKey }).catch((error) => {
        hasRequestedSidebarPage.current = false;
        setSidebarBootstrapError(
          error instanceof Error
            ? error.message
            : "Could not create the sidebar page.",
        );
      });
      return;
    }

    if (sidebarTree) {
      hasRequestedSidebarPage.current = false;
      setSidebarBootstrapError("");
    }
  }, [ensureSidebarPage, isOwnerKeyValid, ownerKey, sidebarTree]);

  useEffect(() => {
    if (!ownerKey || !isOwnerKeyValid || !selectedPage || pageMeta.pageType !== "task") {
      return;
    }

    if (taskSidebarSection) {
      hasRequestedTaskSidebarSection.current.delete(selectedPage._id as string);
      return;
    }

    const pageId = selectedPage._id as string;
    if (hasRequestedTaskSidebarSection.current.has(pageId)) {
      return;
    }

    hasRequestedTaskSidebarSection.current.add(pageId);
    void ensureTaskPageSidebarSection({
      ownerKey,
      pageId: selectedPage._id,
    }).catch(() => {
      hasRequestedTaskSidebarSection.current.delete(pageId);
    });
  }, [
    ensureTaskPageSidebarSection,
    isOwnerKeyValid,
    ownerKey,
    pageMeta.pageType,
    selectedPage,
    taskSidebarSection,
  ]);

  useEffect(() => {
    if (!isSidebarQueryLoading) {
      setShowSidebarDiagnostics(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowSidebarDiagnostics(true);
    }, 1500);

    return () => window.clearTimeout(timeout);
  }, [isSidebarQueryLoading]);

  useEffect(() => {
    if (!pages) {
      return;
    }

    const matchingLocationPage =
      locationPageId
        ? pages.find((page) => page._id === locationPageId) ?? null
        : null;

    if (matchingLocationPage) {
      hasResolvedInitialPageSelection.current = true;
      if (selectedPageId !== matchingLocationPage._id) {
        setSelectedPageId(matchingLocationPage._id);
      }
      return;
    }

    if (locationPageId) {
      hasResolvedInitialPageSelection.current = true;
      setSelectedPageId(null);
      setLocationPageId(null);
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(LAST_PAGE_STORAGE_KEY);
      }
      writePageIdToHistory(null, "replace");
      return;
    }

    if (!hasResolvedInitialPageSelection.current) {
      hasResolvedInitialPageSelection.current = true;
      if (typeof window === "undefined") {
        return;
      }

      const storedPageId = window.localStorage.getItem(LAST_PAGE_STORAGE_KEY);
      if (!storedPageId) {
        return;
      }

      const matchingStoredPage = pages.find((page) => page._id === storedPageId);
      if (matchingStoredPage) {
        setSelectedPageId(matchingStoredPage._id);
        setLocationPageId(matchingStoredPage._id);
        writePageIdToHistory(matchingStoredPage._id, "replace");
      } else {
        window.localStorage.removeItem(LAST_PAGE_STORAGE_KEY);
      }
      return;
    }

    if (selectedPageId && !pages.some((page) => page._id === selectedPageId)) {
      setSelectedPageId(null);
      setLocationPageId(null);
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(LAST_PAGE_STORAGE_KEY);
      }
      writePageIdToHistory(null, "replace");
      return;
    }

    if (!locationPageId && selectedPageId !== null) {
      setSelectedPageId(null);
    }
  }, [locationPageId, pages, selectedPageId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (selectedPageId) {
      window.localStorage.setItem(LAST_PAGE_STORAGE_KEY, selectedPageId);
    } else {
      window.localStorage.removeItem(LAST_PAGE_STORAGE_KEY);
    }
  }, [selectedPageId]);

  useEffect(() => {
    setPageTitleDraft(activePageTree?.page?.title ?? "");
    setChatStatus("");
    setJournalFeedbackStatus("");
    clearNodeSelection();
    setPendingInsertedComposer(null);
  }, [activePageTree?.page?._id, activePageTree?.page?.title, clearNodeSelection]);

  const handleRetrySidebarSetup = useCallback(async () => {
    if (!ownerKey) {
      return;
    }

    hasRequestedSidebarPage.current = false;
    setSidebarBootstrapError("");
    setShowSidebarDiagnostics(false);

    try {
      await ensureSidebarPage({ ownerKey });
    } catch (error) {
      setSidebarBootstrapError(
        error instanceof Error ? error.message : "Could not create the sidebar page.",
      );
    }
  }, [ensureSidebarPage, ownerKey]);

  const handleRebuildEmbeddings = async () => {
    setIsRebuildingEmbeddings(true);
    setEmbeddingRebuildStatus("");
    try {
      const result = (await rebuildEmbeddings({
        ownerKey,
      })) as {
        queuedCount: number;
      };

      setEmbeddingRebuildStatus(
        result.queuedCount > 0
          ? `Queued ${result.queuedCount} node embeddings for refresh.`
          : "No active nodes needed an embedding rebuild.",
      );
    } catch (error) {
      setEmbeddingRebuildStatus(
        error instanceof Error
          ? error.message
          : "Could not queue an embedding rebuild right now.",
      );
    } finally {
      setIsRebuildingEmbeddings(false);
    }
  };

  const handleRefreshSidebarLinks = async () => {
    setIsRefreshingSidebarLinks(true);
    try {
      await refreshSidebarLinks({
        ownerKey,
      });
    } finally {
      setIsRefreshingSidebarLinks(false);
    }
  };

  const handleResetLocalState = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const confirmed = window.confirm(
      "Clear the saved browser state for this app on this device and reload?",
    );
    if (!confirmed) {
      return;
    }

    window.localStorage.removeItem(LAST_PAGE_STORAGE_KEY);
    window.localStorage.removeItem(SIDEBAR_COLLAPSE_STORAGE_KEY);
    window.localStorage.removeItem(COLLAPSED_NODES_STORAGE_KEY);
    window.localStorage.removeItem(WORKSPACE_AI_DOCK_COLLAPSE_STORAGE_KEY);
    setSelectedPageId(null);
    setLocationPageId(null);
    writePageIdToHistory(null, "replace");
    setOwnerKey("");
    window.location.reload();
  }, [setOwnerKey]);

  useEffect(() => {
    if (!dragSelection) {
      return;
    }

    setSelectedNodeIds(
      buildNodeSelectionIds(
        visibleNodeOrder,
        dragSelection.anchorNodeId,
        dragSelection.currentNodeId,
      ),
    );
  }, [dragSelection, visibleNodeOrder]);

  const selectNodeRange = useCallback((anchorNodeId: string, currentNodeId: string) => {
    setSelectedNodeIds(
      buildNodeSelectionIds(visibleNodeOrder, anchorNodeId, currentNodeId),
    );
    setDragSelection(null);
  }, [visibleNodeOrder]);

  const focusLastVisiblePageNode = useCallback(() => {
    if (!selectedPage || isPageArchived) {
      return;
    }

    const targetNode = [...pageVisibleRows]
      .reverse()
      .find((node) => getNodeMeta(node).locked !== true);

    if (!targetNode) {
      return;
    }

    selectSingleNode(targetNode._id);
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-node-id="${targetNode._id}"] textarea`,
      );
      focusElementAtEnd(target as HTMLTextAreaElement | null);
    }, 0);
  }, [isPageArchived, pageVisibleRows, selectSingleNode, selectedPage]);

  const moveHighlightedNodeByKeyboard = useCallback(
    async (direction: -1 | 1) => {
      if (selectedNodeIds.size !== 1) {
        return;
      }

      const nodeId = [...selectedNodeIds][0];
      if (!nodeId) {
        return;
      }

      const context = findNodeContext(sidebarNodes, tree, nodeId);
      if (!context || getNodeMeta(context.node).locked === true) {
        return;
      }

      const beforePlacement = buildNodePlacement(
        context.pageId,
        context.parentNodeId,
        (context.previousSibling?._id as Id<"nodes"> | undefined) ?? null,
      );

      let afterPlacement: NodePlacement | null = null;

      if (direction === -1) {
        if (context.siblingIndex === 0) {
          return;
        }

        const afterNodeId =
          context.siblingIndex > 1
            ? ((context.siblings[context.siblingIndex - 2]?._id as Id<"nodes"> | undefined) ??
              null)
            : null;

        afterPlacement = buildNodePlacement(
          context.pageId,
          context.parentNodeId,
          afterNodeId,
        );

        await moveNode({
          ownerKey,
          nodeId: context.node._id as Id<"nodes">,
          pageId: context.pageId,
          parentNodeId: context.parentNodeId,
          afterNodeId,
        });
      } else {
        const nextSibling = context.siblings[context.siblingIndex + 1];
        if (!nextSibling) {
          return;
        }

        afterPlacement = buildNodePlacement(
          context.pageId,
          context.parentNodeId,
          nextSibling._id as Id<"nodes">,
        );

        await moveNode({
          ownerKey,
          nodeId: context.node._id as Id<"nodes">,
          pageId: context.pageId,
          parentNodeId: context.parentNodeId,
          afterNodeId: nextSibling._id as Id<"nodes">,
        });
      }

      history.pushUndoEntry({
        type: "move_node",
        pageId: context.pageId,
        nodeId: context.node._id as Id<"nodes">,
        beforePlacement,
        afterPlacement,
        focusEditorId: getNodeEditorId(context.node._id as Id<"nodes">),
      });
      selectSingleNode(context.node._id);
    },
    [history, moveNode, ownerKey, selectSingleNode, selectedNodeIds, sidebarNodes, tree],
  );

  const indentHighlightedNodeByKeyboard = useCallback(
    async (outdent: boolean) => {
      if (selectedNodeIds.size === 0) {
        return;
      }

      const orderedSelectedNodeIds = visibleNodeOrder.filter((nodeId) =>
        selectedNodeIds.has(nodeId),
      );
      const selectedRootNodeIds = orderedSelectedNodeIds.filter((nodeId) => {
        let currentNode = workspaceNodeMap.get(nodeId) ?? null;
        while (currentNode?.parentNodeId) {
          const parentNodeId = currentNode.parentNodeId as string;
          if (selectedNodeIds.has(parentNodeId)) {
            return false;
          }
          currentNode = workspaceNodeMap.get(parentNodeId) ?? null;
        }

        return true;
      });

      if (selectedRootNodeIds.length === 0) {
        return;
      }

      const contexts = selectedRootNodeIds
        .map((nodeId) => findNodeContext(sidebarNodes, tree, nodeId))
        .filter(
          (
            context,
          ): context is NonNullable<ReturnType<typeof findNodeContext>> => context !== null,
        )
        .filter((context) => {
          if (getNodeMeta(context.node).locked === true) {
            return false;
          }

          const page = pagesById.get(context.pageId as string);
          return !page?.archived;
        });

      if (contexts.length === 0) {
        return;
      }

      const firstContext = contexts[0]!;
      const sharedPageId = firstContext.pageId;
      const sharedParentNodeId = firstContext.parentNodeId;
      const allContextsShareContainer = contexts.every(
        (context) =>
          context.pageId === sharedPageId && context.parentNodeId === sharedParentNodeId,
      );
      if (!allContextsShareContainer) {
        return;
      }

      const historyEntries: Array<Extract<HistoryEntry, { type: "move_node" }>> = [];

      if (outdent) {
        if (!firstContext.node.parentNodeId) {
          return;
        }

        const parentNode = workspaceNodeMap.get(firstContext.node.parentNodeId as string);
        if (!parentNode) {
          return;
        }

        let nextAfterNodeId = parentNode._id as Id<"nodes">;
        const targetParentNodeId = (parentNode.parentNodeId as Id<"nodes"> | null) ?? null;

        for (const context of contexts) {
          const beforePlacement = buildNodePlacement(
            context.pageId,
            context.parentNodeId,
            (context.previousSibling?._id as Id<"nodes"> | undefined) ?? null,
          );
          const afterPlacement = buildNodePlacement(
            context.pageId,
            targetParentNodeId,
            nextAfterNodeId,
          );

          await moveNode({
            ownerKey,
            nodeId: context.node._id as Id<"nodes">,
            pageId: context.pageId,
            parentNodeId: targetParentNodeId,
            afterNodeId: nextAfterNodeId,
          });

          historyEntries.push({
            type: "move_node",
            pageId: context.pageId,
            nodeId: context.node._id as Id<"nodes">,
            beforePlacement,
            afterPlacement,
            focusEditorId: getNodeEditorId(context.node._id as Id<"nodes">),
          });

          nextAfterNodeId = context.node._id as Id<"nodes">;
        }
      } else {
        if (!firstContext.previousSibling) {
          return;
        }

        let nextAfterNodeId = getLastChildNodeId(firstContext.previousSibling);
        const targetParentNodeId = firstContext.previousSibling._id as Id<"nodes">;

        for (const context of contexts) {
          const beforePlacement = buildNodePlacement(
            context.pageId,
            context.parentNodeId,
            (context.previousSibling?._id as Id<"nodes"> | undefined) ?? null,
          );
          const afterPlacement = buildNodePlacement(
            context.pageId,
            targetParentNodeId,
            nextAfterNodeId,
          );

          await moveNode({
            ownerKey,
            nodeId: context.node._id as Id<"nodes">,
            pageId: context.pageId,
            parentNodeId: targetParentNodeId,
            afterNodeId: nextAfterNodeId,
          });

          historyEntries.push({
            type: "move_node",
            pageId: context.pageId,
            nodeId: context.node._id as Id<"nodes">,
            beforePlacement,
            afterPlacement,
            focusEditorId: getNodeEditorId(context.node._id as Id<"nodes">),
          });

          nextAfterNodeId = context.node._id as Id<"nodes">;
        }
      }

      if (historyEntries.length === 0) {
        return;
      }

      if (historyEntries.length === 1) {
        history.pushUndoEntry(historyEntries[0]!);
      } else {
        history.pushUndoEntry({
          type: "compound",
          pageId: sharedPageId,
          entries: historyEntries,
          focusAfterUndoId: getNodeEditorId(historyEntries[0]!.nodeId),
          focusAfterRedoId: getNodeEditorId(
            historyEntries[historyEntries.length - 1]!.nodeId,
          ),
        });
      }

      setSelectedNodeIds(
        new Set(contexts.map((context) => context.node._id as string)),
      );
      setDragSelection(null);
    },
    [
      history,
      moveNode,
      ownerKey,
      pagesById,
      selectedNodeIds,
      setDragSelection,
      setSelectedNodeIds,
      sidebarNodes,
      tree,
      visibleNodeOrder,
      workspaceNodeMap,
    ],
  );

  const setHighlightedNodeCollapsedByKeyboard = useCallback(
    (nextCollapsed: boolean) => {
      if (selectedNodeIds.size !== 1) {
        return;
      }

      const nodeId = [...selectedNodeIds][0];
      if (!nodeId) {
        return;
      }

      const context = findNodeContext(sidebarNodes, tree, nodeId);
      if (!context || context.node.children.length === 0) {
        return;
      }

      setCollapsedNodeIds((current) => {
        const next = new Set(current);
        if (nextCollapsed) {
          next.add(nodeId);
        } else {
          next.delete(nodeId);
        }
        return next;
      });
    },
    [selectedNodeIds, sidebarNodes, tree],
  );

  const toggleHighlightedNodeKind = useCallback(async () => {
    if (selectedNodeIds.size !== 1) {
      return;
    }

    const nodeId = [...selectedNodeIds][0];
    if (!nodeId) {
      return;
    }

    const node = workspaceNodeMap.get(nodeId);
    if (!node || getNodeMeta(node).locked === true) {
      return;
    }

    const page = pagesById.get(node.pageId as string);
    if (page?.archived) {
      return;
    }

    const beforeSnapshot = toNodeValueSnapshot(node);
    const afterSnapshot: NodeValueSnapshot =
      node.kind === "task"
        ? {
            text: node.text,
            kind: "note",
            taskStatus: null,
          }
        : {
            text: node.text,
            kind: "task",
            taskStatus: "todo",
          };

    await updateNode({
      ownerKey,
      nodeId: node._id,
      text: afterSnapshot.text,
      kind: afterSnapshot.kind,
      lockKind: true,
      taskStatus: afterSnapshot.taskStatus,
    });

    history.pushUndoEntry({
      type: "update_node",
      pageId: node.pageId as Id<"pages">,
      nodeId: node._id as Id<"nodes">,
      before: beforeSnapshot,
      after: afterSnapshot,
      focusEditorId: getNodeEditorId(node._id as Id<"nodes">),
    });
    selectSingleNode(nodeId);
  }, [history, ownerKey, pagesById, selectSingleNode, selectedNodeIds, updateNode, workspaceNodeMap]);

  const deleteHighlightedNodes = useCallback(async () => {
    if (selectedNodeIds.size === 0) {
      return;
    }

    const orderedSelectedNodeIds = visibleNodeOrder.filter((nodeId) =>
      selectedNodeIds.has(nodeId),
    );
    const selectedRootNodeIds = orderedSelectedNodeIds.filter((nodeId) => {
      let currentNode = workspaceNodeMap.get(nodeId) ?? null;
      while (currentNode?.parentNodeId) {
        const parentNodeId = currentNode.parentNodeId as string;
        if (selectedNodeIds.has(parentNodeId)) {
          return false;
        }
        currentNode = workspaceNodeMap.get(parentNodeId) ?? null;
      }

      return true;
    });

    const deletableNodes = selectedRootNodeIds
      .map((nodeId) => workspaceNodeMap.get(nodeId) ?? null)
      .filter((node): node is Doc<"nodes"> => {
        if (!node) {
          return false;
        }

        if (getNodeMeta(node).locked === true) {
          return false;
        }

        const page = pagesById.get(node.pageId as string);
        return !page?.archived;
      });

    if (deletableNodes.length === 0) {
      return;
    }

    if (deletableNodes.length > 1) {
      const confirmed = window.confirm(
        `Delete ${deletableNodes.length} selected items?`,
      );
      if (!confirmed) {
        return;
      }
    }

    const historyEntries: Array<Extract<HistoryEntry, { type: "archive_node_tree" }>> = [];

    for (const node of deletableNodes) {
      const context = findNodeContext(sidebarNodes, tree, node._id as string);
      const focusAfterRedoId =
        context?.previousSibling?._id
          ? getNodeEditorId(context.previousSibling._id as Id<"nodes">)
          : getComposerEditorId(
              node.pageId as Id<"pages">,
              (node.parentNodeId as Id<"nodes"> | null) ?? null,
            );

      await setNodeTreeArchived({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
        archived: true,
      });

      historyEntries.push({
        type: "archive_node_tree",
        pageId: node.pageId as Id<"pages">,
        nodeId: node._id as Id<"nodes">,
        focusAfterUndoId: getNodeEditorId(node._id as Id<"nodes">),
        focusAfterRedoId,
      });
    }

    clearNodeSelection();

    if (historyEntries.length === 1) {
      history.pushUndoEntry(historyEntries[0]!);
      return;
    }

    history.pushUndoEntry({
      type: "compound",
      pageId: historyEntries[0]!.pageId,
      entries: historyEntries,
      focusAfterUndoId: historyEntries[0]!.focusAfterUndoId,
      focusAfterRedoId: historyEntries[historyEntries.length - 1]!.focusAfterRedoId,
    });
  }, [
    clearNodeSelection,
    history,
    ownerKey,
    pagesById,
    selectedNodeIds,
    setNodeTreeArchived,
    sidebarNodes,
    tree,
    visibleNodeOrder,
    workspaceNodeMap,
  ]);

  const openInsertedComposer = useCallback(
    (pageId: Id<"pages">, parentNodeId: Id<"nodes"> | null, afterNodeId: Id<"nodes">) => {
      setPendingInsertedComposer((current) => ({
        pageId,
        parentNodeId,
        afterNodeId,
        focusToken:
          current &&
          current.pageId === pageId &&
          current.parentNodeId === parentNodeId &&
          current.afterNodeId === afterNodeId
            ? current.focusToken + 1
            : 1,
      }));
    },
    [],
  );

  const clearInsertedComposer = useCallback(() => {
    setPendingInsertedComposer(null);
  }, []);

  useEffect(() => {
    const handleMouseUp = () => {
      setDragSelection(null);
    };

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  useEffect(() => {
    if (!dragSelection || typeof document === "undefined") {
      return;
    }

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragSelection]);

  useEffect(() => {
    if (!activeDraggedNodeId || typeof document === "undefined") {
      return;
    }

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [activeDraggedNodeId]);

  useEffect(() => {
    if (!paletteOpen) {
      return;
    }

    setPaletteHighlightIndex(0);
    window.setTimeout(() => paletteInputRef.current?.focus(), 0);
  }, [paletteOpen, paletteMode]);

  useEffect(() => {
    if (!paletteOpen || paletteMode !== "find") {
      setIsTextSearchLoading(false);
      return;
    }

    const normalizedQuery = paletteQuery.trim();
    if (normalizedQuery.length === 0) {
      setTextSearchResults([]);
      setIsTextSearchLoading(false);
      return;
    }

    let isCancelled = false;
    setIsTextSearchLoading(true);
    const timeoutId = window.setTimeout(async () => {
      try {
        const results = (await findNodesText({
          ownerKey,
          query: normalizedQuery,
          limit: 12,
        })) as unknown[];

        if (isCancelled) {
          return;
        }

        setTextSearchResults(normalizeNodeSearchResults(results));
      } catch {
        if (!isCancelled) {
          setTextSearchResults([]);
        }
      } finally {
        if (!isCancelled) {
          setIsTextSearchLoading(false);
        }
      }
    }, 120);

    return () => {
      isCancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [findNodesText, ownerKey, paletteMode, paletteOpen, paletteQuery]);

  useEffect(() => {
    if (!paletteOpen || paletteMode !== "nodes") {
      setIsNodeSearchLoading(false);
      return;
    }

    const normalizedQuery = paletteQuery.trim();
    if (normalizedQuery.length === 0) {
      setNodeSearchResults([]);
      setIsNodeSearchLoading(false);
      return;
    }

    let isCancelled = false;
    setIsNodeSearchLoading(true);
    const timeoutId = window.setTimeout(async () => {
      try {
        const results = (await searchNodes({
          ownerKey,
          query: normalizedQuery,
          limit: 12,
        })) as unknown[];

        if (isCancelled) {
          return;
        }

        setNodeSearchResults(normalizeNodeSearchResults(results));
      } catch {
        if (!isCancelled) {
          setNodeSearchResults([]);
        }
      } finally {
        if (!isCancelled) {
          setIsNodeSearchLoading(false);
        }
      }
    }, 180);

    return () => {
      isCancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [ownerKey, paletteMode, paletteOpen, paletteQuery, searchNodes]);

  useEffect(() => {
    if (!pendingRevealNodeId || !activePageTree) {
      return;
    }

    const pageNodeMap = new Map(
      activePageTree.nodes.map((node) => [node._id as string, node]),
    );
    const ancestorNodeIds = getAncestorNodeIds(pendingRevealNodeId, pageNodeMap);
    if (!ancestorNodeIds.some((ancestorNodeId) => collapsedNodeIds.has(ancestorNodeId))) {
      return;
    }

    setCollapsedNodeIds((current) => {
      const next = new Set(current);
      for (const ancestorNodeId of ancestorNodeIds) {
        next.delete(ancestorNodeId);
      }
      return next;
    });
  }, [activePageTree, collapsedNodeIds, pendingRevealNodeId]);

  useEffect(() => {
    if (
      !pendingRevealNodeId ||
      !selectedPageId ||
      !activePageTree ||
      activePageTree.page._id !== selectedPageId
    ) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let attempts = 0;

    const reveal = () => {
      if (cancelled) {
        return;
      }

      const target = findRevealTargetElement(
        pendingRevealNodeId,
        activePageTree.nodes,
      );

      if (target) {
        setSelectedNodeIds(new Set([pendingRevealNodeId]));
        target.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
        setPendingRevealNodeId(null);
        return;
      }

      if (attempts >= 15) {
        return;
      }

      attempts += 1;
      timeoutId = window.setTimeout(reveal, 90);
    };

    timeoutId = window.setTimeout(reveal, 40);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activePageTree, collapsedNodeIds, pendingRevealNodeId, selectedPageId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      const normalizedKey = event.key.toLowerCase();

      if (isModifier && event.shiftKey && normalizedKey === "f") {
        event.preventDefault();
        openPalette("find");
        return;
      }

      if (isModifier && event.shiftKey && normalizedKey === "p") {
        event.preventDefault();
        openPalette(lastPaletteModeRef.current);
        return;
      }

      if (isModifier && event.shiftKey && normalizedKey === "l") {
        event.preventDefault();
        focusWorkspaceAiDockInput();
        return;
      }

      if (isModifier && event.shiftKey && normalizedKey === "k") {
        event.preventDefault();
        void copyNodeLinkToClipboard(event.target);
        return;
      }

      if (
        isModifier &&
        event.shiftKey &&
        normalizedKey === "c" &&
        selectedNodeIds.size > 0 &&
        !isTextEntryElement(event.target)
      ) {
        event.preventDefault();
        void toggleHighlightedNodeKind();
        return;
      }

      if (isModifier && normalizedKey === "k") {
        event.preventDefault();
        openPalette("pages");
        return;
      }

      if (isModifier && normalizedKey === "o") {
        event.preventDefault();
        openPalette(event.shiftKey ? "nodes" : "pages");
        return;
      }

      if (event.key === "Escape") {
        if (paletteOpen) {
          event.preventDefault();
          setPaletteOpen(false);
          setPaletteQuery("");
          setPaletteMode("pages");
          setTextSearchResults([]);
          setNodeSearchResults([]);
          return;
        }

        if (isTextEntryElement(event.target)) {
          event.preventDefault();
          clearNodeSelection();

          const activeElement = document.activeElement;
          if (activeElement instanceof HTMLElement) {
            activeElement.blur();
          }
          return;
        }

        if (selectedNodeIds.size > 0) {
          setSelectedNodeIds(new Set());
          setDragSelection(null);
        }
        return;
      }

      if (
        selectedNodeIds.size === 0 &&
        !isTextEntryElement(event.target) &&
        !event.shiftKey &&
        !event.altKey &&
        !isModifier &&
        event.key === "ArrowUp"
      ) {
        event.preventDefault();
        focusLastVisiblePageNode();
        return;
      }

      if (selectedNodeIds.size > 0 && !isTextEntryElement(event.target)) {
        if (isModifier && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          setHighlightedNodeCollapsedByKeyboard(event.key === "ArrowLeft");
          return;
        }

        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          void deleteHighlightedNodes();
          return;
        }

        if (event.key === "Tab") {
          event.preventDefault();
          void indentHighlightedNodeByKeyboard(event.shiftKey);
          return;
        }

        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;

          if (isModifier) {
            void moveHighlightedNodeByKeyboard(direction);
            return;
          }

          const selectedIndices = [...selectedNodeIds]
            .map((nodeId) => visibleNodeOrder.indexOf(nodeId))
            .filter((index) => index >= 0)
            .sort((left, right) => left - right);

          if (selectedIndices.length === 0) {
            return;
          }

          if (event.shiftKey) {
            const edgeIndex =
              direction === 1
                ? selectedIndices[selectedIndices.length - 1]!
                : selectedIndices[0]!;
            const anchorIndex =
              direction === 1
                ? selectedIndices[0]!
                : selectedIndices[selectedIndices.length - 1]!;
            const nextIndex = edgeIndex + direction;
            const nextNodeId = visibleNodeOrder[nextIndex];
            const anchorNodeId = visibleNodeOrder[anchorIndex];

            if (!nextNodeId || !anchorNodeId) {
              return;
            }

            selectNodeRange(anchorNodeId, nextNodeId);
            return;
          }

          if (selectedIndices.length !== 1) {
            return;
          }

          const currentIndex = selectedIndices[0]!;
          const nextNodeId = visibleNodeOrder[currentIndex + direction];
          if (!nextNodeId) {
            return;
          }

          selectSingleNode(nextNodeId);
          window.setTimeout(() => {
            const target = document.querySelector<HTMLElement>(
              `[data-node-id="${nextNodeId}"] textarea`,
            );
            focusElementAtEnd(target as HTMLTextAreaElement | null);
          }, 0);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    copyNodeLinkToClipboard,
    deleteHighlightedNodes,
    focusLastVisiblePageNode,
    focusWorkspaceAiDockInput,
    indentHighlightedNodeByKeyboard,
    moveHighlightedNodeByKeyboard,
    openPalette,
    paletteOpen,
    clearNodeSelection,
    selectNodeRange,
    selectSingleNode,
    selectedNodeIds,
    setHighlightedNodeCollapsedByKeyboard,
    toggleHighlightedNodeKind,
    visibleNodeOrder,
  ]);

  useEffect(() => {
    if (selectedNodeIds.size === 0) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (
        event.target instanceof HTMLElement &&
        (event.target.closest("[data-node-shell]") ||
          event.target.closest("[data-selection-gutter='true']"))
      ) {
        return;
      }

      clearNodeSelection();
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [clearNodeSelection, selectedNodeIds]);

  useEffect(() => {
    if (!pageTitleEditorId || !pageTitleTarget) {
      return;
    }

    return history.registerEditor(
      pageTitleEditorId,
      pageTitleTarget,
      selectedPage?.title ?? "",
      {
        getElement: () => pageTitleInputRef.current,
        getValue: () => pageTitleDraftRef.current,
        setValue: setPageTitleDraft,
        focusAtEnd: () => focusElementAtEnd(pageTitleInputRef.current),
      },
    );
  }, [history, pageTitleEditorId, pageTitleTarget, selectedPage?.title]);

  useEffect(() => {
    if (!pageTitleEditorId || !pageTitleTarget || !selectedPage) {
      return;
    }

    history.syncCommittedValue(pageTitleEditorId, selectedPage.title, pageTitleTarget);
  }, [history, pageTitleEditorId, pageTitleTarget, selectedPage]);

  const handleCreatePage = async (section: SidebarSection) => {
    setIsCreatingPage(section);
    try {
      const pageType: PageType =
        section === "Models"
          ? "model"
          : section === "Tasks"
            ? "task"
          : section === "Journal"
            ? "journal"
            : section === "Scratchpads"
              ? "scratchpad"
            : "default";
      const title =
        section === "Models"
          ? "Untitled Model"
          : section === "Journal"
            ? formatLocalDateTitle()
            : section === "Scratchpads"
              ? "Untitled Scratchpad"
            : `Untitled ${section.slice(0, -1)}`;
      const pageId = await createPage({
        ownerKey,
        title,
        sidebarSection: section,
        pageType,
      });
      setSelectedPageId(pageId);
    } finally {
      setIsCreatingPage(null);
    }
  };

  const handleRenamePage = async () => {
    if (!selectedPage || !pageTitleEditorId || !pageTitleTarget) {
      return;
    }

    const nextTitle = pageTitleDraft.trim() || "Untitled";
    if (nextTitle !== selectedPage.title) {
      await renamePage({
        ownerKey,
        pageId: selectedPage._id,
        title: nextTitle,
      });
    }

    const beforeTitle = history.commitTrackedValue(
      pageTitleEditorId,
      pageTitleTarget,
      nextTitle,
    );
    setPageTitleDraft(nextTitle);

    if (beforeTitle !== nextTitle) {
      history.pushUndoEntry({
        type: "rename_page",
        pageId: selectedPage._id,
        beforeTitle,
        afterTitle: nextTitle,
        focusEditorId: pageTitleEditorId,
      });
    }
  };

  const handleSelectPage = useCallback((pageId: Id<"pages">) => {
    setSelectedPageId(pageId);
    setLocationPageId(pageId);
    writePageIdToHistory(pageId, "push");
    setPendingRevealNodeId(null);
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteHighlightIndex(0);
    setPaletteMode("pages");
    setTextSearchResults([]);
    setNodeSearchResults([]);
    clearNodeSelection();
  }, [clearNodeSelection]);

  const handleSelectNodeSearchResult = useCallback((result: NodeSearchResult) => {
    if (!result.page) {
      return;
    }

    setSelectedPageId(result.page._id);
    setLocationPageId(result.page._id);
    writePageIdToHistory(result.page._id, "push");
    setPendingRevealNodeId(result.node._id as string);
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteHighlightIndex(0);
    setPaletteMode("nodes");
    setTextSearchResults([]);
    clearNodeSelection();
  }, [clearNodeSelection]);

  const handleOpenLinkedNode = useCallback((pageId: Id<"pages">, nodeId: Id<"nodes">) => {
    setSelectedPageId(pageId);
    setLocationPageId(pageId);
    writePageIdToHistory(pageId, "push");
    setPendingRevealNodeId(nodeId as string);
    clearNodeSelection();
  }, [clearNodeSelection]);

  const handleOpenWorkspaceKnowledgeSource = useCallback(
    (source: WorkspaceKnowledgeSourceSnapshot) => {
      if (!source.pageId) {
        return;
      }

      setSelectedPageId(source.pageId as Id<"pages">);
      setLocationPageId(source.pageId);
      writePageIdToHistory(source.pageId, "push");
      if (source.nodeId) {
        setPendingRevealNodeId(source.nodeId);
      }
      clearNodeSelection();
    },
    [clearNodeSelection],
  );

  const handleWorkspaceChatSubmit = useCallback(async () => {
    const question = workspaceChatDraft.trim();
    if (question.length === 0) {
      return;
    }

    setIsWorkspaceChatLoading(true);
    setWorkspaceChatError("");
    try {
      const explicitTargets = resolveExplicitKnowledgeLinkTargets(question, pagesByTitle);
      await chatWithWorkspace({
        ownerKey,
        question,
        limit: 10,
        linkedPageIds: explicitTargets.linkedPageIds,
        linkedNodeIds: explicitTargets.linkedNodeIds,
      });
      setWorkspaceChatDraft("");
    } catch (error) {
      setWorkspaceChatError(
        error instanceof Error
          ? error.message
          : "Knowledge-base chat failed.",
      );
    } finally {
      setIsWorkspaceChatLoading(false);
    }
  }, [chatWithWorkspace, ownerKey, pagesByTitle, workspaceChatDraft]);

  const handleArchivePage = async (page: PageDoc, archived: boolean) => {
    await archivePage({
      ownerKey,
      pageId: page._id,
      archived,
    });
  };

  const handleDeletePageForever = async (page: PageDoc) => {
    const firstConfirmation = window.confirm(
      `Delete "${page.title}" forever? This will permanently remove the archived page and all of its contents.`,
    );
    if (!firstConfirmation) {
      return;
    }

    const secondConfirmation = window.confirm(
      `Are you absolutely sure? "${page.title}" cannot be recovered after this.`,
    );
    if (!secondConfirmation) {
      return;
    }

    await deletePageForever({
      ownerKey,
      pageId: page._id,
    });

    setSelectedPageId(null);
  };

  const handleGenerateJournalFeedback = async () => {
    if (!selectedPageId || isPageArchived) {
      return;
    }

    setIsGeneratingJournalFeedback(true);
    setJournalFeedbackStatus("");
    try {
      const result = (await generateJournalFeedback({
        ownerKey,
        pageId: selectedPageId,
      })) as {
        summary: string;
        feedbackLines: string[];
      };
      setJournalFeedbackStatus(result.summary);
    } catch (error) {
      setJournalFeedbackStatus(
        error instanceof Error
          ? error.message
          : "Could not generate journal feedback right now.",
      );
    } finally {
      setIsGeneratingJournalFeedback(false);
    }
  };

  const handleRegenerateModel = async () => {
    if (!selectedPageId || isPageArchived) {
      return;
    }

    setIsSendingChat(true);
    setChatStatus("");
    try {
      const result = (await rewriteModelSection({
        ownerKey,
        pageId: selectedPageId,
        prompt: MODEL_REGENERATE_PROMPT,
      })) as {
        summary: string;
      };
      setChatStatus(result.summary);
    } catch (error) {
      setChatStatus(
        error instanceof Error
          ? error.message
          : "Could not regenerate the model right now.",
      );
    } finally {
      setIsSendingChat(false);
    }
  };

  const handlePaletteKeyDown = (event: TextareaKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const currentIndex = PALETTE_MODE_ORDER.indexOf(paletteMode);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const nextIndex =
        (currentIndex + direction + PALETTE_MODE_ORDER.length) % PALETTE_MODE_ORDER.length;
      const nextMode = PALETTE_MODE_ORDER[nextIndex] ?? "pages";

      switchPaletteMode(nextMode);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPaletteHighlightIndex((current) =>
        activePaletteResultsCount === 0 ? 0 : Math.min(current + 1, activePaletteResultsCount - 1),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setPaletteHighlightIndex((current) =>
        activePaletteResultsCount === 0 ? 0 : Math.max(current - 1, 0),
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (paletteMode === "pages") {
        const highlighted = paletteResults[paletteHighlightIndex];
        if (highlighted) {
          handleSelectPage(highlighted._id);
        }
        return;
      }

      const highlighted =
        paletteMode === "find"
          ? textSearchResults[paletteHighlightIndex]
          : nodeSearchResults[paletteHighlightIndex];
      if (highlighted) {
        handleSelectNodeSearchResult(highlighted);
      }
    }
  };

  const beginNodeSelection = (nodeId: string) => {
    setDragSelection({
      anchorNodeId: nodeId,
      currentNodeId: nodeId,
    });
    setSelectedNodeIds(new Set([nodeId]));
  };

  const extendNodeSelection = (nodeId: string) => {
    setDragSelection((current) =>
      current
        ? {
            ...current,
            currentNodeId: nodeId,
          }
        : current,
    );
  };

  return (
    <WorkspaceHistoryProvider value={history}>
      <main className="relative min-h-screen bg-[var(--workspace-bg)] text-[var(--workspace-text)]">
      <div className="pointer-events-none fixed right-4 top-4 z-40 md:right-6 md:top-6">
        <div className="pointer-events-auto flex items-center gap-2 border border-[var(--workspace-border)] bg-[color-mix(in_srgb,var(--workspace-surface)_88%,transparent)] px-2 py-2 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.5)] backdrop-blur-sm">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openPalette(lastPaletteModeRef.current)}
            className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
          >
            Command
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void history.undo()}
            disabled={!history.canUndo || history.isApplyingHistory}
            className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void history.redo()}
            disabled={!history.canRedo || history.isApplyingHistory}
            className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Redo
          </button>
        </div>
      </div>
      <div
        className={clsx(
          "mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 pb-36 md:pb-44",
          isSidebarCollapsed
            ? "lg:grid-cols-[56px_minmax(0,1fr)]"
            : "lg:grid-cols-[320px_minmax(0,1fr)]",
        )}
      >
        <aside
          className={clsx(
            "flex flex-col border-b border-[var(--workspace-border)] bg-[var(--workspace-sidebar-bg)] lg:border-b-0 lg:border-r",
            isSidebarCollapsed ? "px-2 py-4" : "p-6",
          )}
        >
          {isSidebarCollapsed ? (
            <div className="flex h-full flex-col items-center gap-3">
              <button
                type="button"
                onClick={() => setIsSidebarCollapsed(false)}
                className="flex h-9 w-9 items-center justify-center border border-[var(--workspace-border-control)] text-sm font-semibold text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
              >
                &gt;
              </button>
              <div className="mt-auto flex flex-col items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleRebuildEmbeddings()}
                  disabled={isRebuildingEmbeddings}
                  className="flex h-9 w-9 items-center justify-center border border-[var(--workspace-border-control)] text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-wait disabled:opacity-60"
                >
                  Emb
                </button>
                <button
                  type="button"
                  onClick={() => setOwnerKey("")}
                  className="flex h-9 w-9 items-center justify-center border border-[var(--workspace-border-control)] text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                >
                  Lock
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-4">
                <button
                  type="button"
                  onClick={() => setIsSidebarCollapsed(true)}
                  className="flex h-9 w-9 items-center justify-center border border-[var(--workspace-border-control)] text-sm font-semibold text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                >
                  &lt;
                </button>
                <div className="flex-1" />
              </div>

              <div className="mt-6 flex-1 overflow-y-auto">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                    Sidebar
                  </p>
                  <p className="text-[11px] text-[var(--workspace-text-faint)]">
                    Use `[[Page]]` links to build your map.
                  </p>
                </div>
                {sidebarTree ? (
                  <div className="space-y-1">
                    <OutlineNodeList
                      nodes={sidebarNodes}
                      ownerKey={ownerKey}
                      pageId={sidebarTree?.page._id as Id<"pages">}
                      nodeMap={sidebarNodeMap}
                      createNodesBatch={createNodesBatch}
                      updateNode={updateNode}
                      moveNode={moveNode}
                      splitNode={splitNode}
                      replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                      setNodeTreeArchived={setNodeTreeArchived}
                      isPageReadOnly={false}
                      collapsedNodeIds={collapsedNodeIds}
                      selectedNodeIds={selectedNodeIds}
                      onToggleNodeCollapsed={toggleNodeCollapsed}
                      onSelectSingleNode={selectSingleNode}
                      onSelectNodeRange={selectNodeRange}
                      pendingInsertedComposer={pendingInsertedComposer}
                      onOpenInsertedComposer={openInsertedComposer}
                      onClearInsertedComposer={clearInsertedComposer}
                      onBeginTextEditing={clearNodeSelection}
                      activeDraggedNodeId={activeDraggedNodeId}
                      activeDraggedNodePayload={activeDraggedNodePayload}
                      onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                      onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      pagesByTitle={pagesByTitle}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      mobileIndentStep={SIDEBAR_MOBILE_INDENT_STEP}
                    />
                    <InlineComposer
                      ownerKey={ownerKey}
                      pageId={sidebarTree?.page._id as Id<"pages">}
                      parentNodeId={null}
                      afterNodeId={sidebarNodes[sidebarNodes.length - 1]?._id as Id<"nodes"> | undefined}
                      createNodesBatch={createNodesBatch}
                      readOnly={false}
                      depth={0}
                      mobileIndentStep={SIDEBAR_MOBILE_INDENT_STEP}
                      placeholder="New sidebar line…"
                      onBeginTextEditing={clearNodeSelection}
                    />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-[var(--workspace-text-faint)]">
                      {sidebarTree === null ? "Creating sidebar structure…" : "Preparing sidebar…"}
                    </p>
                    {sidebarBootstrapError ? (
                      <div className="border border-[var(--workspace-danger)] bg-[var(--workspace-surface-muted)] p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-danger)]">
                          Sidebar Error
                        </p>
                        <p className="mt-2 text-sm leading-6 text-[var(--workspace-text-subtle)]">
                          {sidebarBootstrapError}
                        </p>
                      </div>
                    ) : null}
                    {showSidebarDiagnostics ? (
                      <div className="border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] p-3 text-sm text-[var(--workspace-text-subtle)]">
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                          Sidebar Diagnostics
                        </p>
                        <div className="mt-2 space-y-1">
                          <p>
                            Connection:{" "}
                            {connectionState.isWebSocketConnected
                              ? "connected"
                              : connectionState.hasEverConnected
                                ? "reconnecting"
                                : "connecting"}
                          </p>
                          <p>
                            Owner token:{" "}
                            {isOwnerKeyValid === true
                              ? "valid"
                              : isOwnerKeyValid === false
                                ? "invalid"
                                : "checking"}
                          </p>
                          <p>
                            Pages query: {pages ? `${pages.length} page(s) loaded` : "loading"}
                          </p>
                          <p>
                            Sidebar query:{" "}
                            {sidebarTree === null
                              ? "missing sidebar page"
                              : isSidebarQueryLoading
                                ? "still loading"
                                : "idle"}
                          </p>
                          <p>
                            In-flight requests:{" "}
                            {connectionState.hasInflightRequests ? "yes" : "no"}
                          </p>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void handleRetrySidebarSetup()}
                            className="border border-[var(--workspace-border-control)] px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                          >
                            Retry Sidebar
                          </button>
                          <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="border border-[var(--workspace-border-control)] px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                          >
                            Reload
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {pages && pages.length > 0 ? (
                      <p className="text-xs leading-5 text-[var(--workspace-text-faint)]">
                        Your pages are still available below while the sidebar outline catches up.
                      </p>
                    ) : null}
                  </div>
                )}

                <div className="mt-8 border-t border-[var(--workspace-border-soft)] pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                      Uncategorized
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleRefreshSidebarLinks()}
                      disabled={isRefreshingSidebarLinks}
                      className="border border-[var(--workspace-border-control)] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-wait disabled:opacity-60"
                    >
                      {isRefreshingSidebarLinks ? "Refreshing…" : "Refresh"}
                    </button>
                  </div>
                  {uncategorizedPages.length === 0 ? (
                    <p className="mt-3 text-sm text-[var(--workspace-text-faint)]">
                      Every active page is referenced in the sidebar.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-1">
                      {uncategorizedPages.map((page) => (
                        <button
                          key={page._id}
                          type="button"
                          onClick={() => handleSelectPage(page._id)}
                          className={clsx(
                            "block w-full px-2 py-1.5 text-left text-sm transition",
                            selectedPageId === page._id
                              ? "bg-[var(--workspace-surface-accent)] text-[var(--workspace-brand)]"
                              : "text-[var(--workspace-text-strong)] hover:bg-[var(--workspace-surface-accent)]",
                          )}
                        >
                          <span>{page.title}</span>
                          <span className="ml-2 text-[10px] uppercase tracking-[0.16em] text-[var(--workspace-text-faint)]">
                            {getPageTypeDisplayLabel(page)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-8 border-t border-[var(--workspace-border-soft)] pt-5 opacity-75">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                    Archive
                  </p>
                  {archivedPages.length === 0 ? (
                    <p className="mt-3 text-sm text-[var(--workspace-text-faint)]">
                      No archived pages.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-1">
                      {archivedPages.map((page) => (
                        <button
                          key={page._id}
                          type="button"
                          onClick={() => handleSelectPage(page._id)}
                          className={clsx(
                            "block w-full px-2 py-1.5 text-left text-sm transition",
                            selectedPageId === page._id
                              ? "bg-[var(--workspace-surface-accent)] text-[var(--workspace-brand)]"
                              : "text-[var(--workspace-text-faint)] hover:bg-[var(--workspace-surface-accent)] hover:text-[var(--workspace-text)]",
                          )}
                        >
                          <span>{page.title}</span>
                          <span className="ml-2 text-[10px] uppercase tracking-[0.16em] text-[var(--workspace-text-faint)]">
                            {getPageTypeDisplayLabel(page)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-6 border-t border-[var(--workspace-border-soft)] pt-4">
                <div className="flex flex-wrap gap-2">
                  {SIDEBAR_SECTIONS.map((section) => (
                    <button
                      key={section}
                      type="button"
                      onClick={() => void handleCreatePage(section)}
                      disabled={isCreatingPage === section}
                      className="border border-[var(--workspace-border-control)] px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-wait disabled:opacity-60"
                    >
                      {isCreatingPage === section ? "Creating…" : `+ ${getPageTypeLabelForSection(section)}`}
                    </button>
                  ))}
                </div>
                <div className="mt-4 space-y-3">
                  <button
                    type="button"
                    onClick={() => void handleRebuildEmbeddings()}
                    disabled={isRebuildingEmbeddings}
                    className="w-full border border-[var(--workspace-border-control)] px-3 py-2 text-left text-xs font-medium uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-wait disabled:opacity-60"
                  >
                    {isRebuildingEmbeddings ? "Rebuilding…" : "Rebuild Embeddings"}
                  </button>
                  {embeddingRebuildStatus ? (
                    <p className="text-xs leading-5 text-[var(--workspace-text-faint)]">
                      {embeddingRebuildStatus}
                    </p>
                  ) : null}
                  <p className="text-xs leading-5 text-[var(--workspace-text-faint)]">
                    {embeddingProgressLabel}
                  </p>
                  <button
                    type="button"
                    onClick={handleResetLocalState}
                    className="w-full border border-[var(--workspace-border-control)] px-3 py-2 text-left text-xs font-medium uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                  >
                    Reset Local State
                  </button>
                  <p className="text-xs leading-5 text-[var(--workspace-text-faint)]">
                    Clears saved browser state for this site and reloads.
                  </p>
                  <button
                    type="button"
                    onClick={() => setOwnerKey("")}
                    className="border border-[var(--workspace-border-control)] px-3 py-1 text-xs font-medium text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                  >
                    Lock
                  </button>
                </div>
              </div>
            </>
          )}
        </aside>

        <section className="p-6 md:p-10">
          {isMainPaneLoading && !selectedPage ? (
            <div className="grid min-h-[60vh] place-items-center border border-dashed border-[var(--workspace-border)] bg-[color-mix(in_srgb,var(--workspace-surface)_70%,transparent)] p-8 text-center">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-[var(--workspace-accent)]">
                  Loading
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                  Opening page…
                </h2>
              </div>
            </div>
          ) : !selectedPage ? (
            <div className="grid min-h-[60vh] place-items-center border border-dashed border-[var(--workspace-border)] bg-[color-mix(in_srgb,var(--workspace-surface)_70%,transparent)] p-8 text-center">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-[var(--workspace-accent)]">
                  Empty Workspace
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                  Create your first page from the sidebar
                </h2>
              </div>
            </div>
          ) : (
            <div className="relative">
              <div
                key={selectedPage._id}
                className="workspace-pane-fade flex min-h-[calc(100vh-5rem)] flex-col border border-[var(--workspace-border)] bg-[var(--workspace-surface)]"
              >
              <div className="px-10 py-6 md:px-14">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.3em] text-[var(--workspace-accent)]">
                      <span>{getPageTypeDisplayLabel(selectedPage)}</span>
                      {isPageArchived ? (
                        <span className="rounded-full border border-[var(--workspace-border)] px-2 py-1 text-[10px] tracking-[0.2em] text-[var(--workspace-text-faint)]">
                          Archived
                        </span>
                      ) : null}
                    </div>
                    <input
                      ref={pageTitleInputRef}
                      value={pageTitleDraft}
                      onChange={(event) => {
                        setPageTitleDraft(event.target.value);
                        if (pageTitleEditorId && pageTitleTarget) {
                          history.updateDraftValue(
                            pageTitleEditorId,
                            pageTitleTarget,
                            event.target.value,
                          );
                        }
                      }}
                      onBlur={() => void handleRenamePage()}
                      disabled={isPageArchived}
                      className="mt-4 w-full border-0 bg-transparent p-0 text-4xl font-semibold tracking-tight outline-none disabled:text-[var(--workspace-text-muted)]"
                    />
                  </div>
                </div>
                <div className="mt-6 h-px bg-[var(--workspace-border-subtle)]" />
              </div>

              <div
                className="flex-1 px-10 py-6 md:px-14"
                onMouseDownCapture={(event) => {
                  if (
                    selectedNodeIds.size > 0 &&
                    !(event.target instanceof HTMLElement && (
                      event.target.closest("[data-selection-gutter='true']") ||
                      event.target.closest("[data-item-selection-surface='true']") ||
                      event.altKey
                    ))
                  ) {
                    clearNodeSelection();
                  }
                }}
              >
                {pageMeta.pageType === "task" ? (
                  <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
                    <div className="min-w-0 space-y-1">
                      <OutlineNodeList
                        nodes={genericRoots}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        updateNode={updateNode}
                        moveNode={moveNode}
                        splitNode={splitNode}
                        replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                        setNodeTreeArchived={setNodeTreeArchived}
                        isPageReadOnly={isPageArchived}
                        collapsedNodeIds={collapsedNodeIds}
                        selectedNodeIds={selectedNodeIds}
                        onToggleNodeCollapsed={toggleNodeCollapsed}
                        onSelectSingleNode={selectSingleNode}
                        onSelectNodeRange={selectNodeRange}
                        pendingInsertedComposer={pendingInsertedComposer}
                        onOpenInsertedComposer={openInsertedComposer}
                        onClearInsertedComposer={clearInsertedComposer}
                        onBeginTextEditing={clearNodeSelection}
                        activeDraggedNodeId={activeDraggedNodeId}
                        activeDraggedNodePayload={activeDraggedNodePayload}
                        onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                        onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        pagesByTitle={pagesByTitle}
                        onOpenPage={handleSelectPage}
                        onOpenNode={handleOpenLinkedNode}
                      />
                      <InlineComposer
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        parentNodeId={null}
                        afterNodeId={genericRoots[genericRoots.length - 1]?._id as Id<"nodes"> | undefined}
                        createNodesBatch={createNodesBatch}
                        readOnly={isPageArchived}
                        depth={0}
                        onBeginTextEditing={clearNodeSelection}
                      />
                    </div>
                    <aside className="min-w-0 border-t border-[var(--workspace-border-subtle)] pt-6 lg:sticky lg:top-6 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                      {taskSidebarSection ? (
                        <PageSection
                          title="Sidebar"
                          sectionNode={taskSidebarSection}
                          ownerKey={ownerKey}
                          pageId={selectedPage._id}
                          nodeMap={nodeMap}
                          createNodesBatch={createNodesBatch}
                          updateNode={updateNode}
                          moveNode={moveNode}
                          splitNode={splitNode}
                          replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                          setNodeTreeArchived={setNodeTreeArchived}
                          isPageReadOnly={isPageArchived}
                          collapsedNodeIds={collapsedNodeIds}
                          selectedNodeIds={selectedNodeIds}
                          onToggleNodeCollapsed={toggleNodeCollapsed}
                          onSelectSingleNode={selectSingleNode}
                          onSelectNodeRange={selectNodeRange}
                          pendingInsertedComposer={pendingInsertedComposer}
                          onOpenInsertedComposer={openInsertedComposer}
                          onClearInsertedComposer={clearInsertedComposer}
                          onBeginTextEditing={clearNodeSelection}
                          activeDraggedNodeId={activeDraggedNodeId}
                          activeDraggedNodePayload={activeDraggedNodePayload}
                          onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                          onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                          onSelectionStart={beginNodeSelection}
                          onSelectionExtend={extendNodeSelection}
                          pagesByTitle={pagesByTitle}
                          onOpenPage={handleSelectPage}
                          onOpenNode={handleOpenLinkedNode}
                          compact
                        />
                      ) : (
                        <div className="text-xs uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                          Preparing sidebar…
                        </div>
                      )}
                    </aside>
                  </div>
                ) : pageMeta.pageType === "model" ? (
                  <div className="divide-y divide-[var(--workspace-border-subtle)]">
                    <div className="pb-8">
                      <PageSection
                        title="Model"
                        sectionNode={modelSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        updateNode={updateNode}
                        moveNode={moveNode}
                        splitNode={splitNode}
                        replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                      setNodeTreeArchived={setNodeTreeArchived}
                      isPageReadOnly={isPageArchived}
                      collapsedNodeIds={collapsedNodeIds}
                      selectedNodeIds={selectedNodeIds}
                      onToggleNodeCollapsed={toggleNodeCollapsed}
                      onSelectSingleNode={selectSingleNode}
                      onSelectNodeRange={selectNodeRange}
                      pendingInsertedComposer={pendingInsertedComposer}
                      onOpenInsertedComposer={openInsertedComposer}
                      onClearInsertedComposer={clearInsertedComposer}
                      onBeginTextEditing={clearNodeSelection}
                      activeDraggedNodeId={activeDraggedNodeId}
                      activeDraggedNodePayload={activeDraggedNodePayload}
                      onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                      onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      pagesByTitle={pagesByTitle}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      depthOffset={sectionDepthOffset}
                      statusMessage={chatStatus}
                      action={
                        <button
                          type="button"
                          onClick={() => void handleRegenerateModel()}
                          disabled={isSendingChat || isPageArchived}
                          className="border border-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isSendingChat ? "Regenerating…" : "Regenerate Model"}
                        </button>
                      }
                    />
                  </div>
                    <div className="pt-8">
                      <PageSection
                        title="Recent"
                        sectionNode={recentExamplesSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        updateNode={updateNode}
                        moveNode={moveNode}
                        splitNode={splitNode}
                        replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                      setNodeTreeArchived={setNodeTreeArchived}
                      isPageReadOnly={isPageArchived}
                      collapsedNodeIds={collapsedNodeIds}
                      selectedNodeIds={selectedNodeIds}
                      onToggleNodeCollapsed={toggleNodeCollapsed}
                      onSelectSingleNode={selectSingleNode}
                      onSelectNodeRange={selectNodeRange}
                      pendingInsertedComposer={pendingInsertedComposer}
                      onOpenInsertedComposer={openInsertedComposer}
                      onClearInsertedComposer={clearInsertedComposer}
                      onBeginTextEditing={clearNodeSelection}
                      activeDraggedNodeId={activeDraggedNodeId}
                      activeDraggedNodePayload={activeDraggedNodePayload}
                      onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                      onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      pagesByTitle={pagesByTitle}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      depthOffset={sectionDepthOffset}
                    />
                  </div>
                  </div>
                ) : pageMeta.pageType === "journal" ? (
                  <div className="divide-y divide-[var(--workspace-border-subtle)]">
                    <div className="pb-8">
                      <PageSection
                        title="Thoughts/Stuff"
                        sectionNode={journalThoughtsSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        updateNode={updateNode}
                        moveNode={moveNode}
                        splitNode={splitNode}
                        replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                      setNodeTreeArchived={setNodeTreeArchived}
                      isPageReadOnly={isPageArchived}
                      collapsedNodeIds={collapsedNodeIds}
                      selectedNodeIds={selectedNodeIds}
                      onToggleNodeCollapsed={toggleNodeCollapsed}
                      onSelectSingleNode={selectSingleNode}
                      onSelectNodeRange={selectNodeRange}
                      pendingInsertedComposer={pendingInsertedComposer}
                      onOpenInsertedComposer={openInsertedComposer}
                      onClearInsertedComposer={clearInsertedComposer}
                      onBeginTextEditing={clearNodeSelection}
                      activeDraggedNodeId={activeDraggedNodeId}
                      activeDraggedNodePayload={activeDraggedNodePayload}
                      onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                      onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      pagesByTitle={pagesByTitle}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      depthOffset={sectionDepthOffset}
                    />
                  </div>
                    <div className="pt-8">
                      <PageSection
                        title="Feedback"
                        sectionNode={journalFeedbackSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        updateNode={updateNode}
                        moveNode={moveNode}
                        splitNode={splitNode}
                        replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                      setNodeTreeArchived={setNodeTreeArchived}
                      isPageReadOnly={isPageArchived}
                      collapsedNodeIds={collapsedNodeIds}
                      selectedNodeIds={selectedNodeIds}
                      onToggleNodeCollapsed={toggleNodeCollapsed}
                      onSelectSingleNode={selectSingleNode}
                      onSelectNodeRange={selectNodeRange}
                      pendingInsertedComposer={pendingInsertedComposer}
                      onOpenInsertedComposer={openInsertedComposer}
                      onClearInsertedComposer={clearInsertedComposer}
                      onBeginTextEditing={clearNodeSelection}
                      activeDraggedNodeId={activeDraggedNodeId}
                      activeDraggedNodePayload={activeDraggedNodePayload}
                      onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                      onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      pagesByTitle={pagesByTitle}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      depthOffset={sectionDepthOffset}
                      statusMessage={journalFeedbackStatus}
                      action={
                          <button
                            type="button"
                            onClick={() => void handleGenerateJournalFeedback()}
                            disabled={isGeneratingJournalFeedback || isPageArchived}
                            className="border border-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isGeneratingJournalFeedback ? "Generating…" : "Generate Feedback"}
                          </button>
                        }
                      />
                    </div>
                  </div>
                ) : pageMeta.pageType === "scratchpad" ? (
                  <div className="divide-y divide-[var(--workspace-border-subtle)]">
                    <div className="pb-8">
                      <PageSection
                        title="Live"
                        sectionNode={scratchpadLiveSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        updateNode={updateNode}
                        moveNode={moveNode}
                        splitNode={splitNode}
                        replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                        setNodeTreeArchived={setNodeTreeArchived}
                        isPageReadOnly={isPageArchived}
                        collapsedNodeIds={collapsedNodeIds}
                        selectedNodeIds={selectedNodeIds}
                        onToggleNodeCollapsed={toggleNodeCollapsed}
                        onSelectSingleNode={selectSingleNode}
                        onSelectNodeRange={selectNodeRange}
                        pendingInsertedComposer={pendingInsertedComposer}
                        onOpenInsertedComposer={openInsertedComposer}
                        onClearInsertedComposer={clearInsertedComposer}
                        onBeginTextEditing={clearNodeSelection}
                        activeDraggedNodeId={activeDraggedNodeId}
                        activeDraggedNodePayload={activeDraggedNodePayload}
                        onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                        onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        pagesByTitle={pagesByTitle}
                        onOpenPage={handleSelectPage}
                        onOpenNode={handleOpenLinkedNode}
                        depthOffset={sectionDepthOffset}
                      />
                    </div>
                    <div className="pt-8">
                      <PageSection
                        title="Previous"
                        sectionNode={scratchpadPreviousSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        updateNode={updateNode}
                        moveNode={moveNode}
                        splitNode={splitNode}
                        replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                        setNodeTreeArchived={setNodeTreeArchived}
                        isPageReadOnly={isPageArchived}
                        collapsedNodeIds={collapsedNodeIds}
                        selectedNodeIds={selectedNodeIds}
                        onToggleNodeCollapsed={toggleNodeCollapsed}
                        onSelectSingleNode={selectSingleNode}
                        onSelectNodeRange={selectNodeRange}
                        pendingInsertedComposer={pendingInsertedComposer}
                        onOpenInsertedComposer={openInsertedComposer}
                        onClearInsertedComposer={clearInsertedComposer}
                        onBeginTextEditing={clearNodeSelection}
                        activeDraggedNodeId={activeDraggedNodeId}
                        activeDraggedNodePayload={activeDraggedNodePayload}
                        onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                        onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        pagesByTitle={pagesByTitle}
                        onOpenPage={handleSelectPage}
                        onOpenNode={handleOpenLinkedNode}
                        depthOffset={sectionDepthOffset}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <OutlineNodeList
                      nodes={genericRoots}
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      nodeMap={nodeMap}
                      createNodesBatch={createNodesBatch}
                      updateNode={updateNode}
                      moveNode={moveNode}
                      splitNode={splitNode}
                      replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
                      setNodeTreeArchived={setNodeTreeArchived}
                      isPageReadOnly={isPageArchived}
                      collapsedNodeIds={collapsedNodeIds}
                      selectedNodeIds={selectedNodeIds}
                      onToggleNodeCollapsed={toggleNodeCollapsed}
                      onSelectSingleNode={selectSingleNode}
                      onSelectNodeRange={selectNodeRange}
                      pendingInsertedComposer={pendingInsertedComposer}
                      onOpenInsertedComposer={openInsertedComposer}
                      onClearInsertedComposer={clearInsertedComposer}
                      onBeginTextEditing={clearNodeSelection}
                      activeDraggedNodeId={activeDraggedNodeId}
                      activeDraggedNodePayload={activeDraggedNodePayload}
                      onSetActiveDraggedNodeId={setActiveDraggedNodeId}
                      onSetActiveDraggedNodePayload={setActiveDraggedNodePayload}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      pagesByTitle={pagesByTitle}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                    />
                    <InlineComposer
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      parentNodeId={null}
                      afterNodeId={genericRoots[genericRoots.length - 1]?._id as Id<"nodes"> | undefined}
                      createNodesBatch={createNodesBatch}
                      readOnly={isPageArchived}
                      depth={0}
                      onBeginTextEditing={clearNodeSelection}
                    />
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--workspace-border-subtle)] px-10 py-5 md:px-14">
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => selectedPage && void handleArchivePage(selectedPage, !isPageArchived)}
                    className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                  >
                    {isPageArchived ? "Restore" : "Archive"}
                  </button>
                  {isPageArchived ? (
                    <button
                      type="button"
                      onClick={() => selectedPage && void handleDeletePageForever(selectedPage)}
                      className="border border-[var(--workspace-danger)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-danger)] transition hover:bg-[var(--workspace-danger)] hover:text-[var(--workspace-inverse-text)]"
                    >
                      Delete Forever
                    </button>
                  ) : null}
                </div>
              </div>
              </div>
              {isMainPaneLoading ? (
                <div className="workspace-pane-fade pointer-events-auto absolute inset-0 z-20 grid place-items-center bg-[color-mix(in_srgb,var(--workspace-bg)_74%,transparent)] backdrop-blur-[2px]">
                  <div className="border border-[var(--workspace-border)] bg-[var(--workspace-surface)] px-6 py-4 text-center shadow-[0_20px_50px_-35px_rgba(0,0,0,0.45)]">
                    <p className="text-xs uppercase tracking-[0.3em] text-[var(--workspace-accent)]">
                      Loading
                    </p>
                    <p className="mt-2 text-lg font-medium text-[var(--workspace-text)]">
                      Opening page…
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
      {paletteOpen ? (
        <div
          className="fixed inset-0 z-50 bg-[var(--workspace-text)]/20 p-4 sm:p-8"
          onClick={() => {
            setPaletteOpen(false);
            setPaletteQuery("");
            setPaletteMode("pages");
            setTextSearchResults([]);
            setNodeSearchResults([]);
          }}
        >
          <div
            className="mx-auto mt-16 w-full max-w-2xl border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] shadow-[0_30px_90px_-45px_rgba(53,41,24,0.45)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
              <div className="mb-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    switchPaletteMode("pages");
                  }}
                  className={clsx(
                    "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    paletteMode === "pages"
                      ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                      : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  Pages
                </button>
                <button
                  type="button"
                  onClick={() => {
                    switchPaletteMode("find");
                  }}
                  className={clsx(
                    "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    paletteMode === "find"
                      ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                      : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  Find
                </button>
                <button
                  type="button"
                  onClick={() => {
                    switchPaletteMode("nodes");
                  }}
                  className={clsx(
                    "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    paletteMode === "nodes"
                      ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                      : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  Semantic
                </button>
              </div>
              <div className="flex items-center gap-3">
                <input
                  ref={paletteInputRef}
                  value={paletteQuery}
                  onChange={(event) => {
                    setPaletteQuery(event.target.value);
                    setPaletteHighlightIndex(0);
                  }}
                  onKeyDown={handlePaletteKeyDown}
                  placeholder={
                    paletteMode === "pages"
                      ? "Search pages..."
                      : paletteMode === "find"
                        ? "Find exact text in notes and tasks..."
                        : "Search notes and tasks semantically across the workspace..."
                  }
                  className="w-full border-0 bg-transparent p-0 text-lg outline-none"
                />
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto py-2">
              {paletteMode === "pages" ? (
                paletteResults.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">No matching pages.</p>
                ) : (
                paletteResults.map((page, index) => {
                  return (
                    <button
                      key={page._id}
                      type="button"
                      onMouseEnter={() => setPaletteHighlightIndex(index)}
                      onClick={() => handleSelectPage(page._id)}
                      className={clsx(
                        "flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition",
                        index === paletteHighlightIndex
                          ? "bg-[var(--workspace-sidebar-bg)]"
                          : "hover:bg-[var(--workspace-surface-hover)]",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                          {page.title}
                        </span>
                        <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                          {getPageTypeDisplayLabel(page)}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                        {page.archived ? (
                          <span className="rounded-full border border-[var(--workspace-border)] px-2 py-1 text-[var(--workspace-text-faint)]">
                            Archived
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })
                )
              ) : paletteMode === "find" ? paletteQuery.trim().length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
                  Find plain text across all active notes and tasks in all pages.
                </p>
              ) : isTextSearchLoading ? (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">Finding text…</p>
              ) : textSearchResults.length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">No matching text.</p>
              ) : (
                textSearchResults.map((result, index) => {
                  return (
                    <button
                      key={`${result.node._id}:${result.page?._id ?? "page"}:find`}
                      type="button"
                      onMouseEnter={() => setPaletteHighlightIndex(index)}
                      onClick={() => handleSelectNodeSearchResult(result)}
                      className={clsx(
                        "flex w-full items-start justify-between gap-3 px-5 py-3 text-left transition",
                        index === paletteHighlightIndex
                          ? "bg-[var(--workspace-sidebar-bg)]"
                          : "hover:bg-[var(--workspace-surface-hover)]",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                          {result.node.text || "(empty line)"}
                        </span>
                        <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                          {result.page?.title ?? "Unknown page"}
                          {result.page ? ` • ${getPageTypeDisplayLabel(result.page)}` : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                        <span>Text</span>
                      </span>
                    </button>
                  );
                })
              ) : paletteMode === "nodes" ? paletteQuery.trim().length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
                  Search across all active notes and tasks in all pages.
                </p>
              ) : isNodeSearchLoading ? (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">Searching notes…</p>
              ) : nodeSearchResults.length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">No matching notes.</p>
              ) : (
                nodeSearchResults.map((result, index) => {
                  return (
                    <button
                      key={`${result.node._id}:${result.page?._id ?? "page"}`}
                      type="button"
                      onMouseEnter={() => setPaletteHighlightIndex(index)}
                      onClick={() => handleSelectNodeSearchResult(result)}
                      className={clsx(
                        "flex w-full items-start justify-between gap-3 px-5 py-3 text-left transition",
                        index === paletteHighlightIndex
                          ? "bg-[var(--workspace-sidebar-bg)]"
                          : "hover:bg-[var(--workspace-surface-hover)]",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                          {result.node.text || "(empty line)"}
                        </span>
                        <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                          {result.page?.title ?? "Unknown page"}
                          {result.page ? ` • ${getPageTypeDisplayLabel(result.page)}` : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                        <span>{result.node.kind === "task" ? "Task" : "Note"}</span>
                      </span>
                    </button>
                  );
                })
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <WorkspaceAiDock
        ownerKey={ownerKey}
        draft={workspaceChatDraft}
        onDraftChange={setWorkspaceChatDraft}
        onSubmit={() => void handleWorkspaceChatSubmit()}
        messages={workspaceChatMessages}
        isLoading={isWorkspaceChatLoading}
        error={workspaceChatError}
        onClearError={() => setWorkspaceChatError("")}
        onOpenSource={handleOpenWorkspaceKnowledgeSource}
        isCollapsed={isWorkspaceAiDockCollapsed}
        onToggleCollapsed={() =>
          setIsWorkspaceAiDockCollapsed((current) => !current)
        }
      />
      </main>
    </WorkspaceHistoryProvider>
  );
}

function PageSection({
  title,
  sectionNode,
  ownerKey,
  pageId,
  nodeMap,
  createNodesBatch,
  updateNode,
  moveNode,
  splitNode,
  replaceNodeAndInsertSiblings,
  setNodeTreeArchived,
  isPageReadOnly,
  collapsedNodeIds,
  selectedNodeIds,
  onToggleNodeCollapsed,
  onSelectSingleNode,
  onSelectNodeRange,
  pendingInsertedComposer,
  onOpenInsertedComposer,
  onClearInsertedComposer,
  onBeginTextEditing,
  activeDraggedNodeId,
  activeDraggedNodePayload,
  onSetActiveDraggedNodeId,
  onSetActiveDraggedNodePayload,
  onSelectionStart,
  onSelectionExtend,
  pagesByTitle,
  onOpenPage,
  onOpenNode,
  depthOffset = 0,
  mobileIndentStep = 0,
  action = null,
  statusMessage = "",
  compact = false,
}: {
  title: string;
  sectionNode: TreeNode | null;
  ownerKey: string;
  pageId: Id<"pages">;
  nodeMap: Map<string, Doc<"nodes">>;
  createNodesBatch: CreateNodesBatchMutation;
  updateNode: UpdateNodeMutation;
  moveNode: MoveNodeMutation;
  splitNode: SplitNodeMutation;
  replaceNodeAndInsertSiblings: ReplaceNodeAndInsertSiblingsMutation;
  setNodeTreeArchived: SetNodeTreeArchivedMutation;
  isPageReadOnly: boolean;
  collapsedNodeIds: Set<string>;
  selectedNodeIds: Set<string>;
  onToggleNodeCollapsed: (nodeId: string) => void;
  onSelectSingleNode: (nodeId: string) => void;
  onSelectNodeRange: (anchorNodeId: string, currentNodeId: string) => void;
  pendingInsertedComposer: PendingInsertedComposer | null;
  onOpenInsertedComposer: (
    pageId: Id<"pages">,
    parentNodeId: Id<"nodes"> | null,
    afterNodeId: Id<"nodes">,
  ) => void;
  onClearInsertedComposer: () => void;
  onBeginTextEditing: () => void;
  activeDraggedNodeId: string | null;
  activeDraggedNodePayload: DraggedNodePayload | null;
  onSetActiveDraggedNodeId: (nodeId: string | null) => void;
  onSetActiveDraggedNodePayload: (payload: DraggedNodePayload | null) => void;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
  pagesByTitle: Map<string, PageDoc>;
  onOpenPage: (pageId: Id<"pages">) => void;
  onOpenNode: (pageId: Id<"pages">, nodeId: Id<"nodes">) => void;
  depthOffset?: number;
  mobileIndentStep?: number;
  action?: ReactNode;
  statusMessage?: string;
  compact?: boolean;
}) {
  const lastChild = sectionNode
    ? sectionNode.children[sectionNode.children.length - 1] ?? null
    : null;

  return (
    <div
      data-section-slot={
        typeof getNodeMeta(sectionNode).sectionSlot === "string"
          ? (getNodeMeta(sectionNode).sectionSlot as string)
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-4">
        <h2
          className={clsx(
            compact
              ? "text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]"
              : "text-2xl font-semibold tracking-tight",
          )}
        >
          {title}
        </h2>
        {action}
      </div>
      {statusMessage ? (
        <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">{statusMessage}</p>
      ) : null}
      <div className="mt-2 border-b border-[var(--workspace-border)]" />
      <div className={clsx(compact ? "mt-3 space-y-1" : "mt-4 space-y-1")}>
        <OutlineNodeList
          nodes={sectionNode?.children ?? []}
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={(sectionNode?._id as Id<"nodes"> | null) ?? null}
          nodeMap={nodeMap}
          createNodesBatch={createNodesBatch}
          updateNode={updateNode}
          moveNode={moveNode}
          splitNode={splitNode}
          replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
          setNodeTreeArchived={setNodeTreeArchived}
          depth={depthOffset}
          isPageReadOnly={isPageReadOnly}
          collapsedNodeIds={collapsedNodeIds}
          selectedNodeIds={selectedNodeIds}
          onToggleNodeCollapsed={onToggleNodeCollapsed}
          onSelectSingleNode={onSelectSingleNode}
          onSelectNodeRange={onSelectNodeRange}
          pendingInsertedComposer={pendingInsertedComposer}
          onOpenInsertedComposer={onOpenInsertedComposer}
          onClearInsertedComposer={onClearInsertedComposer}
          onBeginTextEditing={onBeginTextEditing}
          activeDraggedNodeId={activeDraggedNodeId}
          activeDraggedNodePayload={activeDraggedNodePayload}
          onSetActiveDraggedNodeId={onSetActiveDraggedNodeId}
          onSetActiveDraggedNodePayload={onSetActiveDraggedNodePayload}
          onSelectionStart={onSelectionStart}
          onSelectionExtend={onSelectionExtend}
          pagesByTitle={pagesByTitle}
          onOpenPage={onOpenPage}
          onOpenNode={onOpenNode}
          mobileIndentStep={mobileIndentStep}
        />
        <InlineComposer
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={(sectionNode?._id as Id<"nodes"> | undefined) ?? undefined}
          afterNodeId={(lastChild?._id as Id<"nodes"> | undefined) ?? undefined}
          createNodesBatch={createNodesBatch}
          readOnly={isPageReadOnly}
          depth={depthOffset}
          mobileIndentStep={mobileIndentStep}
          onBeginTextEditing={onBeginTextEditing}
        />
      </div>
    </div>
  );
}

function OutlineNodeList({
  nodes,
  ownerKey,
  pageId,
  nodeMap,
  createNodesBatch,
  updateNode,
  moveNode,
  splitNode,
  replaceNodeAndInsertSiblings,
  setNodeTreeArchived,
  depth = 0,
  parentNodeId = null,
  isPageReadOnly,
  collapsedNodeIds,
  selectedNodeIds,
  onToggleNodeCollapsed,
  onSelectSingleNode,
  onSelectNodeRange,
  pendingInsertedComposer,
  onOpenInsertedComposer,
  onClearInsertedComposer,
  onBeginTextEditing,
  activeDraggedNodeId,
  activeDraggedNodePayload,
  onSetActiveDraggedNodeId,
  onSetActiveDraggedNodePayload,
  onSelectionStart,
  onSelectionExtend,
  pagesByTitle,
  onOpenPage,
  onOpenNode,
  mobileIndentStep = 0,
}: {
  nodes: TreeNode[];
  ownerKey: string;
  pageId: Id<"pages">;
  nodeMap: Map<string, Doc<"nodes">>;
  createNodesBatch: CreateNodesBatchMutation;
  updateNode: UpdateNodeMutation;
  moveNode: MoveNodeMutation;
  splitNode: SplitNodeMutation;
  replaceNodeAndInsertSiblings: ReplaceNodeAndInsertSiblingsMutation;
  setNodeTreeArchived: SetNodeTreeArchivedMutation;
  depth?: number;
  parentNodeId?: Id<"nodes"> | null;
  isPageReadOnly: boolean;
  collapsedNodeIds: Set<string>;
  selectedNodeIds: Set<string>;
  onToggleNodeCollapsed: (nodeId: string) => void;
  onSelectSingleNode: (nodeId: string) => void;
  onSelectNodeRange: (anchorNodeId: string, currentNodeId: string) => void;
  pendingInsertedComposer: PendingInsertedComposer | null;
  onOpenInsertedComposer: (
    pageId: Id<"pages">,
    parentNodeId: Id<"nodes"> | null,
    afterNodeId: Id<"nodes">,
  ) => void;
  onClearInsertedComposer: () => void;
  onBeginTextEditing: () => void;
  activeDraggedNodeId: string | null;
  activeDraggedNodePayload: DraggedNodePayload | null;
  onSetActiveDraggedNodeId: (nodeId: string | null) => void;
  onSetActiveDraggedNodePayload: (payload: DraggedNodePayload | null) => void;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
  pagesByTitle: Map<string, PageDoc>;
  onOpenPage: (pageId: Id<"pages">) => void;
  onOpenNode: (pageId: Id<"pages">, nodeId: Id<"nodes">) => void;
  mobileIndentStep?: number;
}) {
  return (
    <>
      {nodes.map((node, index) => (
        <OutlineNodeEditor
          key={node._id}
          node={node}
          previousSibling={index > 0 ? nodes[index - 1]! : null}
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={parentNodeId}
          nodeMap={nodeMap}
          createNodesBatch={createNodesBatch}
          updateNode={updateNode}
          moveNode={moveNode}
          splitNode={splitNode}
          replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
          setNodeTreeArchived={setNodeTreeArchived}
          siblings={nodes}
          siblingIndex={index}
          depth={depth}
          isPageReadOnly={isPageReadOnly}
          collapsedNodeIds={collapsedNodeIds}
          isSelected={isNodeWithinSelectedSubtree(node._id, selectedNodeIds, nodeMap)}
          selectedNodeIds={selectedNodeIds}
          onToggleNodeCollapsed={onToggleNodeCollapsed}
          onSelectSingleNode={onSelectSingleNode}
          onSelectNodeRange={onSelectNodeRange}
        pendingInsertedComposer={pendingInsertedComposer}
        onOpenInsertedComposer={onOpenInsertedComposer}
        onClearInsertedComposer={onClearInsertedComposer}
        onBeginTextEditing={onBeginTextEditing}
        activeDraggedNodeId={activeDraggedNodeId}
        activeDraggedNodePayload={activeDraggedNodePayload}
        onSetActiveDraggedNodeId={onSetActiveDraggedNodeId}
        onSetActiveDraggedNodePayload={onSetActiveDraggedNodePayload}
          onSelectionStart={onSelectionStart}
          onSelectionExtend={onSelectionExtend}
          pagesByTitle={pagesByTitle}
          onOpenPage={onOpenPage}
          onOpenNode={onOpenNode}
          mobileIndentStep={mobileIndentStep}
        />
      ))}
    </>
  );
}

function LinkAutocompleteMenu({
  suggestions,
  highlightIndex,
  onHover,
  onSelect,
  anchorRef,
}: {
  suggestions: LinkSuggestion[];
  highlightIndex: number;
  onHover: (index: number) => void;
  onSelect: (suggestion: LinkSuggestion) => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const position = useFloatingMenuPosition(anchorRef, true);

  if (!position || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="fixed z-[140] border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] shadow-[0_24px_64px_-32px_rgba(0,0,0,0.6)]"
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
    >
      {suggestions.length === 0 ? (
        <p className="px-3 py-2 text-sm text-[var(--workspace-text-subtle)]">
          No matching pages or nodes.
        </p>
      ) : (
        <div className="overflow-y-auto py-1" style={{ maxHeight: position.maxHeight }}>
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.key}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(suggestion);
              }}
              onMouseEnter={() => onHover(index)}
              className={clsx(
                "block w-full px-3 py-2 text-left transition",
                index === highlightIndex
                  ? "bg-[var(--workspace-sidebar-bg)]"
                  : "hover:bg-[var(--workspace-surface-hover)]",
              )}
            >
              <div className="text-sm text-[var(--workspace-text-strong)]">
                {suggestion.title}
              </div>
              <div className="text-xs text-[var(--workspace-text-subtle)]">
                {suggestion.subtitle}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

function LinkedTextPreview({
  segments,
  onFocusLine,
  onOpenPage,
  onOpenNode,
  isDisabled,
  className,
}: {
  segments: LinkPreviewSegment[];
  onFocusLine: () => void;
  onOpenPage: (pageId: Id<"pages">) => void;
  onOpenNode: (pageId: Id<"pages">, nodeId: Id<"nodes">) => void;
  isDisabled: boolean;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "absolute inset-0 z-10 whitespace-pre-wrap break-words px-0 py-1 text-[15px] leading-6",
        isDisabled ? "cursor-default" : "cursor-text",
        className,
      )}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-page-link-preview='true']")) {
          return;
        }
        if (isDisabled) {
          return;
        }
        event.preventDefault();
        onFocusLine();
      }}
    >
      {segments.map((segment) =>
        segment.kind === "text" ? (
          <span key={segment.key}>{segment.text}</span>
        ) : (
          segment.pageId !== null ? (
            <button
              key={segment.key}
              type="button"
              data-page-link-preview="true"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (segment.linkKind === "node" && segment.nodeId) {
                  onOpenNode(segment.pageId!, segment.nodeId);
                  return;
                }
                onOpenPage(segment.pageId!);
              }}
              className={clsx(
                "inline-flex items-center cursor-pointer text-[var(--workspace-brand)] underline decoration-[1.5px] underline-offset-[3px] transition hover:text-[var(--workspace-brand-hover)]",
                segment.archived ? "opacity-75" : "",
              )}
            >
              <span>{segment.text}</span>
              {segment.pageTypeLabel ? (
                <span className="ml-1 text-[10px] uppercase tracking-[0.16em] text-[var(--workspace-text-faint)] no-underline">
                  {segment.pageTypeLabel}
                </span>
              ) : null}
            </button>
          ) : (
            <span
              key={segment.key}
              className={clsx(
                "inline text-[var(--workspace-brand)] underline decoration-[1.5px] underline-offset-[3px]",
                segment.linkKind === "node"
                  ? "decoration-dotted"
                  : "decoration-[var(--workspace-brand)]/70",
                segment.resolved ? "" : "opacity-80",
              )}
            >
              {segment.text}
            </span>
          )
        ),
      )}
    </div>
  );
}

function PlainTextPreview({
  text,
  onFocusLine,
  isDisabled,
  className,
}: {
  text: string;
  onFocusLine: () => void;
  isDisabled: boolean;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "absolute inset-0 z-10 whitespace-pre-wrap break-words px-0 py-1 text-[15px] leading-6",
        isDisabled ? "cursor-default" : "cursor-text",
        className,
      )}
      onMouseDown={(event) => {
        if (isDisabled) {
          return;
        }
        event.preventDefault();
        onFocusLine();
      }}
    >
      {text}
    </div>
  );
}

function WorkspaceAiDock({
  ownerKey,
  draft,
  onDraftChange,
  onSubmit,
  messages,
  isLoading,
  error,
  onClearError,
  onOpenSource,
  isCollapsed,
  onToggleCollapsed,
}: {
  ownerKey: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  messages: Doc<"chatMessages">[];
  isLoading: boolean;
  error: string;
  onClearError: () => void;
  onOpenSource: (source: WorkspaceKnowledgeSourceSnapshot) => void;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const [caretPosition, setCaretPosition] = useState<number | null>(null);
  const [linkHighlightIndex, setLinkHighlightIndex] = useState(0);
  const activeLinkToken = getActiveLinkToken(draft, caretPosition);
  const linkTargetResults = useQuery(
    api.workspace.searchLinkTargets,
    ownerKey && activeLinkToken
      ? {
          ownerKey,
          query: activeLinkToken.query,
          limit: 6,
        }
      : SKIP,
  ) as LinkTargetSearchResults | undefined;
  const linkSuggestions = useMemo(
    () => buildLinkSuggestions(linkTargetResults),
    [linkTargetResults],
  );
  const activeLinkHighlightIndex =
    linkSuggestions.length === 0
      ? 0
      : Math.min(linkHighlightIndex, linkSuggestions.length - 1);
  const showHistoryPanel = messages.length > 0 || error.length > 0 || isLoading;

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [draft]);

  useEffect(() => {
    const container = historyRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [error, isLoading, messages]);

  const applyLinkSuggestion = (suggestion: LinkSuggestion) => {
    if (!activeLinkToken) {
      return;
    }

    const nextValue =
      draft.slice(0, activeLinkToken.startIndex) +
      suggestion.insertText +
      draft.slice(activeLinkToken.endIndex);
    const nextCaretPosition = activeLinkToken.startIndex + suggestion.insertText.length;

    onDraftChange(nextValue);
    setCaretPosition(nextCaretPosition);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  };

  const handleKeyDown = (event: TextareaKeyboardEvent<HTMLTextAreaElement>) => {
    if (activeLinkToken && linkSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setLinkHighlightIndex((current) =>
          Math.min(current + 1, linkSuggestions.length - 1),
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setLinkHighlightIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const highlighted = linkSuggestions[activeLinkHighlightIndex];
        if (highlighted) {
          applyLinkSuggestion(highlighted);
        }
        return;
      }

      if (event.key === "Tab") {
        const highlighted = linkSuggestions[activeLinkHighlightIndex];
        if (highlighted) {
          event.preventDefault();
          applyLinkSuggestion(highlighted);
          return;
        }
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pb-3 md:px-6 md:pb-6">
      <div className="pointer-events-auto mx-auto max-w-[1600px]">
        <div className="overflow-hidden border border-[var(--workspace-border)] bg-[var(--workspace-surface)] shadow-[0_-16px_48px_-32px_rgba(0,0,0,0.65)] backdrop-blur-sm">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--workspace-border-subtle)] px-4 py-2 md:px-6">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                AI Chat
              </p>
              <p className="text-[11px] text-[var(--workspace-text-faint)]">
                {messages.length > 0
                  ? `${messages.length} message${messages.length === 1 ? "" : "s"} saved`
                  : "Persistent workspace conversation"}
              </p>
            </div>
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="border border-[var(--workspace-border-control)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
            >
              {isCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
          <div
            className={clsx(
              "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
              isCollapsed
                ? "pointer-events-none grid-rows-[0fr] opacity-0"
                : "grid-rows-[1fr] opacity-100",
            )}
          >
            <div
              aria-hidden={isCollapsed}
              className="min-h-0 overflow-hidden"
            >
              {showHistoryPanel ? (
                <div
                  ref={historyRef}
                  className="max-h-[38vh] overflow-y-auto border-b border-[var(--workspace-border-subtle)] px-4 py-4 md:px-6"
                >
                  <div className="space-y-4">
                    {messages.map((message) => {
                      const metadata =
                        message.role === "assistant"
                          ? readWorkspaceKnowledgeMessageMetadata(message)
                          : null;
                      const isUser = message.role === "user";

                      return (
                        <div
                          key={message._id}
                          className={clsx(
                            "flex",
                            isUser ? "justify-end" : "justify-start",
                          )}
                        >
                          <div
                            className={clsx(
                              "max-w-3xl border px-4 py-3",
                              isUser
                                ? "border-[var(--workspace-brand)] bg-[color-mix(in_srgb,var(--workspace-brand)_14%,transparent)]"
                                : "border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-muted)]",
                            )}
                          >
                            <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                              {isUser ? "You" : "AI"}
                            </p>
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--workspace-text)]">
                              {message.text}
                            </p>
                            {!isUser && metadata ? (
                              <>
                                <div className="mt-4 space-y-2">
                                  {metadata.sources.map((source, index) => (
                                    <button
                                      key={`${message._id}:${source.nodeId}:${index}`}
                                      type="button"
                                      onClick={() => onOpenSource(source)}
                                      className="block w-full border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface)] px-4 py-3 text-left transition hover:border-[var(--workspace-border-hover)] hover:bg-[var(--workspace-surface-hover)]"
                                    >
                                      <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                                        {source.nodeText || "(empty line)"}
                                      </span>
                                      <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                                        {source.pageTitle ?? "Unknown page"} • {source.nodeKind === "task" ? "Task" : "Note"}
                                      </span>
                                      {source.content && source.content.trim() !== source.nodeText.trim() ? (
                                        <span className="mt-2 block whitespace-pre-wrap text-xs leading-6 text-[var(--workspace-text-subtle)]">
                                          {source.content}
                                        </span>
                                      ) : null}
                                    </button>
                                  ))}
                                </div>
                                <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--workspace-border-subtle)] pt-3 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                                  <span>{metadata.model}</span>
                                  <span>{metadata.error ? "OpenAI issue surfaced" : "Grounded with linked + semantic context"}</span>
                                </div>
                              </>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    {isLoading ? (
                      <div className="flex justify-start">
                        <div className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-muted)] px-4 py-3">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                            AI
                          </p>
                          <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">
                            Thinking…
                          </p>
                        </div>
                      </div>
                    ) : null}
                    {error ? (
                      <div className="border border-[var(--workspace-danger)]/40 bg-[color-mix(in_srgb,var(--workspace-danger)_10%,transparent)] px-4 py-3 text-sm text-[var(--workspace-text)]">
                        <div className="flex items-start justify-between gap-3">
                          <p className="whitespace-pre-wrap leading-6">{error}</p>
                          <button
                            type="button"
                            onClick={onClearError}
                            className="border border-[var(--workspace-border-control)] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="relative flex items-end gap-3 px-4 py-3 md:px-6 md:py-4">
              <div className="min-w-0 flex-1">
                <textarea
                  id={WORKSPACE_AI_DOCK_TEXTAREA_ID}
                  ref={textareaRef}
                  value={draft}
                  onChange={(event) => {
                    if (error) {
                      onClearError();
                    }
                    onDraftChange(event.target.value);
                    setCaretPosition(event.target.selectionStart ?? event.target.value.length);
                  }}
                  onFocus={(event) => {
                    setCaretPosition(event.target.selectionStart ?? event.target.value.length);
                  }}
                  onSelect={(event) => {
                    setCaretPosition(
                      event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                    );
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask AI about your workspace. Use [[Page]] or [[Node|node:id]] to pin specific context…"
                  rows={1}
                  disabled={isLoading}
                  tabIndex={isCollapsed ? -1 : 0}
                  className="w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[15px] leading-6 outline-none"
                />
                <p className="mt-1 text-[11px] leading-5 text-[var(--workspace-text-faint)]">
                  This chat persists between sessions. Linked pages and nodes in `[[...]]` are sent as explicit context before semantic retrieval.
                </p>
              </div>
              <button
                type="button"
                onClick={onSubmit}
                disabled={isLoading || draft.trim().length === 0}
                className={clsx(
                  "border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition",
                  isLoading
                    ? "cursor-wait opacity-60"
                    : draft.trim().length === 0
                      ? "cursor-not-allowed opacity-60"
                      : "hover:bg-[var(--workspace-brand-hover)]",
                )}
              >
                {isLoading ? "Thinking…" : "Ask AI"}
              </button>
              {activeLinkToken && linkSuggestions.length > 0 ? (
                <LinkAutocompleteMenu
                  anchorRef={textareaRef}
                  suggestions={linkSuggestions}
                  highlightIndex={activeLinkHighlightIndex}
                  onHover={setLinkHighlightIndex}
                  onSelect={applyLinkSuggestion}
                />
              ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OutlineNodeEditor({
  node,
  siblings,
  siblingIndex,
  previousSibling,
  ownerKey,
  pageId,
  parentNodeId,
  nodeMap,
  createNodesBatch,
  updateNode,
  moveNode,
  splitNode,
  replaceNodeAndInsertSiblings,
  setNodeTreeArchived,
  depth = 0,
  isPageReadOnly,
  collapsedNodeIds,
  isSelected,
  selectedNodeIds,
  onToggleNodeCollapsed,
  onSelectSingleNode,
  onSelectNodeRange,
  pendingInsertedComposer,
  onOpenInsertedComposer,
  onClearInsertedComposer,
  onBeginTextEditing,
  activeDraggedNodeId,
  activeDraggedNodePayload,
  onSetActiveDraggedNodeId,
  onSetActiveDraggedNodePayload,
  onSelectionStart,
  onSelectionExtend,
  pagesByTitle,
  onOpenPage,
  onOpenNode,
  mobileIndentStep = 0,
}: {
  node: TreeNode;
  siblings: TreeNode[];
  siblingIndex: number;
  previousSibling: TreeNode | null;
  ownerKey: string;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null;
  nodeMap: Map<string, Doc<"nodes">>;
  createNodesBatch: CreateNodesBatchMutation;
  updateNode: UpdateNodeMutation;
  moveNode: MoveNodeMutation;
  splitNode: SplitNodeMutation;
  replaceNodeAndInsertSiblings: ReplaceNodeAndInsertSiblingsMutation;
  setNodeTreeArchived: SetNodeTreeArchivedMutation;
  depth?: number;
  isPageReadOnly: boolean;
  collapsedNodeIds: Set<string>;
  isSelected: boolean;
  selectedNodeIds: Set<string>;
  onToggleNodeCollapsed: (nodeId: string) => void;
  onSelectSingleNode: (nodeId: string) => void;
  onSelectNodeRange: (anchorNodeId: string, currentNodeId: string) => void;
  pendingInsertedComposer: PendingInsertedComposer | null;
  onOpenInsertedComposer: (
    pageId: Id<"pages">,
    parentNodeId: Id<"nodes"> | null,
    afterNodeId: Id<"nodes">,
  ) => void;
  onClearInsertedComposer: () => void;
  onBeginTextEditing: () => void;
  activeDraggedNodeId: string | null;
  activeDraggedNodePayload: DraggedNodePayload | null;
  onSetActiveDraggedNodeId: (nodeId: string | null) => void;
  onSetActiveDraggedNodePayload: (payload: DraggedNodePayload | null) => void;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
  pagesByTitle: Map<string, PageDoc>;
  onOpenPage: (pageId: Id<"pages">) => void;
  onOpenNode: (pageId: Id<"pages">, nodeId: Id<"nodes">) => void;
  mobileIndentStep?: number;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState(node.text);
  const [isFocused, setIsFocused] = useState(false);
  const [caretPosition, setCaretPosition] = useState<number | null>(null);
  const [linkHighlightIndex, setLinkHighlightIndex] = useState(0);
  const [dropTarget, setDropTarget] = useState<NodeDropTarget | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const markerHoldTimeoutRef = useRef<number | null>(null);
  const markerLongPressTriggeredRef = useRef(false);
  const childrenAnimationFrameRef = useRef<number | null>(null);

  const nodeMeta = getNodeMeta(node);
  const isLocked = nodeMeta.locked === true;
  const isDisabled = isLocked || isPageReadOnly;
  const editorId = getNodeEditorId(node._id as Id<"nodes">);
  const editorTarget = useMemo(
    () =>
      ({
        kind: "node",
        pageId,
        nodeId: node._id as Id<"nodes">,
      } satisfies TrackedEditorTarget),
    [node._id, pageId],
  );
  const fallbackFocusEditorId =
    previousSibling?._id
      ? getNodeEditorId(previousSibling._id as Id<"nodes">)
      : getComposerEditorId(pageId, parentNodeId);
  const nextSibling = siblings[siblingIndex + 1] ?? null;
  const normalizedDraft = draft.trim();
  const isVisualEmptyLine = normalizedDraft === ".";
  const isVisualSeparatorLine = normalizedDraft === "---";
  const isDimmedLine = isDimmedSyntaxLine(draft);
  const shouldRevealVisualPlaceholder = isFocused || isSelected;
  const nodeLinkTargetIds = useMemo(
    () =>
      extractLinkMatches(draft)
        .flatMap((match) =>
          match.link.kind === "node" ? [match.link.targetNodeRef as Id<"nodes">] : [],
        )
        .filter((value, index, collection) => collection.indexOf(value) === index),
    [draft],
  );
  const resolvedNodeLinks = useQuery(
    api.workspace.resolveNodeLinks,
    ownerKey && !isFocused && nodeLinkTargetIds.length > 0
      ? {
          ownerKey,
          nodeIds: nodeLinkTargetIds,
        }
      : SKIP,
  ) as NodeLinkTargetResolution[] | undefined;
  const nodeTargetsById = useMemo(() => {
    const next = new Map<string, NodeLinkTargetResolution>();
    for (const target of resolvedNodeLinks ?? []) {
      next.set(target.nodeId, target);
    }
    return next;
  }, [resolvedNodeLinks]);
  const linkPreviewSegments = useMemo(() => {
    const segments = buildLinkPreviewSegments(draft, pagesByTitle, nodeTargetsById);
    return isDimmedLine ? stripDimPrefixFromSegments(segments) : segments;
  }, [draft, isDimmedLine, nodeTargetsById, pagesByTitle]);
  const displayDraft = useMemo(
    () => (isDimmedLine ? stripDimmedSyntaxPrefix(draft) : draft),
    [draft, isDimmedLine],
  );
  const hasPageLinkPreview =
    !isFocused &&
    !isVisualEmptyLine &&
    !isVisualSeparatorLine &&
    linkPreviewSegments.length > 0;
  const hasPlainTextPreview =
    !isFocused &&
    !isVisualEmptyLine &&
    !isVisualSeparatorLine &&
    isDimmedLine &&
    !hasPageLinkPreview;
  const hasDisplayPreview = hasPageLinkPreview || hasPlainTextPreview;
  const activeLinkToken = getActiveLinkToken(draft, caretPosition);
  const linkTargetResults = useQuery(
    api.workspace.searchLinkTargets,
    ownerKey && isFocused && activeLinkToken
      ? {
          ownerKey,
          query: activeLinkToken.query,
          limit: 6,
          excludeNodeId: node._id as Id<"nodes">,
        }
      : SKIP,
  ) as LinkTargetSearchResults | undefined;
  const linkSuggestions = useMemo(
    () => buildLinkSuggestions(linkTargetResults),
    [linkTargetResults],
  );
  const activeLinkHighlightIndex =
    linkSuggestions.length === 0
      ? 0
      : Math.min(linkHighlightIndex, linkSuggestions.length - 1);
  const pendingSiblingComposerVisible =
    pendingInsertedComposer?.pageId === pageId &&
    pendingInsertedComposer?.parentNodeId === parentNodeId &&
    pendingInsertedComposer?.afterNodeId === node._id;
  const pendingSiblingComposerFocusToken =
    pendingSiblingComposerVisible ? pendingInsertedComposer?.focusToken ?? 0 : 0;
  const isDraggingAnotherNode = activeDraggedNodeId !== null && activeDraggedNodeId !== node._id;
  const hasChildren = node.children.length > 0;
  const hasNestedGrandchildren = node.children.some((child) => child.children.length > 0);
  const isCollapsed = hasChildren && collapsedNodeIds.has(node._id);
  const [shouldRenderChildren, setShouldRenderChildren] = useState(hasChildren && !isCollapsed);
  const [isChildrenExpanded, setIsChildrenExpanded] = useState(hasChildren && !isCollapsed);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [draft]);

  useEffect(() => {
    return history.registerEditor(editorId, editorTarget, node.text, {
      getElement: () => textareaRef.current,
      getValue: () => draftRef.current,
      setValue: setDraft,
      focusAtEnd: () => focusElementAtEnd(textareaRef.current),
    });
  }, [editorId, editorTarget, history, node.text]);

  useEffect(() => {
    history.syncCommittedValue(editorId, node.text, editorTarget);
  }, [editorId, editorTarget, history, node.text]);

  useEffect(() => {
    return () => history.flushDraftCheckpoint(editorId);
  }, [editorId, history]);

  useEffect(() => {
    return () => {
      if (markerHoldTimeoutRef.current !== null) {
        window.clearTimeout(markerHoldTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (childrenAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(childrenAnimationFrameRef.current);
      childrenAnimationFrameRef.current = null;
    }

    if (!hasChildren) {
      if (shouldRenderChildren || isChildrenExpanded) {
        childrenAnimationFrameRef.current = window.requestAnimationFrame(() => {
          setShouldRenderChildren(false);
          setIsChildrenExpanded(false);
          childrenAnimationFrameRef.current = null;
        });
      }
      return;
    }

    if (isCollapsed) {
      if (isChildrenExpanded) {
        childrenAnimationFrameRef.current = window.requestAnimationFrame(() => {
          setIsChildrenExpanded(false);
          childrenAnimationFrameRef.current = null;
        });
      }
      return;
    }

    if (!shouldRenderChildren || !isChildrenExpanded) {
      childrenAnimationFrameRef.current = window.requestAnimationFrame(() => {
        setShouldRenderChildren(true);
        setIsChildrenExpanded(true);
        childrenAnimationFrameRef.current = null;
      });
    }

    return () => {
      if (childrenAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(childrenAnimationFrameRef.current);
        childrenAnimationFrameRef.current = null;
      }
    };
  }, [hasChildren, isChildrenExpanded, isCollapsed, shouldRenderChildren]);

  const applyLinkSuggestion = (suggestion: LinkSuggestion) => {
    if (!activeLinkToken) {
      return;
    }

    const nextValue =
      draft.slice(0, activeLinkToken.startIndex) +
      suggestion.insertText +
      draft.slice(activeLinkToken.endIndex);
    const nextCaretPosition = activeLinkToken.startIndex + suggestion.insertText.length;

    setDraft(nextValue);
    history.updateDraftValue(editorId, editorTarget, nextValue);
    setCaretPosition(nextCaretPosition);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  };

  const focusLineEditor = () => {
    onBeginTextEditing();
    focusElementAtEnd(textareaRef.current);
  };

  const focusAdjacentVisibleNode = (direction: -1 | 1) => {
    const shells = Array.from(
      document.querySelectorAll<HTMLElement>("[data-node-shell][data-node-id]"),
    );
    const currentIndex = shells.findIndex((shell) => shell.dataset.nodeId === node._id);
    if (currentIndex === -1) {
      return false;
    }

    const targetShell = shells[currentIndex + direction];
    const targetNodeId = targetShell?.dataset.nodeId;
    if (!targetShell || !targetNodeId) {
      return false;
    }

    onSelectSingleNode(targetNodeId);
    const targetInput = targetShell.querySelector<HTMLTextAreaElement>("textarea");
    window.setTimeout(() => {
      focusElementAtEnd(targetInput);
    }, 0);
    return true;
  };

  const isDescendantOfNode = (candidateNodeId: string, potentialAncestorNodeId: string) => {
    let currentNode = nodeMap.get(candidateNodeId);
    while (currentNode?.parentNodeId) {
      if (currentNode.parentNodeId === potentialAncestorNodeId) {
        return true;
      }
      currentNode = nodeMap.get(currentNode.parentNodeId as string);
    }
    return false;
  };

  const handleToggleCollapsed = () => {
    if (!hasChildren) {
      return;
    }

    if (
      !isCollapsed &&
      [...selectedNodeIds].some(
        (selectedNodeId) =>
          selectedNodeId !== node._id && isDescendantOfNode(selectedNodeId, node._id),
      )
    ) {
      onSelectSingleNode(node._id);
    }

    onToggleNodeCollapsed(node._id);
  };

  const setCollapsedState = (nextCollapsed: boolean) => {
    if (!hasChildren) {
      return;
    }

    if (nextCollapsed === isCollapsed) {
      return;
    }

    handleToggleCollapsed();
  };

  const getDropTargetFromEvent = (
    event: ReactDragEvent<HTMLElement>,
    payload: DraggedNodePayload,
  ): NodeDropTarget | null => {
    if (
      payload.nodeId === node._id ||
      payload.pageId !== pageId ||
      isDescendantOfNode(node._id, payload.nodeId)
    ) {
      return null;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeY = event.clientY - bounds.top;
    const relativeX = event.clientX - bounds.left;
    const upperZone = relativeY < bounds.height * 0.35;
    const nestingThreshold = 86;
    const wantsNest = !upperZone && relativeX > nestingThreshold;

    if (wantsNest) {
      return {
        placement: "nest",
        parentNodeId: node._id as Id<"nodes">,
        afterNodeId:
          ((node.children[node.children.length - 1]?._id as Id<"nodes"> | undefined) ?? null),
        lineSide: "bottom",
        lineIndentOffset: 30,
      };
    }

    return {
      placement: upperZone ? "before" : "after",
      parentNodeId,
      afterNodeId: upperZone
        ? (((siblings[siblingIndex - 1]?._id as Id<"nodes"> | undefined) ?? null))
        : (node._id as Id<"nodes">),
      lineSide: upperZone ? "top" : "bottom",
      lineIndentOffset: 14,
    };
  };

  const handleDragHandleStart = (event: ReactDragEvent<HTMLButtonElement>) => {
    if (isDisabled) {
      event.preventDefault();
      return;
    }

    clearMarkerHold();
    markerLongPressTriggeredRef.current = false;

    const payload: DraggedNodePayload = {
      nodeId: node._id,
      pageId,
      parentNodeId,
      previousSiblingId: previousSibling?._id ?? null,
    };

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(NODE_DRAG_MIME_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", JSON.stringify(payload));
    onSetActiveDraggedNodeId(node._id);
    onSetActiveDraggedNodePayload(payload);
    onSelectSingleNode(node._id);
  };

  const clearMarkerHold = () => {
    if (markerHoldTimeoutRef.current !== null) {
      window.clearTimeout(markerHoldTimeoutRef.current);
      markerHoldTimeoutRef.current = null;
    }
  };

  const handleMarkerPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isDisabled) {
      return;
    }

    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    markerLongPressTriggeredRef.current = false;
    clearMarkerHold();
    markerHoldTimeoutRef.current = window.setTimeout(() => {
      markerHoldTimeoutRef.current = null;
      markerLongPressTriggeredRef.current = true;
      onSelectSingleNode(node._id);
    }, 180);
  };

  const handleMarkerPointerEnd = () => {
    clearMarkerHold();
  };

  const consumeMarkerLongPress = () => {
    if (!markerLongPressTriggeredRef.current) {
      return false;
    }

    markerLongPressTriggeredRef.current = false;
    return true;
  };

  const handleMarkerClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (consumeMarkerLongPress()) {
      event.preventDefault();
      return;
    }

    if (node.kind === "task") {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        void handleToggleNodeKind();
        return;
      }

      void handleToggleTask();
      return;
    }

    void handleToggleNodeKind();
  };

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    const payload = activeDraggedNodePayload;

    if (
      !payload ||
      payload.pageId !== pageId
    ) {
      setDropTarget(null);
      return;
    }

    const nextDropTarget = getDropTargetFromEvent(event, payload);
    if (!nextDropTarget) {
      setDropTarget(null);
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(nextDropTarget);
  };

  const handleDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    const payload = activeDraggedNodePayload;
    const nextDropTarget = payload ? getDropTargetFromEvent(event, payload) : null;
    setDropTarget(null);
    onSetActiveDraggedNodeId(null);
    onSetActiveDraggedNodePayload(null);

    if (
      !payload ||
      payload.pageId !== pageId ||
      !nextDropTarget
    ) {
      return;
    }

    event.preventDefault();
    const beforePlacement = buildNodePlacement(
      payload.pageId as Id<"pages">,
      (payload.parentNodeId as Id<"nodes"> | null) ?? null,
      (payload.previousSiblingId as Id<"nodes"> | null) ?? null,
    );
    const afterPlacement = buildNodePlacement(
      pageId,
      nextDropTarget.parentNodeId,
      nextDropTarget.afterNodeId,
    );

    if (
      beforePlacement.pageId === afterPlacement.pageId &&
      beforePlacement.parentNodeId === afterPlacement.parentNodeId &&
      beforePlacement.afterNodeId === afterPlacement.afterNodeId
    ) {
      return;
    }

    await moveNode({
      ownerKey,
      nodeId: payload.nodeId as Id<"nodes">,
      pageId,
      parentNodeId: nextDropTarget.parentNodeId,
      afterNodeId: nextDropTarget.afterNodeId,
    });

    history.pushUndoEntry({
      type: "move_node",
      pageId,
      nodeId: payload.nodeId as Id<"nodes">,
      beforePlacement,
      afterPlacement,
      focusEditorId: getNodeEditorId(payload.nodeId as Id<"nodes">),
    });

    onSelectSingleNode(payload.nodeId);
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-node-id="${payload.nodeId}"] textarea`,
      );
      focusElementAtEnd(target as HTMLTextAreaElement | null);
    }, 0);
  };

  const buildUpdateEntry = (
    beforeValue: string,
    afterValue: NodeValueSnapshot,
  ): HistoryEntry | null => {
    const beforeParsed = parseNodeDraftWithFallback(beforeValue, {
      kind: node.kind as "note" | "task",
      taskStatus: (node.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
    });
    if (beforeParsed.shouldDelete) {
      return null;
    }

    const beforeSnapshot = toNodeValueSnapshot(beforeParsed);
    if (
      beforeSnapshot.text === afterValue.text &&
      beforeSnapshot.kind === afterValue.kind &&
      beforeSnapshot.taskStatus === afterValue.taskStatus
    ) {
      return null;
    }

    return {
      type: "update_node",
      pageId,
      nodeId: node._id as Id<"nodes">,
      before: beforeSnapshot,
      after: afterValue,
      focusEditorId: editorId,
    };
  };

  const commitNodeText = async (
    nextDraft: string,
  ): Promise<{
    deleted: boolean;
    updateEntry: HistoryEntry | null;
    parsed: NodeValueSnapshot | null;
  }> => {
    if (isDisabled) {
      return {
        deleted: false,
        updateEntry: null,
        parsed: toNodeValueSnapshot({
          text: node.text,
          kind: node.kind as "note" | "task",
          taskStatus: (node.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
        }),
      };
    }

    const parsed = parseNodeDraftWithFallback(nextDraft, {
      kind: node.kind as "note" | "task",
      taskStatus: (node.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
    });
    if (parsed.shouldDelete) {
      await setNodeTreeArchived({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
        archived: true,
      });
      history.resetTrackedValue(editorId, editorTarget);
      history.pushUndoEntry({
        type: "archive_node_tree",
        pageId,
        nodeId: node._id as Id<"nodes">,
        focusAfterUndoId: editorId,
        focusAfterRedoId: fallbackFocusEditorId,
      });
      return {
        deleted: true,
        updateEntry: null,
        parsed: null,
      };
    }

    const nextSnapshot = toNodeValueSnapshot(parsed);
    if (
      parsed.text !== node.text ||
      parsed.kind !== node.kind ||
      parsed.taskStatus !== node.taskStatus
    ) {
      await updateNode({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
        text: parsed.text,
        kind: parsed.kind,
        taskStatus: parsed.taskStatus,
      });
    }

    const beforeValue = history.commitTrackedValue(
      editorId,
      editorTarget,
      nextSnapshot.text,
    );
    setDraft(nextSnapshot.text);
    return {
      deleted: false,
      updateEntry: buildUpdateEntry(beforeValue, nextSnapshot),
      parsed: nextSnapshot,
    };
  };

  const handleSave = async () => {
    const result = await commitNodeText(draft);
    if (result.updateEntry) {
      history.pushUndoEntry(result.updateEntry);
    }
    return result;
  };

  const handleToggleTask = async () => {
    if (node.kind !== "task" || isDisabled) {
      return;
    }

    const saveResult = await commitNodeText(draft);
    if (saveResult.deleted || !saveResult.parsed) {
      return;
    }

    const beforeSnapshot: NodeValueSnapshot = {
      text: saveResult.parsed.text,
      kind: "task",
      taskStatus: (node.taskStatus ?? "todo") as NodeValueSnapshot["taskStatus"],
    };
    const afterSnapshot: NodeValueSnapshot = {
      text: saveResult.parsed.text,
      kind: "task",
      taskStatus: node.taskStatus === "done" ? "todo" : "done",
    };

    await updateNode({
      ownerKey,
      nodeId: node._id as Id<"nodes">,
      text: afterSnapshot.text,
      kind: afterSnapshot.kind,
      lockKind: true,
      taskStatus: afterSnapshot.taskStatus,
    });
    history.commitTrackedValue(
      editorId,
      editorTarget,
      afterSnapshot.text,
    );
    setDraft(afterSnapshot.text);
    const toggleEntry: HistoryEntry = {
      type: "update_node",
      pageId,
      nodeId: node._id as Id<"nodes">,
      before: beforeSnapshot,
      after: afterSnapshot,
      focusEditorId: editorId,
    };

    if (saveResult.updateEntry) {
      history.pushUndoEntry({
        type: "compound",
        pageId,
        entries: [saveResult.updateEntry, toggleEntry],
        focusAfterUndoId: editorId,
        focusAfterRedoId: editorId,
      });
      return;
    }

    history.pushUndoEntry(toggleEntry);
  };

  const handleToggleNodeKind = async () => {
    if (isDisabled) {
      return;
    }

    const saveResult = await commitNodeText(draft);
    if (saveResult.deleted || !saveResult.parsed) {
      return;
    }

    const beforeSnapshot = saveResult.parsed;
    const afterSnapshot: NodeValueSnapshot =
      beforeSnapshot.kind === "task"
        ? {
            text: beforeSnapshot.text,
            kind: "note",
            taskStatus: null,
          }
        : {
            text: beforeSnapshot.text,
            kind: "task",
            taskStatus: "todo",
          };

    await updateNode({
      ownerKey,
      nodeId: node._id as Id<"nodes">,
      text: afterSnapshot.text,
      kind: afterSnapshot.kind,
      lockKind: true,
      taskStatus: afterSnapshot.taskStatus,
    });
    history.commitTrackedValue(
      editorId,
      editorTarget,
      afterSnapshot.text,
    );
    setDraft(afterSnapshot.text);

    const toggleEntry: HistoryEntry = {
      type: "update_node",
      pageId,
      nodeId: node._id as Id<"nodes">,
      before: beforeSnapshot,
      after: afterSnapshot,
      focusEditorId: editorId,
    };

    if (saveResult.updateEntry) {
      history.pushUndoEntry({
        type: "compound",
        pageId,
        entries: [saveResult.updateEntry, toggleEntry],
        focusAfterUndoId: editorId,
        focusAfterRedoId: editorId,
      });
      return;
    }

    history.pushUndoEntry(toggleEntry);
  };

  const handlePaste = async (event: TextareaClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = event.clipboardData.getData("text");
    const lines = splitPastedLines(pastedText);
    if (lines.length <= 1 || isDisabled) {
      return;
    }

    event.preventDefault();
    const [firstLine, ...restLines] = lines;
    if (!firstLine) {
      return;
    }

    const firstParsed = parseNodeDraftWithFallback(firstLine, {
      kind: node.kind as "note" | "task",
      taskStatus: (node.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
    });
    if (firstParsed.shouldDelete) {
      return;
    }

    const siblingInputs = restLines
      .map((line) => parseNodeDraft(line))
      .filter((entry) => !entry.shouldDelete);
    const result = (await replaceNodeAndInsertSiblings({
      ownerKey,
      nodeId: node._id as Id<"nodes">,
      text: firstParsed.text,
      kind: firstParsed.kind,
      taskStatus: firstParsed.taskStatus,
      siblings: siblingInputs.map((entry) => ({
        text: entry.text,
        kind: entry.kind,
        taskStatus: entry.taskStatus,
      })),
    })) as {
      updatedNode: Doc<"nodes"> | null;
      createdNodes: Doc<"nodes">[];
    };

    const beforeValue = history.commitTrackedValue(
      editorId,
      editorTarget,
      firstParsed.text,
    );
    setDraft(firstParsed.text);

    const updateEntry = buildUpdateEntry(
      beforeValue,
      toNodeValueSnapshot(firstParsed),
    );
    const createdNodes = result.createdNodes.map((createdNode, index) =>
      toCreatedNodeSnapshot(
        createdNode,
        index === 0
          ? (node._id as Id<"nodes">)
          : result.createdNodes[index - 1]!._id,
      ),
    );
    const createEntry: HistoryEntry | null =
      createdNodes.length > 0
        ? {
            type: "create_nodes",
            pageId,
            nodes: createdNodes,
            focusAfterUndoId: editorId,
            focusAfterRedoId: getNodeEditorId(
              createdNodes[createdNodes.length - 1]!.nodeId,
            ),
          }
        : null;

    if (updateEntry && createEntry) {
      history.pushUndoEntry({
        type: "compound",
        pageId,
        entries: [updateEntry, createEntry],
        focusAfterUndoId: editorId,
        focusAfterRedoId: createEntry.focusAfterRedoId,
      });
      return;
    }

    if (updateEntry) {
      history.pushUndoEntry(updateEntry);
      return;
    }

    if (createEntry) {
      history.pushUndoEntry(createEntry);
    }
  };

  const handleKeyDown = async (event: TextareaKeyboardEvent<HTMLTextAreaElement>) => {
    const isModifier = event.metaKey || event.ctrlKey;
    const normalizedKey = event.key.toLowerCase();

    if (activeLinkToken && linkSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setLinkHighlightIndex((current) => (current + 1) % linkSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setLinkHighlightIndex((current) =>
          (current - 1 + linkSuggestions.length) % linkSuggestions.length,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const suggestion =
          linkSuggestions[activeLinkHighlightIndex] ?? linkSuggestions[0];
        if (suggestion) {
          applyLinkSuggestion(suggestion);
        }
        return;
      }
    }

    if (isModifier && event.shiftKey && normalizedKey === "c") {
      event.preventDefault();
      await handleToggleNodeKind();
      return;
    }

    if (isModifier && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      setCollapsedState(event.key === "ArrowLeft");
      return;
    }

    if (isModifier && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      if (isDisabled) {
        return;
      }

      event.preventDefault();
      const saveResult = await commitNodeText(draft);
      const historyEntries: HistoryEntry[] = [];
      if (saveResult.updateEntry) {
        historyEntries.push(saveResult.updateEntry);
      }

      if (saveResult.deleted) {
        return;
      }

      if (event.key === "ArrowUp") {
        if (!previousSibling) {
          return;
        }

        const afterNodeId =
          siblingIndex > 1
            ? (siblings[siblingIndex - 2]?._id as Id<"nodes"> | undefined) ?? null
            : null;
        const beforePlacement = buildNodePlacement(
          pageId,
          parentNodeId,
          (previousSibling?._id as Id<"nodes"> | undefined) ?? null,
        );
        const afterPlacement = buildNodePlacement(pageId, parentNodeId, afterNodeId);

        await moveNode({
          ownerKey,
          nodeId: node._id as Id<"nodes">,
          pageId,
          parentNodeId,
          afterNodeId,
        });

        historyEntries.push({
          type: "move_node",
          pageId,
          nodeId: node._id as Id<"nodes">,
          beforePlacement,
          afterPlacement,
          focusEditorId: editorId,
        });
      } else {
        if (!nextSibling) {
          return;
        }

        const beforePlacement = buildNodePlacement(
          pageId,
          parentNodeId,
          (previousSibling?._id as Id<"nodes"> | undefined) ?? null,
        );
        const afterPlacement = buildNodePlacement(
          pageId,
          parentNodeId,
          nextSibling._id as Id<"nodes">,
        );

        await moveNode({
          ownerKey,
          nodeId: node._id as Id<"nodes">,
          pageId,
          parentNodeId,
          afterNodeId: nextSibling._id as Id<"nodes">,
        });

        historyEntries.push({
          type: "move_node",
          pageId,
          nodeId: node._id as Id<"nodes">,
          beforePlacement,
          afterPlacement,
          focusEditorId: editorId,
        });
      }

      if (historyEntries.length === 1) {
        history.pushUndoEntry(historyEntries[0]!);
      } else {
        history.pushUndoEntry({
          type: "compound",
          pageId,
          entries: historyEntries,
          focusAfterUndoId: editorId,
          focusAfterRedoId: editorId,
        });
      }

      window.setTimeout(() => {
        focusElementAtEnd(textareaRef.current);
      }, 0);
      onSelectSingleNode(node._id);
      return;
    }

    if (
      event.shiftKey &&
      !event.altKey &&
      !isModifier &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      onSelectSingleNode(node._id);
      textareaRef.current?.blur();
      return;
    }

    if (
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      focusAdjacentVisibleNode(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Backspace" && draft.length === 0 && !isDisabled) {
      event.preventDefault();
      await setNodeTreeArchived({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
        archived: true,
      });
      history.resetTrackedValue(editorId, editorTarget);
      history.pushUndoEntry({
        type: "archive_node_tree",
        pageId,
        nodeId: node._id as Id<"nodes">,
        focusAfterUndoId: editorId,
        focusAfterRedoId: fallbackFocusEditorId,
      });
      return;
    }

    if (event.key === "Tab") {
      if (isDisabled) {
        return;
      }

      event.preventDefault();
      const saveResult = await commitNodeText(draft);
      const historyEntries: HistoryEntry[] = [];
      if (saveResult.updateEntry) {
        historyEntries.push(saveResult.updateEntry);
      }

      const beforePlacement = buildNodePlacement(
        pageId,
        parentNodeId,
        (previousSibling?._id as Id<"nodes"> | undefined) ?? null,
      );
      let afterPlacement: NodePlacement | null = null;

      if (saveResult.deleted) {
        return;
      }

      if (event.shiftKey) {
        if (!node.parentNodeId) {
          return;
        }

        const parentNode = nodeMap.get(node.parentNodeId as string);
        if (!parentNode) {
          return;
        }

        afterPlacement = buildNodePlacement(
          pageId,
          (parentNode.parentNodeId as Id<"nodes"> | null) ?? null,
          parentNode._id as Id<"nodes">,
        );
        await moveNode({
          ownerKey,
          nodeId: node._id as Id<"nodes">,
          pageId,
          parentNodeId: (parentNode.parentNodeId as Id<"nodes"> | null) ?? null,
          afterNodeId: parentNode._id as Id<"nodes">,
        });
      } else {
        if (!previousSibling) {
          return;
        }

        const targetAfterNodeId = getLastChildNodeId(previousSibling);
        afterPlacement = buildNodePlacement(
          pageId,
          previousSibling._id as Id<"nodes">,
          targetAfterNodeId,
        );
        await moveNode({
          ownerKey,
          nodeId: node._id as Id<"nodes">,
          pageId,
          parentNodeId: previousSibling._id as Id<"nodes">,
          afterNodeId: targetAfterNodeId,
        });
      }

      if (afterPlacement) {
        historyEntries.push({
          type: "move_node",
          pageId,
          nodeId: node._id as Id<"nodes">,
          beforePlacement,
          afterPlacement,
          focusEditorId: editorId,
        });
      }

      if (historyEntries.length === 1) {
        history.pushUndoEntry(historyEntries[0]!);
      } else if (historyEntries.length > 1) {
        history.pushUndoEntry({
          type: "compound",
          pageId,
          entries: historyEntries,
          focusAfterUndoId: editorId,
          focusAfterRedoId: editorId,
        });
      }
      return;
    }

    if (event.key !== "Enter" || isDisabled) {
      return;
    }

    event.preventDefault();
    const rawValue = event.currentTarget.value;
    const cursorStart = event.currentTarget.selectionStart ?? rawValue.length;
    const cursorEnd = event.currentTarget.selectionEnd ?? cursorStart;

    if (cursorStart < rawValue.length || cursorStart !== cursorEnd) {
      const isStartOfLineSplit = cursorStart === 0 && cursorEnd === 0;
      const headDraft = rawValue.slice(0, cursorStart);
      const tailDraft = rawValue.slice(cursorEnd);
      const segmentFallback = {
        kind: node.kind as "note" | "task",
        taskStatus: (node.taskStatus ?? null) as
          | "todo"
          | "in_progress"
          | "done"
          | "cancelled"
          | null,
      };
      const normalizedHead = isStartOfLineSplit
        ? {
            text: "",
            kind: "note" as const,
            taskStatus: null,
          }
        : parseSplitSegmentDraft(headDraft, segmentFallback);
      const normalizedTail = parseSplitSegmentDraft(tailDraft, segmentFallback);
      const result = (await splitNode({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
        headText: normalizedHead.text,
        headKind: normalizedHead.kind,
        headTaskStatus: normalizedHead.taskStatus ?? undefined,
        tailText: normalizedTail.text,
        tailKind: normalizedTail.kind,
        tailTaskStatus: normalizedTail.taskStatus ?? undefined,
      })) as {
        updatedNode: Doc<"nodes"> | null;
        createdNode: Doc<"nodes"> | null;
      };
      const beforeValue = history.commitTrackedValue(
        editorId,
        editorTarget,
        normalizedHead.text,
      );
      setDraft(normalizedHead.text);
      const updateEntry = buildUpdateEntry(beforeValue, toNodeValueSnapshot(normalizedHead));
      const createEntry =
        result.createdNode
          ? ({
              type: "create_nodes",
              pageId,
              nodes: [
                toCreatedNodeSnapshot(
                  result.createdNode,
                  node._id as Id<"nodes">,
                ),
              ],
              focusAfterUndoId: editorId,
              focusAfterRedoId: getNodeEditorId(result.createdNode._id),
            } satisfies HistoryEntry)
          : null;

      if (updateEntry && createEntry) {
        history.pushUndoEntry({
          type: "compound",
          pageId,
          entries: [updateEntry, createEntry],
          focusAfterUndoId: editorId,
          focusAfterRedoId: createEntry.focusAfterRedoId,
        });
      } else if (updateEntry) {
        history.pushUndoEntry(updateEntry);
      } else if (createEntry) {
        history.pushUndoEntry(createEntry);
      }

      if (isStartOfLineSplit) {
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(0, 0);
        });
      }
      return;
    }

    if (draft.trim().length > 0 || pendingSiblingComposerVisible) {
      onOpenInsertedComposer(pageId, parentNodeId, node._id as Id<"nodes">);
    }

    const result = await commitNodeText(draft);
    if (result.deleted) {
      onClearInsertedComposer();
      return;
    }

    if (result.updateEntry) {
      history.pushUndoEntry(result.updateEntry);
    }
  };

  return (
    <div className="space-y-0.5">
      <div
        data-node-shell
        data-node-id={node._id}
        data-item-selection-surface="true"
        onMouseDownCapture={(event) => {
          if (event.button !== 0 || !event.altKey) {
            return;
          }

          event.preventDefault();
          onSelectionStart(node._id);
        }}
        onMouseEnter={() => onSelectionExtend(node._id)}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }

          setDropTarget(null);
        }}
        onDrop={(event) => void handleDrop(event)}
        className={clsx(
          "outline-depth-shell group relative rounded-sm transition",
          isSelected
            ? "bg-[var(--workspace-sidebar-bg)] ring-1 ring-[var(--workspace-border-soft)]"
            : "",
        )}
        style={
          {
            "--outline-depth": depth,
            "--outline-mobile-indent-step": `${mobileIndentStep}px`,
          } as CSSProperties
        }
      >
        {dropTarget ? (
          <div
            className={clsx(
              "pointer-events-none absolute right-0 z-20 h-0 border-t-2 border-[var(--workspace-brand)]",
              dropTarget.lineSide === "top" ? "top-0" : "bottom-0",
            )}
            style={{ left: `${dropTarget.lineIndentOffset}px` }}
          >
            <span className="absolute -left-1.5 -top-[5px] h-2.5 w-2.5 rounded-full bg-[var(--workspace-brand)]" />
          </div>
        ) : null}
        <div className="flex min-h-8 items-start gap-1.5">
          <div className="flex min-h-8 w-4 flex-none items-start justify-center pt-[7px] text-[var(--workspace-text-faint)]">
            {isLocked ||
            ((isVisualEmptyLine || isVisualSeparatorLine) && !shouldRevealVisualPlaceholder) ? null : node.kind === "task" ? (
              <button
                type="button"
                data-selection-gutter="true"
                draggable={!isDisabled}
                onPointerDown={handleMarkerPointerDown}
                onPointerUp={handleMarkerPointerEnd}
                onPointerLeave={handleMarkerPointerEnd}
                onPointerCancel={handleMarkerPointerEnd}
                onClick={handleMarkerClick}
                onDragStart={handleDragHandleStart}
                onDragEnd={() => {
                  clearMarkerHold();
                  markerLongPressTriggeredRef.current = false;
                  setDropTarget(null);
                  onSetActiveDraggedNodeId(null);
                  onSetActiveDraggedNodePayload(null);
                }}
                disabled={isDisabled}
                title="Click to toggle task status. Hold a modifier key to convert to a note."
                className={clsx(
                  "flex h-4 w-4 flex-none cursor-grab items-center justify-center border text-[10px] transition active:cursor-grabbing",
                  node.taskStatus === "done"
                    ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                    : "border-[var(--workspace-border-hover)] bg-[var(--workspace-surface)] text-transparent hover:border-[var(--workspace-accent)]",
                  isDisabled ? "cursor-not-allowed opacity-70" : "",
                )}
              >
                x
              </button>
            ) : (
              <button
                type="button"
                data-selection-gutter="true"
                draggable={!isDisabled}
                onPointerDown={handleMarkerPointerDown}
                onPointerUp={handleMarkerPointerEnd}
                onPointerLeave={handleMarkerPointerEnd}
                onPointerCancel={handleMarkerPointerEnd}
                onClick={handleMarkerClick}
                onDragStart={handleDragHandleStart}
                onDragEnd={() => {
                  clearMarkerHold();
                  markerLongPressTriggeredRef.current = false;
                  setDropTarget(null);
                  onSetActiveDraggedNodeId(null);
                  onSetActiveDraggedNodePayload(null);
                }}
                disabled={isDisabled}
                title="Convert this note into a task."
                className={clsx(
                  "flex h-4 w-4 flex-none cursor-grab items-center justify-center transition hover:text-[var(--workspace-brand)] active:cursor-grabbing",
                  isDisabled ? "cursor-not-allowed opacity-60" : "",
                )}
              >
                <span className="h-2 w-2 rounded-full bg-current" />
              </button>
            )}
          </div>
          <div className="relative flex min-h-8 min-w-0 flex-1 items-start">
            {isVisualSeparatorLine && !shouldRevealVisualPlaceholder ? (
              <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-[var(--workspace-border)]" />
            ) : null}
            <textarea
              ref={textareaRef}
              value={draft}
              onMouseDown={() => {
                onBeginTextEditing();
              }}
              onChange={(event) => {
                onBeginTextEditing();
                setDraft(event.target.value);
                history.updateDraftValue(editorId, editorTarget, event.target.value);
                setCaretPosition(event.target.selectionStart ?? event.target.value.length);
              }}
              onFocus={(event) => {
                onBeginTextEditing();
                setIsFocused(true);
                setCaretPosition(event.target.selectionStart ?? event.target.value.length);
              }}
              onBlur={() => {
                setIsFocused(false);
                void handleSave();
              }}
              onSelect={(event) => {
                setCaretPosition(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
              }}
              onPaste={(event) => void handlePaste(event)}
              onKeyDown={(event) => void handleKeyDown(event)}
              placeholder="Write a line…"
              disabled={isDisabled}
              rows={1}
              className={clsx(
                "w-full resize-none overflow-hidden border-0 border-b border-transparent bg-transparent px-0 py-1 text-[15px] leading-6 outline-none transition focus:border-[var(--workspace-border)] disabled:text-[var(--workspace-text-muted)]",
                isDraggingAnotherNode ? "pointer-events-none select-none" : "",
                node.taskStatus === "done" ? "text-[var(--workspace-text-faint)] line-through" : "",
                isDimmedLine && node.taskStatus !== "done"
                  ? "text-[var(--workspace-text-subtle)]"
                  : "",
                (isVisualEmptyLine || isVisualSeparatorLine) && !shouldRevealVisualPlaceholder
                  ? "text-transparent"
                  : "",
                hasDisplayPreview ? "text-transparent caret-transparent" : "",
              )}
            />
            {hasPageLinkPreview ? (
              <LinkedTextPreview
                segments={linkPreviewSegments}
                onFocusLine={focusLineEditor}
                onOpenPage={onOpenPage}
                onOpenNode={onOpenNode}
                isDisabled={isDisabled || activeDraggedNodeId !== null}
                className={clsx(
                  node.taskStatus === "done"
                    ? "text-[var(--workspace-text-faint)] line-through"
                    : isDimmedLine
                      ? "text-[var(--workspace-text-subtle)]"
                      : "text-[var(--workspace-text)]",
                )}
              />
            ) : hasPlainTextPreview ? (
              <PlainTextPreview
                text={displayDraft}
                onFocusLine={focusLineEditor}
                isDisabled={isDisabled || activeDraggedNodeId !== null}
                className={clsx(
                  node.taskStatus === "done"
                    ? "text-[var(--workspace-text-faint)] line-through"
                    : isDimmedLine
                      ? "text-[var(--workspace-text-subtle)]"
                      : "text-[var(--workspace-text)]",
                )}
              />
            ) : null}
            {isFocused && activeLinkToken ? (
              <LinkAutocompleteMenu
                anchorRef={textareaRef}
                suggestions={linkSuggestions}
                highlightIndex={activeLinkHighlightIndex}
                onHover={setLinkHighlightIndex}
                onSelect={applyLinkSuggestion}
              />
            ) : null}
          </div>
          <div className="ml-1 flex flex-none items-start gap-1 pt-[3px]">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleToggleCollapsed}
              disabled={!hasChildren}
              aria-label={isCollapsed ? "Expand nested items" : "Collapse nested items"}
              className={clsx(
                "flex h-10 w-8 flex-none items-center justify-center text-base leading-none transition",
                hasChildren
                  ? "text-[var(--workspace-text-faint)] hover:text-[var(--workspace-text)]"
                  : "cursor-default text-transparent",
              )}
            >
              <span
                className={clsx(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full transition-transform",
                  hasNestedGrandchildren
                    ? "border border-[var(--workspace-border-hover)]"
                    : "",
                  isCollapsed ? "rotate-0" : "rotate-90",
                )}
              >
                ▸
              </span>
            </button>
          </div>
        </div>
      </div>
      {hasChildren && (shouldRenderChildren || !isCollapsed) ? (
        <div
          className={clsx(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
            isChildrenExpanded
              ? "grid-rows-[1fr] opacity-100"
              : "pointer-events-none grid-rows-[0fr] opacity-0",
          )}
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget) {
              return;
            }

            if (!isCollapsed || isChildrenExpanded) {
              return;
            }

            setShouldRenderChildren(false);
          }}
        >
          <div aria-hidden={!isChildrenExpanded} className="min-h-0 overflow-hidden">
            <OutlineNodeList
              nodes={node.children}
              ownerKey={ownerKey}
              pageId={pageId}
              parentNodeId={node._id as Id<"nodes">}
              nodeMap={nodeMap}
              createNodesBatch={createNodesBatch}
              updateNode={updateNode}
              moveNode={moveNode}
              splitNode={splitNode}
              replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
              setNodeTreeArchived={setNodeTreeArchived}
              depth={depth + 1}
              isPageReadOnly={isPageReadOnly}
              collapsedNodeIds={collapsedNodeIds}
              selectedNodeIds={selectedNodeIds}
              onToggleNodeCollapsed={onToggleNodeCollapsed}
              onSelectSingleNode={onSelectSingleNode}
              onSelectNodeRange={onSelectNodeRange}
              pendingInsertedComposer={pendingInsertedComposer}
              onOpenInsertedComposer={onOpenInsertedComposer}
              onClearInsertedComposer={onClearInsertedComposer}
              onBeginTextEditing={onBeginTextEditing}
              activeDraggedNodeId={activeDraggedNodeId}
              activeDraggedNodePayload={activeDraggedNodePayload}
              onSetActiveDraggedNodeId={onSetActiveDraggedNodeId}
              onSetActiveDraggedNodePayload={onSetActiveDraggedNodePayload}
              onSelectionStart={onSelectionStart}
              onSelectionExtend={onSelectionExtend}
              pagesByTitle={pagesByTitle}
              onOpenPage={onOpenPage}
              onOpenNode={onOpenNode}
              mobileIndentStep={mobileIndentStep}
            />
          </div>
        </div>
      ) : null}
      {pendingSiblingComposerVisible ? (
        <InlineComposer
          key={`inserted-composer:${pageId}:${parentNodeId ?? "root"}:${node._id}`}
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={parentNodeId}
          afterNodeId={node._id as Id<"nodes">}
          createNodesBatch={createNodesBatch}
          historyInstanceKey={`inserted:${node._id}`}
          readOnly={isPageReadOnly}
          depth={depth}
          mobileIndentStep={mobileIndentStep}
          autoFocusToken={pendingSiblingComposerFocusToken}
          persistWhenEmpty
          placeholder="Write a line…"
          onBeginTextEditing={onBeginTextEditing}
          onSubmitted={() => {
            onClearInsertedComposer();
          }}
          onCancel={() => {
            onClearInsertedComposer();
          }}
        />
      ) : null}
    </div>
  );
}

function InlineComposer({
  ownerKey,
  pageId,
  parentNodeId,
  afterNodeId,
  createNodesBatch,
  historyInstanceKey,
  readOnly = false,
  depth = 0,
  mobileIndentStep = 0,
  autoFocusToken = 0,
  persistWhenEmpty = false,
  placeholder = "New line…",
  onBeginTextEditing,
  onSubmitted,
  onCancel,
}: {
  ownerKey: string;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null | undefined;
  afterNodeId?: Id<"nodes">;
  createNodesBatch: CreateNodesBatchMutation;
  historyInstanceKey?: string;
  readOnly?: boolean;
  depth?: number;
  mobileIndentStep?: number;
  autoFocusToken?: number;
  persistWhenEmpty?: boolean;
  placeholder?: string;
  onBeginTextEditing?: () => void;
  onSubmitted?: () => void;
  onCancel?: () => void;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [caretPosition, setCaretPosition] = useState<number | null>(null);
  const [linkHighlightIndex, setLinkHighlightIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const isSubmittingRef = useRef(false);
  const editorId = getComposerEditorId(
    pageId,
    parentNodeId ?? null,
    historyInstanceKey,
  );
  const editorTarget = useMemo(
    () =>
      ({
        kind: "composer",
        pageId,
        parentNodeId: parentNodeId ?? null,
      } satisfies TrackedEditorTarget),
    [pageId, parentNodeId],
  );
  const activeLinkToken = getActiveLinkToken(draft, caretPosition);
  const linkTargetResults = useQuery(
    api.workspace.searchLinkTargets,
    ownerKey && isFocused && activeLinkToken
      ? {
          ownerKey,
          query: activeLinkToken.query,
          limit: 6,
        }
      : SKIP,
  ) as LinkTargetSearchResults | undefined;
  const linkSuggestions = useMemo(
    () => buildLinkSuggestions(linkTargetResults),
    [linkTargetResults],
  );
  const activeLinkHighlightIndex =
    linkSuggestions.length === 0
      ? 0
      : Math.min(linkHighlightIndex, linkSuggestions.length - 1);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [draft]);

  useEffect(() => {
    return history.registerEditor(editorId, editorTarget, "", {
      getElement: () => textareaRef.current,
      getValue: () => draftRef.current,
      setValue: setDraft,
      focusAtEnd: () => focusElementAtEnd(textareaRef.current),
    });
  }, [editorId, editorTarget, history]);

  useEffect(() => {
    return () => history.flushDraftCheckpoint(editorId);
  }, [editorId, history]);

  useEffect(() => {
    if (autoFocusToken <= 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      focusElementAtEnd(textareaRef.current);
    });
  }, [autoFocusToken]);

  const applyLinkSuggestion = (suggestion: LinkSuggestion) => {
    if (!activeLinkToken) {
      return;
    }

    const nextValue =
      draft.slice(0, activeLinkToken.startIndex) +
      suggestion.insertText +
      draft.slice(activeLinkToken.endIndex);
    const nextCaretPosition = activeLinkToken.startIndex + suggestion.insertText.length;

    setDraft(nextValue);
    history.updateDraftValue(editorId, editorTarget, nextValue);
    setCaretPosition(nextCaretPosition);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  };

  const submitLines = async (value: string) => {
    if (readOnly || isSubmittingRef.current) {
      return;
    }

    const lines = splitPastedLines(value);
    if (lines.length === 0) {
      return;
    }

    let nextAfterNodeId: Id<"nodes"> | null | undefined = afterNodeId ?? null;
    const batch = lines
      .map((line) => parseNodeDraft(line))
      .filter((entry) => !entry.shouldDelete)
      .map((entry) => {
        const nextEntry = {
          parentNodeId: parentNodeId ?? null,
          afterNodeId: nextAfterNodeId,
          text: entry.text,
          kind: entry.kind,
          taskStatus: entry.taskStatus,
        };
        nextAfterNodeId = undefined;
        return nextEntry;
      });

    if (batch.length === 0) {
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);

    try {
      const createdNodes = (await createNodesBatch({
        ownerKey,
        pageId,
        nodes: batch,
      })) as Doc<"nodes">[];

      const createdSnapshots = createdNodes.map((createdNode, index) =>
        toCreatedNodeSnapshot(
          createdNode,
          index === 0
            ? (afterNodeId ?? null)
            : createdNodes[index - 1]!._id,
        ),
      );

      history.resetTrackedValue(editorId, editorTarget, "");
      setDraft("");
      onSubmitted?.();
      history.pushUndoEntry({
        type: "create_nodes",
        pageId,
        nodes: createdSnapshots,
        focusAfterUndoId: editorId,
        focusAfterRedoId:
          createdSnapshots.length > 0
            ? getNodeEditorId(createdSnapshots[createdSnapshots.length - 1]!.nodeId)
            : editorId,
      });
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = async (event: TextareaKeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly || isSubmittingRef.current) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();

      if (draft.trim().length === 0) {
        onCancel?.();
        return;
      }

      const textarea = event.currentTarget;
      await submitLines(draft);
      window.requestAnimationFrame(() => {
        textarea.blur();
      });
      return;
    }

    if (activeLinkToken && linkSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setLinkHighlightIndex((current) => (current + 1) % linkSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setLinkHighlightIndex((current) =>
          (current - 1 + linkSuggestions.length) % linkSuggestions.length,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const suggestion =
          linkSuggestions[activeLinkHighlightIndex] ?? linkSuggestions[0];
        if (suggestion) {
          applyLinkSuggestion(suggestion);
        }
        return;
      }
    }

    if (event.key !== "Enter") {
      if (event.key === "Backspace" && draft.trim().length === 0) {
        event.preventDefault();
        onCancel?.();
      }
      return;
    }

    event.preventDefault();
    await submitLines(draft);
  };

  const handlePaste = async (event: TextareaClipboardEvent<HTMLTextAreaElement>) => {
    if (readOnly || isSubmittingRef.current) {
      return;
    }

    const pastedText = event.clipboardData.getData("text");
    const lines = splitPastedLines(pastedText);
    if (lines.length <= 1) {
      return;
    }

    event.preventDefault();
    await submitLines(pastedText);
  };

  const handleBlur = () => {
    setIsFocused(false);

    if (isSubmittingRef.current) {
      return;
    }

    const currentDraft = draftRef.current;
    if (readOnly || currentDraft.trim().length === 0) {
      history.flushDraftCheckpoint(editorId);
      if (!persistWhenEmpty) {
        onCancel?.();
      }
      return;
    }

    void submitLines(currentDraft);
  };

  return (
    <div
      className="outline-depth-composer relative"
      style={
        {
          "--outline-depth": depth,
          "--outline-mobile-indent-step": `${mobileIndentStep}px`,
        } as CSSProperties
      }
    >
      <textarea
        ref={textareaRef}
        value={draft}
        onMouseDown={() => {
          onBeginTextEditing?.();
        }}
        onChange={(event) => {
          onBeginTextEditing?.();
          setDraft(event.target.value);
          history.updateDraftValue(editorId, editorTarget, event.target.value);
          setCaretPosition(event.target.selectionStart ?? event.target.value.length);
        }}
        onFocus={(event) => {
          onBeginTextEditing?.();
          setIsFocused(true);
          setCaretPosition(event.target.selectionStart ?? event.target.value.length);
        }}
        onBlur={handleBlur}
        onSelect={(event) => {
          setCaretPosition(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
        }}
        onPaste={(event) => void handlePaste(event)}
        onKeyDown={(event) => void handleKeyDown(event)}
        placeholder={placeholder}
        disabled={readOnly || isSubmitting}
        rows={1}
        className="w-full resize-none overflow-hidden border-0 border-b border-transparent bg-transparent px-0 py-0.5 pr-8 text-[15px] leading-6 outline-none transition focus:border-[var(--workspace-border)] disabled:text-[var(--workspace-text-muted)]"
      />
      {isSubmitting ? (
        <div className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-[var(--workspace-text-faint)]">
          <span className="block h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent" />
        </div>
      ) : null}
      {isFocused && activeLinkToken ? (
        <LinkAutocompleteMenu
          anchorRef={textareaRef}
          suggestions={linkSuggestions}
          highlightIndex={activeLinkHighlightIndex}
          onHover={setLinkHighlightIndex}
          onSelect={applyLinkSuggestion}
        />
      ) : null}
    </div>
  );
}
