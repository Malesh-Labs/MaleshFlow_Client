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
import {
  buildJournalFeedbackUserPrompt,
  buildModelRewriteUserPrompt,
  JOURNAL_FEEDBACK_SYSTEM_PROMPT,
  MODEL_REGENERATE_REQUEST,
  MODEL_REWRITE_SYSTEM_PROMPT,
} from "@/lib/domain/aiPrompts";
import { parseHeadingSyntax } from "@/lib/domain/displaySyntax";
import {
  applySelectedInlineFormattingShortcut,
  hasRenderableInlineFormatting,
  splitTextForInlineFormatting,
} from "@/lib/domain/inlineFormatting";
import { buildOutlineTree, type OutlineTreeNode } from "@/lib/domain/outline";
import {
  advanceRecurringDueDateRange,
  areRecurrenceFrequenciesEqual,
  formatDueDateRange,
  getRecurrenceLabel,
  isOverdueDueDateRange,
  parseRecurrenceFrequency,
  type RecurrenceFrequency,
  type RecurringCompletionMode,
} from "@/lib/domain/recurrence";
import {
  applySelectedLinkShortcut,
  extractLinkMatches,
  getExplicitWikiLinkPreviewText,
  replaceLinkMarkupWithLabels,
} from "@/lib/domain/links";
import type { ScreenshotImportNode } from "@/lib/domain/screenshotImport";
import { extractTagMatches } from "@/lib/domain/tags";
import {
  buildNodeSelectionIds,
  filterPagesForCommandPalette,
} from "@/lib/domain/workspaceUi";
import {
  getEffectiveTaskDueDateRange,
  plannerChatPlanSchema,
} from "@/lib/domain/planner";
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
import { ArchiveSearchPanel } from "@/components/ArchiveSearchPanel";
import { FindReplacePanel } from "@/components/FindReplacePanel";
import { ImporterPanel } from "@/components/ImporterPanel";
import { MigrationPanel } from "@/components/MigrationPanel";
import { ScreenshotImportPanel } from "@/components/ScreenshotImportPanel";
import { TaskSchedulePanel } from "@/components/TaskSchedulePanel";
import type { ImportedOutlineNode } from "@/lib/domain/importer";

const SKIP = "skip" as const;
const SIDEBAR_SECTIONS = [
  "Models",
  "Tasks",
  "Notes",
  "Templates",
  "Journal",
  "Scratchpads",
] as const;
const OWNER_KEY_STORAGE_KEY = "maleshflow-owner-key";
const OWNER_KEY_EVENT = "maleshflow-owner-key-change";
const LAST_PAGE_STORAGE_KEY = "maleshflow-last-page-id";
const SIDEBAR_COLLAPSE_STORAGE_KEY = "maleshflow-sidebar-collapsed";
const COLLAPSED_NODES_STORAGE_KEY = "maleshflow-collapsed-node-ids";
const UNCATEGORIZED_SECTION_COLLAPSE_STORAGE_KEY =
  "maleshflow-uncategorized-section-collapsed";
const JOURNAL_SECTION_COLLAPSE_STORAGE_KEY = "maleshflow-journal-section-collapsed";
const TAGS_SECTION_COLLAPSE_STORAGE_KEY = "maleshflow-tags-section-collapsed";
const ARCHIVE_SECTION_COLLAPSE_STORAGE_KEY = "maleshflow-archive-section-collapsed";
const RECURRING_TASK_COMPLETION_MODE_STORAGE_KEY =
  "maleshflow-recurring-task-completion-mode";
const NODE_DRAG_MIME_TYPE = "application/x-maleshflow-node";
const OUTLINE_CLIPBOARD_MIME_TYPE = "application/x-maleshflow-outline";
const WORKSPACE_AI_CHAT_TEXTAREA_ID = "workspace-ai-chat-textarea";
const SIDEBAR_MOBILE_INDENT_STEP = 12;

type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
type PageType =
  | "default"
  | "note"
  | "task"
  | "planner"
  | "model"
  | "journal"
  | "scratchpad";
type PageDoc = Doc<"pages">;
type PageTreeResult = {
  page: PageDoc;
  nodes: Doc<"nodes">[];
  backlinks: Doc<"links">[];
  pageBacklinkCount: number;
  pageBacklinkCountTruncated?: boolean;
  nodeBacklinkCounts: Record<string, number>;
  loadWarning?: string | null;
};
type SidebarTreeResult = {
  page: PageDoc;
  nodes: Doc<"nodes">[];
  linkedPageIds: Id<"pages">[];
  nodeBacklinkCounts: Record<string, number>;
};
type PaletteMode =
  | "pages"
  | "find"
  | "nodes"
  | "chat"
  | "actions"
  | "replace"
  | "archive"
  | "migration"
  | "importer"
  | "screenshotImport"
  | "taskSchedule";
const PALETTE_MODE_ORDER: PaletteMode[] = [
  "actions",
  "pages",
  "find",
  "nodes",
  "chat",
];
type NodeSearchResult = {
  node: Doc<"nodes">;
  page: PageDoc | null;
  score?: number;
  content?: string;
};
type ActionPaletteResult = {
  key: string;
  title: string;
  subtitle: string;
  keywords: string[];
  actionLabel: string;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
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
    }
  | {
      key: string;
      kind: "tag";
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
      linkKind: "page" | "node" | "external";
      href?: string | null;
      pageTypeBadge?: string | null;
    }
  | {
      key: string;
      kind: "tag";
      text: string;
      value: string;
      normalizedValue: string;
    };
type RenderedPreviewSegment =
  | (LinkPreviewSegment & {
      strike: boolean;
      italic: boolean;
      bold: boolean;
      code: boolean;
    });
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
type SidebarTagResult = {
  label: string;
  value: string;
  normalizedValue: string;
  count: number;
};
type DraggedNodePayload = {
  nodeId: string;
  pageId: string;
  rootNodeIds: string[];
};
type OutlineClipboardNode = {
  text: string;
  kind: "note" | "task";
  taskStatus: NodeValueSnapshot["taskStatus"];
  noteCompleted: boolean;
  dueAt?: number | null;
  dueEndAt?: number | null;
  recurrenceFrequency?: RecurrenceFrequency;
  lockKind: boolean;
  children: OutlineClipboardNode[];
};
type OutlineClipboardPayload = {
  version: 1;
  nodes: OutlineClipboardNode[];
};
type PendingInsertedComposer = {
  pageId: string;
  parentNodeId: string | null;
  afterNodeId: string;
  focusToken: number;
};
type PlannerNextTaskSuggestion = {
  plannerNodeId: string;
  text: string;
  created: boolean;
  sourcePageId: string | null;
  sourcePageTitle: string | null;
  linkedSourceTaskId: string | null;
  dueAt: number | null;
  dueEndAt: number | null;
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
type BuildDraggedNodePayloadFn = (args: {
  nodeId: string;
  pageId: Id<"pages">;
}) => DraggedNodePayload;
type DropDraggedNodesFn = (
  payload: DraggedNodePayload,
  dropTarget: NodeDropTarget,
) => Promise<void>;
type InsertOutlineClipboardNodesFn = (args: {
  nodes: OutlineClipboardNode[];
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null;
  afterNodeId: Id<"nodes"> | null;
  focusAfterUndoId?: string | null;
  focusAfterRedoId?: string | null;
}) => Promise<{
  createdNodes: Doc<"nodes">[];
  createdRootNodeIds: Id<"nodes">[];
}>;
type OutlineClipboardBatchEntry = {
  clientId: string;
  parentNodeId?: Id<"nodes"> | null;
  parentClientId?: string;
  afterNodeId?: Id<"nodes"> | null;
  afterClientId?: string;
  text?: string;
  kind?: "note" | "task";
  taskStatus?: NodeValueSnapshot["taskStatus"];
  noteCompleted?: boolean;
  dueAt?: number | null;
  dueEndAt?: number | null;
  recurrenceFrequency?: RecurrenceFrequency;
  lockKind?: boolean;
};

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
  | "plannerSidebar"
  | "plannerRunningArchive"
  | "plannerTemplate"
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
  dueEndAt?: number | null;
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
  const isSidebarPage = sourceMeta.specialPage === "sidebar";

  const pageType: PageType =
    isSidebarPage
      ? "note"
      : sourceMeta.pageType === "planner"
      ? "planner"
      : sourceMeta.pageType === "model"
      ? "model"
      : sourceMeta.pageType === "journal"
        ? "journal"
        : sourceMeta.pageType === "scratchpad"
          ? "scratchpad"
          : sourceMeta.pageType === "note" || sourceMeta.sidebarSection === "Notes"
            ? "note"
          : sourceMeta.pageType === "task" || sourceMeta.sidebarSection === "Tasks"
            ? "task"
          : "default";
  const sidebarSection = SIDEBAR_SECTIONS.includes(sourceMeta.sidebarSection as SidebarSection)
    ? (sourceMeta.sidebarSection as SidebarSection)
    : isSidebarPage
      ? "Notes"
      : pageType === "model"
      ? "Models"
      : pageType === "planner"
      ? "Tasks"
      : pageType === "journal"
        ? "Journal"
        : pageType === "scratchpad"
          ? "Scratchpads"
          : pageType === "note"
            ? "Notes"
            : "Tasks";

  return { sidebarSection, pageType };
}

function isSidebarSpecialPage(page: Doc<"pages"> | null | undefined) {
  const sourceMeta =
    page && typeof page.sourceMeta === "object" && page.sourceMeta
      ? (page.sourceMeta as Record<string, unknown>)
      : {};

  return sourceMeta.specialPage === "sidebar";
}

function getPageTypeLabel(page: Doc<"pages"> | null | undefined) {
  const meta = getPageMeta(page);
  if (meta.pageType === "planner") {
    return "Planner";
  }

  return getPageTypeLabelForSection(meta.sidebarSection);
}

function getPageTypeLabelForSection(sidebarSection: SidebarSection) {
  switch (sidebarSection) {
    case "Models":
      return "Model";
    case "Tasks":
      return "Task";
    case "Notes":
      return "Note";
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

function getPageTypeEmoji(page: Doc<"pages"> | null | undefined) {
  if (!page) {
    return "📄";
  }

  switch (getPageMeta(page).pageType) {
    case "model":
      return "🧠";
    case "task":
      return "☑️";
    case "planner":
      return "🗓️";
    case "note":
      return "📝";
    case "journal":
      return "📓";
    case "scratchpad":
      return "✏️";
    case "default":
    default: {
      const meta = getPageMeta(page);
      if (meta.sidebarSection === "Templates") {
        return "🧩";
      }
      return "📄";
    }
  }
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

function getNodeMeta(node: { sourceMeta?: unknown } | null | undefined) {
  if (!node || typeof node.sourceMeta !== "object" || !node.sourceMeta) {
    return {};
  }

  return node.sourceMeta as Record<string, unknown>;
}

function isPlannerDayTask(
  node:
    | Pick<Doc<"nodes">, "_id" | "parentNodeId" | "sourceMeta" | "kind">
    | Pick<TreeNode, "_id" | "parentNodeId" | "sourceMeta" | "kind">
    | null
    | undefined,
  nodeMap:
    | Map<string, Pick<Doc<"nodes">, "_id" | "parentNodeId" | "sourceMeta" | "kind">>
    | Map<string, Pick<TreeNode, "_id" | "parentNodeId" | "sourceMeta" | "kind">>,
) {
  if (!node || node.kind !== "task") {
    return false;
  }

  return isPlannerDayItem(node, nodeMap);
}

function isPlannerDayItem(
  node:
    | Pick<Doc<"nodes">, "_id" | "parentNodeId" | "sourceMeta" | "kind">
    | Pick<TreeNode, "_id" | "parentNodeId" | "sourceMeta" | "kind">
    | null
    | undefined,
  nodeMap:
    | Map<string, Pick<Doc<"nodes">, "_id" | "parentNodeId" | "sourceMeta" | "kind">>
    | Map<string, Pick<TreeNode, "_id" | "parentNodeId" | "sourceMeta" | "kind">>,
) {
  if (!node) {
    return false;
  }

  let currentParentId = (node.parentNodeId as string | null) ?? null;
  while (currentParentId) {
    const parentNode = nodeMap.get(currentParentId) ?? null;
    if (!parentNode) {
      return false;
    }

    const parentMeta = getNodeMeta(parentNode);
    if (parentMeta.plannerKind === "plannerDay") {
      return true;
    }

    currentParentId = (parentNode.parentNodeId as string | null) ?? null;
  }

  return false;
}

function isNodeNoteCompleted(
  node:
    | Pick<Doc<"nodes">, "kind" | "sourceMeta">
    | Pick<NodeValueSnapshot, "kind" | "noteCompleted">
    | null
    | undefined,
) {
  if (!node || node.kind !== "note") {
    return false;
  }

  if ("noteCompleted" in node) {
    return node.noteCompleted === true;
  }

  const sourceMeta =
    node.sourceMeta && typeof node.sourceMeta === "object"
      ? (node.sourceMeta as Record<string, unknown>)
      : {};
  return sourceMeta.noteCompleted === true;
}

function getNodeRecurrenceFrequency(
  node:
    | {
        kind: string;
        sourceMeta?: Record<string, unknown> | null;
      }
    | {
        kind: string;
        recurrenceFrequency?: RecurrenceFrequency;
      }
    | null
    | undefined,
): RecurrenceFrequency {
  if (!node || node.kind !== "task") {
    return null;
  }

  if ("recurrenceFrequency" in node) {
    return parseRecurrenceFrequency(node.recurrenceFrequency);
  }

  const sourceMeta =
    "sourceMeta" in node && node.sourceMeta && typeof node.sourceMeta === "object"
      ? (node.sourceMeta as Record<string, unknown>)
      : {};
  return parseRecurrenceFrequency(sourceMeta.recurrenceFrequency);
}

function getRecurringCompletionTransition(
  node: {
    text: string;
    kind: string;
    taskStatus: string | null;
    dueAt: number | null;
    dueEndAt?: number | null;
    sourceMeta?: Record<string, unknown> | null;
  },
  completionMode: RecurringCompletionMode,
): NodeValueSnapshot | null {
  const recurrenceFrequency = getNodeRecurrenceFrequency(node);
  if (node.kind !== "task" || recurrenceFrequency === null || !node.dueAt) {
    return null;
  }

  if (node.taskStatus === "done") {
    return {
      text: node.text,
      kind: "task",
      taskStatus: "todo",
      noteCompleted: false,
      dueAt: node.dueAt,
      dueEndAt: node.dueEndAt ?? null,
      recurrenceFrequency,
    };
  }

  const nextRange = advanceRecurringDueDateRange({
    dueAt: node.dueAt,
    dueEndAt: node.dueEndAt ?? null,
    frequency: recurrenceFrequency,
    mode: completionMode,
  });

  return {
    text: node.text,
    kind: "task",
    taskStatus: "todo",
    noteCompleted: false,
    dueAt: nextRange.dueAt,
    dueEndAt: nextRange.dueEndAt,
    recurrenceFrequency,
  };
}

function withNodeScheduleSnapshot(
  snapshot: NodeValueSnapshot,
  source:
    | {
        kind: string;
        dueAt?: number | null;
        dueEndAt?: number | null;
        sourceMeta?: Record<string, unknown> | null;
      }
    | {
        kind: string;
        dueAt?: number | null;
        dueEndAt?: number | null;
        recurrenceFrequency?: RecurrenceFrequency;
      },
): NodeValueSnapshot {
  if (snapshot.kind !== "task") {
    return {
      ...snapshot,
      taskStatus: null,
      dueAt: null,
      dueEndAt: null,
      recurrenceFrequency: null,
    };
  }

  return {
    ...snapshot,
    taskStatus: snapshot.taskStatus ?? "todo",
    dueAt: snapshot.dueAt ?? ("dueAt" in source ? (source.dueAt ?? null) : null),
    dueEndAt:
      snapshot.dueEndAt ?? ("dueEndAt" in source ? (source.dueEndAt ?? null) : null),
    recurrenceFrequency:
      snapshot.recurrenceFrequency ?? getNodeRecurrenceFrequency(source),
  };
}

function getTaskScheduleSummary(task: {
  kind: string;
  dueAt: number | null;
  dueEndAt?: number | null;
  sourceMeta?: Record<string, unknown> | null;
}, effectiveDueRange?: { dueAt: number | null; dueEndAt: number | null }) {
  if (task.kind !== "task") {
    return "";
  }

  const parts: string[] = [];
  const dueAt = effectiveDueRange?.dueAt ?? task.dueAt;
  const dueEndAt = effectiveDueRange?.dueEndAt ?? task.dueEndAt ?? null;
  if (dueAt) {
    parts.push(formatDueDateRange(dueAt, dueEndAt));
  }

  const recurrenceFrequency = getNodeRecurrenceFrequency(task);
  if (recurrenceFrequency) {
    parts.push(getRecurrenceLabel(recurrenceFrequency));
  }

  return parts.join(" • ");
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

function getDocumentTitle(pageTitle: string | null | undefined) {
  const trimmedTitle = pageTitle?.trim();
  return trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : "Malesh Flow";
}

function readPageIdFromLocation() {
  if (typeof window === "undefined") {
    return null;
  }

  const url = new URL(window.location.href);
  return url.searchParams.get("page");
}

function focusWorkspaceAiChatInput() {
  if (typeof document === "undefined") {
    return;
  }

  const input = document.getElementById(WORKSPACE_AI_CHAT_TEXTAREA_ID);
  if (input instanceof HTMLTextAreaElement) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

function writePageIdToHistory(
  pageId: string | null,
  mode: "push" | "replace" = "push",
  pageTitle?: string | null,
) {
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
  const nextTitle = getDocumentTitle(pageTitle);
  if (document.title !== nextTitle) {
    document.title = nextTitle;
  }
  if (mode === "replace") {
    window.history.replaceState({}, nextTitle, nextUrl);
    return;
  }

  window.history.pushState({}, nextTitle, nextUrl);
}

function buildNodeLinkInsertText(node: Doc<"nodes">) {
  return `[[${sanitizeLinkLabel(node.text)}|node:${node._id}]]`;
}

function buildNodeClipboardLink(node: Pick<Doc<"nodes">, "_id" | "text">) {
  return `[[${sanitizeLinkLabel(node.text)}|node:${node._id}]]`;
}

function buildPageLinkInsertText(page: Pick<Doc<"pages">, "_id" | "title">) {
  return `[[${sanitizeLinkLabel(page.title)}|page:${page._id}]]`;
}

function buildPageBacklinkSearchQuery(page: Pick<Doc<"pages">, "_id">) {
  return `page:${page._id}`;
}

function buildNodeBacklinkSearchQuery(node: { _id: string }) {
  return `node:${node._id}`;
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
  pagesById: Map<string, PageDoc>,
) {
  const linkedPageIds = new Set<Id<"pages">>();
  const linkedNodeIds = new Set<Id<"nodes">>();

  for (const match of extractLinkMatches(value)) {
    if (match.link.kind === "page") {
      const page =
        (match.link.targetPageRef
          ? pagesById.get(match.link.targetPageRef)
          : null) ??
        (match.link.targetPageTitle
          ? pagesByTitle.get(normalizePageTitleKey(match.link.targetPageTitle))
          : null);
      if (page && !page.archived) {
        linkedPageIds.add(page._id);
      }
      continue;
    }

    if (match.link.kind === "node") {
      linkedNodeIds.add(match.link.targetNodeRef as Id<"nodes">);
    }
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
  if (
    inner.includes("]]") ||
    inner.includes("\n") ||
    inner.includes("|node:") ||
    inner.includes("|page:")
  ) {
    return null;
  }

  return {
    startIndex,
    endIndex: caretPosition,
    query: inner,
  };
}

function getActiveTagToken(value: string, caretPosition: number | null) {
  if (caretPosition === null) {
    return null;
  }

  const beforeCaret = value.slice(0, caretPosition);
  const match = beforeCaret.match(/(^|[^A-Za-z0-9_])#([A-Za-z0-9/-]*)$/);
  if (!match) {
    return null;
  }

  const query = match[2] ?? "";
  if (query.length === 0) {
    return null;
  }

  const startIndex = beforeCaret.length - query.length - 1;
  const trailingMatch = value.slice(caretPosition).match(/^[A-Za-z0-9/-]*/);
  const trailing = trailingMatch?.[0] ?? "";

  return {
    startIndex,
    endIndex: caretPosition + trailing.length,
    query,
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
    insertText: buildPageLinkInsertText(page),
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

function buildTagSuggestions(
  tags: SidebarTagResult[],
  query: string,
  limit = 6,
): LinkSuggestion[] {
  const normalizedQuery = query.trim().replace(/^#/, "").toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const rankedMatches = [...tags]
    .filter((tag) => tag.normalizedValue.includes(normalizedQuery))
    .sort((left, right) => {
      const leftRank =
        left.normalizedValue === normalizedQuery
          ? 0
          : left.normalizedValue.startsWith(normalizedQuery)
            ? 1
            : 2;
      const rightRank =
        right.normalizedValue === normalizedQuery
          ? 0
          : right.normalizedValue.startsWith(normalizedQuery)
            ? 1
            : 2;

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      if (left.count !== right.count) {
        return right.count - left.count;
      }

      return left.normalizedValue.localeCompare(right.normalizedValue);
    })
    .slice(0, limit);

  return rankedMatches.map((tag) => ({
    key: `tag:${tag.normalizedValue}`,
    kind: "tag",
    title: tag.label,
    subtitle: `Tag • ${tag.count} use${tag.count === 1 ? "" : "s"}`,
    insertText: tag.label,
  }));
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
  pagesById: Map<string, PageDoc> = new Map(),
  nodeTargetsById: Map<string, NodeLinkTargetResolution>,
): LinkPreviewSegment[] {
  const linkMatches = extractLinkMatches(value);
  const tagMatches = extractTagMatches(value).filter(
    (tagMatch) =>
      !linkMatches.some(
        (linkMatch) =>
          tagMatch.start < linkMatch.end && tagMatch.end > linkMatch.start,
      ),
  );
  const matches = [
    ...linkMatches.map((match) => ({ ...match, tokenKind: "link" as const })),
    ...tagMatches.map((match) => ({ ...match, tokenKind: "tag" as const })),
  ].sort((left, right) => left.start - right.start);
  if (matches.length === 0) {
    return [];
  }

  const segments: LinkPreviewSegment[] = [];
  let cursor = 0;
  let hasRenderableToken = false;

  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({
        key: `text:${cursor}`,
        kind: "text",
        text: value.slice(cursor, match.start),
      });
    }

    hasRenderableToken = true;
    if (match.tokenKind === "tag") {
      segments.push({
        key: `tag:${match.start}`,
        kind: "tag",
        text: match.label,
        value: match.value,
        normalizedValue: match.normalizedValue,
      });
    } else if (match.link.kind === "external") {
      segments.push({
        key: `external:${match.start}`,
        kind: "link",
        text: match.link.text,
        pageId: null,
        nodeId: null,
        archived: false,
        resolved: true,
        linkKind: "external",
        href: normalizeExternalHref(match.link.targetUrl),
        pageTypeBadge: null,
      });
    } else if (match.link.kind === "page") {
      const page =
        (match.link.targetPageRef
          ? pagesById.get(match.link.targetPageRef)
          : null) ??
        (match.link.targetPageTitle
          ? pagesByTitle.get(normalizePageTitleKey(match.link.targetPageTitle))
          : null);
      const pagePreviewText = getExplicitWikiLinkPreviewText(match.link.label);
      segments.push({
        key: `page:${match.start}`,
        kind: "link",
        text: pagePreviewText || page?.title || match.link.targetPageTitle || "Linked page",
        pageId: page?._id ?? null,
        nodeId: null,
        archived: page?.archived ?? false,
        resolved: Boolean(page),
        linkKind: "page",
        href: null,
        pageTypeBadge: page ? getPageTypeEmoji(page) : null,
      });
    } else {
      const targetNode = nodeTargetsById.get(match.link.targetNodeRef);
      const nodeLabel = getExplicitWikiLinkPreviewText(match.link.label);
      const renderedTargetNodeText = targetNode
        ? replaceLinkMarkupWithLabels(targetNode.text).trim()
        : "";
      segments.push({
        key: `node:${match.start}`,
        kind: "link",
        text: nodeLabel || renderedTargetNodeText || "Linked node",
        pageId: targetNode?.pageId ?? null,
        nodeId: targetNode?.nodeId ?? null,
        archived: targetNode?.pageArchived ?? false,
        resolved: Boolean(targetNode?.pageId),
        linkKind: "node",
        href: null,
        pageTypeBadge: null,
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

  return hasRenderableToken ? segments : [];
}

function normalizeExternalHref(value: string) {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return trimmedValue;
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmedValue)) {
    return trimmedValue;
  }

  if (trimmedValue.startsWith("//")) {
    return `https:${trimmedValue}`;
  }

  return `https://${trimmedValue}`;
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

function isValidClipboardTaskStatus(value: unknown): value is NodeValueSnapshot["taskStatus"] {
  return (
    value === null ||
    value === "todo" ||
    value === "in_progress" ||
    value === "done" ||
    value === "cancelled"
  );
}

function isOutlineClipboardNode(value: unknown): value is OutlineClipboardNode {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.text === "string" &&
    (record.kind === "note" || record.kind === "task") &&
    isValidClipboardTaskStatus(record.taskStatus) &&
    typeof record.noteCompleted === "boolean" &&
    (record.dueAt === undefined || typeof record.dueAt === "number" || record.dueAt === null) &&
    (record.dueEndAt === undefined ||
      typeof record.dueEndAt === "number" ||
      record.dueEndAt === null) &&
    (record.recurrenceFrequency === undefined ||
      record.recurrenceFrequency === null ||
      parseRecurrenceFrequency(record.recurrenceFrequency) !== null) &&
    typeof record.lockKind === "boolean" &&
    Array.isArray(record.children) &&
    record.children.every((child) => isOutlineClipboardNode(child))
  );
}

function parseOutlineClipboardPayload(raw: string) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      nodes?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) {
      return null;
    }

    if (!parsed.nodes.every((node) => isOutlineClipboardNode(node))) {
      return null;
    }

    return parsed as OutlineClipboardPayload;
  } catch {
    return null;
  }
}

function findTreeNodeById(nodes: TreeNode[], targetNodeId: string): TreeNode | null {
  for (const node of nodes) {
    if (node._id === targetNodeId) {
      return node;
    }

    const childMatch = findTreeNodeById(node.children, targetNodeId);
    if (childMatch) {
      return childMatch;
    }
  }

  return null;
}

function getSelectedRootNodeIds(
  selectedNodeIds: Set<string>,
  visibleNodeOrder: string[],
  nodeMap: Map<string, Doc<"nodes">>,
) {
  const orderedSelectedNodeIds = visibleNodeOrder.filter((nodeId) => selectedNodeIds.has(nodeId));
  return orderedSelectedNodeIds.filter((nodeId) => {
    let currentNode = nodeMap.get(nodeId) ?? null;
    while (currentNode?.parentNodeId) {
      const parentNodeId = currentNode.parentNodeId as string;
      if (selectedNodeIds.has(parentNodeId)) {
        return false;
      }
      currentNode = nodeMap.get(parentNodeId) ?? null;
    }

    return true;
  });
}

function arePlacementsEqual(left: NodePlacement, right: NodePlacement) {
  return (
    left.pageId === right.pageId &&
    left.parentNodeId === right.parentNodeId &&
    left.afterNodeId === right.afterNodeId
  );
}

function serializeTreeNodeForClipboard(node: TreeNode): OutlineClipboardNode {
  const nodeMeta = getNodeMeta(node);
  return {
    text: node.text,
    kind: node.kind as "note" | "task",
    taskStatus: (node.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
    noteCompleted: nodeMeta.noteCompleted === true,
    dueAt: node.dueAt ?? null,
    dueEndAt: node.dueEndAt ?? null,
    recurrenceFrequency: getNodeRecurrenceFrequency(node),
    lockKind: nodeMeta.taskKindLocked === true,
    children: node.children.map((child) => serializeTreeNodeForClipboard(child)),
  };
}

function countTreeNodeSubtree(node: TreeNode): number {
  return (
    1 +
    node.children.reduce((total, child) => total + countTreeNodeSubtree(child), 0)
  );
}

function buildOutlineClipboardText(nodes: OutlineClipboardNode[], depth = 0): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const prefix = "  ".repeat(depth);
    const lineText =
      node.kind === "task"
        ? `${node.taskStatus === "done" ? "[x]" : "[ ]"} ${node.text}`
        : node.text;
    lines.push(`${prefix}${lineText}`);
    if (node.children.length > 0) {
      lines.push(buildOutlineClipboardText(node.children, depth + 1));
    }
  }

  return lines.join("\n");
}

function countNodesInClipboardPayload(nodes: OutlineClipboardNode[]): number {
  return nodes.reduce(
    (count, node) => count + 1 + countNodesInClipboardPayload(node.children),
    0,
  );
}

function importedNodesToClipboardNodes(nodes: ImportedOutlineNode[]): OutlineClipboardNode[] {
  return nodes.map((node) => ({
    text: node.text,
    kind: node.kind,
    taskStatus: node.taskStatus,
    noteCompleted: node.noteCompleted,
    dueAt: node.dueAt,
    dueEndAt: node.dueEndAt,
    recurrenceFrequency: node.recurrenceFrequency,
    lockKind: node.lockKind,
    children: importedNodesToClipboardNodes(node.children),
  }));
}

function flattenOutlineClipboardNodesForBatch(
  nodes: OutlineClipboardNode[],
  destination: {
    parentNodeId: Id<"nodes"> | null;
    afterNodeId: Id<"nodes"> | null;
  },
) {
  const entries: OutlineClipboardBatchEntry[] = [];
  const rootClientIds: string[] = [];
  let counter = 0;

  const appendNode = (
    node: OutlineClipboardNode,
    placement: {
      parentNodeId?: Id<"nodes"> | null;
      parentClientId?: string;
      afterNodeId?: Id<"nodes"> | null;
      afterClientId?: string;
    },
  ) => {
    const clientId = `outline-clip-${counter++}`;
    entries.push({
      clientId,
      parentNodeId: placement.parentNodeId,
      parentClientId: placement.parentClientId,
      afterNodeId: placement.afterNodeId,
      afterClientId: placement.afterClientId,
      text: node.text,
      kind: node.kind,
      taskStatus: node.taskStatus,
      noteCompleted: node.noteCompleted,
      dueAt: node.dueAt,
      dueEndAt: node.dueEndAt,
      recurrenceFrequency: node.recurrenceFrequency,
      lockKind: node.lockKind,
    });

    let previousChildClientId: string | null = null;
    for (const child of node.children) {
      previousChildClientId = appendNode(child, {
        parentClientId: clientId,
        afterClientId: previousChildClientId ?? undefined,
        afterNodeId: previousChildClientId ? undefined : null,
      });
    }

    return clientId;
  };

  let previousRootClientId: string | null = null;
  for (const node of nodes) {
    const clientId = appendNode(node, {
      parentNodeId: destination.parentNodeId,
      afterClientId: previousRootClientId ?? undefined,
      afterNodeId: previousRootClientId ? undefined : destination.afterNodeId,
    });
    rootClientIds.push(clientId);
    previousRootClientId = clientId;
  }

  return { entries, rootClientIds };
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
    | Pick<Doc<"nodes">, "text" | "kind" | "taskStatus" | "dueAt" | "dueEndAt">
    | Pick<Doc<"nodes">, "text" | "kind" | "taskStatus" | "dueAt" | "dueEndAt" | "sourceMeta">
    | {
        text: string;
        kind: "note" | "task";
        taskStatus: "todo" | "in_progress" | "done" | "cancelled" | null;
        noteCompleted?: boolean;
        dueAt?: number | null;
        dueEndAt?: number | null;
        recurrenceFrequency?: RecurrenceFrequency;
      },
): NodeValueSnapshot {
  return {
    text: value.text,
    kind: value.kind as "note" | "task",
    taskStatus: (value.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
    noteCompleted: isNodeNoteCompleted(
      value as
        | Pick<Doc<"nodes">, "kind" | "sourceMeta">
        | Pick<NodeValueSnapshot, "kind" | "noteCompleted">,
    ),
    dueAt: "dueAt" in value ? (value.dueAt ?? null) : null,
    dueEndAt: "dueEndAt" in value ? (value.dueEndAt ?? null) : null,
    recurrenceFrequency: getNodeRecurrenceFrequency(
      value as
        | Pick<Doc<"nodes">, "kind" | "sourceMeta">
        | Pick<NodeValueSnapshot, "kind" | "recurrenceFrequency">,
    ),
  };
}

function isDimmedSyntaxLine(value: string) {
  return value.trim().startsWith("%%");
}

function stripDimmedSyntaxPrefix(value: string) {
  return value.replace(/^(\s*)%%\s*/, "$1");
}

function applyInlineFormattingToPreviewSegments(segments: LinkPreviewSegment[]) {
  const rendered: RenderedPreviewSegment[] = [];
  let formattingState = {
    strike: false,
    italic: false,
    bold: false,
    code: false,
  };

  for (const segment of segments) {
    if (segment.kind !== "text") {
      rendered.push({
        ...segment,
        ...formattingState,
      });
      continue;
    }

    const splitResult = splitTextForInlineFormatting(segment.text, formattingState);
    for (const textSegment of splitResult.segments) {
      rendered.push({
        key: `${segment.key}:${textSegment.key}`,
        kind: "text",
        text: textSegment.text,
        strike: textSegment.strike,
        italic: textSegment.italic,
        bold: textSegment.bold,
        code: textSegment.code,
      });
    }
    formattingState = splitResult.nextState;
  }

  return rendered;
}

function readStoredBoolean(key: string, defaultValue: boolean) {
  if (typeof window === "undefined") {
    return defaultValue;
  }

  const storedValue = window.localStorage.getItem(key);
  if (storedValue === null) {
    return defaultValue;
  }

  return storedValue === "true";
}

function readStoredRecurringCompletionMode(defaultValue: RecurringCompletionMode) {
  if (typeof window === "undefined") {
    return defaultValue;
  }

  const storedValue = window.localStorage.getItem(RECURRING_TASK_COMPLETION_MODE_STORAGE_KEY);
  return storedValue === "today" || storedValue === "dueDate"
    ? storedValue
    : defaultValue;
}

function getHeadingPreviewClass(level: 1 | 2 | 3 | null) {
  if (level === 1) {
    return "text-[1.9rem] leading-[2.3rem] font-semibold tracking-tight";
  }

  if (level === 2) {
    return "text-[1.45rem] leading-[1.9rem] font-semibold tracking-tight";
  }

  if (level === 3) {
    return "text-[1.1rem] leading-[1.55rem] font-semibold tracking-tight";
  }

  return "";
}

function getHeadingRowMinHeightClass(level: 1 | 2 | 3 | null) {
  if (level === 1) {
    return "min-h-[3.25rem]";
  }

  if (level === 2) {
    return "min-h-[2.7rem]";
  }

  if (level === 3) {
    return "min-h-[1.8rem]";
  }

  return "min-h-0";
}

function getHeadingMarkerOffsetClass(level: 1 | 2 | 3 | null) {
  if (level === 1) {
    return "pt-[0.85rem]";
  }

  if (level === 2) {
    return "pt-[0.65rem]";
  }

  if (level === 3) {
    return "pt-[0.28rem]";
  }

  return "";
}

function getHeadingControlOffsetClass(level: 1 | 2 | 3 | null) {
  if (level === 1) {
    return "pt-[0.55rem]";
  }

  if (level === 2) {
    return "pt-[0.35rem]";
  }

  if (level === 3) {
    return "pt-[0.08rem]";
  }

  return "";
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
    noteCompleted: isNodeNoteCompleted(node),
    dueAt: node.dueAt ?? null,
    recurrenceFrequency: getNodeRecurrenceFrequency(node),
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
  const [plannerStatus, setPlannerStatus] = useState("");
  const [modelPromptNote, setModelPromptNote] = useState("");
  const [journalFeedbackPromptNote, setJournalFeedbackPromptNote] = useState("");
  const [activeAiPromptEditor, setActiveAiPromptEditor] = useState<
    "model" | "journalFeedback" | null
  >(null);
  const [embeddingRebuildStatus, setEmbeddingRebuildStatus] = useState("");
  const [isCreatingPage, setIsCreatingPage] = useState<SidebarSection | null>(null);
  const [isCreatingPlannerPage, setIsCreatingPlannerPage] = useState(false);
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [isGeneratingJournalFeedback, setIsGeneratingJournalFeedback] = useState(false);
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const [isRefreshingSidebarLinks, setIsRefreshingSidebarLinks] = useState(false);
  const [isPlannerAppendingDay, setIsPlannerAppendingDay] = useState(false);
  const [isPlannerCompletingDay, setIsPlannerCompletingDay] = useState(false);
  const [isPlannerAddingRandomTask, setIsPlannerAddingRandomTask] = useState(false);
  const [isPlannerResolvingNextTask, setIsPlannerResolvingNextTask] = useState(false);
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
  const [plannerChatDraft, setPlannerChatDraft] = useState("");
  const [plannerChatError, setPlannerChatError] = useState("");
  const [isPlannerChatLoading, setIsPlannerChatLoading] = useState(false);
  const [plannerNextTaskSuggestion, setPlannerNextTaskSuggestion] =
    useState<PlannerNextTaskSuggestion | null>(null);
  const [lastResolvedPageTree, setLastResolvedPageTree] = useState<PageTreeResult | null>(null);
  const [activeDraggedNodeId, setActiveDraggedNodeId] = useState<string | null>(null);
  const [activeDraggedNodePayload, setActiveDraggedNodePayload] = useState<DraggedNodePayload | null>(null);
  const [pendingRevealNodeId, setPendingRevealNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(new Set());
  const [actionContextNodeId, setActionContextNodeId] = useState<string | null>(null);
  const [recurringCompletionMode, setRecurringCompletionMode] =
    useState<RecurringCompletionMode>("dueDate");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isUncategorizedSectionCollapsed, setIsUncategorizedSectionCollapsed] = useState(false);
  const [isJournalSectionCollapsed, setIsJournalSectionCollapsed] = useState(false);
  const [isTagsSectionCollapsed, setIsTagsSectionCollapsed] = useState(false);
  const [isArchiveSectionCollapsed, setIsArchiveSectionCollapsed] = useState(false);
  const [showSidebarDiagnostics, setShowSidebarDiagnostics] = useState(false);
  const [sidebarBootstrapError, setSidebarBootstrapError] = useState<string>("");
  const [copySnackbarMessage, setCopySnackbarMessage] = useState("");
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
  const tags = useQuery(
    api.workspace.listTags,
    ownerKey && isOwnerKeyValid ? { ownerKey } : SKIP,
  );
  const workspaceKnowledgeThread = useQuery(
    api.chatData.getWorkspaceKnowledgeThread,
    ownerKey && isOwnerKeyValid ? { ownerKey } : SKIP,
  );
  const plannerChatThread = useQuery(
    api.chatData.getChatThread,
    ownerKey && isOwnerKeyValid && selectedPageId
      ? { ownerKey, pageId: selectedPageId }
      : SKIP,
  );
  const pageTree = useQuery(
    api.workspace.getPageTree,
    ownerKey && isOwnerKeyValid && selectedPageId
      ? { ownerKey, pageId: selectedPageId }
      : SKIP,
  ) as PageTreeResult | null | undefined;
  const sidebarTree = useQuery(
    api.workspace.getSidebarTree,
    ownerKey && isOwnerKeyValid ? { ownerKey } : SKIP,
  ) as SidebarTreeResult | null | undefined;

  const createPage = useMutation(api.workspace.createPage);
  const ensureSidebarPage = useMutation(api.workspace.ensureSidebarPage);
  const ensureTaskPageSidebarSection = useMutation(
    api.workspace.ensureTaskPageSidebarSection,
  );
  const ensurePlannerPageSections = useMutation(api.planner.ensurePlannerPageSections);
  const renamePage = useMutation(api.workspace.renamePage);
  const archivePage = useMutation(api.workspace.archivePage);
  const setPlannerScanExcluded = useMutation(api.workspace.setPlannerScanExcluded);
  const deletePageForever = useMutation(api.workspace.deletePageForever);
  const rebuildEmbeddings = useMutation(api.workspace.rebuildEmbeddings);
  const refreshSidebarLinks = useMutation(api.workspace.refreshSidebarLinks);
  const createNodesBatch = useMutation(api.workspace.createNodesBatch);
  const updateNode = useMutation(api.workspace.updateNode);
  const updateNodesBatch = useMutation(api.workspace.updateNodesBatch);
  const moveNode = useMutation(api.workspace.moveNode);
  const moveNodesBatch = useMutation(api.workspace.moveNodesBatch);
  const splitNode = useMutation(api.workspace.splitNode);
  const replaceNodeAndInsertSiblings = useMutation(
    api.workspace.replaceNodeAndInsertSiblings,
  );
  const setNodeTreeArchived = useMutation(api.workspace.setNodeTreeArchived);
  const setNodeTreesArchivedBatch = useMutation(api.workspace.setNodeTreesArchivedBatch);
  const rewriteModelSection = useAction(api.chat.rewriteModelSection);
  const generateJournalFeedback = useAction(api.chat.generateJournalFeedback);
  const runPlannerChat = useAction(api.chat.runPlannerChat);
  const applyApprovedPlannerPlan = useMutation(api.chatData.applyApprovedPlannerPlan);
  const appendPlannerDay = useMutation(api.planner.appendPlannerDay);
  const completePlannerDayWithAi = useAction(api.plannerAi.completePlannerDayWithAi);
  const addRandomPlannerTask = useMutation(api.planner.addRandomPlannerTask);
  const resolveNextPlannerTask = useMutation(api.planner.resolveNextPlannerTask);
  const completePlannerTask = useMutation(api.planner.completePlannerTask);
  const findNodesText = useAction(api.ai.findNodesText);
  const searchNodes = useAction(api.ai.searchNodes);
  const chatWithWorkspace = useAction(api.ai.chatWithWorkspace);
  const pageTitleInputRef = useRef<HTMLInputElement>(null);
  const pageTitleDraftRef = useRef(pageTitleDraft);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const paletteResultsRef = useRef<HTMLDivElement>(null);
  const lastPaletteModeRef = useRef<PaletteMode>("pages");
  const hasResolvedInitialPageSelection = useRef(false);
  const hasRequestedSidebarPage = useRef(false);
  const hasRequestedTaskSidebarSection = useRef(new Set<string>());
  const hasRequestedPlannerSections = useRef(new Set<string>());
  const textSelectionGestureRef = useRef<{
    anchorNodeId: string;
    lastNodeId: string;
    startY: number;
    convertedToItemSelection: boolean;
  } | null>(null);

  const clearNodeSelection = useCallback(() => {
    setSelectedNodeIds(new Set());
    setDragSelection(null);
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

  const openTaskSchedulePalette = useCallback((nodeId: string | null) => {
    setActionContextNodeId(nodeId);
    setPaletteMode("taskSchedule");
    setPaletteQuery("");
    setPaletteHighlightIndex(0);
    setTextSearchResults([]);
    setNodeSearchResults([]);
    setPaletteOpen(true);
  }, []);

  const cyclePaletteMode = useCallback((direction: -1 | 1) => {
    const currentIndex = PALETTE_MODE_ORDER.indexOf(paletteMode);
    const safeCurrentIndex =
      currentIndex === -1
        ? Math.max(PALETTE_MODE_ORDER.indexOf("actions"), 0)
        : currentIndex;
    const nextIndex =
      (safeCurrentIndex + direction + PALETTE_MODE_ORDER.length) %
      PALETTE_MODE_ORDER.length;
    const nextMode = PALETTE_MODE_ORDER[nextIndex] ?? "pages";
    switchPaletteMode(nextMode);
  }, [paletteMode, switchPaletteMode]);

  const openFindPaletteForQuery = useCallback((query: string) => {
    lastPaletteModeRef.current = "find";
    setPaletteMode("find");
    setPaletteQuery(query);
    setPaletteHighlightIndex(0);
    setTextSearchResults([]);
    setNodeSearchResults([]);
    setPaletteOpen(true);
  }, []);

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
  const selectedPageSourceMeta =
    selectedPage && typeof selectedPage.sourceMeta === "object" && selectedPage.sourceMeta
      ? (selectedPage.sourceMeta as Record<string, unknown>)
      : null;
  const isSelectedPageExcludedFromPlannerScan =
    selectedPageSourceMeta?.excludeFromPlannerScan === true;
  const plannerChatMessages = plannerChatThread?.messages ?? [];
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
  const pageNodeBacklinkCounts = useMemo(
    () => new Map(Object.entries(activePageTree?.nodeBacklinkCounts ?? {})),
    [activePageTree?.nodeBacklinkCounts],
  );
  const sidebarNodeBacklinkCounts = useMemo(
    () => new Map(Object.entries(sidebarTree?.nodeBacklinkCounts ?? {})),
    [sidebarTree?.nodeBacklinkCounts],
  );
  const sidebarLinkedPageIds = useMemo(
    () => new Set((sidebarTree?.linkedPageIds ?? []).map((pageId) => pageId as string)),
    [sidebarTree?.linkedPageIds],
  );
  const pageBacklinkCount = activePageTree?.pageBacklinkCount ?? 0;
  const isPageBacklinkCountTruncated = activePageTree?.pageBacklinkCountTruncated ?? false;
  const pageLoadWarning = activePageTree?.loadWarning ?? null;

  const modelSection = findSectionNode(tree, "model");
  const recentExamplesSection = findSectionNode(tree, "recentExamples");
  const taskSidebarSection = findSectionNode(tree, "taskSidebar");
  const plannerSidebarSection = findSectionNode(tree, "plannerSidebar");
  const plannerLegacyArchiveSection = findSectionNode(tree, "plannerRunningArchive");
  const plannerTemplateSection = findSectionNode(tree, "plannerTemplate");
  const journalThoughtsSection = findSectionNode(tree, "journalThoughts");
  const journalFeedbackSection = findSectionNode(tree, "journalFeedback");
  const scratchpadLiveSection = findSectionNode(tree, "scratchpadLive");
  const scratchpadPreviousSection = findSectionNode(tree, "scratchpadPrevious");
  const modelPromptLines = useMemo(
    () =>
      (modelSection?.children ?? [])
        .map((node) => node.text.trim())
        .filter((line) => line.length > 0),
    [modelSection],
  );
  const recentPromptLines = useMemo(
    () =>
      (recentExamplesSection?.children ?? [])
        .map((node) => node.text.trim())
        .filter((line) => line.length > 0),
    [recentExamplesSection],
  );
  const journalThoughtPromptLines = useMemo(
    () =>
      (journalThoughtsSection?.children ?? [])
        .map((node) => node.text.trim())
        .filter((line) => line.length > 0),
    [journalThoughtsSection],
  );
  const modelPromptPreview = useMemo(
    () =>
      buildModelRewriteUserPrompt({
        pageTitle: selectedPage?.title ?? "(untitled)",
        request: MODEL_REGENERATE_REQUEST,
        userNote: modelPromptNote,
        existingModelLines: modelPromptLines,
        recentExampleLines: recentPromptLines,
      }),
    [modelPromptLines, modelPromptNote, recentPromptLines, selectedPage?.title],
  );
  const journalFeedbackPromptPreview = useMemo(
    () =>
      buildJournalFeedbackUserPrompt({
        pageTitle: selectedPage?.title ?? "(untitled)",
        userNote: journalFeedbackPromptNote,
        thoughtLines: journalThoughtPromptLines,
      }),
    [journalFeedbackPromptNote, journalThoughtPromptLines, selectedPage?.title],
  );

  useEffect(() => {
    setActiveAiPromptEditor(null);
    setModelPromptNote("");
    setJournalFeedbackPromptNote("");
    setPlannerStatus("");
    setPlannerChatDraft("");
    setPlannerChatError("");
  }, [selectedPageId]);

  const genericRoots =
    pageMeta.pageType === "task"
      ? collectChildren(
          tree,
          new Set([taskSidebarSection?._id].filter(Boolean) as string[]),
        )
      : pageMeta.pageType === "planner"
      ? collectChildren(
          tree,
          new Set(
            [
              plannerSidebarSection?._id,
              plannerLegacyArchiveSection?._id,
              plannerTemplateSection?._id,
            ].filter(Boolean) as string[],
          ),
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
  const plannerVisibleRoots = [plannerTemplateSection].filter(
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
      ? flattenTreeNodes(genericRoots, collapsedNodeIds)
      : pageMeta.pageType === "planner"
      ? flattenTreeNodes([...genericRoots, ...plannerVisibleRoots], collapsedNodeIds)
      : pageMeta.pageType === "model"
      ? flattenTreeNodes([...modelVisibleRoots, ...genericRoots], collapsedNodeIds)
      : pageMeta.pageType === "journal"
        ? flattenTreeNodes([...journalVisibleRoots, ...genericRoots], collapsedNodeIds)
        : pageMeta.pageType === "scratchpad"
          ? flattenTreeNodes([...scratchpadVisibleRoots, ...genericRoots], collapsedNodeIds)
        : flattenTreeNodes(genericRoots, collapsedNodeIds);
  const sidebarVisibleRows = flattenTreeNodes(sidebarNodes, collapsedNodeIds);
  const visibleNodeOrder = [...sidebarVisibleRows, ...pageVisibleRows].map((node) => node._id);
  const revealNodes = useMemo(() => {
    if (!pendingRevealNodeId) {
      return null;
    }

    if ((sidebarTree?.nodes ?? []).some((node) => (node._id as string) === pendingRevealNodeId)) {
      return sidebarTree?.nodes ?? null;
    }

    if ((activePageTree?.nodes ?? []).some((node) => (node._id as string) === pendingRevealNodeId)) {
      return activePageTree?.nodes ?? null;
    }

    return null;
  }, [activePageTree?.nodes, pendingRevealNodeId, sidebarTree?.nodes]);
  const uncategorizedPages = useMemo(
    () =>
      (pages ?? [])
        .filter(
          (page) =>
            !page.archived &&
            getPageMeta(page).pageType !== "journal" &&
            !sidebarLinkedPageIds.has(page._id as string),
        )
        .sort((left, right) =>
          left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
        ),
    [pages, sidebarLinkedPageIds],
  );
  const journalPages = useMemo(
    () =>
      (pages ?? [])
        .filter((page) => !page.archived && getPageMeta(page).pageType === "journal")
        .sort((left, right) =>
          left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
        ),
    [pages],
  );
  const archivedPages = (pages ?? []).filter((page) => page.archived);
  const showUncategorizedSectionContent =
    uncategorizedPages.length > 0 && !isUncategorizedSectionCollapsed;
  const showJournalSectionContent = !isJournalSectionCollapsed;
  const showTagsSectionContent = !isTagsSectionCollapsed;
  const showArchiveSectionContent = !isArchiveSectionCollapsed;
  const sortedTags: SidebarTagResult[] = tags ?? [];
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
  const paletteContextNodeId =
    selectedNodeIds.size === 1 ? ([...selectedNodeIds][0] ?? null) : actionContextNodeId;
  const taskScheduleTargetNode = useMemo(() => {
    if (!paletteContextNodeId) {
      return null;
    }

    const node = workspaceNodeMap.get(paletteContextNodeId) ?? null;
    if (!node || node.kind !== "task" || getNodeMeta(node).locked === true) {
      return null;
    }

    const page = pagesById.get(node.pageId as string);
    if (page?.archived) {
      return null;
    }

    return node;
  }, [paletteContextNodeId, pagesById, workspaceNodeMap]);
  const taskScheduleEffectiveDueRange = useMemo(
    () =>
      taskScheduleTargetNode
        ? getEffectiveTaskDueDateRange(taskScheduleTargetNode, workspaceNodeMap)
        : { dueAt: null, dueEndAt: null },
    [taskScheduleTargetNode, workspaceNodeMap],
  );
  const taskScheduleSummary = taskScheduleTargetNode
    ? getTaskScheduleSummary(taskScheduleTargetNode, taskScheduleEffectiveDueRange)
    : "";
  const insertOutlineClipboardNodes = useCallback(
    async ({
      nodes,
      pageId,
      parentNodeId,
      afterNodeId,
      focusAfterUndoId = null,
      focusAfterRedoId = null,
    }: {
      nodes: OutlineClipboardNode[];
      pageId: Id<"pages">;
      parentNodeId: Id<"nodes"> | null;
      afterNodeId: Id<"nodes"> | null;
      focusAfterUndoId?: string | null;
      focusAfterRedoId?: string | null;
    }) => {
      if (nodes.length === 0) {
        return {
          createdNodes: [] as Doc<"nodes">[],
          createdRootNodeIds: [] as Id<"nodes">[],
        };
      }

      const { entries, rootClientIds } = flattenOutlineClipboardNodesForBatch(nodes, {
        parentNodeId,
        afterNodeId,
      });
      const createdNodes = (await createNodesBatch({
        ownerKey,
        pageId,
        nodes: entries,
      })) as Doc<"nodes">[];
      const clientIdToNodeId = new Map<string, Id<"nodes">>();
      const createdSnapshots: CreatedNodeSnapshot[] = [];

      for (const [index, entry] of entries.entries()) {
        const createdNode = createdNodes[index] ?? null;
        if (!createdNode) {
          continue;
        }

        clientIdToNodeId.set(entry.clientId, createdNode._id);
        const resolvedAfterNodeId =
          entry.afterClientId
            ? (clientIdToNodeId.get(entry.afterClientId) ?? null)
            : (entry.afterNodeId ?? null);
        createdSnapshots.push(
          toCreatedNodeSnapshot(createdNode, resolvedAfterNodeId),
        );
      }

      if (createdSnapshots.length > 0) {
        history.pushUndoEntry({
          type: "create_nodes",
          pageId,
          nodes: createdSnapshots,
          focusAfterUndoId,
          focusAfterRedoId:
            focusAfterRedoId ??
            getNodeEditorId(createdSnapshots[createdSnapshots.length - 1]!.nodeId),
        });
      }

      return {
        createdNodes,
        createdRootNodeIds: rootClientIds
          .map((clientId) => clientIdToNodeId.get(clientId) ?? null)
          .filter((nodeId): nodeId is Id<"nodes"> => nodeId !== null),
      };
    },
    [createNodesBatch, history, ownerKey],
  );
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
    setCopySnackbarMessage("Copied node link");
  }, [selectedNodeIds, workspaceNodeMap]);
  const copySelectedNodesToClipboard = useCallback((event: ClipboardEvent) => {
    if (selectedNodeIds.size === 0 || isTextEntryElement(event.target) || !event.clipboardData) {
      return;
    }

    const selectedRootNodeIds = getSelectedRootNodeIds(
      selectedNodeIds,
      visibleNodeOrder,
      workspaceNodeMap,
    );
    if (selectedRootNodeIds.length === 0) {
      return;
    }

    const selectedRoots = selectedRootNodeIds
      .map((nodeId) => findTreeNodeById([...sidebarNodes, ...tree], nodeId))
      .filter((node): node is TreeNode => node !== null);
    if (selectedRoots.length === 0) {
      return;
    }

    const payload: OutlineClipboardPayload = {
      version: 1,
      nodes: selectedRoots.map((node) => serializeTreeNodeForClipboard(node)),
    };
    event.clipboardData.setData(
      OUTLINE_CLIPBOARD_MIME_TYPE,
      JSON.stringify(payload),
    );
    event.clipboardData.setData(
      "text/plain",
      buildOutlineClipboardText(payload.nodes),
    );
    setCopySnackbarMessage(
      `Copied ${selectedRoots.length} item${selectedRoots.length === 1 ? "" : "s"}`,
    );
    event.preventDefault();
  }, [selectedNodeIds, setCopySnackbarMessage, sidebarNodes, tree, visibleNodeOrder, workspaceNodeMap]);
  const pasteOutlineClipboardAfterSelection = useCallback(async (payload: OutlineClipboardPayload) => {
    if (selectedNodeIds.size === 0) {
      return;
    }

    const selectedRootNodeIds = getSelectedRootNodeIds(
      selectedNodeIds,
      visibleNodeOrder,
      workspaceNodeMap,
    );
    const anchorNodeId = selectedRootNodeIds[selectedRootNodeIds.length - 1] ?? null;
    if (!anchorNodeId) {
      return;
    }

    const anchorNode = workspaceNodeMap.get(anchorNodeId) ?? null;
    if (!anchorNode) {
      return;
    }

    const result = await insertOutlineClipboardNodes({
      nodes: payload.nodes,
      pageId: anchorNode.pageId,
      parentNodeId: (anchorNode.parentNodeId as Id<"nodes"> | null) ?? null,
      afterNodeId: anchorNode._id,
    });

    const createdRootNodeIds = result.createdRootNodeIds.map((nodeId) => nodeId as string);
    const firstCreatedRootNodeId = createdRootNodeIds[0] ?? null;
    if (createdRootNodeIds.length > 1) {
      setSelectedNodeIds(new Set(createdRootNodeIds));
      setDragSelection(null);
      setPendingRevealNodeId(firstCreatedRootNodeId);
    } else if (firstCreatedRootNodeId) {
      selectSingleNode(firstCreatedRootNodeId);
      setPendingRevealNodeId(firstCreatedRootNodeId);
    }
    setCopySnackbarMessage(
      `Pasted ${createdRootNodeIds.length} item${createdRootNodeIds.length === 1 ? "" : "s"}`,
    );
  }, [insertOutlineClipboardNodes, selectSingleNode, selectedNodeIds, visibleNodeOrder, workspaceNodeMap]);
  const executeNodeMoveBatch = useCallback(
    async (
      moves: Array<{
        nodeId: Id<"nodes">;
        pageId: Id<"pages">;
        parentNodeId: Id<"nodes"> | null;
        afterNodeId: Id<"nodes"> | null;
      }>,
    ) => {
      if (moves.length === 0) {
        return;
      }

      if (moves.length === 1) {
        const move = moves[0]!;
        await moveNode({
          ownerKey,
          nodeId: move.nodeId,
          pageId: move.pageId,
          parentNodeId: move.parentNodeId,
          afterNodeId: move.afterNodeId,
        });
        return;
      }

      await moveNodesBatch({
        ownerKey,
        moves,
      });
    },
    [moveNode, moveNodesBatch, ownerKey],
  );
  const executeNodeUpdateBatch = useCallback(
    async (
      updates: Array<{
        nodeId: Id<"nodes">;
        text?: string;
        kind?: "note" | "task";
        lockKind?: boolean;
        taskStatus?: NodeValueSnapshot["taskStatus"];
        noteCompleted?: boolean;
        dueAt?: number | null;
        dueEndAt?: number | null;
        recurrenceFrequency?: RecurrenceFrequency | null;
      }>,
    ) => {
      if (updates.length === 0) {
        return;
      }

      if (updates.length === 1) {
        const update = updates[0]!;
        await updateNode({
          ownerKey,
          ...update,
        });
        return;
      }

      await updateNodesBatch({
        ownerKey,
        updates,
      });
    },
    [ownerKey, updateNode, updateNodesBatch],
  );
  const executeNodeArchiveBatch = useCallback(
    async (
      nodeIds: Id<"nodes">[],
      archived: boolean,
    ) => {
      if (nodeIds.length === 0) {
        return;
      }

      if (nodeIds.length === 1) {
        await setNodeTreeArchived({
          ownerKey,
          nodeId: nodeIds[0]!,
          archived,
        });
        return;
      }

      await setNodeTreesArchivedBatch({
        ownerKey,
        nodeIds,
        archived,
      });
    },
    [ownerKey, setNodeTreeArchived, setNodeTreesArchivedBatch],
  );
  const canImportScreenshotWithoutSelection =
    (
      pageMeta.pageType === "default" ||
      pageMeta.pageType === "note" ||
      pageMeta.pageType === "task" ||
      pageMeta.pageType === "planner"
    ) &&
    selectedPageId !== null;
  const handleImportScreenshotNodes = useCallback(async (nodes: ScreenshotImportNode[]) => {
    const outlineNodes: OutlineClipboardNode[] = nodes.map((node) => ({
      text: node.text,
      kind: node.kind,
      taskStatus: node.kind === "task" ? node.taskStatus : null,
      noteCompleted: node.kind === "note" ? node.noteCompleted : false,
      lockKind: true,
      children: node.children.map(function mapChild(child): OutlineClipboardNode {
        return {
          text: child.text,
          kind: child.kind,
          taskStatus: child.kind === "task" ? child.taskStatus : null,
          noteCompleted: child.kind === "note" ? child.noteCompleted : false,
          lockKind: true,
          children: child.children.map(mapChild),
        };
      }),
    }));
    if (outlineNodes.length === 0) {
      return;
    }

    let createdRootNodeIds: Id<"nodes">[] = [];
    if (selectedNodeIds.size > 0) {
      const selectedRootNodeIds = getSelectedRootNodeIds(
        selectedNodeIds,
        visibleNodeOrder,
        workspaceNodeMap,
      );
      const anchorNodeId = selectedRootNodeIds[selectedRootNodeIds.length - 1] ?? null;
      const anchorNode = anchorNodeId ? (workspaceNodeMap.get(anchorNodeId) ?? null) : null;
      if (!anchorNode) {
        throw new Error("Could not find the selected insertion point.");
      }

      const result = await insertOutlineClipboardNodes({
        nodes: outlineNodes,
        pageId: anchorNode.pageId,
        parentNodeId: (anchorNode.parentNodeId as Id<"nodes"> | null) ?? null,
        afterNodeId: anchorNode._id,
      });
      createdRootNodeIds = result.createdRootNodeIds;
    } else if (canImportScreenshotWithoutSelection && selectedPageId) {
      const anchorNode = pageVisibleRows[pageVisibleRows.length - 1] ?? null;
      const result = await insertOutlineClipboardNodes({
        nodes: outlineNodes,
        pageId: selectedPageId,
        parentNodeId: anchorNode
          ? ((anchorNode.parentNodeId as Id<"nodes"> | null) ?? null)
          : null,
        afterNodeId: anchorNode ? (anchorNode._id as Id<"nodes">) : null,
      });
      createdRootNodeIds = result.createdRootNodeIds;
    } else {
      throw new Error("Highlight a target item first so the imported outline knows where to go.");
    }

    const firstCreatedRootNodeId = createdRootNodeIds[0] ?? null;
    if (firstCreatedRootNodeId) {
      selectSingleNode(firstCreatedRootNodeId);
    }

    setCopySnackbarMessage(
      `Imported ${countNodesInClipboardPayload(outlineNodes)} node${countNodesInClipboardPayload(outlineNodes) === 1 ? "" : "s"}`,
    );
  }, [
    canImportScreenshotWithoutSelection,
    insertOutlineClipboardNodes,
    pageVisibleRows,
    selectSingleNode,
    selectedNodeIds,
    selectedPageId,
    setCopySnackbarMessage,
    visibleNodeOrder,
    workspaceNodeMap,
  ]);
  const handleImportTextNodes = useCallback(
    async ({
      pageId,
      pageTitle,
      afterNodeId,
      nodes,
    }: {
      pageId: Id<"pages">;
      pageTitle: string;
      afterNodeId: Id<"nodes"> | null;
      nodes: ImportedOutlineNode[];
    }) => {
      const outlineNodes = importedNodesToClipboardNodes(nodes);
      const result = await insertOutlineClipboardNodes({
        nodes: outlineNodes,
        pageId,
        parentNodeId: null,
        afterNodeId,
      });

      const firstCreatedRootNodeId = result.createdRootNodeIds[0] ?? null;
      setSelectedPageId(pageId);
      setLocationPageId(pageId);
      writePageIdToHistory(pageId, "push", pageTitle);
      clearNodeSelection();
      if (firstCreatedRootNodeId) {
        setPendingRevealNodeId(firstCreatedRootNodeId as string);
      }

      const importedNodeCount = countNodesInClipboardPayload(outlineNodes);
      setCopySnackbarMessage(
        `Imported ${importedNodeCount} item${importedNodeCount === 1 ? "" : "s"} to ${pageTitle}`,
      );
    },
    [
      clearNodeSelection,
      insertOutlineClipboardNodes,
      setCopySnackbarMessage,
      setLocationPageId,
      setSelectedPageId,
    ],
  );
  const canImportScreenshot = selectedNodeIds.size > 0 || canImportScreenshotWithoutSelection;
  const screenshotImportTargetLabel =
    selectedNodeIds.size > 0
      ? "the selected location"
      : selectedPage
        ? `the end of ${selectedPage.title}`
        : "your workspace";
  const paletteResults = filterPagesForCommandPalette(
    (pages ?? []).map((page) => ({
      ...page,
      searchTerms: [
        getPageTypeLabel(page),
        getPageMeta(page).sidebarSection,
      ],
    })),
    paletteQuery,
    14,
  );
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

    setIsSidebarCollapsed(readStoredBoolean(SIDEBAR_COLLAPSE_STORAGE_KEY, false));
    setIsUncategorizedSectionCollapsed(
      readStoredBoolean(UNCATEGORIZED_SECTION_COLLAPSE_STORAGE_KEY, true),
    );
    setIsJournalSectionCollapsed(
      readStoredBoolean(JOURNAL_SECTION_COLLAPSE_STORAGE_KEY, true),
    );
    setIsTagsSectionCollapsed(
      readStoredBoolean(TAGS_SECTION_COLLAPSE_STORAGE_KEY, true),
    );
    setIsArchiveSectionCollapsed(
      readStoredBoolean(ARCHIVE_SECTION_COLLAPSE_STORAGE_KEY, true),
    );
    setRecurringCompletionMode(
      readStoredRecurringCompletionMode("dueDate"),
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
      UNCATEGORIZED_SECTION_COLLAPSE_STORAGE_KEY,
      isUncategorizedSectionCollapsed ? "true" : "false",
    );
  }, [isUncategorizedSectionCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      JOURNAL_SECTION_COLLAPSE_STORAGE_KEY,
      isJournalSectionCollapsed ? "true" : "false",
    );
  }, [isJournalSectionCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      TAGS_SECTION_COLLAPSE_STORAGE_KEY,
      isTagsSectionCollapsed ? "true" : "false",
    );
  }, [isTagsSectionCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      ARCHIVE_SECTION_COLLAPSE_STORAGE_KEY,
      isArchiveSectionCollapsed ? "true" : "false",
    );
  }, [isArchiveSectionCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      RECURRING_TASK_COMPLETION_MODE_STORAGE_KEY,
      recurringCompletionMode,
    );
  }, [recurringCompletionMode]);

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
    if (paletteOpen) {
      return;
    }

    setActionContextNodeId(null);
  }, [paletteOpen]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;

    if (paletteOpen) {
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
    }

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [paletteOpen]);

  useEffect(() => {
    if (!plannerNextTaskSuggestion) {
      return;
    }

    const handleDismissNextTaskSuggestion = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPlannerNextTaskSuggestion(null);
      }
    };

    window.addEventListener("keydown", handleDismissNextTaskSuggestion);
    return () => {
      window.removeEventListener("keydown", handleDismissNextTaskSuggestion);
    };
  }, [plannerNextTaskSuggestion]);

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
    if (!ownerKey || !isOwnerKeyValid || !selectedPage || pageMeta.pageType !== "planner") {
      return;
    }

    if (plannerSidebarSection && plannerTemplateSection) {
      hasRequestedPlannerSections.current.delete(selectedPage._id as string);
      return;
    }

    const pageId = selectedPage._id as string;
    if (hasRequestedPlannerSections.current.has(pageId)) {
      return;
    }

    hasRequestedPlannerSections.current.add(pageId);
    void ensurePlannerPageSections({
      ownerKey,
      pageId: selectedPage._id,
    }).catch(() => {
      hasRequestedPlannerSections.current.delete(pageId);
    });
  }, [
    ensurePlannerPageSections,
    isOwnerKeyValid,
    ownerKey,
    pageMeta.pageType,
    plannerSidebarSection,
    plannerTemplateSection,
    selectedPage,
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
      writePageIdToHistory(null, "replace", null);
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
        writePageIdToHistory(matchingStoredPage._id, "replace", matchingStoredPage.title);
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
      writePageIdToHistory(null, "replace", null);
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
    if (typeof window === "undefined") {
      return;
    }

    const nextPageTitle =
      selectedPage?.title ??
      (selectedPageId ? pagesById.get(selectedPageId as string)?.title ?? null : null);
    const nextDocumentTitle = getDocumentTitle(nextPageTitle);

    if (document.title !== nextDocumentTitle) {
      document.title = nextDocumentTitle;
    }

    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.replaceState(window.history.state, nextDocumentTitle, currentUrl);
  }, [pagesById, selectedPage?.title, selectedPageId]);

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

  const handleRebuildEmbeddings = useCallback(async () => {
    setIsRebuildingEmbeddings(true);
    setEmbeddingRebuildStatus("");
    try {
      const result = (await rebuildEmbeddings({
        ownerKey,
      })) as {
        started?: boolean;
        batchSize?: number;
      };
      setEmbeddingRebuildStatus(
        result.started
          ? `Started rebuilding embeddings in background batches${result.batchSize ? ` of ${result.batchSize}` : ""}. Skipped nodes like --- and . will be cleaned up as the rebuild runs.`
          : "Started rebuilding embeddings in the background.",
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not start an embedding rebuild right now.";
      setEmbeddingRebuildStatus(
        message.includes("Server Error")
          ? "Could not start the embedding rebuild because the backend hit an internal limit. The rebuild now runs in batches, so try again once after refreshing. If it still fails, send me the request id shown in the error."
          : message,
      );
    } finally {
      setIsRebuildingEmbeddings(false);
    }
  }, [ownerKey, rebuildEmbeddings]);

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
    window.localStorage.removeItem(UNCATEGORIZED_SECTION_COLLAPSE_STORAGE_KEY);
    window.localStorage.removeItem(TAGS_SECTION_COLLAPSE_STORAGE_KEY);
    window.localStorage.removeItem(ARCHIVE_SECTION_COLLAPSE_STORAGE_KEY);
    window.localStorage.removeItem(COLLAPSED_NODES_STORAGE_KEY);
    window.localStorage.removeItem(RECURRING_TASK_COMPLETION_MODE_STORAGE_KEY);
    setSelectedPageId(null);
    setLocationPageId(null);
    writePageIdToHistory(null, "replace", null);
    setOwnerKey("");
    window.location.reload();
  }, [setOwnerKey]);

  const handleCreatePage = useCallback(async (section: SidebarSection) => {
    setIsCreatingPage(section);
    try {
      const pageType: PageType =
        section === "Models"
          ? "model"
          : section === "Tasks"
            ? "task"
          : section === "Notes"
            ? "note"
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
      setLocationPageId(pageId);
      writePageIdToHistory(pageId, "push", title);
      setPendingRevealNodeId(null);
      setPaletteOpen(false);
      setPaletteQuery("");
      setPaletteHighlightIndex(0);
      setPaletteMode("pages");
      setTextSearchResults([]);
      setNodeSearchResults([]);
      clearNodeSelection();
    } finally {
      setIsCreatingPage(null);
    }
  }, [clearNodeSelection, createPage, ownerKey]);

  const handleCreatePlannerPage = useCallback(async () => {
    setIsCreatingPlannerPage(true);
    try {
      const title = "Untitled Planner";
      const pageId = await createPage({
        ownerKey,
        title,
        sidebarSection: "Tasks",
        pageType: "planner",
      });
      setSelectedPageId(pageId);
      setLocationPageId(pageId);
      writePageIdToHistory(pageId, "push", title);
      setPendingRevealNodeId(null);
      setPaletteOpen(false);
      setPaletteQuery("");
      setPaletteHighlightIndex(0);
      setPaletteMode("pages");
      setTextSearchResults([]);
      setNodeSearchResults([]);
      clearNodeSelection();
    } finally {
      setIsCreatingPlannerPage(false);
    }
  }, [clearNodeSelection, createPage, ownerKey]);

  const handleSaveTaskSchedule = useCallback(async ({
    dueAt,
    dueEndAt,
    recurrenceFrequency,
  }: {
    dueAt: number | null;
    dueEndAt: number | null;
    recurrenceFrequency: RecurrenceFrequency;
  }) => {
    const node = taskScheduleTargetNode;
    if (!node) {
      throw new Error("Pick a task first.");
    }

    const beforeSnapshot = toNodeValueSnapshot(node);
    const afterSnapshot = withNodeScheduleSnapshot(
      {
        text: node.text,
        kind: "task",
        taskStatus: (node.taskStatus ?? "todo") as NodeValueSnapshot["taskStatus"],
        noteCompleted: false,
        dueAt,
        dueEndAt,
        recurrenceFrequency,
      },
      node,
    );

    if (
      beforeSnapshot.text === afterSnapshot.text &&
      beforeSnapshot.kind === afterSnapshot.kind &&
      beforeSnapshot.taskStatus === afterSnapshot.taskStatus &&
      beforeSnapshot.noteCompleted === afterSnapshot.noteCompleted &&
      beforeSnapshot.dueAt === afterSnapshot.dueAt &&
      beforeSnapshot.dueEndAt === afterSnapshot.dueEndAt &&
      areRecurrenceFrequenciesEqual(
        beforeSnapshot.recurrenceFrequency ?? null,
        afterSnapshot.recurrenceFrequency ?? null,
      )
    ) {
      return;
    }

    await updateNode({
      ownerKey,
      nodeId: node._id,
      text: afterSnapshot.text,
      kind: "task",
      taskStatus: afterSnapshot.taskStatus,
      noteCompleted: false,
      dueAt: afterSnapshot.dueAt,
      dueEndAt: afterSnapshot.dueEndAt,
      recurrenceFrequency: afterSnapshot.recurrenceFrequency,
    });

    history.pushUndoEntry({
      type: "update_node",
      pageId: node.pageId as Id<"pages">,
      nodeId: node._id as Id<"nodes">,
      before: beforeSnapshot,
      after: afterSnapshot,
      focusEditorId: getNodeEditorId(node._id as Id<"nodes">),
    });
  }, [history, ownerKey, taskScheduleTargetNode, updateNode]);

  const actionResults = useMemo(() => {
    const results: ActionPaletteResult[] = [
      ...SIDEBAR_SECTIONS.map((section) => {
        const title = getPageTypeLabelForSection(section);
        const singular =
          section === "Scratchpads" ? "scratchpad" : section.toLowerCase().replace(/s$/, "");
        return {
          key: `new-${section.toLowerCase()}`,
          title: `New ${title}`,
          subtitle: `Create a new ${title.toLowerCase()} page.`,
          keywords: ["new", "create", title.toLowerCase(), section.toLowerCase(), singular, "page"],
          actionLabel: isCreatingPage === section ? "Creating…" : "Create",
          disabled: isCreatingPage === section,
          onSelect: () => void handleCreatePage(section),
        } satisfies ActionPaletteResult;
      }),
      {
        key: "new-planner",
        title: "New Planner",
        subtitle: "Create a new planner page with a sidebar and weekly template.",
        keywords: ["new", "create", "planner", "plan", "page"],
        actionLabel: isCreatingPlannerPage ? "Creating…" : "Create",
        disabled: isCreatingPlannerPage,
        onSelect: () => void handleCreatePlannerPage(),
      },
      {
        key: "find-replace",
        title: "Find & Replace",
        subtitle: selectedPage
          ? "Preview and replace exact text in the current page or across the active workspace."
          : "Preview and replace exact text across the active workspace.",
        keywords: ["find", "replace", "local", "global", "page", "workspace", "text"],
        actionLabel: "Open",
        onSelect: () => {
          switchPaletteMode("replace");
        },
      },
      {
        key: "task-schedule",
        title: "Set Task Schedule",
        subtitle: taskScheduleTargetNode
          ? taskScheduleSummary
            ? `${taskScheduleTargetNode.text || "(empty task)"} • ${taskScheduleSummary}`
            : `Add a due date or recurrence to ${taskScheduleTargetNode.text || "this task"}.`
          : "Highlight a task, or open Actions while your caret is inside a task.",
        keywords: ["task", "schedule", "due", "date", "repeat", "recurring", "overdue"],
        actionLabel: "Open",
        disabled: taskScheduleTargetNode === null,
        onSelect: () => {
          openTaskSchedulePalette(taskScheduleTargetNode?._id as string | null);
        },
      },
      {
        key: "migration",
        title: "Import From App",
        subtitle: "Snapshot Dynalist, WorkFlowy, or Logseq and review chunk-by-chunk changes before applying them.",
        keywords: ["migration", "import", "app", "dynalist", "workflowy", "logseq", "archive"],
        actionLabel: "Open",
        onSelect: () => {
          switchPaletteMode("migration");
        },
      },
      {
        key: "import-text",
        title: "Import From Text",
        subtitle: "Paste text, normalize Dynalist-style content, preview the parsed nodes, and import them into a chosen page.",
        keywords: [
          "import",
          "text import",
          "paste",
          "text",
          "dynalist",
          "links",
          "due",
          "recurring",
          "recurrence",
          "schedule",
        ],
        actionLabel: "Open",
        onSelect: () => {
          switchPaletteMode("importer");
        },
      },
      {
        key: "import-screenshot",
        title: "Import Screenshot",
        subtitle: canImportScreenshot
          ? "Paste an outliner screenshot, preview the translated hierarchy, and import it into the current workspace."
          : "Paste an outliner screenshot and preview it. Open a page or highlight a target item before importing.",
        keywords: ["import", "screenshot", "image", "ocr", "outline", "paste"],
        actionLabel: "Open",
        onSelect: () => {
          switchPaletteMode("screenshotImport");
        },
      },
      {
        key: "search-archive",
        title: "Search Archive",
        subtitle: "Search archived pages and nodes without mixing them into active workspace results.",
        keywords: ["archive", "search", "find", "semantic", "archived"],
        actionLabel: "Open",
        onSelect: () => {
          switchPaletteMode("archive");
        },
      },
      {
        key: "rebuild-embeddings",
        title: isRebuildingEmbeddings ? "Rebuilding Embeddings…" : "Rebuild Embeddings",
        subtitle: embeddingRebuildStatus || embeddingProgressLabel,
        keywords: ["rebuild", "embeddings", "refresh", "vectors", "knowledge"],
        actionLabel: isRebuildingEmbeddings ? "Running…" : "Run",
        disabled: isRebuildingEmbeddings,
        onSelect: () => {
          void handleRebuildEmbeddings();
        },
      },
      {
        key: "reset-local-state",
        title: "Reset Local State",
        subtitle: "Clear saved browser state for this site and reload.",
        keywords: ["reset", "local", "state", "reload", "cache", "storage"],
        actionLabel: "Reset",
        onSelect: handleResetLocalState,
      },
      {
        key: "lock-workspace",
        title: "Lock Workspace",
        subtitle: "Clear the owner token and return to the lock screen.",
        keywords: ["lock", "logout", "owner", "token", "workspace"],
        actionLabel: "Lock",
        onSelect: () => {
          setOwnerKey("");
          setPaletteOpen(false);
        },
      },
    ];

    const normalizedQuery = paletteQuery.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return results;
    }

    return results.filter((result) =>
      [result.title, result.subtitle, ...result.keywords].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
    );
  }, [
    embeddingProgressLabel,
    embeddingRebuildStatus,
    handleCreatePage,
    handleCreatePlannerPage,
    handleRebuildEmbeddings,
    handleResetLocalState,
    isCreatingPage,
    isCreatingPlannerPage,
    isRebuildingEmbeddings,
    canImportScreenshot,
    openTaskSchedulePalette,
    paletteQuery,
    setOwnerKey,
    switchPaletteMode,
    taskScheduleSummary,
    taskScheduleTargetNode,
    selectedPage,
  ]);

  const activePaletteResultsCount =
    paletteMode === "pages"
      ? paletteResults.length
      : paletteMode === "find"
        ? textSearchResults.length
      : paletteMode === "nodes"
        ? nodeSearchResults.length
        : paletteMode === "actions"
            ? actionResults.length
            : 0;

  useEffect(() => {
    if (!copySnackbarMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopySnackbarMessage("");
    }, 1800);

    return () => window.clearTimeout(timeoutId);
  }, [copySnackbarMessage]);

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

  const setExplicitSelectedNodeIds = useCallback((nodeIds: string[]) => {
    setSelectedNodeIds(new Set(nodeIds));
    setDragSelection(null);
  }, []);

  const buildDraggedNodePayload = useCallback<BuildDraggedNodePayloadFn>(
    ({ nodeId, pageId }) => {
      const selectedRootNodeIds = getSelectedRootNodeIds(
        selectedNodeIds,
        visibleNodeOrder,
        workspaceNodeMap,
      ).filter((selectedRootNodeId) => {
        const selectedNode = workspaceNodeMap.get(selectedRootNodeId);
        if (!selectedNode || selectedNode.pageId !== pageId) {
          return false;
        }

        if (getNodeMeta(selectedNode).locked === true) {
          return false;
        }

        const selectedPage = pagesById.get(selectedNode.pageId as string);
        return !selectedPage?.archived;
      });

      const rootNodeIds =
        selectedNodeIds.has(nodeId) && selectedRootNodeIds.includes(nodeId)
          ? selectedRootNodeIds
          : [nodeId];

      return {
        nodeId,
        pageId,
        rootNodeIds: [...new Set(rootNodeIds)],
      };
    },
    [pagesById, selectedNodeIds, visibleNodeOrder, workspaceNodeMap],
  );

  const dropDraggedNodes = useCallback<DropDraggedNodesFn>(
    async (payload, dropTarget) => {
      const requestedRootNodeIds =
        payload.rootNodeIds.length > 0 ? payload.rootNodeIds : [payload.nodeId];
      const rootNodeContexts = [...new Set(requestedRootNodeIds)]
        .map((nodeId) => findNodeContext(sidebarNodes, tree, nodeId))
        .filter(
          (
            context,
          ): context is NonNullable<ReturnType<typeof findNodeContext>> => context !== null,
        )
        .filter((context) => {
          if (context.pageId !== payload.pageId) {
            return false;
          }

          if (getNodeMeta(context.node).locked === true) {
            return false;
          }

          const page = pagesById.get(context.node.pageId as string);
          return !page?.archived;
        });

      if (rootNodeContexts.length === 0) {
        return;
      }

      const targetPageId = payload.pageId as Id<"pages">;
      const targetParentNodeId = dropTarget.parentNodeId;
      const targetAfterNodeId = dropTarget.afterNodeId;
      const rootNodeIds = rootNodeContexts.map((context) => context.node._id as string);
      const historyEntries: Array<Extract<HistoryEntry, { type: "move_node" }>> = [];

      const desiredPlacements = rootNodeContexts.map((context, index) =>
        buildNodePlacement(
          targetPageId,
          targetParentNodeId,
          index === 0
            ? targetAfterNodeId
            : (rootNodeContexts[index - 1]!.node._id as Id<"nodes">),
        ),
      );

      const isNoOp = rootNodeContexts.every((context, index) =>
        arePlacementsEqual(
          buildNodePlacement(
            context.pageId,
            context.parentNodeId,
            (context.previousSibling?._id as Id<"nodes"> | undefined) ?? null,
          ),
          desiredPlacements[index]!,
        ),
      );
      if (isNoOp) {
        return;
      }

      const moves = rootNodeContexts.map((context, index) => {
        const beforePlacement = buildNodePlacement(
          context.pageId,
          context.parentNodeId,
          (context.previousSibling?._id as Id<"nodes"> | undefined) ?? null,
        );
        const afterPlacement = desiredPlacements[index]!;

        historyEntries.push({
          type: "move_node",
          pageId: context.pageId,
          nodeId: context.node._id as Id<"nodes">,
          beforePlacement,
          afterPlacement,
          focusEditorId: getNodeEditorId(context.node._id as Id<"nodes">),
        });
        return {
          nodeId: context.node._id as Id<"nodes">,
          pageId: afterPlacement.pageId,
          parentNodeId: afterPlacement.parentNodeId,
          afterNodeId: afterPlacement.afterNodeId,
        };
      });

      await executeNodeMoveBatch(moves);

      if (historyEntries.length === 1) {
        history.pushUndoEntry(historyEntries[0]!);
        selectSingleNode(rootNodeIds[0]!);
        window.setTimeout(() => {
          const target = document.querySelector<HTMLElement>(
            `[data-node-id="${rootNodeIds[0]!}"] textarea`,
          );
          focusElementAtEnd(target as HTMLTextAreaElement | null);
        }, 0);
        return;
      }

      history.pushUndoEntry({
        type: "compound",
        pageId: historyEntries[0]!.pageId,
        entries: historyEntries,
        focusAfterUndoId: historyEntries[0]!.focusEditorId,
        focusAfterRedoId: historyEntries[historyEntries.length - 1]!.focusEditorId,
      });
      setExplicitSelectedNodeIds(rootNodeIds);
    },
    [executeNodeMoveBatch, history, pagesById, selectSingleNode, setExplicitSelectedNodeIds, sidebarNodes, tree],
  );

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
      if (selectedNodeIds.size === 0) {
        return;
      }

      const selectedRootNodeIds = getSelectedRootNodeIds(
        selectedNodeIds,
        visibleNodeOrder,
        workspaceNodeMap,
      );
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

      if (contexts.length !== selectedRootNodeIds.length) {
        return;
      }

      const firstContext = contexts[0]!;
      const lastContext = contexts[contexts.length - 1]!;
      const sharedPageId = firstContext.pageId;
      const sharedParentNodeId = firstContext.parentNodeId;
      const allContextsShareContainer = contexts.every(
        (context) =>
          context.pageId === sharedPageId && context.parentNodeId === sharedParentNodeId,
      );
      if (!allContextsShareContainer) {
        return;
      }

      const selectedSpanLength =
        lastContext.siblingIndex - firstContext.siblingIndex + 1;
      if (selectedSpanLength !== contexts.length) {
        return;
      }

      const historyEntries: Array<Extract<HistoryEntry, { type: "move_node" }>> = [];

      if (direction === -1) {
        if (firstContext.siblingIndex === 0) {
          return;
        }

        let nextAfterNodeId =
          firstContext.siblingIndex > 1
            ? ((firstContext.siblings[firstContext.siblingIndex - 2]?._id as
                | Id<"nodes">
                | undefined) ?? null)
            : null;

        const moves = contexts.map((context) => {
          const beforePlacement = buildNodePlacement(
            context.pageId,
            context.parentNodeId,
            (context.previousSibling?._id as Id<"nodes"> | undefined) ?? null,
          );
          const afterPlacement = buildNodePlacement(
            context.pageId,
            context.parentNodeId,
            nextAfterNodeId,
          );

          historyEntries.push({
            type: "move_node",
            pageId: context.pageId,
            nodeId: context.node._id as Id<"nodes">,
            beforePlacement,
            afterPlacement,
            focusEditorId: getNodeEditorId(context.node._id as Id<"nodes">),
          });

          const move = {
            nodeId: context.node._id as Id<"nodes">,
            pageId: context.pageId,
            parentNodeId: context.parentNodeId,
            afterNodeId: nextAfterNodeId,
          };
          nextAfterNodeId = context.node._id as Id<"nodes">;
          return move;
        });

        await executeNodeMoveBatch(moves);
      } else {
        const nextSibling = lastContext.siblings[lastContext.siblingIndex + 1];
        if (!nextSibling) {
          return;
        }

        const afterNodeId = nextSibling._id as Id<"nodes">;

        const moves = [...contexts].reverse().map((context) => {
          const beforePlacement = buildNodePlacement(
            context.pageId,
            context.parentNodeId,
            (context.previousSibling?._id as Id<"nodes"> | undefined) ?? null,
          );
          const afterPlacement = buildNodePlacement(
            context.pageId,
            context.parentNodeId,
            afterNodeId,
          );

          historyEntries.push({
            type: "move_node",
            pageId: context.pageId,
            nodeId: context.node._id as Id<"nodes">,
            beforePlacement,
            afterPlacement,
            focusEditorId: getNodeEditorId(context.node._id as Id<"nodes">),
          });
          return {
            nodeId: context.node._id as Id<"nodes">,
            pageId: context.pageId,
            parentNodeId: context.parentNodeId,
            afterNodeId,
          };
        });

        await executeNodeMoveBatch(moves);
      }

      if (historyEntries.length === 0) {
        return;
      }

      if (historyEntries.length === 1) {
        history.pushUndoEntry(historyEntries[0]!);
        selectSingleNode(historyEntries[0]!.nodeId as string);
        return;
      }

      history.pushUndoEntry({
        type: "compound",
        pageId: sharedPageId,
        entries: historyEntries,
        focusAfterUndoId: getNodeEditorId(historyEntries[0]!.nodeId),
        focusAfterRedoId: getNodeEditorId(
          historyEntries[historyEntries.length - 1]!.nodeId,
        ),
      });
      setDragSelection(null);
    },
    [
      history,
      executeNodeMoveBatch,
      pagesById,
      selectSingleNode,
      selectedNodeIds,
      setDragSelection,
      sidebarNodes,
      tree,
      visibleNodeOrder,
      workspaceNodeMap,
    ],
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

        const moves = contexts.map((context) => {
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

          historyEntries.push({
            type: "move_node",
            pageId: context.pageId,
            nodeId: context.node._id as Id<"nodes">,
            beforePlacement,
            afterPlacement,
            focusEditorId: getNodeEditorId(context.node._id as Id<"nodes">),
          });

          const move = {
            nodeId: context.node._id as Id<"nodes">,
            pageId: context.pageId,
            parentNodeId: targetParentNodeId,
            afterNodeId: nextAfterNodeId,
          };
          nextAfterNodeId = context.node._id as Id<"nodes">;
          return move;
        });

        await executeNodeMoveBatch(moves);
      } else {
        if (!firstContext.previousSibling) {
          return;
        }

        let nextAfterNodeId = getLastChildNodeId(firstContext.previousSibling);
        const targetParentNodeId = firstContext.previousSibling._id as Id<"nodes">;

        const moves = contexts.map((context) => {
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

          historyEntries.push({
            type: "move_node",
            pageId: context.pageId,
            nodeId: context.node._id as Id<"nodes">,
            beforePlacement,
            afterPlacement,
            focusEditorId: getNodeEditorId(context.node._id as Id<"nodes">),
          });

          const move = {
            nodeId: context.node._id as Id<"nodes">,
            pageId: context.pageId,
            parentNodeId: targetParentNodeId,
            afterNodeId: nextAfterNodeId,
          };
          nextAfterNodeId = context.node._id as Id<"nodes">;
          return move;
        });

        await executeNodeMoveBatch(moves);
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
      executeNodeMoveBatch,
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
    if (selectedNodeIds.size === 0) {
      return;
    }

    const orderedSelectedNodeIds = visibleNodeOrder.filter((nodeId) =>
      selectedNodeIds.has(nodeId),
    );
    if (orderedSelectedNodeIds.length === 0) {
      return;
    }

    const historyEntries: Array<Extract<HistoryEntry, { type: "update_node" }>> = [];
    let completedPlannerLinkedTask = false;
    const updates: Array<{
      nodeId: Id<"nodes">;
      text: string;
      kind: "note" | "task";
      lockKind: boolean;
      taskStatus: NodeValueSnapshot["taskStatus"];
      noteCompleted: boolean;
      dueAt: number | null;
      dueEndAt: number | null;
      recurrenceFrequency: RecurrenceFrequency | null;
    }> = [];

    for (const nodeId of orderedSelectedNodeIds) {
      const node = workspaceNodeMap.get(nodeId);
      if (!node || getNodeMeta(node).locked === true) {
        continue;
      }

      const page = pagesById.get(node.pageId as string);
      if (page?.archived) {
        continue;
      }

      if (isPlannerDayTask(node, workspaceNodeMap)) {
        await completePlannerTask({
          ownerKey,
          plannerNodeId: node._id as Id<"nodes">,
          completionMode: recurringCompletionMode,
        });
        completedPlannerLinkedTask = true;
        continue;
      }

      const beforeSnapshot = toNodeValueSnapshot(node);
      const afterSnapshot: NodeValueSnapshot =
        node.kind === "task"
          ? withNodeScheduleSnapshot({
              text: node.text,
              kind: "note",
              taskStatus: null,
              noteCompleted: false,
              dueAt: null,
              dueEndAt: null,
              recurrenceFrequency: null,
            }, node)
          : withNodeScheduleSnapshot({
              text: node.text,
              kind: "task",
              taskStatus: "todo",
              noteCompleted: false,
              dueAt: null,
              dueEndAt: null,
              recurrenceFrequency: null,
            }, node);

      updates.push({
        nodeId: node._id as Id<"nodes">,
        text: afterSnapshot.text,
        kind: afterSnapshot.kind,
        lockKind: true,
        taskStatus: afterSnapshot.taskStatus,
        noteCompleted: false,
        dueAt: afterSnapshot.dueAt ?? null,
        dueEndAt: afterSnapshot.dueEndAt ?? null,
        recurrenceFrequency: afterSnapshot.recurrenceFrequency ?? null,
      });

      historyEntries.push({
        type: "update_node",
        pageId: node.pageId as Id<"pages">,
        nodeId: node._id as Id<"nodes">,
        before: beforeSnapshot,
        after: afterSnapshot,
        focusEditorId: getNodeEditorId(node._id as Id<"nodes">),
      });
    }

    await executeNodeUpdateBatch(updates);

    if (historyEntries.length === 0) {
      if (completedPlannerLinkedTask) {
        clearNodeSelection();
      }
      return;
    }

    if (historyEntries.length === 1) {
      history.pushUndoEntry(historyEntries[0]!);
      return;
    }

    history.pushUndoEntry({
      type: "compound",
      pageId: historyEntries[0]!.pageId,
      entries: historyEntries,
      focusAfterUndoId: historyEntries[0]!.focusEditorId,
      focusAfterRedoId: historyEntries[historyEntries.length - 1]!.focusEditorId,
    });
  }, [clearNodeSelection, completePlannerTask, executeNodeUpdateBatch, history, ownerKey, pagesById, recurringCompletionMode, selectedNodeIds, visibleNodeOrder, workspaceNodeMap]);

  const toggleHighlightedNodeCompletion = useCallback(async () => {
    if (selectedNodeIds.size === 0) {
      return;
    }

    const orderedSelectedNodeIds = visibleNodeOrder.filter((nodeId) =>
      selectedNodeIds.has(nodeId),
    );
    if (orderedSelectedNodeIds.length === 0) {
      return;
    }

    const historyEntries: Array<Extract<HistoryEntry, { type: "update_node" }>> = [];
    const updates: Array<{
      nodeId: Id<"nodes">;
      text: string;
      kind: "note" | "task";
      lockKind: boolean;
      taskStatus: NodeValueSnapshot["taskStatus"];
      noteCompleted: boolean;
      dueAt: number | null;
      dueEndAt: number | null;
      recurrenceFrequency: RecurrenceFrequency | null;
    }> = [];

    for (const nodeId of orderedSelectedNodeIds) {
      const node = workspaceNodeMap.get(nodeId);
      if (!node || getNodeMeta(node).locked === true) {
        continue;
      }

      const page = pagesById.get(node.pageId as string);
      if (page?.archived) {
        continue;
      }

      if (isPlannerDayTask(node, workspaceNodeMap)) {
        await completePlannerTask({
          ownerKey,
          plannerNodeId: node._id as Id<"nodes">,
          completionMode: recurringCompletionMode,
        });
        clearNodeSelection();
        continue;
      }

      if (
        node.kind === "note" &&
        !isNodeNoteCompleted(node) &&
        isPlannerDayItem(node, workspaceNodeMap)
      ) {
        await completePlannerTask({
          ownerKey,
          plannerNodeId: node._id as Id<"nodes">,
          completionMode: recurringCompletionMode,
        });
        clearNodeSelection();
        continue;
      }

      const beforeSnapshot = toNodeValueSnapshot(node);
      const afterSnapshot: NodeValueSnapshot =
        node.kind === "task"
          ? (getRecurringCompletionTransition(node, recurringCompletionMode) ??
            withNodeScheduleSnapshot({
              text: node.text,
              kind: "task",
              taskStatus: node.taskStatus === "done" ? "todo" : "done",
              noteCompleted: false,
              dueAt: node.dueAt ?? null,
              dueEndAt: node.dueEndAt ?? null,
              recurrenceFrequency: getNodeRecurrenceFrequency(node),
            }, node))
          : withNodeScheduleSnapshot({
              text: node.text,
              kind: "note",
              taskStatus: null,
              noteCompleted: !isNodeNoteCompleted(node),
              dueAt: null,
              dueEndAt: null,
              recurrenceFrequency: null,
            }, node);

      updates.push({
        nodeId: node._id as Id<"nodes">,
        text: afterSnapshot.text,
        kind: afterSnapshot.kind,
        lockKind: true,
        taskStatus: afterSnapshot.taskStatus,
        noteCompleted: afterSnapshot.noteCompleted,
        dueAt: afterSnapshot.dueAt ?? null,
        dueEndAt: afterSnapshot.dueEndAt ?? null,
        recurrenceFrequency: afterSnapshot.recurrenceFrequency ?? null,
      });

      historyEntries.push({
        type: "update_node",
        pageId: node.pageId as Id<"pages">,
        nodeId: node._id as Id<"nodes">,
        before: beforeSnapshot,
        after: afterSnapshot,
        focusEditorId: getNodeEditorId(node._id as Id<"nodes">),
      });
    }

    await executeNodeUpdateBatch(updates);

    if (historyEntries.length === 0) {
      return;
    }

    if (historyEntries.length === 1) {
      history.pushUndoEntry(historyEntries[0]!);
      selectSingleNode(historyEntries[0]!.nodeId as string);
      return;
    }

    history.pushUndoEntry({
      type: "compound",
      pageId: historyEntries[0]!.pageId,
      entries: historyEntries,
      focusAfterUndoId: historyEntries[0]!.focusEditorId,
      focusAfterRedoId: historyEntries[historyEntries.length - 1]!.focusEditorId,
    });
  }, [clearNodeSelection, completePlannerTask, executeNodeUpdateBatch, history, ownerKey, pagesById, recurringCompletionMode, selectSingleNode, selectedNodeIds, visibleNodeOrder, workspaceNodeMap]);

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

    const totalDeletedNodeCount = deletableNodes.reduce((total, node) => {
      const treeNode =
        findTreeNodeById(tree, node._id as string) ??
        findTreeNodeById(sidebarNodes, node._id as string);
      return total + (treeNode ? countTreeNodeSubtree(treeNode) : 1);
    }, 0);

    if (totalDeletedNodeCount > 1) {
      const confirmed = window.confirm(
        `Delete ${totalDeletedNodeCount} selected items?`,
      );
      if (!confirmed) {
        return;
      }
    }

    const historyEntries: Array<Extract<HistoryEntry, { type: "archive_node_tree" }>> = [];
    const nodeIdsToArchive: Id<"nodes">[] = [];

    for (const node of deletableNodes) {
      const context = findNodeContext(sidebarNodes, tree, node._id as string);
      const focusAfterRedoId =
        context?.previousSibling?._id
          ? getNodeEditorId(context.previousSibling._id as Id<"nodes">)
          : getComposerEditorId(
              node.pageId as Id<"pages">,
              (node.parentNodeId as Id<"nodes"> | null) ?? null,
            );

      nodeIdsToArchive.push(node._id as Id<"nodes">);

      historyEntries.push({
        type: "archive_node_tree",
        pageId: node.pageId as Id<"pages">,
        nodeId: node._id as Id<"nodes">,
        focusAfterUndoId: getNodeEditorId(node._id as Id<"nodes">),
        focusAfterRedoId,
      });
    }

    await executeNodeArchiveBatch(nodeIdsToArchive, true);

    clearNodeSelection();

    if (historyEntries.length === 0) {
      return;
    }

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
    executeNodeArchiveBatch,
    history,
    pagesById,
    selectedNodeIds,
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
      textSelectionGestureRef.current = null;
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
    const handleMouseMove = (event: MouseEvent) => {
      const gesture = textSelectionGestureRef.current;
      if (!gesture || typeof document === "undefined") {
        return;
      }

      if ((event.buttons & 1) !== 1) {
        textSelectionGestureRef.current = null;
        return;
      }

      const targetElement = document.elementFromPoint(event.clientX, event.clientY);
      const hoveredNodeId =
        targetElement instanceof HTMLElement
          ? targetElement.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? null
          : null;
      const nextNodeId = hoveredNodeId ?? gesture.anchorNodeId;

      if (!gesture.convertedToItemSelection) {
        if (Math.abs(event.clientY - gesture.startY) < 10) {
          return;
        }

        gesture.convertedToItemSelection = true;
        gesture.lastNodeId = nextNodeId;
        window.getSelection()?.removeAllRanges();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        setDragSelection({
          anchorNodeId: gesture.anchorNodeId,
          currentNodeId: nextNodeId,
        });
        return;
      }

      if (gesture.lastNodeId === nextNodeId) {
        return;
      }

      gesture.lastNodeId = nextNodeId;
      setDragSelection((current) =>
        current
          ? {
              ...current,
              currentNodeId: nextNodeId,
            }
          : {
              anchorNodeId: gesture.anchorNodeId,
              currentNodeId: nextNodeId,
            },
      );
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

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
    window.setTimeout(() => {
      if (paletteMode === "chat") {
        focusWorkspaceAiChatInput();
        return;
      }

      if (
        paletteMode === "archive" ||
        paletteMode === "migration" ||
        paletteMode === "importer" ||
        paletteMode === "screenshotImport"
      ) {
        return;
      }

      paletteInputRef.current?.focus();
    }, 0);
  }, [paletteOpen, paletteMode]);

  useEffect(() => {
    if (
      !paletteOpen ||
      paletteMode === "chat" ||
      paletteMode === "archive" ||
      paletteMode === "migration" ||
      paletteMode === "importer" ||
      paletteMode === "screenshotImport" ||
      activePaletteResultsCount === 0
    ) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const activeItem = paletteResultsRef.current?.querySelector<HTMLElement>(
        `[data-palette-item-index="${paletteHighlightIndex}"]`,
      );
      activeItem?.scrollIntoView({
        block: "nearest",
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activePaletteResultsCount, paletteHighlightIndex, paletteMode, paletteOpen]);

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
    if (!pendingRevealNodeId || !revealNodes) {
      return;
    }

    const pageNodeMap = new Map(
      revealNodes.map((node) => [node._id as string, node]),
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
  }, [collapsedNodeIds, pendingRevealNodeId, revealNodes]);

  useEffect(() => {
    if (
      !pendingRevealNodeId ||
      !revealNodes
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
        revealNodes,
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
  }, [collapsedNodeIds, pendingRevealNodeId, revealNodes, selectedPageId]);

  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      copySelectedNodesToClipboard(event);
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (isTextEntryElement(event.target) || !event.clipboardData) {
        return;
      }

      const payload = parseOutlineClipboardPayload(
        event.clipboardData.getData(OUTLINE_CLIPBOARD_MIME_TYPE),
      );
      if (!payload) {
        return;
      }

      event.preventDefault();
      void pasteOutlineClipboardAfterSelection(payload);
    };

    window.addEventListener("copy", handleCopy);
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("copy", handleCopy);
      window.removeEventListener("paste", handlePaste);
    };
  }, [copySelectedNodesToClipboard, pasteOutlineClipboardAfterSelection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const isModifier = event.metaKey || event.ctrlKey;
      const normalizedKey = event.key.toLowerCase();

      if (
        paletteOpen &&
        !isModifier &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        cyclePaletteMode(event.key === "ArrowRight" ? 1 : -1);
        return;
      }

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
        openPalette("chat");
        return;
      }

      if (isModifier && event.shiftKey && normalizedKey === "k") {
        event.preventDefault();
        void copyNodeLinkToClipboard(event.target);
        return;
      }

      if (
        isModifier &&
        normalizedKey === "enter" &&
        selectedNodeIds.size > 0 &&
        !isTextEntryElement(event.target)
      ) {
        event.preventDefault();
        void toggleHighlightedNodeCompletion();
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
        setActionContextNodeId(
          getNodeIdFromTarget(event.target) ??
            (selectedNodeIds.size === 1 ? ([...selectedNodeIds][0] ?? null) : null),
        );
        openPalette("actions");
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
            const edgeIndex =
              direction === 1
                ? selectedIndices[selectedIndices.length - 1]!
                : selectedIndices[0]!;
            let nextIndex = edgeIndex + direction;

            while (nextIndex >= 0 && nextIndex < visibleNodeOrder.length) {
              const candidateNodeId = visibleNodeOrder[nextIndex];
              if (candidateNodeId && !selectedNodeIds.has(candidateNodeId)) {
                clearNodeSelection();
                window.setTimeout(() => {
                  const target = document.querySelector<HTMLElement>(
                    `[data-node-id="${candidateNodeId}"] textarea:not([disabled])`,
                  );
                  focusElementAtEnd(target as HTMLTextAreaElement | null);
                }, 0);
                return;
              }
              nextIndex += direction;
            }

            clearNodeSelection();
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
    indentHighlightedNodeByKeyboard,
    moveHighlightedNodeByKeyboard,
    openPalette,
    cyclePaletteMode,
    paletteOpen,
    clearNodeSelection,
    selectNodeRange,
    selectSingleNode,
    selectedNodeIds,
    setHighlightedNodeCollapsedByKeyboard,
    toggleHighlightedNodeCompletion,
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

  useEffect(() => {
    if (pageMeta.pageType !== "planner") {
      setPlannerNextTaskSuggestion(null);
    }
  }, [pageMeta.pageType, selectedPageId]);

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

  const handleToggleSelectedTaskPagePlannerScan = useCallback(async () => {
    if (!selectedPage || pageMeta.pageType !== "task" || isPageArchived) {
      return;
    }

    const nextExcluded = !isSelectedPageExcludedFromPlannerScan;
    try {
      await setPlannerScanExcluded({
        ownerKey,
        pageId: selectedPage._id,
        excluded: nextExcluded,
      });
      setCopySnackbarMessage(
        nextExcluded
          ? "Excluded this task page from planner scans"
          : "Included this task page in planner scans",
      );
    } catch (error) {
      setCopySnackbarMessage(
        error instanceof Error
          ? error.message
          : "Could not update planner scan settings.",
      );
    }
  }, [
    isPageArchived,
    isSelectedPageExcludedFromPlannerScan,
    ownerKey,
    pageMeta.pageType,
    selectedPage,
    setPlannerScanExcluded,
  ]);

  const handleSelectPage = useCallback((pageId: Id<"pages">) => {
    const page = pagesById.get(pageId as string);
    setSelectedPageId(pageId);
    setLocationPageId(pageId);
    writePageIdToHistory(pageId, "push", page?.title ?? null);
    setPendingRevealNodeId(null);
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteHighlightIndex(0);
    setPaletteMode("pages");
    setTextSearchResults([]);
    setNodeSearchResults([]);
    clearNodeSelection();
  }, [clearNodeSelection, pagesById]);

  const handleSelectNodeSearchResult = useCallback((result: NodeSearchResult) => {
    if (!result.page) {
      return;
    }

    if (isSidebarSpecialPage(result.page)) {
      setIsSidebarCollapsed(false);
      setPendingRevealNodeId(result.node._id as string);
      setPaletteOpen(false);
      setPaletteQuery("");
      setPaletteHighlightIndex(0);
      setPaletteMode("find");
      setTextSearchResults([]);
      clearNodeSelection();
      return;
    }

    setSelectedPageId(result.page._id);
    setLocationPageId(result.page._id);
    writePageIdToHistory(result.page._id, "push", result.page.title);
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
    writePageIdToHistory(pageId, "push", pagesById.get(pageId as string)?.title ?? null);
    setPendingRevealNodeId(nodeId as string);
    clearNodeSelection();
  }, [clearNodeSelection, pagesById]);

  const handleOpenWorkspaceKnowledgeSource = useCallback(
    (source: WorkspaceKnowledgeSourceSnapshot) => {
      if (!source.pageId) {
        return;
      }

      setSelectedPageId(source.pageId as Id<"pages">);
      setLocationPageId(source.pageId);
      writePageIdToHistory(source.pageId, "push", source.pageTitle);
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
      const explicitTargets = resolveExplicitKnowledgeLinkTargets(
        question,
        pagesByTitle,
        pagesById,
      );
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
  }, [chatWithWorkspace, ownerKey, pagesById, pagesByTitle, workspaceChatDraft]);

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
        userNote:
          journalFeedbackPromptNote.trim().length > 0
            ? journalFeedbackPromptNote.trim()
            : undefined,
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
        prompt: MODEL_REGENERATE_REQUEST,
        userNote: modelPromptNote.trim().length > 0 ? modelPromptNote.trim() : undefined,
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

  const focusPlannerNode = useCallback((nodeId: string) => {
    setPendingRevealNodeId(nodeId);
    setSelectedNodeIds(new Set([nodeId]));
  }, []);

  const handleAppendPlannerDay = useCallback(async () => {
    if (!selectedPageId || pageMeta.pageType !== "planner" || isPageArchived) {
      return;
    }

    setIsPlannerAppendingDay(true);
    setPlannerStatus("");
    try {
      const result = await appendPlannerDay({
        ownerKey,
        pageId: selectedPageId,
      });
      if (result?.dayNodeId) {
        focusPlannerNode(result.dayNodeId as string);
      }
      setPlannerStatus("Added the next planner day.");
    } catch (error) {
      setPlannerStatus(
        error instanceof Error ? error.message : "Could not add the next planner day.",
      );
    } finally {
      setIsPlannerAppendingDay(false);
    }
  }, [
    appendPlannerDay,
    focusPlannerNode,
    isPageArchived,
    ownerKey,
    pageMeta.pageType,
    selectedPageId,
  ]);

  const handleCompletePlannerDay = useCallback(async () => {
    if (!selectedPageId || pageMeta.pageType !== "planner" || isPageArchived) {
      return;
    }

    setIsPlannerCompletingDay(true);
    setPlannerStatus("");
    try {
      const result = await completePlannerDayWithAi({
        ownerKey,
        pageId: selectedPageId,
      });
      if (result?.nextDayNodeId) {
        focusPlannerNode(result.nextDayNodeId as string);
      }
      const movedCount = typeof result?.movedCount === "number" ? result.movedCount : 0;
      const duplicateCount =
        typeof result?.archivedDuplicateCount === "number"
          ? result.archivedDuplicateCount
          : 0;
      const parts = [`Completed the top day and rolled ${movedCount} item${movedCount === 1 ? "" : "s"} forward.`];
      if (duplicateCount > 0) {
        parts.push(
          `${duplicateCount} linked duplicate${duplicateCount === 1 ? " was" : "s were"} skipped because it already existed in the next day.`,
        );
      }
      setPlannerStatus(parts.join(" "));
    } catch (error) {
      setPlannerStatus(
        error instanceof Error ? error.message : "Could not complete the top planner day.",
      );
    } finally {
      setIsPlannerCompletingDay(false);
    }
  }, [
    completePlannerDayWithAi,
    focusPlannerNode,
    isPageArchived,
    ownerKey,
    pageMeta.pageType,
    selectedPageId,
  ]);

  const handleAddRandomPlannerTask = useCallback(async () => {
    if (!selectedPageId || pageMeta.pageType !== "planner" || isPageArchived) {
      return;
    }

    setIsPlannerAddingRandomTask(true);
    setPlannerStatus("");
    try {
      const result = await addRandomPlannerTask({
        ownerKey,
        pageId: selectedPageId,
        seed: Date.now(),
      });
      if (result?.plannerNodeId) {
        focusPlannerNode(result.plannerNodeId as string);
      }
      setPlannerStatus("Added a random open task to the current day.");
    } catch (error) {
      setPlannerStatus(
        error instanceof Error ? error.message : "Could not add a random task right now.",
      );
    } finally {
      setIsPlannerAddingRandomTask(false);
    }
  }, [addRandomPlannerTask, focusPlannerNode, isPageArchived, ownerKey, pageMeta.pageType, selectedPageId]);

  const handleResolveNextPlannerTask = useCallback(async () => {
    if (!selectedPageId || pageMeta.pageType !== "planner" || isPageArchived) {
      return;
    }

    setIsPlannerResolvingNextTask(true);
    setPlannerStatus("");
    try {
      const result = await resolveNextPlannerTask({
        ownerKey,
        pageId: selectedPageId,
      });
      if (result?.plannerNodeId) {
        setPlannerNextTaskSuggestion({
          plannerNodeId: result.plannerNodeId as string,
          text: typeof result.text === "string" ? result.text : "Untitled task",
          created: result.created === true,
          sourcePageId:
            typeof result.sourcePageId === "string" ? result.sourcePageId : null,
          sourcePageTitle:
            typeof result.sourcePageTitle === "string" ? result.sourcePageTitle : null,
          linkedSourceTaskId:
            typeof result.linkedSourceTaskId === "string" ? result.linkedSourceTaskId : null,
          dueAt: typeof result.dueAt === "number" ? result.dueAt : null,
          dueEndAt: typeof result.dueEndAt === "number" ? result.dueEndAt : null,
        });
      }
      setPlannerStatus(
        result?.created
          ? "Suggested a new task for today."
          : "Suggested the next task for today.",
      );
    } catch (error) {
      setPlannerStatus(
        error instanceof Error ? error.message : "Could not choose the next task right now.",
      );
    } finally {
      setIsPlannerResolvingNextTask(false);
    }
  }, [isPageArchived, ownerKey, pageMeta.pageType, resolveNextPlannerTask, selectedPageId]);

  const handleSubmitPlannerChat = useCallback(async () => {
    if (
      !selectedPageId ||
      pageMeta.pageType !== "planner" ||
      isPageArchived ||
      plannerChatDraft.trim().length === 0
    ) {
      return;
    }

    setIsPlannerChatLoading(true);
    setPlannerChatError("");
    try {
      await runPlannerChat({
        ownerKey,
        pageId: selectedPageId,
        prompt: plannerChatDraft.trim(),
        threadId: plannerChatThread?.thread?._id,
      });
      setPlannerChatDraft("");
    } catch (error) {
      setPlannerChatError(
        error instanceof Error ? error.message : "Planner AI could not respond right now.",
      );
    } finally {
      setIsPlannerChatLoading(false);
    }
  }, [
    isPageArchived,
    ownerKey,
    pageMeta.pageType,
    plannerChatDraft,
    plannerChatThread?.thread?._id,
    runPlannerChat,
    selectedPageId,
  ]);

  const handleApplyPlannerPlan = useCallback(async (messageId: Id<"chatMessages">) => {
    try {
      await applyApprovedPlannerPlan({
        ownerKey,
        messageId,
        completionMode: recurringCompletionMode,
      });
      setPlannerChatError("");
    } catch (error) {
      setPlannerChatError(
        error instanceof Error ? error.message : "Could not apply the planner changes.",
      );
    }
  }, [applyApprovedPlannerPlan, ownerKey, recurringCompletionMode]);

  const handlePaletteKeyDown = (event: TextareaKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      cyclePaletteMode(event.key === "ArrowRight" ? 1 : -1);
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

      if (paletteMode === "actions") {
        const highlighted = actionResults[paletteHighlightIndex];
        if (highlighted) {
          void highlighted.onSelect();
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
      <main
        className="relative min-h-screen bg-[var(--workspace-bg)] text-[var(--workspace-text)]"
        onMouseDownCapture={(event) => {
          if (event.button !== 0 || !(event.target instanceof HTMLTextAreaElement)) {
            textSelectionGestureRef.current = null;
            return;
          }

          const nodeId =
            event.target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ?? null;
          if (!nodeId) {
            textSelectionGestureRef.current = null;
            return;
          }

          textSelectionGestureRef.current = {
            anchorNodeId: nodeId,
            lastNodeId: nodeId,
            startY: event.clientY,
            convertedToItemSelection: false,
          };
        }}
      >
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
          "mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 pb-36 transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none md:pb-44",
        )}
        style={
          isMobileLayout
            ? undefined
            : {
                gridTemplateColumns: isSidebarCollapsed
                  ? "72px minmax(0,1fr)"
                  : "320px minmax(0,1fr)",
              }
        }
      >
        <aside
          className={clsx(
            "overflow-hidden border-b border-[var(--workspace-border)] bg-[var(--workspace-sidebar-bg)] lg:border-b-0 lg:border-r",
          )}
        >
          <div
            className={clsx(
              "flex h-full flex-col transition-[padding] duration-200 ease-out motion-reduce:transition-none",
              isSidebarCollapsed ? "px-3 py-4 md:px-4 md:py-5" : "p-6",
            )}
          >
            <div
              className={clsx(
                "flex items-start",
                isSidebarCollapsed
                  ? isMobileLayout
                    ? "justify-start"
                    : "justify-center"
                  : "justify-between gap-4",
              )}
            >
              <button
                type="button"
                onClick={() => setIsSidebarCollapsed((current) => !current)}
                className="flex h-9 w-9 items-center justify-center border border-[var(--workspace-border-control)] text-sm font-semibold text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
              >
                <span className="lg:hidden">{isSidebarCollapsed ? "˅" : "˄"}</span>
                <span className="hidden lg:inline">{isSidebarCollapsed ? ">" : "<"}</span>
              </button>
              {!isSidebarCollapsed ? <div className="flex-1" /> : null}
            </div>

            <div
              className={clsx(
                "grid min-h-0 flex-1 transition-[grid-template-rows,opacity,margin-top] duration-200 ease-out motion-reduce:transition-none",
                isSidebarCollapsed
                  ? "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"
                  : "mt-6 grid-rows-[1fr] opacity-100",
              )}
            >
              <div aria-hidden={isSidebarCollapsed} className="min-h-0 overflow-hidden">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex-1 overflow-y-auto">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                    Sidebar
                  </p>
                </div>
                {sidebarTree ? (
                  <div className="space-y-1">
                    <OutlineNodeList
                      nodes={sidebarNodes}
                      ownerKey={ownerKey}
                      pageId={sidebarTree?.page._id as Id<"pages">}
                      nodeBacklinkCounts={sidebarNodeBacklinkCounts}
                      nodeMap={sidebarNodeMap}
                      createNodesBatch={createNodesBatch}
                      insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                      onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                      buildDraggedNodePayload={buildDraggedNodePayload}
                      onDropDraggedNodes={dropDraggedNodes}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      availableTags={sortedTags}
                      pagesByTitle={pagesByTitle}
                      pagesById={pagesById}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      onOpenTag={openFindPaletteForQuery}
                      onOpenFindQuery={openFindPaletteForQuery}
                      recurringCompletionMode={recurringCompletionMode}
                      mobileIndentStep={SIDEBAR_MOBILE_INDENT_STEP}
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
                    <p
                      className={clsx(
                        "flex-1 text-xs font-semibold uppercase tracking-[0.22em]",
                        uncategorizedPages.length === 0
                          ? "text-[var(--workspace-text-faint)] opacity-60"
                          : "text-[var(--workspace-text-faint)]",
                      )}
                    >
                      Uncategorized
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRefreshSidebarLinks()}
                        disabled={isRefreshingSidebarLinks}
                        className="border border-[var(--workspace-border-control)] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-wait disabled:opacity-60"
                      >
                        {isRefreshingSidebarLinks ? "Refreshing…" : "Refresh"}
                      </button>
                      {uncategorizedPages.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setIsUncategorizedSectionCollapsed((current) => !current)}
                          className="flex h-8 w-8 items-center justify-center border border-[var(--workspace-border-control)] text-sm font-semibold leading-none text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                          aria-label={
                            showUncategorizedSectionContent
                              ? "Collapse uncategorized pages"
                              : "Expand uncategorized pages"
                          }
                        >
                          {showUncategorizedSectionContent ? "−" : "+"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div
                    className={clsx(
                      "grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-out motion-reduce:transition-none",
                      showUncategorizedSectionContent
                        ? "mt-3 grid-rows-[1fr] opacity-100"
                        : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0",
                    )}
                  >
                    <div
                      aria-hidden={!showUncategorizedSectionContent}
                      className="min-h-0 overflow-hidden"
                    >
                      <div className="space-y-1">
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
                            <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] px-1 text-[10px] leading-none text-[var(--workspace-text-faint)]">
                              {getPageTypeEmoji(page)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-8 border-t border-[var(--workspace-border-soft)] pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                      Journal
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsJournalSectionCollapsed((current) => !current)}
                      className="flex h-8 w-8 items-center justify-center border border-[var(--workspace-border-control)] text-sm font-semibold leading-none text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                      aria-label={showJournalSectionContent ? "Collapse journal pages" : "Expand journal pages"}
                    >
                      {showJournalSectionContent ? "−" : "+"}
                    </button>
                  </div>
                  <div
                    className={clsx(
                      "grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-out motion-reduce:transition-none",
                      showJournalSectionContent
                        ? "mt-3 grid-rows-[1fr] opacity-100"
                        : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0",
                    )}
                  >
                    <div
                      aria-hidden={!showJournalSectionContent}
                      className="min-h-0 overflow-hidden"
                    >
                      {journalPages.length === 0 ? (
                        <p className="text-sm text-[var(--workspace-text-faint)]">
                          No journal pages.
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {journalPages.map((page) => (
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
                              <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] px-1 text-[10px] leading-none text-[var(--workspace-text-faint)]">
                                {getPageTypeEmoji(page)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-8 border-t border-[var(--workspace-border-soft)] pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                      Tags
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsTagsSectionCollapsed((current) => !current)}
                      className="flex h-8 w-8 items-center justify-center border border-[var(--workspace-border-control)] text-sm font-semibold leading-none text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                      aria-label={isTagsSectionCollapsed ? "Expand tags" : "Collapse tags"}
                    >
                      {isTagsSectionCollapsed ? "+" : "−"}
                    </button>
                  </div>
                  <div
                    className={clsx(
                      "grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-out motion-reduce:transition-none",
                      showTagsSectionContent
                        ? "mt-3 grid-rows-[1fr] opacity-100"
                        : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0",
                    )}
                  >
                    <div
                      aria-hidden={!showTagsSectionContent}
                      className="min-h-0 overflow-hidden"
                    >
                      {typeof tags === "undefined" ? (
                        <p className="text-sm text-[var(--workspace-text-faint)]">
                          Loading tags…
                        </p>
                      ) : sortedTags.length === 0 ? (
                        <p className="text-sm text-[var(--workspace-text-faint)]">
                          No tags yet.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {sortedTags.map((tag) => (
                            <button
                              key={tag.normalizedValue}
                              type="button"
                              onClick={() => openFindPaletteForQuery(tag.label)}
                              className="inline-flex items-center gap-2 border border-[var(--workspace-border-control)] px-2 py-1 text-left text-xs text-[var(--workspace-brand)] underline decoration-[1.5px] underline-offset-[3px] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-brand-hover)]"
                            >
                              <span>{tag.label}</span>
                              <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--workspace-text-faint)] no-underline">
                                {tag.count}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-8 border-t border-[var(--workspace-border-soft)] pt-5 opacity-75">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                      Archive
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsArchiveSectionCollapsed((current) => !current)}
                      className="flex h-8 w-8 items-center justify-center border border-[var(--workspace-border-control)] text-sm font-semibold leading-none text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                      aria-label={showArchiveSectionContent ? "Collapse archive" : "Expand archive"}
                    >
                      {showArchiveSectionContent ? "−" : "+"}
                    </button>
                  </div>
                  <div
                    className={clsx(
                      "grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-out motion-reduce:transition-none",
                      showArchiveSectionContent
                        ? "mt-3 grid-rows-[1fr] opacity-100"
                        : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0",
                    )}
                  >
                    <div
                      aria-hidden={!showArchiveSectionContent}
                      className="min-h-0 overflow-hidden"
                    >
                      {archivedPages.length === 0 ? (
                        <p className="text-sm text-[var(--workspace-text-faint)]">
                          No archived pages.
                        </p>
                      ) : (
                        <div className="space-y-1">
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
                              <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] px-1 text-[10px] leading-none text-[var(--workspace-text-faint)]">
                                {getPageTypeEmoji(page)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
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
                      {pageBacklinkCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => openFindPaletteForQuery(buildPageBacklinkSearchQuery(selectedPage))}
                          className="rounded-full border border-[var(--workspace-border)] px-2 py-1 text-[10px] tracking-[0.2em] text-[var(--workspace-text-faint)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                          title={`Show ${pageBacklinkCount}${isPageBacklinkCountTruncated ? "+" : ""} incoming link${pageBacklinkCount === 1 ? "" : "s"}`}
                        >
                          {pageBacklinkCount}
                          {isPageBacklinkCountTruncated ? "+" : ""} link
                          {pageBacklinkCount === 1 ? "" : "s"}
                        </button>
                      ) : null}
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
                      className="mt-4 w-full border-0 bg-transparent p-0 text-4xl font-semibold tracking-tight text-[var(--workspace-text-subtle)] outline-none disabled:text-[var(--workspace-text-muted)]"
                    />
                    {pageLoadWarning ? (
                      <div className="mt-4 rounded-md border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] px-3 py-2 text-sm text-[var(--workspace-text-faint)]">
                        {pageLoadWarning}
                      </div>
                    ) : null}
                  </div>
                  {pageMeta.pageType === "task" ? (
                    <button
                      type="button"
                      onClick={() => void handleToggleSelectedTaskPagePlannerScan()}
                      disabled={isPageArchived}
                      className={clsx(
                        "shrink-0 border px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] transition disabled:cursor-not-allowed disabled:opacity-60",
                        isSelectedPageExcludedFromPlannerScan
                          ? "border-[var(--workspace-brand)] text-[var(--workspace-brand)] hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)]"
                          : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                      )}
                      >
                      {isSelectedPageExcludedFromPlannerScan
                        ? "Include In Planner"
                        : "Exclude From Planner"}
                    </button>
                  ) : null}
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
                  <div className="min-w-0 space-y-1">
                    <OutlineNodeList
                      nodes={genericRoots}
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      nodeBacklinkCounts={pageNodeBacklinkCounts}
                      nodeMap={nodeMap}
                      createNodesBatch={createNodesBatch}
                      insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                      onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                      buildDraggedNodePayload={buildDraggedNodePayload}
                      onDropDraggedNodes={dropDraggedNodes}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      availableTags={sortedTags}
                      pagesByTitle={pagesByTitle}
                      pagesById={pagesById}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      onOpenTag={openFindPaletteForQuery}
                      onOpenFindQuery={openFindPaletteForQuery}
                      recurringCompletionMode={recurringCompletionMode}
                    />
                  </div>
                ) : pageMeta.pageType === "planner" ? (
                  <div className="space-y-8">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleAppendPlannerDay()}
                        disabled={isPlannerAppendingDay || isPageArchived}
                        className="border border-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isPlannerAppendingDay ? "Adding…" : "Add Day"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCompletePlannerDay()}
                        disabled={isPlannerCompletingDay || isPageArchived}
                        className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isPlannerCompletingDay ? "Completing…" : "Complete Day"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleAddRandomPlannerTask()}
                        disabled={isPlannerAddingRandomTask || isPageArchived}
                        className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isPlannerAddingRandomTask ? "Picking…" : "Add Random Task"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveNextPlannerTask()}
                        disabled={isPlannerResolvingNextTask || isPageArchived}
                        className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isPlannerResolvingNextTask ? "Finding…" : "Next Task"}
                      </button>
                    </div>
                    {plannerStatus ? (
                      <p className="text-sm text-[var(--workspace-text-subtle)]">{plannerStatus}</p>
                    ) : null}
                    {plannerNextTaskSuggestion ? (
                      <div
                        className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
                        onClick={() => setPlannerNextTaskSuggestion(null)}
                      >
                        <div
                          className="w-full max-w-lg border border-[var(--workspace-border)] bg-[var(--workspace-surface)] p-5 shadow-2xl"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--workspace-accent)]">
                                Next Suggested Task
                              </p>
                              <h3 className="mt-3 text-2xl font-semibold tracking-tight text-[var(--workspace-text)]">
                                {plannerNextTaskSuggestion.text}
                              </h3>
                            </div>
                            <button
                              type="button"
                              onClick={() => setPlannerNextTaskSuggestion(null)}
                              className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                            >
                              Dismiss
                            </button>
                          </div>
                          <div className="mt-4 flex flex-wrap gap-2 text-xs uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                            <span>
                              {plannerNextTaskSuggestion.created ? "Pulled into today" : "Already in today"}
                            </span>
                            {plannerNextTaskSuggestion.sourcePageTitle ? (
                              <span>From {plannerNextTaskSuggestion.sourcePageTitle}</span>
                            ) : null}
                            {plannerNextTaskSuggestion.dueAt ? (
                              <span>
                                {formatDueDateRange(
                                  plannerNextTaskSuggestion.dueAt,
                                  plannerNextTaskSuggestion.dueEndAt ?? null,
                                )}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-6 flex flex-wrap gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                focusPlannerNode(plannerNextTaskSuggestion.plannerNodeId);
                                setPlannerNextTaskSuggestion(null);
                              }}
                              className="border border-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)]"
                            >
                              Focus Task
                            </button>
                            {plannerNextTaskSuggestion.sourcePageId ? (
                              <button
                                type="button"
                                onClick={() => {
                                  handleSelectPage(
                                    plannerNextTaskSuggestion.sourcePageId as Id<"pages">,
                                  );
                                  setPlannerNextTaskSuggestion(null);
                                }}
                                className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                              >
                                Open Source Page
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : null}
                    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
                      <div className="min-w-0 space-y-1">
                        <OutlineNodeList
                          nodes={genericRoots}
                          ownerKey={ownerKey}
                          pageId={selectedPage._id}
                          nodeBacklinkCounts={pageNodeBacklinkCounts}
                          nodeMap={nodeMap}
                          createNodesBatch={createNodesBatch}
                          insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                          onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                          buildDraggedNodePayload={buildDraggedNodePayload}
                          onDropDraggedNodes={dropDraggedNodes}
                          onSelectionStart={beginNodeSelection}
                          onSelectionExtend={extendNodeSelection}
                          availableTags={sortedTags}
                          pagesByTitle={pagesByTitle}
                          pagesById={pagesById}
                          onOpenPage={handleSelectPage}
                          onOpenNode={handleOpenLinkedNode}
                          onOpenTag={openFindPaletteForQuery}
                          onOpenFindQuery={openFindPaletteForQuery}
                          recurringCompletionMode={recurringCompletionMode}
                        />
                      </div>
                      <aside className="min-w-0 border-t border-[var(--workspace-border-subtle)] pt-6 lg:sticky lg:top-6 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:overscroll-contain lg:border-l lg:border-t-0 lg:pl-6 lg:pr-1 lg:pt-0">
                        {plannerSidebarSection ? (
                          <PageSection
                            title="Sidebar"
                            sectionNode={plannerSidebarSection}
                            ownerKey={ownerKey}
                            pageId={selectedPage._id}
                            nodeBacklinkCounts={pageNodeBacklinkCounts}
                            nodeMap={nodeMap}
                            createNodesBatch={createNodesBatch}
                            insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                            onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                            buildDraggedNodePayload={buildDraggedNodePayload}
                            onDropDraggedNodes={dropDraggedNodes}
                            onSelectionStart={beginNodeSelection}
                            onSelectionExtend={extendNodeSelection}
                            availableTags={sortedTags}
                            pagesByTitle={pagesByTitle}
                            pagesById={pagesById}
                            onOpenPage={handleSelectPage}
                            onOpenNode={handleOpenLinkedNode}
                            onOpenTag={openFindPaletteForQuery}
                            onOpenFindQuery={openFindPaletteForQuery}
                            recurringCompletionMode={recurringCompletionMode}
                            compact
                            showHeader={false}
                          />
                        ) : (
                          <div className="text-xs uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]">
                            Preparing planner sidebar…
                          </div>
                        )}
                      </aside>
                    </div>
                    <PageSection
                      title="Template"
                      sectionNode={plannerTemplateSection}
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      nodeBacklinkCounts={pageNodeBacklinkCounts}
                      nodeMap={nodeMap}
                      createNodesBatch={createNodesBatch}
                      insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                      onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                      buildDraggedNodePayload={buildDraggedNodePayload}
                      onDropDraggedNodes={dropDraggedNodes}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      availableTags={sortedTags}
                      pagesByTitle={pagesByTitle}
                      pagesById={pagesById}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      onOpenTag={openFindPaletteForQuery}
                      onOpenFindQuery={openFindPaletteForQuery}
                      recurringCompletionMode={recurringCompletionMode}
                      depthOffset={sectionDepthOffset}
                    />
                    <PlannerAiChatPanel
                      draft={plannerChatDraft}
                      onDraftChange={setPlannerChatDraft}
                      onSubmit={() => void handleSubmitPlannerChat()}
                      messages={plannerChatMessages}
                      isLoading={isPlannerChatLoading}
                      error={plannerChatError}
                      onClearError={() => setPlannerChatError("")}
                      onApplyPlan={(messageId) => void handleApplyPlannerPlan(messageId)}
                    />
                  </div>
                ) : pageMeta.pageType === "model" ? (
                  <div className="divide-y divide-[var(--workspace-border-subtle)]">
                    <div className="pb-8">
                      <PageSection
                        title="Model"
                        sectionNode={modelSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeBacklinkCounts={pageNodeBacklinkCounts}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                      onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                      buildDraggedNodePayload={buildDraggedNodePayload}
                      onDropDraggedNodes={dropDraggedNodes}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      availableTags={sortedTags}
                      pagesByTitle={pagesByTitle}
                      pagesById={pagesById}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      onOpenTag={openFindPaletteForQuery}
                      onOpenFindQuery={openFindPaletteForQuery}
                      recurringCompletionMode={recurringCompletionMode}
                      depthOffset={sectionDepthOffset}
                      statusMessage={chatStatus}
                      headerDetail={
                        activeAiPromptEditor === "model" ? (
                          <AiPromptEditorPanel
                            userNote={modelPromptNote}
                            onUserNoteChange={setModelPromptNote}
                            systemPrompt={MODEL_REWRITE_SYSTEM_PROMPT}
                            userPromptPreview={modelPromptPreview}
                            helperText="Linked page/node context from Model and Recent is also dereferenced and included when present. The last few model-regeneration messages are also included in the backend request."
                          />
                        ) : null
                      }
                      action={
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setActiveAiPromptEditor((current) =>
                                current === "model" ? null : "model",
                              )
                            }
                            className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                          >
                            Prompt
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRegenerateModel()}
                            disabled={isSendingChat || isPageArchived}
                            className="border border-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isSendingChat ? "Regenerating…" : "Regenerate Model"}
                          </button>
                        </div>
                      }
                    />
                  </div>
                    <div className="pt-8">
                      <PageSection
                        title="Recent"
                        sectionNode={recentExamplesSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeBacklinkCounts={pageNodeBacklinkCounts}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                      onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                      buildDraggedNodePayload={buildDraggedNodePayload}
                      onDropDraggedNodes={dropDraggedNodes}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      availableTags={sortedTags}
                      pagesByTitle={pagesByTitle}
                      pagesById={pagesById}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      onOpenTag={openFindPaletteForQuery}
                      onOpenFindQuery={openFindPaletteForQuery}
                      recurringCompletionMode={recurringCompletionMode}
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
                        nodeBacklinkCounts={pageNodeBacklinkCounts}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                      onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                      buildDraggedNodePayload={buildDraggedNodePayload}
                      onDropDraggedNodes={dropDraggedNodes}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      availableTags={sortedTags}
                      pagesByTitle={pagesByTitle}
                      pagesById={pagesById}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      onOpenTag={openFindPaletteForQuery}
                      onOpenFindQuery={openFindPaletteForQuery}
                      recurringCompletionMode={recurringCompletionMode}
                      depthOffset={sectionDepthOffset}
                    />
                  </div>
                    <div className="pt-8">
                      <PageSection
                        title="Feedback"
                        sectionNode={journalFeedbackSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeBacklinkCounts={pageNodeBacklinkCounts}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                      onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                      buildDraggedNodePayload={buildDraggedNodePayload}
                      onDropDraggedNodes={dropDraggedNodes}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      availableTags={sortedTags}
                      pagesByTitle={pagesByTitle}
                      pagesById={pagesById}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      onOpenTag={openFindPaletteForQuery}
                      onOpenFindQuery={openFindPaletteForQuery}
                      recurringCompletionMode={recurringCompletionMode}
                      depthOffset={sectionDepthOffset}
                      statusMessage={journalFeedbackStatus}
                      headerDetail={
                        activeAiPromptEditor === "journalFeedback" ? (
                          <AiPromptEditorPanel
                            userNote={journalFeedbackPromptNote}
                            onUserNoteChange={setJournalFeedbackPromptNote}
                            systemPrompt={JOURNAL_FEEDBACK_SYSTEM_PROMPT}
                            userPromptPreview={journalFeedbackPromptPreview}
                            helperText="Linked page/node context from Thoughts/Stuff is also dereferenced and included when present."
                          />
                        ) : null
                      }
                      action={
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setActiveAiPromptEditor((current) =>
                                current === "journalFeedback" ? null : "journalFeedback",
                              )
                            }
                            className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                          >
                            Prompt
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleGenerateJournalFeedback()}
                            disabled={isGeneratingJournalFeedback || isPageArchived}
                            className="border border-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isGeneratingJournalFeedback ? "Generating…" : "Generate Feedback"}
                          </button>
                        </div>
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
                        nodeBacklinkCounts={pageNodeBacklinkCounts}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                        onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                        buildDraggedNodePayload={buildDraggedNodePayload}
                        onDropDraggedNodes={dropDraggedNodes}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        availableTags={sortedTags}
                        pagesByTitle={pagesByTitle}
                        pagesById={pagesById}
                        onOpenPage={handleSelectPage}
                        onOpenNode={handleOpenLinkedNode}
                        onOpenTag={openFindPaletteForQuery}
                        onOpenFindQuery={openFindPaletteForQuery}
                        recurringCompletionMode={recurringCompletionMode}
                        depthOffset={sectionDepthOffset}
                      />
                    </div>
                    <div className="pt-8">
                      <PageSection
                        title="Previous"
                        sectionNode={scratchpadPreviousSection}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        nodeBacklinkCounts={pageNodeBacklinkCounts}
                        nodeMap={nodeMap}
                        createNodesBatch={createNodesBatch}
                        insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                        onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                        buildDraggedNodePayload={buildDraggedNodePayload}
                        onDropDraggedNodes={dropDraggedNodes}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        availableTags={sortedTags}
                        pagesByTitle={pagesByTitle}
                        pagesById={pagesById}
                        onOpenPage={handleSelectPage}
                        onOpenNode={handleOpenLinkedNode}
                        onOpenTag={openFindPaletteForQuery}
                        onOpenFindQuery={openFindPaletteForQuery}
                        recurringCompletionMode={recurringCompletionMode}
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
                      nodeBacklinkCounts={pageNodeBacklinkCounts}
                      nodeMap={nodeMap}
                      createNodesBatch={createNodesBatch}
                      insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
                      onSetSelectedNodeIds={setExplicitSelectedNodeIds}
                      buildDraggedNodePayload={buildDraggedNodePayload}
                      onDropDraggedNodes={dropDraggedNodes}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                      availableTags={sortedTags}
                      pagesByTitle={pagesByTitle}
                      pagesById={pagesById}
                      onOpenPage={handleSelectPage}
                      onOpenNode={handleOpenLinkedNode}
                      onOpenTag={openFindPaletteForQuery}
                      onOpenFindQuery={openFindPaletteForQuery}
                      recurringCompletionMode={recurringCompletionMode}
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
          className="fixed inset-0 z-50 overflow-hidden bg-[var(--workspace-text)]/20 p-4 sm:p-8"
          onClick={() => {
            setPaletteOpen(false);
            setPaletteQuery("");
            setPaletteMode("pages");
            setTextSearchResults([]);
            setNodeSearchResults([]);
          }}
        >
          <div
            className={clsx(
              "mx-auto mt-16 flex h-[calc(100vh-8rem)] w-full flex-col overflow-hidden border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] shadow-[0_30px_90px_-45px_rgba(53,41,24,0.45)]",
              paletteMode === "migration"
                ? "max-w-6xl"
                : paletteMode === "chat" ||
                    paletteMode === "replace" ||
                    paletteMode === "archive" ||
                    paletteMode === "importer" ||
                    paletteMode === "screenshotImport" ||
                    paletteMode === "taskSchedule"
                  ? "max-w-4xl"
                  : "max-w-2xl",
            )}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-[var(--workspace-border-subtle)] px-5 py-4">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    switchPaletteMode("actions");
                  }}
                  className={clsx(
                    "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    paletteMode === "actions"
                      ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                      : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  Actions
                </button>
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
                <button
                  type="button"
                  onClick={() => {
                    switchPaletteMode("chat");
                  }}
                  className={clsx(
                    "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    paletteMode === "chat"
                      ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                      : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  Chat
                </button>
                {paletteMode === "archive" ? (
                  <button
                    type="button"
                    onClick={() => {
                      switchPaletteMode("archive");
                    }}
                    className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition"
                  >
                    Search Archive
                  </button>
                ) : null}
                {paletteMode === "replace" ? (
                  <button
                    type="button"
                    onClick={() => {
                      switchPaletteMode("replace");
                    }}
                    className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition"
                  >
                    Find &amp; Replace
                  </button>
                ) : null}
                {paletteMode === "migration" ? (
                  <button
                    type="button"
                    onClick={() => {
                      switchPaletteMode("migration");
                    }}
                    className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition"
                  >
                    Import From App
                  </button>
                ) : null}
                {paletteMode === "importer" ? (
                  <button
                    type="button"
                    onClick={() => {
                      switchPaletteMode("importer");
                    }}
                    className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition"
                  >
                    Import From Text
                  </button>
                ) : null}
                {paletteMode === "screenshotImport" ? (
                  <button
                    type="button"
                    onClick={() => {
                      switchPaletteMode("screenshotImport");
                    }}
                    className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition"
                  >
                    Import Screenshot
                  </button>
                ) : null}
                {paletteMode === "taskSchedule" ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPaletteMode("taskSchedule");
                    }}
                    className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition"
                  >
                    Task Schedule
                  </button>
                ) : null}
              </div>
              {paletteMode === "chat" ||
              paletteMode === "replace" ||
              paletteMode === "archive" ||
              paletteMode === "migration" ||
              paletteMode === "importer" ||
              paletteMode === "screenshotImport" ||
              paletteMode === "taskSchedule" ? (
                <p className="text-sm text-[var(--workspace-text-subtle)]">
                  {paletteMode === "chat"
                    ? "Persistent workspace chat"
                    : paletteMode === "replace"
                      ? "Preview and replace exact text in the current page or across the active workspace."
                    : paletteMode === "archive"
                      ? "Search archived pages and nodes without mixing them into active workspace results."
                      : paletteMode === "migration"
                        ? "Snapshot imports, review suggested changes, and explicitly approve each chunk before it touches the workspace."
                        : paletteMode === "importer"
                          ? "Paste text, preview exactly what will be added, and import it into the page you choose."
                        : paletteMode === "screenshotImport"
                          ? "Paste an outliner screenshot, preview the translated structure, then import it as real nodes."
                          : "Set a due date, recurrence, and recurring completion rule for the current task."}
                </p>
              ) : (
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
                          : paletteMode === "nodes"
                            ? "Search notes and tasks semantically across the workspace..."
                              : "Run a workspace action..."
                    }
                    className="w-full border-0 bg-transparent p-0 text-lg outline-none"
                  />
                </div>
              )}
            </div>
            <div
              ref={paletteResultsRef}
              className={clsx(
                "min-h-0 h-full flex-1",
              paletteMode === "chat" ||
              paletteMode === "replace" ||
              paletteMode === "archive" ||
              paletteMode === "migration" ||
              paletteMode === "importer" ||
              paletteMode === "screenshotImport" ||
                  paletteMode === "taskSchedule"
                  ? "overflow-hidden"
                  : "overflow-y-auto py-2",
              )}
            >
              {paletteMode === "pages" ? (
                paletteResults.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">No matching pages.</p>
                ) : (
                paletteResults.map((page, index) => {
                  return (
                    <button
                      key={page._id}
                      type="button"
                      data-palette-item-index={index}
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
                      data-palette-item-index={index}
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
                      data-palette-item-index={index}
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
              ) : paletteMode === "actions" ? (
                actionResults.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
                    No matching actions.
                  </p>
                ) : (
                  <div className="grid min-h-full auto-rows-[minmax(6rem,1fr)]">
                    {actionResults.map((result, index) => (
                      <button
                        key={result.key}
                        type="button"
                        data-palette-item-index={index}
                        disabled={result.disabled}
                        onMouseEnter={() => setPaletteHighlightIndex(index)}
                        onClick={() => {
                          void result.onSelect();
                        }}
                        className={clsx(
                          "flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition",
                          result.disabled ? "cursor-wait opacity-70" : "",
                          index === paletteHighlightIndex
                            ? "bg-[var(--workspace-sidebar-bg)]"
                            : "hover:bg-[var(--workspace-surface-hover)]",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                            {result.title}
                          </span>
                          <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                            {result.subtitle}
                          </span>
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                          {result.actionLabel}
                        </span>
                      </button>
                    ))}
                  </div>
                )
              ) : paletteMode === "chat" ? (
                <WorkspaceAiChatPanel
                  ownerKey={ownerKey}
                  availableTags={sortedTags}
                  draft={workspaceChatDraft}
                  onDraftChange={setWorkspaceChatDraft}
                  onSubmit={() => void handleWorkspaceChatSubmit()}
                  messages={workspaceChatMessages}
                  isLoading={isWorkspaceChatLoading}
                  error={workspaceChatError}
                  onClearError={() => setWorkspaceChatError("")}
                  onOpenSource={handleOpenWorkspaceKnowledgeSource}
                  onCycleMode={cyclePaletteMode}
                />
              ) : paletteMode === "replace" ? (
                <FindReplacePanel
                  ownerKey={ownerKey}
                  currentPageId={selectedPage?._id ?? null}
                  currentPageTitle={selectedPage?.title ?? null}
                  onSelectResult={handleSelectNodeSearchResult}
                  onApplied={(message) => {
                    setCopySnackbarMessage(message);
                  }}
                />
              ) : paletteMode === "archive" ? (
                <ArchiveSearchPanel
                  ownerKey={ownerKey}
                  onSelectResult={handleSelectNodeSearchResult}
                />
              ) : paletteMode === "migration" ? (
                <MigrationPanel ownerKey={ownerKey} />
              ) : paletteMode === "importer" ? (
                <ImporterPanel
                  ownerKey={ownerKey}
                  pages={pages ?? []}
                  initialPageId={selectedPage?._id ?? null}
                  onImport={handleImportTextNodes}
                  onImported={() => {
                    setPaletteOpen(false);
                    setPaletteQuery("");
                    setPaletteMode("pages");
                    setTextSearchResults([]);
                    setNodeSearchResults([]);
                  }}
                />
              ) : paletteMode === "screenshotImport" ? (
                <ScreenshotImportPanel
                  ownerKey={ownerKey}
                  canImport={canImportScreenshot}
                  targetLabel={screenshotImportTargetLabel}
                  onImport={handleImportScreenshotNodes}
                  onImported={() => {
                    setPaletteOpen(false);
                    setPaletteQuery("");
                    setPaletteMode("pages");
                    setTextSearchResults([]);
                    setNodeSearchResults([]);
                  }}
                />
              ) : paletteMode === "taskSchedule" ? (
                taskScheduleTargetNode ? (
                  <TaskSchedulePanel
                    taskTitle={taskScheduleTargetNode.text}
                    dueAt={taskScheduleEffectiveDueRange.dueAt}
                    dueEndAt={taskScheduleEffectiveDueRange.dueEndAt}
                    recurrenceFrequency={getNodeRecurrenceFrequency(taskScheduleTargetNode)}
                    recurringCompletionMode={recurringCompletionMode}
                    onRecurringCompletionModeChange={setRecurringCompletionMode}
                    onSave={(args) => handleSaveTaskSchedule(args)}
                    onSaved={() => {
                      setCopySnackbarMessage("Task schedule saved");
                      setPaletteOpen(false);
                      setPaletteQuery("");
                      setPaletteMode("pages");
                      setTextSearchResults([]);
                      setNodeSearchResults([]);
                    }}
                  />
                ) : (
                  <div className="px-5 py-8 text-sm text-[var(--workspace-text-subtle)]">
                    Highlight a task, or open the command palette while your caret is inside a task, then choose <span className="text-[var(--workspace-text)]">Set Task Schedule</span>.
                  </div>
                )
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {copySnackbarMessage ? (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-40 -translate-x-1/2 md:bottom-6">
          <div className="border border-[var(--workspace-border)] bg-[color-mix(in_srgb,var(--workspace-surface)_92%,transparent)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text)] shadow-[0_18px_40px_-28px_rgba(0,0,0,0.5)] backdrop-blur-sm">
            {copySnackbarMessage}
          </div>
        </div>
      ) : null}
      </main>
    </WorkspaceHistoryProvider>
  );
}

function AiPromptEditorPanel({
  userNote,
  onUserNoteChange,
  systemPrompt,
  userPromptPreview,
  helperText,
}: {
  userNote: string;
  onUserNoteChange: (value: string) => void;
  systemPrompt: string;
  userPromptPreview: string;
  helperText: string;
}) {
  return (
    <div className="border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] p-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
            Add Note For AI
          </span>
          <textarea
            value={userNote}
            onChange={(event) => onUserNoteChange(event.target.value)}
            rows={4}
            placeholder="Optional extra instruction to prepend before the default request…"
            className="mt-2 w-full resize-y border border-[var(--workspace-border)] bg-transparent px-3 py-2 text-sm leading-6 text-[var(--workspace-text)] outline-none transition focus:border-[var(--workspace-accent)]"
          />
        </label>
        <div className="space-y-4">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              System Prompt
            </span>
            <textarea
              readOnly
              value={systemPrompt}
              rows={5}
              className="mt-2 w-full resize-y border border-[var(--workspace-border-subtle)] bg-transparent px-3 py-2 text-xs leading-5 text-[var(--workspace-text-subtle)] outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
              User Prompt Preview
            </span>
            <textarea
              readOnly
              value={userPromptPreview}
              rows={10}
              className="mt-2 w-full resize-y border border-[var(--workspace-border-subtle)] bg-transparent px-3 py-2 text-xs leading-5 text-[var(--workspace-text-subtle)] outline-none"
            />
          </label>
        </div>
      </div>
      <p className="mt-3 text-xs leading-5 text-[var(--workspace-text-faint)]">{helperText}</p>
    </div>
  );
}

function PageSection({
  title,
  sectionNode,
  ownerKey,
  pageId,
  nodeBacklinkCounts,
  nodeMap,
  createNodesBatch,
  insertOutlineClipboardNodes,
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
  onSetSelectedNodeIds,
  buildDraggedNodePayload,
  onDropDraggedNodes,
  onSelectionStart,
  onSelectionExtend,
  availableTags,
  pagesByTitle,
  pagesById = new Map(),
  onOpenPage,
  onOpenNode,
  onOpenTag,
  onOpenFindQuery,
  recurringCompletionMode,
  depthOffset = 0,
  mobileIndentStep = 0,
  action = null,
  headerDetail = null,
  statusMessage = "",
  compact = false,
  showHeader = true,
}: {
  title: string;
  sectionNode: TreeNode | null;
  ownerKey: string;
  pageId: Id<"pages">;
  nodeBacklinkCounts: Map<string, number>;
  nodeMap: Map<string, Doc<"nodes">>;
  createNodesBatch: CreateNodesBatchMutation;
  insertOutlineClipboardNodes: InsertOutlineClipboardNodesFn;
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
  onSetSelectedNodeIds: (nodeIds: string[]) => void;
  buildDraggedNodePayload: BuildDraggedNodePayloadFn;
  onDropDraggedNodes: DropDraggedNodesFn;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
  availableTags: SidebarTagResult[];
  pagesByTitle: Map<string, PageDoc>;
  pagesById?: Map<string, PageDoc>;
  onOpenPage: (pageId: Id<"pages">) => void;
  onOpenNode: (pageId: Id<"pages">, nodeId: Id<"nodes">) => void;
  onOpenTag: (tag: string) => void;
  onOpenFindQuery: (query: string) => void;
  recurringCompletionMode: RecurringCompletionMode;
  depthOffset?: number;
  mobileIndentStep?: number;
  action?: ReactNode;
  headerDetail?: ReactNode;
  statusMessage?: string;
  compact?: boolean;
  showHeader?: boolean;
}) {
  return (
    <div
      data-section-slot={
        typeof getNodeMeta(sectionNode).sectionSlot === "string"
          ? (getNodeMeta(sectionNode).sectionSlot as string)
          : undefined
      }
    >
      {showHeader ? (
        <>
          <div className="flex items-center justify-between gap-4">
            <h2
              className={clsx(
                compact
                  ? "text-xs font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]"
                  : "text-2xl font-semibold tracking-tight text-[var(--workspace-text-subtle)]",
              )}
            >
              {title}
            </h2>
            {action}
          </div>
          {statusMessage ? (
            <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">{statusMessage}</p>
          ) : null}
          {headerDetail ? <div className="mt-3">{headerDetail}</div> : null}
          <div className="mt-2 border-b border-[var(--workspace-border)]" />
        </>
      ) : null}
      <div
        className={clsx(
          showHeader ? (compact ? "mt-3 space-y-1" : "mt-4 space-y-1") : "space-y-1",
        )}
      >
        <OutlineNodeList
          nodes={sectionNode?.children ?? []}
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={(sectionNode?._id as Id<"nodes"> | null) ?? null}
          nodeBacklinkCounts={nodeBacklinkCounts}
          nodeMap={nodeMap}
          createNodesBatch={createNodesBatch}
          insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
          onSetSelectedNodeIds={onSetSelectedNodeIds}
          buildDraggedNodePayload={buildDraggedNodePayload}
          onDropDraggedNodes={onDropDraggedNodes}
          onSelectionStart={onSelectionStart}
          onSelectionExtend={onSelectionExtend}
          availableTags={availableTags}
          pagesByTitle={pagesByTitle}
          pagesById={pagesById}
          onOpenPage={onOpenPage}
          onOpenNode={onOpenNode}
          onOpenTag={onOpenTag}
          onOpenFindQuery={onOpenFindQuery}
          recurringCompletionMode={recurringCompletionMode}
          mobileIndentStep={mobileIndentStep}
        />
      </div>
    </div>
  );
}

function OutlineNodeList({
  nodes,
  ownerKey,
  pageId,
  nodeBacklinkCounts,
  nodeMap,
  createNodesBatch,
  insertOutlineClipboardNodes,
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
  onSetSelectedNodeIds,
  buildDraggedNodePayload,
  onDropDraggedNodes,
  onSelectionStart,
  onSelectionExtend,
  availableTags,
  pagesByTitle,
  pagesById = new Map(),
  onOpenPage,
  onOpenNode,
  onOpenTag,
  onOpenFindQuery,
  recurringCompletionMode,
  mobileIndentStep = 0,
}: {
  nodes: TreeNode[];
  ownerKey: string;
  pageId: Id<"pages">;
  nodeBacklinkCounts: Map<string, number>;
  nodeMap: Map<string, Doc<"nodes">>;
  createNodesBatch: CreateNodesBatchMutation;
  insertOutlineClipboardNodes: InsertOutlineClipboardNodesFn;
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
  onSetSelectedNodeIds: (nodeIds: string[]) => void;
  buildDraggedNodePayload: BuildDraggedNodePayloadFn;
  onDropDraggedNodes: DropDraggedNodesFn;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
  availableTags: SidebarTagResult[];
  pagesByTitle: Map<string, PageDoc>;
  pagesById?: Map<string, PageDoc>;
  onOpenPage: (pageId: Id<"pages">) => void;
  onOpenNode: (pageId: Id<"pages">, nodeId: Id<"nodes">) => void;
  onOpenTag: (tag: string) => void;
  onOpenFindQuery: (query: string) => void;
  recurringCompletionMode: RecurringCompletionMode;
  mobileIndentStep?: number;
}) {
  return (
    <>
      {nodes.length === 0 ? (
        <InlineComposer
          key={`empty-composer:${pageId}:${parentNodeId ?? "root"}`}
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={parentNodeId}
          treeScopeNodes={nodes}
          nodeMap={nodeMap}
          availableTags={availableTags}
          createNodesBatch={createNodesBatch}
          insertOutlineClipboardNodes={insertOutlineClipboardNodes}
          historyInstanceKey={`empty:${pageId}:${parentNodeId ?? "root"}`}
          readOnly={isPageReadOnly}
          depth={depth}
          mobileIndentStep={mobileIndentStep}
          persistWhenEmpty
          onBeginTextEditing={onBeginTextEditing}
          onSubmitted={(createdNodes, reason) => {
            if (reason === "enter") {
              const lastCreatedNode = createdNodes[createdNodes.length - 1];
              if (lastCreatedNode) {
                onOpenInsertedComposer(
                  pageId,
                  ((lastCreatedNode.parentNodeId as Id<"nodes"> | null) ?? null),
                  lastCreatedNode._id as Id<"nodes">,
                );
              }
            }
          }}
        />
      ) : null}
      {nodes.map((node, index) => (
        <OutlineNodeEditor
          key={node._id}
          node={node}
          previousSibling={index > 0 ? nodes[index - 1]! : null}
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={parentNodeId}
          nodeBacklinkCounts={nodeBacklinkCounts}
          nodeBacklinkCount={nodeBacklinkCounts.get(node._id as string) ?? 0}
          nodeMap={nodeMap}
          createNodesBatch={createNodesBatch}
          insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
          onSetSelectedNodeIds={onSetSelectedNodeIds}
          buildDraggedNodePayload={buildDraggedNodePayload}
          onDropDraggedNodes={onDropDraggedNodes}
          onSelectionStart={onSelectionStart}
          onSelectionExtend={onSelectionExtend}
          availableTags={availableTags}
          pagesByTitle={pagesByTitle}
          pagesById={pagesById}
          onOpenPage={onOpenPage}
          onOpenNode={onOpenNode}
          onOpenTag={onOpenTag}
          onOpenFindQuery={onOpenFindQuery}
          recurringCompletionMode={recurringCompletionMode}
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
  emptyMessage = "No matching suggestions.",
}: {
  suggestions: LinkSuggestion[];
  highlightIndex: number;
  onHover: (index: number) => void;
  onSelect: (suggestion: LinkSuggestion) => void;
  anchorRef: RefObject<HTMLElement | null>;
  emptyMessage?: string;
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
          {emptyMessage}
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

function getInlinePreviewStyle({
  strike,
  italic,
  bold,
  code,
  underline,
}: {
  strike: boolean;
  italic: boolean;
  bold: boolean;
  code: boolean;
  underline: boolean;
}): CSSProperties {
  return {
    textDecorationLine: underline
      ? (strike ? "underline line-through" : "underline")
      : strike
        ? "line-through"
        : undefined,
    fontStyle: italic ? "italic" : undefined,
    fontWeight: bold ? 700 : undefined,
    fontFamily: code
      ? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace"
      : undefined,
    fontSize: code ? "0.92em" : undefined,
    backgroundColor: code
      ? "color-mix(in srgb, var(--workspace-border-subtle) 55%, transparent)"
      : undefined,
    borderRadius: code ? "0.24rem" : undefined,
    paddingInline: code ? "0.22em" : undefined,
  };
}

function LinkedTextPreview({
  segments,
  onFocusLine,
  onOpenPage,
  onOpenNode,
  onOpenTag,
  isDisabled,
  isCompleted,
  className,
}: {
  segments: LinkPreviewSegment[];
  onFocusLine: () => void;
  onOpenPage: (pageId: Id<"pages">) => void;
  onOpenNode: (pageId: Id<"pages">, nodeId: Id<"nodes">) => void;
  onOpenTag: (tag: string) => void;
  isDisabled: boolean;
  isCompleted: boolean;
  className?: string;
}) {
  const renderedSegments = applyInlineFormattingToPreviewSegments(segments);

  return (
    <div
      className={clsx(
        "absolute inset-0 z-10 whitespace-pre-wrap break-words px-0",
        isDisabled ? "cursor-default" : "cursor-text",
        className,
      )}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-inline-preview-interactive='true']")) {
          return;
        }
        if (isDisabled) {
          return;
        }
        event.preventDefault();
        onFocusLine();
      }}
    >
      {renderedSegments.map((segment) =>
        segment.kind === "text" ? (
          <span
            key={segment.key}
            style={getInlinePreviewStyle({
              strike: segment.strike || isCompleted,
              italic: segment.italic,
              bold: segment.bold,
              code: segment.code,
              underline: false,
            })}
          >
            {segment.text}
          </span>
        ) : segment.kind === "tag" ? (
          <button
            key={segment.key}
            type="button"
            data-inline-preview-interactive="true"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenTag(segment.text);
            }}
              className={clsx(
                "inline cursor-pointer decoration-[1.5px] underline-offset-[3px] transition",
                isCompleted
                  ? "text-[var(--workspace-text-faint)] hover:text-[var(--workspace-text-faint)]"
                  : "text-[var(--workspace-brand)] hover:text-[var(--workspace-brand-hover)]",
              )}
            style={getInlinePreviewStyle({
              strike: segment.strike || isCompleted,
              italic: segment.italic,
              bold: segment.bold,
              code: segment.code,
              underline: true,
            })}
          >
            {segment.text}
          </button>
        ) : (
          segment.linkKind === "external" ? (
            <a
              key={segment.key}
              href={segment.href ?? "#"}
              target="_blank"
              rel="noreferrer noopener"
              data-inline-preview-interactive="true"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
              }}
              className={clsx(
                "inline cursor-pointer decoration-[1.5px] underline-offset-[3px] transition",
                isCompleted
                  ? "text-[var(--workspace-text-faint)] hover:text-[var(--workspace-text-faint)]"
                  : "text-[var(--workspace-brand)] hover:text-[var(--workspace-brand-hover)]",
              )}
              style={getInlinePreviewStyle({
                strike: segment.strike || isCompleted,
                italic: segment.italic,
                bold: segment.bold,
                code: segment.code,
                underline: true,
              })}
            >
              {segment.text}
            </a>
          ) : segment.pageId !== null ? (
            <button
              key={segment.key}
              type="button"
              data-inline-preview-interactive="true"
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
                "inline-flex max-w-full align-top cursor-pointer items-start gap-1 text-left transition",
                isCompleted
                  ? "text-[var(--workspace-text-faint)] hover:text-[var(--workspace-text-faint)]"
                  : "text-[var(--workspace-brand)] hover:text-[var(--workspace-brand-hover)]",
                segment.archived ? "opacity-75" : "",
              )}
            >
              <span
                className={clsx(
                  "min-w-0 decoration-[1.5px] underline-offset-[3px]",
                )}
                style={getInlinePreviewStyle({
                  strike: segment.strike || isCompleted,
                  italic: segment.italic,
                  bold: segment.bold,
                  code: segment.code,
                  underline: true,
                })}
              >
                {segment.text}
              </span>
              {segment.pageTypeBadge ? (
                <span
                  className={clsx(
                    "inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] px-1 text-[10px] leading-none no-underline",
                    isCompleted ? "opacity-70" : "",
                  )}
                >
                  {segment.pageTypeBadge}
                </span>
              ) : null}
            </button>
          ) : (
            <span
              key={segment.key}
              className={clsx(
                "inline decoration-[1.5px] underline-offset-[3px]",
                isCompleted
                  ? "text-[var(--workspace-text-faint)]"
                  : "text-[var(--workspace-brand)]",
                segment.linkKind === "node"
                  ? "decoration-dotted"
                  : "decoration-[var(--workspace-brand)]/70",
                segment.resolved ? "" : "opacity-80",
              )}
              style={getInlinePreviewStyle({
                strike: segment.strike || isCompleted,
                italic: segment.italic,
                bold: segment.bold,
                code: segment.code,
                underline: true,
              })}
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
  const { segments: renderedSegments } = splitTextForInlineFormatting(text);

  return (
    <div
      className={clsx(
        "absolute inset-0 z-10 whitespace-pre-wrap break-words px-0",
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
      {renderedSegments.map((segment) => (
        <span
          key={segment.key}
          style={getInlinePreviewStyle({
            strike: segment.strike,
            italic: segment.italic,
            bold: segment.bold,
            code: segment.code,
            underline: false,
          })}
        >
          {segment.text}
        </span>
      ))}
    </div>
  );
}

function LinkPreviewMeasure({
  segments,
  isCompleted,
  className,
  measureRef,
}: {
  segments: LinkPreviewSegment[];
  isCompleted: boolean;
  className?: string;
  measureRef?: RefObject<HTMLDivElement | null>;
}) {
  const renderedSegments = applyInlineFormattingToPreviewSegments(segments);

  return (
    <div
      ref={measureRef}
      aria-hidden="true"
      className={clsx(
        "pointer-events-none absolute left-0 right-0 top-0 invisible whitespace-pre-wrap break-words px-0",
        className,
      )}
    >
      {renderedSegments.map((segment) =>
        segment.kind === "text" ? (
          <span
            key={segment.key}
            style={getInlinePreviewStyle({
              strike: segment.strike || isCompleted,
              italic: segment.italic,
              bold: segment.bold,
              code: segment.code,
              underline: false,
            })}
          >
            {segment.text}
          </span>
        ) : segment.kind === "tag" ? (
          <span
            key={segment.key}
            className={clsx(
              "inline decoration-[1.5px] underline-offset-[3px]",
              isCompleted
                ? "text-[var(--workspace-text-faint)]"
                : "text-[var(--workspace-brand)]",
            )}
            style={getInlinePreviewStyle({
              strike: segment.strike || isCompleted,
              italic: segment.italic,
              bold: segment.bold,
              code: segment.code,
              underline: true,
            })}
          >
            {segment.text}
          </span>
        ) : (
          <span
            key={segment.key}
            className={clsx(
              "inline-flex max-w-full align-top items-start gap-1 text-left",
              isCompleted
                ? "text-[var(--workspace-text-faint)]"
                : "text-[var(--workspace-brand)]",
              segment.archived ? "opacity-75" : "",
              !segment.resolved ? "opacity-80" : "",
            )}
          >
            <span
              className={clsx(
                "min-w-0 decoration-[1.5px] underline-offset-[3px]",
              )}
              style={getInlinePreviewStyle({
                strike: segment.strike || isCompleted,
                italic: segment.italic,
                bold: segment.bold,
                code: segment.code,
                underline: true,
              })}
            >
              {segment.text}
            </span>
            {segment.pageTypeBadge ? (
              <span
                className={clsx(
                  "inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)] px-1 text-[10px] leading-none no-underline",
                  isCompleted ? "opacity-70" : "",
                )}
              >
                {segment.pageTypeBadge}
              </span>
            ) : null}
          </span>
        ),
      )}
    </div>
  );
}

function PlainTextMeasure({
  text,
  className,
  measureRef,
}: {
  text: string;
  className?: string;
  measureRef?: RefObject<HTMLDivElement | null>;
}) {
  const { segments: renderedSegments } = splitTextForInlineFormatting(text);

  return (
    <div
      ref={measureRef}
      aria-hidden="true"
      className={clsx(
        "pointer-events-none absolute left-0 right-0 top-0 invisible whitespace-pre-wrap break-words px-0",
        className,
      )}
    >
      {renderedSegments.map((segment) => (
        <span
          key={segment.key}
          style={getInlinePreviewStyle({
            strike: segment.strike,
            italic: segment.italic,
            bold: segment.bold,
            code: segment.code,
            underline: false,
          })}
        >
          {segment.text}
        </span>
      ))}
    </div>
  );
}

function getNodeTypographyClass({
  isTaskRow,
  headingLevel,
}: {
  isTaskRow: boolean;
  headingLevel: 1 | 2 | 3 | null;
}) {
  if (headingLevel !== null) {
    return clsx("py-0", getHeadingPreviewClass(headingLevel));
  }

  if (isTaskRow) {
    return "py-0 text-[15px] leading-[1.35rem]";
  }

  return "py-0.5 text-[15px] leading-[1.45rem]";
}

function WorkspaceAiChatPanel({
  ownerKey,
  availableTags,
  draft,
  onDraftChange,
  onSubmit,
  messages,
  isLoading,
  error,
  onClearError,
  onOpenSource,
  onCycleMode,
}: {
  ownerKey: string;
  availableTags: SidebarTagResult[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  messages: Doc<"chatMessages">[];
  isLoading: boolean;
  error: string;
  onClearError: () => void;
  onOpenSource: (source: WorkspaceKnowledgeSourceSnapshot) => void;
  onCycleMode: (direction: -1 | 1) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const shouldStickHistoryToBottomRef = useRef(true);
  const [caretPosition, setCaretPosition] = useState<number | null>(null);
  const [linkHighlightIndex, setLinkHighlightIndex] = useState(0);
  const activeLinkToken = getActiveLinkToken(draft, caretPosition);
  const activeTagToken = activeLinkToken ? null : getActiveTagToken(draft, caretPosition);
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
  const tagSuggestions = useMemo(
    () =>
      activeTagToken ? buildTagSuggestions(availableTags, activeTagToken.query) : [],
    [activeTagToken, availableTags],
  );
  const autocompleteToken = activeLinkToken ?? activeTagToken;
  const autocompleteSuggestions = activeLinkToken ? linkSuggestions : tagSuggestions;
  const activeLinkHighlightIndex =
    autocompleteSuggestions.length === 0
      ? 0
      : Math.min(linkHighlightIndex, autocompleteSuggestions.length - 1);
  const showHistoryPanel = messages.length > 0 || error.length > 0 || isLoading;

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [draft]);

  useEffect(() => {
    const container = historyRef.current;
    if (!container) {
      return;
    }

    if (!shouldStickHistoryToBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      historyEndRef.current?.scrollIntoView({ block: "end" });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [error, isLoading, messages]);

  const applyLinkSuggestion = (suggestion: LinkSuggestion) => {
    if (!autocompleteToken) {
      return;
    }

    const nextValue =
      draft.slice(0, autocompleteToken.startIndex) +
      suggestion.insertText +
      draft.slice(autocompleteToken.endIndex);
    const nextCaretPosition = autocompleteToken.startIndex + suggestion.insertText.length;

    onDraftChange(nextValue);
    setCaretPosition(nextCaretPosition);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  };

  const handleKeyDown = (event: TextareaKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      onCycleMode(event.key === "ArrowRight" ? 1 : -1);
      return;
    }

    if (autocompleteToken && autocompleteSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setLinkHighlightIndex((current) =>
          Math.min(current + 1, autocompleteSuggestions.length - 1),
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
        const highlighted = autocompleteSuggestions[activeLinkHighlightIndex];
        if (highlighted) {
          applyLinkSuggestion(highlighted);
        }
        return;
      }

      if (event.key === "Tab") {
        const highlighted = autocompleteSuggestions[activeLinkHighlightIndex];
        if (highlighted) {
          event.preventDefault();
          applyLinkSuggestion(highlighted);
          return;
        }
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      shouldStickHistoryToBottomRef.current = true;
      onSubmit();
    }
  };

  return (
    <div
      data-workspace-ai-chat-panel="true"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--workspace-border-subtle)] px-5 py-3">
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
      </div>
      {showHistoryPanel ? (
        <div
          ref={historyRef}
          onScroll={(event) => {
            const container = event.currentTarget;
            const distanceFromBottom =
              container.scrollHeight - container.scrollTop - container.clientHeight;
            shouldStickHistoryToBottomRef.current = distanceFromBottom <= 40;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-b border-[var(--workspace-border-subtle)] px-5 py-4 [touch-action:pan-y]"
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
            <div ref={historyEndRef} aria-hidden="true" className="h-px w-full" />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-8 text-sm text-[var(--workspace-text-subtle)]">
          Start a persistent workspace conversation.
        </div>
      )}
      <div className="relative shrink-0 border-t border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-muted)] px-5 py-4">
        {isLoading ? (
          <div className="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
            <span>AI is responding…</span>
            <span className="text-[var(--workspace-accent)]">Grounding context</span>
          </div>
        ) : null}
        <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <textarea
            id={WORKSPACE_AI_CHAT_TEXTAREA_ID}
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
            placeholder="Ask AI…"
            rows={1}
            disabled={isLoading}
            className="w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[15px] leading-6 outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            shouldStickHistoryToBottomRef.current = true;
            onSubmit();
          }}
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
        {autocompleteToken ? (
          <LinkAutocompleteMenu
            anchorRef={textareaRef}
            suggestions={autocompleteSuggestions}
            highlightIndex={activeLinkHighlightIndex}
            onHover={setLinkHighlightIndex}
            onSelect={applyLinkSuggestion}
            emptyMessage={
              activeLinkToken
                ? "No matching pages or nodes."
                : "No matching tags."
            }
          />
        ) : null}
        </div>
      </div>
    </div>
  );
}

function PlannerAiChatPanel({
  draft,
  onDraftChange,
  onSubmit,
  messages,
  isLoading,
  error,
  onClearError,
  onApplyPlan,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  messages: Doc<"chatMessages">[];
  isLoading: boolean;
  error: string;
  onClearError: () => void;
  onApplyPlan: (messageId: Id<"chatMessages">) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [draft]);

  useEffect(() => {
    const container = historyRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [messages, error, isLoading]);

  return (
    <div className="border border-[var(--workspace-border)] bg-[var(--workspace-surface-muted)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--workspace-border-subtle)] px-5 py-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
            Planner AI
          </p>
          <p className="text-[11px] text-[var(--workspace-text-faint)]">
            Preview planner changes before applying them.
          </p>
        </div>
      </div>
      <div
        ref={historyRef}
        className="max-h-[22rem] min-h-[10rem] overflow-y-auto border-b border-[var(--workspace-border-subtle)] px-5 py-4"
      >
        <div className="space-y-4">
          {messages.length === 0 ? (
            <p className="text-sm text-[var(--workspace-text-subtle)]">
              Ask the planner AI to adjust today’s plan, finish a task, or clean up planner-only items.
            </p>
          ) : null}
          {messages.map((message) => {
            const isUser = message.role === "user";
            const parsedPlan =
              !isUser && message.proposedPlan
                ? plannerChatPlanSchema.safeParse(message.proposedPlan)
                : null;
            return (
              <div
                key={message._id}
                className={clsx("flex", isUser ? "justify-end" : "justify-start")}
              >
                <div
                  className={clsx(
                    "max-w-3xl border px-4 py-3",
                    isUser
                      ? "border-[var(--workspace-brand)] bg-[color-mix(in_srgb,var(--workspace-brand)_14%,transparent)]"
                      : "border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface)]",
                  )}
                >
                  <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                    {isUser ? "You" : "Planner AI"}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--workspace-text)]">
                    {message.text}
                  </p>
                  {!isUser && parsedPlan?.success ? (
                    <div className="mt-3 space-y-2 border-t border-[var(--workspace-border-subtle)] pt-3">
                      {parsedPlan.data.preview.map((line, index) => (
                        <p
                          key={`${message._id}:preview:${index}`}
                          className="text-sm text-[var(--workspace-text-subtle)]"
                        >
                          {line}
                        </p>
                      ))}
                      {message.status === "pending_approval" ? (
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() => onApplyPlan(message._id)}
                            className="border border-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)]"
                          >
                            Apply Changes
                          </button>
                        </div>
                      ) : (
                        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                          {message.status === "applied" ? "Applied" : "Ready"}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          {isLoading ? (
            <div className="border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface)] px-4 py-3 text-sm text-[var(--workspace-text-subtle)]">
              Planner AI is thinking…
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
      <div className="flex items-end gap-3 px-5 py-4">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            if (error) {
              onClearError();
            }
            onDraftChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          placeholder="Plan with AI…"
          className="min-h-[2.75rem] flex-1 resize-none overflow-hidden border border-[var(--workspace-border)] bg-[var(--workspace-surface)] px-3 py-2 text-[15px] leading-6 outline-none"
        />
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
          {isLoading ? "Thinking…" : "Plan with AI"}
        </button>
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
  nodeBacklinkCounts,
  nodeBacklinkCount,
  nodeMap,
  createNodesBatch,
  insertOutlineClipboardNodes,
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
  onSetSelectedNodeIds,
  buildDraggedNodePayload,
  onDropDraggedNodes,
  onSelectionStart,
  onSelectionExtend,
  availableTags,
  pagesByTitle,
  pagesById = new Map(),
  onOpenPage,
  onOpenNode,
  onOpenTag,
  onOpenFindQuery,
  recurringCompletionMode,
  mobileIndentStep = 0,
}: {
  node: TreeNode;
  siblings: TreeNode[];
  siblingIndex: number;
  previousSibling: TreeNode | null;
  ownerKey: string;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null;
  nodeBacklinkCounts: Map<string, number>;
  nodeBacklinkCount: number;
  nodeMap: Map<string, Doc<"nodes">>;
  createNodesBatch: CreateNodesBatchMutation;
  insertOutlineClipboardNodes: InsertOutlineClipboardNodesFn;
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
  onSetSelectedNodeIds: (nodeIds: string[]) => void;
  buildDraggedNodePayload: BuildDraggedNodePayloadFn;
  onDropDraggedNodes: DropDraggedNodesFn;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
  availableTags: SidebarTagResult[];
  pagesByTitle: Map<string, PageDoc>;
  pagesById?: Map<string, PageDoc>;
  onOpenPage: (pageId: Id<"pages">) => void;
  onOpenNode: (pageId: Id<"pages">, nodeId: Id<"nodes">) => void;
  onOpenTag: (tag: string) => void;
  onOpenFindQuery: (query: string) => void;
  recurringCompletionMode: RecurringCompletionMode;
  mobileIndentStep?: number;
}) {
  const history = useWorkspaceHistory();
  const completePlannerTaskMutation = useMutation(api.planner.completePlannerTask);
  const [draft, setDraft] = useState(node.text);
  const [isFocused, setIsFocused] = useState(false);
  const [caretPosition, setCaretPosition] = useState<number | null>(null);
  const [linkHighlightIndex, setLinkHighlightIndex] = useState(0);
  const [dropTarget, setDropTarget] = useState<NodeDropTarget | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewMeasureRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  const markerHoldTimeoutRef = useRef<number | null>(null);
  const markerLongPressTriggeredRef = useRef(false);
  const childrenAnimationFrameRef = useRef<number | null>(null);

  const nodeMeta = getNodeMeta(node);
  const isNoteCompleted = node.kind === "note" && nodeMeta.noteCompleted === true;
  const isTaskCompleted = node.kind === "task" && node.taskStatus === "done";
  const isCompleted = isTaskCompleted || isNoteCompleted;
  const isLocked = nodeMeta.locked === true;
  const isPlannerTemplateWeekdayRoot =
    typeof nodeMeta.plannerTemplateWeekday === "string" &&
    node.parentNodeId !== null;
  const isPlannerDayRoot =
    nodeMeta.plannerKind === "plannerDay" && node.parentNodeId === null;
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
  const syntaxDisplayDraft = useMemo(
    () => (isDimmedLine ? stripDimmedSyntaxPrefix(draft) : draft),
    [draft, isDimmedLine],
  );
  const headingSyntax = useMemo(
    () => parseHeadingSyntax(syntaxDisplayDraft),
    [syntaxDisplayDraft],
  );
  const displayDraft = headingSyntax.text;
  const isHeadingLine = headingSyntax.level !== null;
  const hasInlineFormattingPreview = hasRenderableInlineFormatting(displayDraft);
  const shouldHideNoteMarker = false;
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
    return buildLinkPreviewSegments(displayDraft, pagesByTitle, pagesById, nodeTargetsById);
  }, [displayDraft, nodeTargetsById, pagesById, pagesByTitle]);
  const hasPageLinkPreview =
    !isFocused &&
    !isVisualEmptyLine &&
    !isVisualSeparatorLine &&
    linkPreviewSegments.length > 0;
  const hasPlainTextPreview =
    !isFocused &&
    !isVisualEmptyLine &&
    !isVisualSeparatorLine &&
    (isDimmedLine || isHeadingLine || hasInlineFormattingPreview) &&
    !hasPageLinkPreview;
  const hasDisplayPreview = hasPageLinkPreview || hasPlainTextPreview;
  const activeLinkToken = getActiveLinkToken(draft, caretPosition);
  const activeTagToken = activeLinkToken ? null : getActiveTagToken(draft, caretPosition);
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
  const tagSuggestions = useMemo(
    () =>
      activeTagToken ? buildTagSuggestions(availableTags, activeTagToken.query) : [],
    [activeTagToken, availableTags],
  );
  const autocompleteToken = activeLinkToken ?? activeTagToken;
  const autocompleteSuggestions = activeLinkToken ? linkSuggestions : tagSuggestions;
  const activeLinkHighlightIndex =
    autocompleteSuggestions.length === 0
      ? 0
      : Math.min(linkHighlightIndex, autocompleteSuggestions.length - 1);
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
  const isTaskRow = node.kind === "task";
  const isHeadingRow = isHeadingLine;
  const hidePlannerTemplateWeekdayMarker = isPlannerTemplateWeekdayRoot;
  const recurrenceFrequency = getNodeRecurrenceFrequency(node);
  const effectiveDueRange = useMemo(
    () => getEffectiveTaskDueDateRange(node, nodeMap),
    [node, nodeMap],
  );
  const dueDateLabel =
    node.kind === "task"
      ? formatDueDateRange(effectiveDueRange.dueAt, effectiveDueRange.dueEndAt ?? null)
      : "";
  const isOverdueTask =
    node.kind === "task" &&
    !isCompleted &&
    isOverdueDueDateRange(effectiveDueRange.dueAt, effectiveDueRange.dueEndAt ?? null);
  const headingRowMinHeightClass = getHeadingRowMinHeightClass(headingSyntax.level);
  const headingMarkerOffsetClass = getHeadingMarkerOffsetClass(headingSyntax.level);
  const headingControlOffsetClass = getHeadingControlOffsetClass(headingSyntax.level);
  const baseTypographyClass = getNodeTypographyClass({
    isTaskRow,
    headingLevel: headingSyntax.level,
  });
  const previewTypographyClass = clsx(
    baseTypographyClass,
    hasPageLinkPreview && !isTaskRow && !isHeadingRow ? "py-1" : "",
    hasPageLinkPreview && isTaskRow ? "py-0.5" : "",
    hasNestedGrandchildren ? "italic" : "",
  );
  const [shouldRenderChildren, setShouldRenderChildren] = useState(hasChildren && !isCollapsed);
  const [isChildrenExpanded, setIsChildrenExpanded] = useState(hasChildren && !isCollapsed);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    if (!isFocused && hasDisplayPreview) {
      const previewMeasure = previewMeasureRef.current;
      if (previewMeasure) {
        textarea.style.height = "0px";
        const previewHeight = Math.ceil(previewMeasure.getBoundingClientRect().height);
        if (previewHeight > 0) {
          textarea.style.height = `${previewHeight}px`;
          return;
        }
      }
    }

    autoResizeTextarea(textarea);
  }, [
    draft,
    displayDraft,
    hasDisplayPreview,
    isFocused,
    isDimmedLine,
    linkPreviewSegments,
    node.taskStatus,
    previewTypographyClass,
  ]);

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
    if (!autocompleteToken) {
      return;
    }

    const nextValue =
      draft.slice(0, autocompleteToken.startIndex) +
      suggestion.insertText +
      draft.slice(autocompleteToken.endIndex);
    const nextCaretPosition = autocompleteToken.startIndex + suggestion.insertText.length;

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

  const restoreEditorSelection = (
    selectionStart: number,
    selectionEnd: number,
    attemptsRemaining = 2,
  ) => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        if (attemptsRemaining > 0) {
          restoreEditorSelection(selectionStart, selectionEnd, attemptsRemaining - 1);
        }
        return;
      }

      onBeginTextEditing();
      textarea.focus();
      const nextSelectionStart = Math.min(selectionStart, textarea.value.length);
      const nextSelectionEnd = Math.min(selectionEnd, textarea.value.length);
      textarea.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    });
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
    const draggedRootNodeIds =
      payload.rootNodeIds.length > 0 ? payload.rootNodeIds : [payload.nodeId];
    if (
      payload.pageId !== pageId ||
      draggedRootNodeIds.some(
        (draggedRootNodeId) =>
          draggedRootNodeId === node._id || isDescendantOfNode(node._id, draggedRootNodeId),
      )
    ) {
      return null;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeY = event.clientY - bounds.top;
    const relativeX = event.clientX - bounds.left;
    const upperZone = relativeY < bounds.height * 0.35;
    const nestingThreshold = 86;
    const wantsNest = !upperZone && relativeX > nestingThreshold;
    const isLastSibling = siblingIndex === siblings.length - 1;

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

    if (!upperZone && !isLastSibling) {
      return null;
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

    const payload = buildDraggedNodePayload({
      nodeId: node._id,
      pageId,
    });

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(NODE_DRAG_MIME_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", JSON.stringify(payload));
    onSetActiveDraggedNodeId(node._id);
    onSetActiveDraggedNodePayload(payload);
    if (payload.rootNodeIds.length > 1) {
      onSetSelectedNodeIds(payload.rootNodeIds);
    } else {
      onSelectSingleNode(node._id);
    }
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
    await onDropDraggedNodes(payload, nextDropTarget);
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

    const beforeSnapshot = withNodeScheduleSnapshot(
      {
        ...toNodeValueSnapshot(beforeParsed),
        noteCompleted:
          beforeParsed.kind === "note"
            ? isNoteCompleted
            : false,
      },
      node,
    );
    if (
      beforeSnapshot.text === afterValue.text &&
      beforeSnapshot.kind === afterValue.kind &&
      beforeSnapshot.taskStatus === afterValue.taskStatus &&
      beforeSnapshot.noteCompleted === afterValue.noteCompleted &&
      beforeSnapshot.dueAt === afterValue.dueAt &&
      beforeSnapshot.dueEndAt === afterValue.dueEndAt &&
      areRecurrenceFrequenciesEqual(
        beforeSnapshot.recurrenceFrequency ?? null,
        afterValue.recurrenceFrequency ?? null,
      )
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
        parsed: withNodeScheduleSnapshot(
          toNodeValueSnapshot({
            text: node.text,
            kind: node.kind as "note" | "task",
            taskStatus: (node.taskStatus ?? null) as NodeValueSnapshot["taskStatus"],
            noteCompleted: isNoteCompleted,
          }),
          node,
        ),
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

    const nextSnapshot = withNodeScheduleSnapshot(
      {
        ...toNodeValueSnapshot(parsed),
        noteCompleted:
          parsed.kind === "note"
            ? isNoteCompleted
            : false,
      },
      node,
    );
    if (
      parsed.text !== node.text ||
      parsed.kind !== node.kind ||
      parsed.taskStatus !== node.taskStatus
    ) {
      await updateNode({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
        text: nextSnapshot.text,
        kind: nextSnapshot.kind,
        taskStatus: nextSnapshot.taskStatus,
        noteCompleted: nextSnapshot.noteCompleted,
        dueAt: nextSnapshot.dueAt,
        dueEndAt: nextSnapshot.dueEndAt,
        recurrenceFrequency: nextSnapshot.recurrenceFrequency,
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

    if (isPlannerDayTask(node, nodeMap)) {
      await completePlannerTaskMutation({
        ownerKey,
        plannerNodeId: node._id as Id<"nodes">,
        completionMode: recurringCompletionMode,
      });
      history.resetTrackedValue(editorId, editorTarget);
      return;
    }

    const beforeSnapshot = withNodeScheduleSnapshot({
      text: saveResult.parsed.text,
      kind: "task",
      taskStatus: (node.taskStatus ?? "todo") as NodeValueSnapshot["taskStatus"],
      noteCompleted: false,
      dueAt: node.dueAt ?? null,
      dueEndAt: node.dueEndAt ?? null,
      recurrenceFrequency,
    }, node);
    const afterSnapshot =
      getRecurringCompletionTransition(
        {
          text: saveResult.parsed.text,
          kind: node.kind,
          taskStatus: node.taskStatus,
          dueAt: node.dueAt,
          dueEndAt: node.dueEndAt,
          sourceMeta: node.sourceMeta,
        },
        recurringCompletionMode,
      ) ??
      withNodeScheduleSnapshot({
        text: saveResult.parsed.text,
        kind: "task",
        taskStatus: node.taskStatus === "done" ? "todo" : "done",
        noteCompleted: false,
        dueAt: node.dueAt ?? null,
        dueEndAt: node.dueEndAt ?? null,
        recurrenceFrequency,
      }, node);

    if (isPlannerDayItem(node, nodeMap) && !isNoteCompleted) {
      await completePlannerTaskMutation({
        ownerKey,
        plannerNodeId: node._id as Id<"nodes">,
        completionMode: recurringCompletionMode,
      });
      history.resetTrackedValue(editorId, editorTarget);
      return;
    }

    await updateNode({
      ownerKey,
      nodeId: node._id as Id<"nodes">,
      text: afterSnapshot.text,
      kind: afterSnapshot.kind,
      lockKind: true,
      taskStatus: afterSnapshot.taskStatus,
      noteCompleted: false,
      dueAt: afterSnapshot.dueAt,
      dueEndAt: afterSnapshot.dueEndAt,
      recurrenceFrequency: afterSnapshot.recurrenceFrequency,
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

  const handleToggleCompletion = async () => {
    if (isDisabled) {
      return;
    }

    if (node.kind === "task") {
      await handleToggleTask();
      return;
    }

    const saveResult = await commitNodeText(draft);
    if (saveResult.deleted || !saveResult.parsed) {
      return;
    }

    const beforeSnapshot = withNodeScheduleSnapshot({
      text: saveResult.parsed.text,
      kind: "note",
      taskStatus: null,
      noteCompleted: isNoteCompleted,
      dueAt: null,
      dueEndAt: null,
      recurrenceFrequency: null,
    }, node);
    const afterSnapshot = withNodeScheduleSnapshot({
      text: saveResult.parsed.text,
      kind: "note",
      taskStatus: null,
      noteCompleted: !isNoteCompleted,
      dueAt: null,
      dueEndAt: null,
      recurrenceFrequency: null,
    }, node);

    await updateNode({
      ownerKey,
      nodeId: node._id as Id<"nodes">,
      text: afterSnapshot.text,
      kind: afterSnapshot.kind,
      lockKind: true,
      taskStatus: null,
      noteCompleted: afterSnapshot.noteCompleted,
      dueAt: afterSnapshot.dueAt,
      dueEndAt: afterSnapshot.dueEndAt,
      recurrenceFrequency: afterSnapshot.recurrenceFrequency,
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
    const afterSnapshot =
      beforeSnapshot.kind === "task"
        ? withNodeScheduleSnapshot({
            text: beforeSnapshot.text,
            kind: "note",
            taskStatus: null,
            noteCompleted: false,
            dueAt: null,
            dueEndAt: null,
            recurrenceFrequency: null,
          }, beforeSnapshot)
        : withNodeScheduleSnapshot({
            text: beforeSnapshot.text,
            kind: "task",
            taskStatus: "todo",
            noteCompleted: false,
            dueAt: null,
            dueEndAt: null,
            recurrenceFrequency: null,
          }, beforeSnapshot);

    await updateNode({
      ownerKey,
      nodeId: node._id as Id<"nodes">,
      text: afterSnapshot.text,
      kind: afterSnapshot.kind,
      lockKind: true,
      taskStatus: afterSnapshot.taskStatus,
      dueAt: afterSnapshot.dueAt,
      dueEndAt: afterSnapshot.dueEndAt,
      recurrenceFrequency: afterSnapshot.recurrenceFrequency,
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
      withNodeScheduleSnapshot(toNodeValueSnapshot(firstParsed), node),
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

    if (isModifier && !event.shiftKey && !event.altKey && normalizedKey === "k") {
      const replacement = applySelectedLinkShortcut(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
      );

      if (replacement) {
        event.preventDefault();
        setDraft(replacement.value);
        history.updateDraftValue(editorId, editorTarget, replacement.value);
        setCaretPosition(replacement.selectionEnd);
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            replacement.selectionStart,
            replacement.selectionEnd,
          );
        });
        return;
      }
    }

    if (isModifier && !event.shiftKey && !event.altKey && normalizedKey === "i") {
      const replacement = applySelectedInlineFormattingShortcut(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
        "__",
      );

      if (replacement) {
        event.preventDefault();
        setDraft(replacement.value);
        history.updateDraftValue(editorId, editorTarget, replacement.value);
        setCaretPosition(replacement.selectionEnd);
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            replacement.selectionStart,
            replacement.selectionEnd,
          );
        });
        return;
      }

      event.preventDefault();
      return;
    }

    if (isModifier && !event.shiftKey && !event.altKey && normalizedKey === "b") {
      const replacement = applySelectedInlineFormattingShortcut(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
        "**",
      );

      if (replacement) {
        event.preventDefault();
        setDraft(replacement.value);
        history.updateDraftValue(editorId, editorTarget, replacement.value);
        setCaretPosition(replacement.selectionEnd);
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            replacement.selectionStart,
            replacement.selectionEnd,
          );
        });
        return;
      }

      event.preventDefault();
      return;
    }

    if (isModifier && event.shiftKey && !event.altKey && (event.key === "_" || event.key === "-")) {
      const replacement = applySelectedInlineFormattingShortcut(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
        "~~",
      );

      if (replacement) {
        event.preventDefault();
        setDraft(replacement.value);
        history.updateDraftValue(editorId, editorTarget, replacement.value);
        setCaretPosition(replacement.selectionEnd);
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            replacement.selectionStart,
            replacement.selectionEnd,
          );
        });
        return;
      }

      event.preventDefault();
      return;
    }

    if (autocompleteToken && autocompleteSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setLinkHighlightIndex((current) => (current + 1) % autocompleteSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setLinkHighlightIndex((current) =>
          (current - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const suggestion =
          autocompleteSuggestions[activeLinkHighlightIndex] ?? autocompleteSuggestions[0];
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

    if (isModifier && normalizedKey === "enter") {
      event.preventDefault();
      await handleToggleCompletion();
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
      const selectionStart = event.currentTarget.selectionStart ?? draft.length;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
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
      restoreEditorSelection(selectionStart, selectionEnd);
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
      let updateEntry: HistoryEntry | null = null;
      let createEntry: HistoryEntry | null = null;

      if (isStartOfLineSplit) {
        const createdNodes = (await createNodesBatch({
          ownerKey,
          pageId,
          nodes: [
            {
              parentNodeId,
              afterNodeId: previousSibling?._id ? (previousSibling._id as Id<"nodes">) : null,
              text: normalizedHead.text,
              kind: normalizedHead.kind,
              taskStatus: normalizedHead.taskStatus ?? undefined,
            },
          ],
        })) as Doc<"nodes">[];
        const createdNode = createdNodes[0] ?? null;

        await updateNode({
          ownerKey,
          nodeId: node._id as Id<"nodes">,
          text: normalizedTail.text,
          kind: normalizedTail.kind,
          taskStatus: normalizedTail.taskStatus ?? undefined,
          noteCompleted: normalizedTail.kind === "note" ? isNoteCompleted : false,
          dueAt: normalizedTail.kind === "task" ? (node.dueAt ?? null) : null,
          dueEndAt: normalizedTail.kind === "task" ? (node.dueEndAt ?? null) : null,
          recurrenceFrequency: normalizedTail.kind === "task" ? recurrenceFrequency : null,
        });

        const beforeValue = history.commitTrackedValue(
          editorId,
          editorTarget,
          normalizedTail.text,
        );
        setDraft(normalizedTail.text);
        updateEntry = buildUpdateEntry(
          beforeValue,
          withNodeScheduleSnapshot(
            {
              ...toNodeValueSnapshot(normalizedTail),
              noteCompleted:
                normalizedTail.kind === "note"
                  ? isNoteCompleted
                  : false,
            },
            node,
          ),
        );
        createEntry =
          createdNode
            ? ({
                type: "create_nodes",
                pageId,
                nodes: [
                  toCreatedNodeSnapshot(
                    createdNode,
                    previousSibling?._id ? (previousSibling._id as Id<"nodes">) : null,
                  ),
                ],
                focusAfterUndoId: editorId,
                focusAfterRedoId: getNodeEditorId(createdNode._id),
              } satisfies HistoryEntry)
            : null;
      } else {
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
        updateEntry = buildUpdateEntry(beforeValue, toNodeValueSnapshot(normalizedHead));
        createEntry =
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
      }

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
          const createdNodeEditorId = createEntry?.focusAfterRedoId ?? null;
          if (!createdNodeEditorId) {
            return;
          }

          const target = document.querySelector<HTMLElement>(
            `[data-history-editor-id="${createdNodeEditorId}"]`,
          );
          if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) {
            return;
          }

          target.focus();
          target.setSelectionRange(0, 0);
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
    <div
      className={clsx(
        "space-y-px",
        isPlannerDayRoot ? "mb-8" : "",
      )}
    >
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
        <div
          className={clsx(
            "flex items-start",
            hidePlannerTemplateWeekdayMarker ? "gap-0" : "gap-1.5",
            isHeadingRow ? headingRowMinHeightClass : "min-h-0",
          )}
        >
          <div
            className={clsx(
              "flex flex-none justify-center text-[var(--workspace-text-faint)]",
              hidePlannerTemplateWeekdayMarker ? "w-0 overflow-hidden opacity-0" : "w-4",
              isHeadingRow
                ? clsx("items-start", headingMarkerOffsetClass)
                : isTaskRow
                  ? "items-start pt-[2px]"
                  : "items-start pt-[5px]",
            )}
          >
            {hidePlannerTemplateWeekdayMarker ||
            isLocked ||
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
                  shouldHideNoteMarker ? "opacity-0" : "",
                  isDisabled ? "cursor-not-allowed opacity-60" : "",
                )}
              >
                <span className="h-2 w-2 rounded-full bg-current" />
              </button>
            )}
          </div>
          <div
            className={clsx(
              "relative flex min-h-0 min-w-0 flex-1 items-start",
              isHeadingRow ? "self-stretch" : "",
            )}
          >
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
                "w-full resize-none overflow-hidden border-0 border-b border-transparent bg-transparent px-0 text-[15px] outline-none transition focus:border-[var(--workspace-border)] disabled:text-[var(--workspace-text-muted)]",
                previewTypographyClass,
                isDraggingAnotherNode ? "pointer-events-none select-none" : "",
                isCompleted ? "text-[var(--workspace-text-faint)] line-through" : "",
                isDimmedLine && !isCompleted
                  ? "text-[var(--workspace-text-subtle)]"
                  : "",
                (isVisualEmptyLine || isVisualSeparatorLine) && !shouldRevealVisualPlaceholder
                  ? "text-transparent"
                  : "",
                hasDisplayPreview
                  ? isDisabled
                    ? "invisible"
                    : "text-transparent caret-transparent"
                  : "",
              )}
              />
            {hasPageLinkPreview ? (
              <LinkPreviewMeasure
                measureRef={previewMeasureRef}
                segments={linkPreviewSegments}
                isCompleted={isCompleted}
                className={clsx(
                  previewTypographyClass,
                  isCompleted
                    ? "text-[var(--workspace-text-faint)] line-through"
                    : isDimmedLine
                      ? "text-[var(--workspace-text-subtle)]"
                      : "text-[var(--workspace-text)]",
                )}
              />
            ) : hasPlainTextPreview ? (
              <PlainTextMeasure
                measureRef={previewMeasureRef}
                text={displayDraft}
                className={clsx(
                  previewTypographyClass,
                  isCompleted
                    ? "text-[var(--workspace-text-faint)] line-through"
                    : isDimmedLine
                      ? "text-[var(--workspace-text-subtle)]"
                      : "text-[var(--workspace-text)]",
                )}
              />
            ) : null}
            {hasPageLinkPreview ? (
              <LinkedTextPreview
                segments={linkPreviewSegments}
                onFocusLine={focusLineEditor}
                onOpenPage={onOpenPage}
                onOpenNode={onOpenNode}
                onOpenTag={onOpenTag}
                isDisabled={isDisabled || activeDraggedNodeId !== null}
                isCompleted={isCompleted}
                className={clsx(
                  previewTypographyClass,
                  isCompleted
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
                  previewTypographyClass,
                  isCompleted
                    ? "text-[var(--workspace-text-faint)] line-through"
                    : isDimmedLine
                      ? "text-[var(--workspace-text-subtle)]"
                      : "text-[var(--workspace-text)]",
                )}
              />
            ) : null}
            {isFocused && autocompleteToken ? (
              <LinkAutocompleteMenu
                anchorRef={textareaRef}
                suggestions={autocompleteSuggestions}
                highlightIndex={activeLinkHighlightIndex}
                onHover={setLinkHighlightIndex}
                onSelect={applyLinkSuggestion}
                emptyMessage={
                  activeLinkToken
                    ? "No matching pages or nodes."
                    : "No matching tags."
                }
              />
            ) : null}
          </div>
          <div
            className={clsx(
              "ml-1 flex flex-none gap-1",
              isHeadingRow
                ? clsx("items-start", headingControlOffsetClass)
                : isTaskRow
                  ? "items-start pt-[1px]"
                  : "items-start pt-[2px]",
            )}
          >
            {node.kind === "task" && (effectiveDueRange.dueAt || recurrenceFrequency) ? (
              <div className="flex items-center gap-1 pt-px text-[10px] leading-none">
                {effectiveDueRange.dueAt ? (
                  <span
                    className={clsx(
                      "rounded-full border px-1.5 py-1 text-[var(--workspace-text-faint)]",
                      isOverdueTask
                        ? "border-[var(--workspace-danger)]/50 text-[var(--workspace-danger)]"
                        : "border-[var(--workspace-border)]",
                      isCompleted ? "opacity-70" : "",
                    )}
                    title={isOverdueTask ? `Overdue since ${dueDateLabel}` : `Due ${dueDateLabel}`}
                  >
                    {isOverdueTask ? `${dueDateLabel} overdue` : dueDateLabel}
                  </span>
                ) : null}
                {recurrenceFrequency ? (
                  <span
                    className={clsx(
                      "rounded-full border border-[var(--workspace-border)] px-1.5 py-1 text-[var(--workspace-text-faint)]",
                      isCompleted ? "opacity-70" : "",
                    )}
                    title={`Repeats ${getRecurrenceLabel(recurrenceFrequency).toLowerCase()}`}
                  >
                    {getRecurrenceLabel(recurrenceFrequency)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {nodeBacklinkCount > 0 ? (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onOpenFindQuery(buildNodeBacklinkSearchQuery(node))}
                title={`${nodeBacklinkCount} incoming link${nodeBacklinkCount === 1 ? "" : "s"}`}
                className="inline-flex min-w-[1.5rem] items-center justify-center px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--workspace-text-faint)] transition hover:text-[var(--workspace-text)]"
              >
                {nodeBacklinkCount}
              </button>
            ) : null}
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleToggleCollapsed}
              disabled={!hasChildren}
              aria-label={isCollapsed ? "Expand nested items" : "Collapse nested items"}
              className={clsx(
                "flex flex-none items-center justify-center leading-none transition",
                hasChildren ? "h-7 w-6 text-sm" : "h-4 w-6 text-xs",
                hasChildren
                  ? "text-[var(--workspace-text-faint)] hover:text-[var(--workspace-text)]"
                  : "cursor-default text-transparent",
              )}
            >
              <span
                className={clsx(
                  "inline-flex items-center justify-center rounded-full transition-transform",
                  hasChildren ? "h-4 w-4" : "h-3 w-3",
                  hasNestedGrandchildren
                    ? "border border-[var(--workspace-border-hover)]"
                    : "",
                  isCollapsed ? "rotate-0" : "rotate-90",
                )}
              >
                <span
                  className={
                    hasNestedGrandchildren ? "-translate-x-px -translate-y-px" : ""
                  }
                >
                  ▸
                </span>
              </span>
            </button>
          </div>
        </div>
        {isPlannerDayRoot ? (
          <div className="ml-[1.375rem] mt-2 mb-4 border-t border-[var(--workspace-border)]/80" />
        ) : null}
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
              nodeBacklinkCounts={nodeBacklinkCounts}
              nodeMap={nodeMap}
              createNodesBatch={createNodesBatch}
              insertOutlineClipboardNodes={insertOutlineClipboardNodes}
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
              onSetSelectedNodeIds={onSetSelectedNodeIds}
              buildDraggedNodePayload={buildDraggedNodePayload}
              onDropDraggedNodes={onDropDraggedNodes}
              onSelectionStart={onSelectionStart}
              onSelectionExtend={onSelectionExtend}
              availableTags={availableTags}
              pagesByTitle={pagesByTitle}
              pagesById={pagesById}
          onOpenPage={onOpenPage}
          onOpenNode={onOpenNode}
          onOpenTag={onOpenTag}
          onOpenFindQuery={onOpenFindQuery}
          recurringCompletionMode={recurringCompletionMode}
          mobileIndentStep={mobileIndentStep}
        />
          </div>
        </div>
      ) : null}
      {!hasChildren && isPlannerTemplateWeekdayRoot ? (
        <InlineComposer
          key={`template-empty-composer:${pageId}:${node._id}`}
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={node._id as Id<"nodes">}
          treeScopeNodes={node.children}
          nodeMap={nodeMap}
          availableTags={availableTags}
          createNodesBatch={createNodesBatch}
          insertOutlineClipboardNodes={insertOutlineClipboardNodes}
          historyInstanceKey={`template-empty:${node._id}`}
          readOnly={isPageReadOnly}
          depth={depth + 1}
          mobileIndentStep={mobileIndentStep}
          persistWhenEmpty
          placeholder="Write a template line…"
          onBeginTextEditing={onBeginTextEditing}
        />
      ) : null}
      {pendingSiblingComposerVisible ? (
        <InlineComposer
          key={`inserted-composer:${pageId}:${parentNodeId ?? "root"}:${node._id}`}
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={parentNodeId}
          afterNodeId={node._id as Id<"nodes">}
          treeScopeNodes={siblings}
          nodeMap={nodeMap}
          availableTags={availableTags}
          createNodesBatch={createNodesBatch}
          insertOutlineClipboardNodes={insertOutlineClipboardNodes}
          historyInstanceKey={`inserted:${node._id}`}
          readOnly={isPageReadOnly}
          depth={depth}
          mobileIndentStep={mobileIndentStep}
          autoFocusToken={pendingSiblingComposerFocusToken}
          persistWhenEmpty
          placeholder="Write a line…"
          onBeginTextEditing={onBeginTextEditing}
          onSubmitted={(createdNodes, reason) => {
            if (reason === "enter") {
              const lastCreatedNode = createdNodes[createdNodes.length - 1];
              if (lastCreatedNode) {
                onOpenInsertedComposer(
                  pageId,
                  ((lastCreatedNode.parentNodeId as Id<"nodes"> | null) ?? null),
                  lastCreatedNode._id as Id<"nodes">,
                );
                return;
              }
            }

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
  treeScopeNodes,
  nodeMap,
  availableTags,
  createNodesBatch,
  insertOutlineClipboardNodes,
  historyInstanceKey,
  readOnly = false,
  depth = 0,
  mobileIndentStep = 0,
  autoFocusToken = 0,
  persistWhenEmpty = false,
  placeholder = "",
  onBeginTextEditing,
  onSubmitted,
  onCancel,
}: {
  ownerKey: string;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null | undefined;
  afterNodeId?: Id<"nodes">;
  treeScopeNodes: TreeNode[];
  nodeMap: Map<string, Doc<"nodes">>;
  availableTags: SidebarTagResult[];
  createNodesBatch: CreateNodesBatchMutation;
  insertOutlineClipboardNodes: InsertOutlineClipboardNodesFn;
  historyInstanceKey?: string;
  readOnly?: boolean;
  depth?: number;
  mobileIndentStep?: number;
  autoFocusToken?: number;
  persistWhenEmpty?: boolean;
  placeholder?: string;
  onBeginTextEditing?: () => void;
  onSubmitted?: (
    createdNodes: Doc<"nodes">[],
    reason: "enter" | "blur" | "escape" | "paste",
  ) => void;
  onCancel?: () => void;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [caretPosition, setCaretPosition] = useState<number | null>(null);
  const [linkHighlightIndex, setLinkHighlightIndex] = useState(0);
  const [composerParentNodeId, setComposerParentNodeId] = useState<Id<"nodes"> | null>(
    parentNodeId ?? null,
  );
  const [composerAfterNodeId, setComposerAfterNodeId] = useState<Id<"nodes"> | null>(
    afterNodeId ?? null,
  );
  const [composerDepth, setComposerDepth] = useState(depth);
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
  const activeTagToken = activeLinkToken ? null : getActiveTagToken(draft, caretPosition);
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
  const tagSuggestions = useMemo(
    () =>
      activeTagToken ? buildTagSuggestions(availableTags, activeTagToken.query) : [],
    [activeTagToken, availableTags],
  );
  const autocompleteToken = activeLinkToken ?? activeTagToken;
  const autocompleteSuggestions = activeLinkToken ? linkSuggestions : tagSuggestions;
  const activeLinkHighlightIndex =
    autocompleteSuggestions.length === 0
      ? 0
      : Math.min(linkHighlightIndex, autocompleteSuggestions.length - 1);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setComposerParentNodeId(parentNodeId ?? null);
    setComposerAfterNodeId(afterNodeId ?? null);
    setComposerDepth(depth);
  }, [afterNodeId, depth, historyInstanceKey, parentNodeId]);

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
    if (!autocompleteToken) {
      return;
    }

    const nextValue =
      draft.slice(0, autocompleteToken.startIndex) +
      suggestion.insertText +
      draft.slice(autocompleteToken.endIndex);
    const nextCaretPosition = autocompleteToken.startIndex + suggestion.insertText.length;

    setDraft(nextValue);
    history.updateDraftValue(editorId, editorTarget, nextValue);
    setCaretPosition(nextCaretPosition);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  };

  const submitLines = async (
    value: string,
    reason: "enter" | "blur" | "escape" | "paste",
  ) => {
    if (readOnly || isSubmittingRef.current) {
      return [];
    }

    const lines = splitPastedLines(value);
    if (lines.length === 0) {
      return [];
    }

    let nextAfterNodeId: Id<"nodes"> | null | undefined = composerAfterNodeId ?? null;
    const batch = lines
      .map((line) => parseNodeDraft(line))
      .filter((entry) => !entry.shouldDelete)
      .map((entry) => {
        const nextEntry = {
          parentNodeId: composerParentNodeId ?? null,
          afterNodeId: nextAfterNodeId,
          text: entry.text,
          kind: entry.kind,
          taskStatus: entry.taskStatus,
        };
        nextAfterNodeId = undefined;
        return nextEntry;
      });

    if (batch.length === 0) {
      return [];
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    let createdNodes: Doc<"nodes">[] = [];

    try {
      createdNodes = (await createNodesBatch({
        ownerKey,
        pageId,
        nodes: batch,
      })) as Doc<"nodes">[];

      const createdSnapshots = createdNodes.map((createdNode, index) =>
        toCreatedNodeSnapshot(
          createdNode,
          index === 0
            ? (composerAfterNodeId ?? null)
            : createdNodes[index - 1]!._id,
        ),
      );

      history.resetTrackedValue(editorId, editorTarget, "");
      setDraft("");
      onSubmitted?.(createdNodes, reason);
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

    return createdNodes;
  };

  const restoreComposerSelection = (selectionStart: number, selectionEnd: number) => {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  };

  const updateComposerPlacement = (
    nextParentNodeId: Id<"nodes"> | null,
    nextAfterNodeId: Id<"nodes"> | null,
    nextDepth: number,
    selectionStart: number,
    selectionEnd: number,
  ) => {
    setComposerParentNodeId(nextParentNodeId);
    setComposerAfterNodeId(nextAfterNodeId);
    setComposerDepth(Math.max(0, nextDepth));
    restoreComposerSelection(selectionStart, selectionEnd);
  };

  const handleKeyDown = async (event: TextareaKeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly || isSubmittingRef.current) {
      return;
    }

    const isModifier = event.metaKey || event.ctrlKey;
    const normalizedKey = event.key.toLowerCase();

    if (isModifier && !event.shiftKey && !event.altKey && normalizedKey === "k") {
      const replacement = applySelectedLinkShortcut(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
      );

      if (replacement) {
        event.preventDefault();
        setDraft(replacement.value);
        setCaretPosition(replacement.selectionEnd);
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            replacement.selectionStart,
            replacement.selectionEnd,
          );
        });
        return;
      }
    }

    if (isModifier && !event.shiftKey && !event.altKey && normalizedKey === "i") {
      const replacement = applySelectedInlineFormattingShortcut(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
        "__",
      );

      if (replacement) {
        event.preventDefault();
        setDraft(replacement.value);
        setCaretPosition(replacement.selectionEnd);
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            replacement.selectionStart,
            replacement.selectionEnd,
          );
        });
        return;
      }

      event.preventDefault();
      return;
    }

    if (isModifier && !event.shiftKey && !event.altKey && normalizedKey === "b") {
      const replacement = applySelectedInlineFormattingShortcut(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
        "**",
      );

      if (replacement) {
        event.preventDefault();
        setDraft(replacement.value);
        setCaretPosition(replacement.selectionEnd);
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            replacement.selectionStart,
            replacement.selectionEnd,
          );
        });
        return;
      }

      event.preventDefault();
      return;
    }

    if (isModifier && event.shiftKey && !event.altKey && (event.key === "_" || event.key === "-")) {
      const replacement = applySelectedInlineFormattingShortcut(
        event.currentTarget.value,
        event.currentTarget.selectionStart ?? 0,
        event.currentTarget.selectionEnd ?? 0,
        "~~",
      );

      if (replacement) {
        event.preventDefault();
        setDraft(replacement.value);
        setCaretPosition(replacement.selectionEnd);
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(
            replacement.selectionStart,
            replacement.selectionEnd,
          );
        });
        return;
      }

      event.preventDefault();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();

      if (draft.trim().length === 0) {
        onCancel?.();
        return;
      }

      const textarea = event.currentTarget;
      await submitLines(draft, "escape");
      window.requestAnimationFrame(() => {
        textarea.blur();
      });
      return;
    }

    if (autocompleteToken && autocompleteSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setLinkHighlightIndex((current) => (current + 1) % autocompleteSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setLinkHighlightIndex((current) =>
          (current - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const suggestion =
          autocompleteSuggestions[activeLinkHighlightIndex] ?? autocompleteSuggestions[0];
        if (suggestion) {
          applyLinkSuggestion(suggestion);
        }
        return;
      }
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const selectionStart = event.currentTarget.selectionStart ?? draft.length;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;

      if (event.shiftKey) {
        if (!composerParentNodeId) {
          restoreComposerSelection(selectionStart, selectionEnd);
          return;
        }

        const parentNode = nodeMap.get(composerParentNodeId as string);
        if (!parentNode) {
          restoreComposerSelection(selectionStart, selectionEnd);
          return;
        }

        updateComposerPlacement(
          ((parentNode.parentNodeId as Id<"nodes"> | null) ?? null),
          parentNode._id as Id<"nodes">,
          composerDepth - 1,
          selectionStart,
          selectionEnd,
        );
        return;
      }

      if (!composerAfterNodeId) {
        restoreComposerSelection(selectionStart, selectionEnd);
        return;
      }

      const previousSiblingContext = findNodeContextInTree(
        treeScopeNodes,
        composerAfterNodeId as string,
      );
      if (!previousSiblingContext) {
        restoreComposerSelection(selectionStart, selectionEnd);
        return;
      }

      updateComposerPlacement(
        previousSiblingContext.node._id as Id<"nodes">,
        getLastChildNodeId(previousSiblingContext.node),
        composerDepth + 1,
        selectionStart,
        selectionEnd,
      );
      return;
    }

    if (event.key !== "Enter") {
      if (event.key === "Backspace" && draft.trim().length === 0) {
        event.preventDefault();
        onCancel?.();
      }
      return;
    }

    event.preventDefault();
    await submitLines(draft, "enter");
  };

  const handlePaste = async (event: TextareaClipboardEvent<HTMLTextAreaElement>) => {
    if (readOnly || isSubmittingRef.current) {
      return;
    }

    const outlineClipboard = parseOutlineClipboardPayload(
      event.clipboardData.getData(OUTLINE_CLIPBOARD_MIME_TYPE),
    );
    if (outlineClipboard) {
      event.preventDefault();
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      try {
        const result = await insertOutlineClipboardNodes({
          nodes: outlineClipboard.nodes,
          pageId,
          parentNodeId: composerParentNodeId ?? null,
          afterNodeId: composerAfterNodeId ?? null,
          focusAfterUndoId: editorId,
        });
        history.resetTrackedValue(editorId, editorTarget, "");
        setDraft("");
        onSubmitted?.(result.createdNodes, "paste");
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
      return;
    }

    const pastedText = event.clipboardData.getData("text");
    const lines = splitPastedLines(pastedText);
    if (lines.length <= 1) {
      return;
    }

    event.preventDefault();
    await submitLines(pastedText, "paste");
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

    void submitLines(currentDraft, "blur");
  };

  return (
    <div
      className="outline-depth-composer relative"
      style={
        {
          "--outline-depth": composerDepth,
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
      {isFocused && autocompleteToken ? (
        <LinkAutocompleteMenu
          anchorRef={textareaRef}
          suggestions={autocompleteSuggestions}
          highlightIndex={activeLinkHighlightIndex}
          onHover={setLinkHighlightIndex}
          onSelect={applyLinkSuggestion}
          emptyMessage={
            activeLinkToken
              ? "No matching pages or nodes."
              : "No matching tags."
          }
        />
      ) : null}
    </div>
  );
}
