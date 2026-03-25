"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Id } from "@/convex/_generated/dataModel";
import {
  extractTrailingDraftEdits,
  limitHistoryEntries,
} from "@/lib/domain/workspaceHistory";

type NodeKind = "note" | "task";
type TaskStatus = "todo" | "in_progress" | "done" | "cancelled" | null;

export type NodeValueSnapshot = {
  text: string;
  kind: NodeKind;
  taskStatus: TaskStatus;
};

export type NodePlacement = {
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null;
  afterNodeId: Id<"nodes"> | null;
};

export type CreatedNodeSnapshot = NodeValueSnapshot & {
  nodeId: Id<"nodes">;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null;
  afterNodeId: Id<"nodes"> | null;
};

export type TrackedEditorTarget =
  | {
      kind: "page_title";
      pageId: Id<"pages">;
    }
  | {
      kind: "node";
      pageId: Id<"pages">;
      nodeId: Id<"nodes">;
    }
  | {
      kind: "composer";
      pageId: Id<"pages">;
      parentNodeId: Id<"nodes"> | null;
    };

export type HistoryEntry =
  | {
      type: "draft_edit";
      editorId: string;
      target: TrackedEditorTarget;
      beforeValue: string;
      afterValue: string;
    }
  | {
      type: "rename_page";
      pageId: Id<"pages">;
      beforeTitle: string;
      afterTitle: string;
      focusEditorId: string;
    }
  | {
      type: "update_node";
      pageId: Id<"pages">;
      nodeId: Id<"nodes">;
      before: NodeValueSnapshot;
      after: NodeValueSnapshot;
      focusEditorId: string;
    }
  | {
      type: "move_node";
      pageId: Id<"pages">;
      nodeId: Id<"nodes">;
      beforePlacement: NodePlacement;
      afterPlacement: NodePlacement;
      focusEditorId: string;
    }
  | {
      type: "create_nodes";
      pageId: Id<"pages">;
      nodes: CreatedNodeSnapshot[];
      focusAfterUndoId: string | null;
      focusAfterRedoId: string | null;
    }
  | {
      type: "archive_node_tree";
      pageId: Id<"pages">;
      nodeId: Id<"nodes">;
      focusAfterUndoId: string | null;
      focusAfterRedoId: string | null;
    }
  | {
      type: "compound";
      pageId: Id<"pages">;
      entries: HistoryEntry[];
      focusAfterUndoId: string | null;
      focusAfterRedoId: string | null;
    };

type RenamePageFn = (args: {
  ownerKey: string;
  pageId: Id<"pages">;
  title: string;
}) => Promise<unknown>;

type UpdateNodeFn = (args: {
  ownerKey: string;
  nodeId: Id<"nodes">;
  text?: string;
  kind?: NodeKind;
  taskStatus?: TaskStatus;
}) => Promise<unknown>;

type MoveNodeFn = (args: {
  ownerKey: string;
  nodeId: Id<"nodes">;
  pageId?: Id<"pages">;
  parentNodeId?: Id<"nodes"> | null;
  afterNodeId?: Id<"nodes"> | null;
}) => Promise<unknown>;

type SetNodeTreeArchivedFn = (args: {
  ownerKey: string;
  nodeId: Id<"nodes">;
  archived: boolean;
}) => Promise<unknown>;

type UseWorkspaceHistoryArgs = {
  ownerKey: string;
  selectedPageId: Id<"pages"> | null;
  setSelectedPageId: (pageId: Id<"pages"> | null) => void;
  renamePage: RenamePageFn;
  updateNode: UpdateNodeFn;
  moveNode: MoveNodeFn;
  setNodeTreeArchived: SetNodeTreeArchivedFn;
  draftCheckpointDelayMs?: number;
};

type EditorAdapter = {
  getElement: () => HTMLInputElement | HTMLTextAreaElement | null;
  getValue: () => string;
  setValue: (value: string) => void;
  focusAtEnd: () => void;
};

type DraftSession = {
  target: TrackedEditorTarget;
  committedValue: string;
  currentValue: string;
  lastCheckpointValue: string;
  timerId: number | null;
};

type WorkspaceHistoryContextValue = ReturnType<typeof useWorkspaceHistoryController>;

const WorkspaceHistoryContext = createContext<WorkspaceHistoryContextValue | null>(null);

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

function getTrackedEditorIdFromTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  return target.closest<HTMLElement>("[data-history-editor-id]")?.dataset.historyEditorId ?? null;
}

function getTargetPageId(target: TrackedEditorTarget) {
  return target.pageId;
}

function getEntryPageId(entry: HistoryEntry) {
  if (entry.type === "draft_edit") {
    return getTargetPageId(entry.target);
  }

  return entry.pageId;
}

export function focusElementAtEnd(element: HTMLInputElement | HTMLTextAreaElement | null) {
  if (!element) {
    return;
  }

  const length = element.value.length;
  element.focus();
  element.setSelectionRange(length, length);
}

export function getPageTitleEditorId(pageId: Id<"pages">) {
  return `page-title:${pageId}`;
}

export function getNodeEditorId(nodeId: Id<"nodes">) {
  return `node:${nodeId}`;
}

export function getComposerEditorId(
  pageId: Id<"pages">,
  parentNodeId: Id<"nodes"> | null | undefined,
) {
  return `composer:${pageId}:${parentNodeId ?? "root"}`;
}

export function WorkspaceHistoryProvider({
  value,
  children,
}: {
  value: WorkspaceHistoryContextValue;
  children: ReactNode;
}) {
  return (
    <WorkspaceHistoryContext.Provider value={value}>
      {children}
    </WorkspaceHistoryContext.Provider>
  );
}

export function useWorkspaceHistory() {
  const value = useContext(WorkspaceHistoryContext);
  if (!value) {
    throw new Error("Workspace history context is not available.");
  }

  return value;
}

export function useWorkspaceHistoryController({
  ownerKey,
  selectedPageId,
  setSelectedPageId,
  renamePage,
  updateNode,
  moveNode,
  setNodeTreeArchived,
  draftCheckpointDelayMs = 750,
}: UseWorkspaceHistoryArgs) {
  const [historyState, setHistoryState] = useState({ undoCount: 0, redoCount: 0 });
  const [isApplyingHistory, setIsApplyingHistory] = useState(false);
  const undoStackRef = useRef<HistoryEntry[]>([]);
  const redoStackRef = useRef<HistoryEntry[]>([]);
  const editorsRef = useRef(new Map<string, EditorAdapter>());
  const draftSessionsRef = useRef(new Map<string, DraftSession>());
  const pendingFocusEditorIdRef = useRef<string | null>(null);
  const selectedPageIdRef = useRef(selectedPageId);

  useEffect(() => {
    selectedPageIdRef.current = selectedPageId;
  }, [selectedPageId]);

  const refreshHistoryState = useCallback(() => {
    setHistoryState({
      undoCount: undoStackRef.current.length,
      redoCount: redoStackRef.current.length,
    });
  }, []);

  const scheduleFocus = useCallback((editorId: string | null) => {
    if (!editorId) {
      return;
    }

    const editor = editorsRef.current.get(editorId);
    if (editor) {
      window.setTimeout(() => editor.focusAtEnd(), 0);
      return;
    }

    pendingFocusEditorIdRef.current = editorId;
  }, []);

  const setSelectedPage = useCallback(
    (pageId: Id<"pages"> | null) => {
      selectedPageIdRef.current = pageId;
      setSelectedPageId(pageId);
    },
    [setSelectedPageId],
  );

  const pushUndoEntry = useCallback(
    (entry: HistoryEntry, clearRedo = true) => {
      undoStackRef.current = limitHistoryEntries(
        [...undoStackRef.current, entry],
        100,
      );
      if (clearRedo) {
        redoStackRef.current = [];
      }
      refreshHistoryState();
    },
    [refreshHistoryState],
  );

  const clearDraftTimer = useCallback((editorId: string) => {
    const session = draftSessionsRef.current.get(editorId);
    if (!session || session.timerId === null) {
      return;
    }

    window.clearTimeout(session.timerId);
    session.timerId = null;
  }, []);

  const removeTrailingDraftEdits = useCallback(
    (editorId: string) => {
      const extracted = extractTrailingDraftEdits(
        undoStackRef.current,
        editorId,
      );
      if (extracted.draftEntries.length > 0) {
        undoStackRef.current = extracted.remainingEntries;
        refreshHistoryState();
      }
      return extracted.draftEntries;
    },
    [refreshHistoryState],
  );

  const flushDraftCheckpoint = useCallback(
    (editorId: string) => {
      clearDraftTimer(editorId);
      const session = draftSessionsRef.current.get(editorId);
      if (!session || session.currentValue === session.lastCheckpointValue) {
        return;
      }

      pushUndoEntry({
        type: "draft_edit",
        editorId,
        target: session.target,
        beforeValue: session.lastCheckpointValue,
        afterValue: session.currentValue,
      });
      session.lastCheckpointValue = session.currentValue;
    },
    [clearDraftTimer, pushUndoEntry],
  );

  const ensureDraftSession = useCallback(
    (editorId: string, fallbackTarget?: TrackedEditorTarget, fallbackValue = "") => {
      let session = draftSessionsRef.current.get(editorId);
      if (!session && fallbackTarget) {
        session = {
          target: fallbackTarget,
          committedValue: fallbackValue,
          currentValue: fallbackValue,
          lastCheckpointValue: fallbackValue,
          timerId: null,
        };
        draftSessionsRef.current.set(editorId, session);
      }

      return session ?? null;
    },
    [],
  );

  const registerEditor = useCallback(
    (
      editorId: string,
      target: TrackedEditorTarget,
      committedValue: string,
      adapter: EditorAdapter,
    ) => {
      editorsRef.current.set(editorId, adapter);

      const session = ensureDraftSession(editorId, target, committedValue);
      if (session) {
        session.target = target;
      }

      const element = adapter.getElement();
      if (element) {
        element.dataset.historyEditorId = editorId;
      }

      if (pendingFocusEditorIdRef.current === editorId) {
        pendingFocusEditorIdRef.current = null;
        window.setTimeout(() => adapter.focusAtEnd(), 0);
      }

      return () => {
        editorsRef.current.delete(editorId);
        clearDraftTimer(editorId);
      };
    },
    [clearDraftTimer, ensureDraftSession],
  );

  const syncCommittedValue = useCallback(
    (editorId: string, committedValue: string, target?: TrackedEditorTarget) => {
      const session = ensureDraftSession(editorId, target, committedValue);
      if (!session) {
        return;
      }

      if (session.currentValue !== session.committedValue) {
        return;
      }

      session.committedValue = committedValue;
      session.currentValue = committedValue;
      session.lastCheckpointValue = committedValue;

      const adapter = editorsRef.current.get(editorId);
      if (adapter && adapter.getValue() !== committedValue) {
        adapter.setValue(committedValue);
      }
    },
    [ensureDraftSession],
  );

  const scheduleCheckpoint = useCallback(
    (editorId: string) => {
      clearDraftTimer(editorId);
      const session = draftSessionsRef.current.get(editorId);
      if (!session) {
        return;
      }

      session.timerId = window.setTimeout(() => {
        flushDraftCheckpoint(editorId);
      }, draftCheckpointDelayMs);
    },
    [clearDraftTimer, draftCheckpointDelayMs, flushDraftCheckpoint],
  );

  const updateDraftValue = useCallback(
    (editorId: string, target: TrackedEditorTarget, nextValue: string) => {
      const session = ensureDraftSession(editorId, target, nextValue);
      if (!session) {
        return;
      }

      session.target = target;
      session.currentValue = nextValue;
      scheduleCheckpoint(editorId);
    },
    [ensureDraftSession, scheduleCheckpoint],
  );

  const commitTrackedValue = useCallback(
    (editorId: string, target: TrackedEditorTarget, nextCommittedValue: string) => {
      flushDraftCheckpoint(editorId);
      const session = ensureDraftSession(editorId, target, nextCommittedValue);
      const originalCommittedValue = session?.committedValue ?? nextCommittedValue;
      removeTrailingDraftEdits(editorId);

      if (session) {
        session.target = target;
        session.committedValue = nextCommittedValue;
        session.currentValue = nextCommittedValue;
        session.lastCheckpointValue = nextCommittedValue;
      }

      const adapter = editorsRef.current.get(editorId);
      if (adapter && adapter.getValue() !== nextCommittedValue) {
        adapter.setValue(nextCommittedValue);
      }

      return originalCommittedValue;
    },
    [ensureDraftSession, flushDraftCheckpoint, removeTrailingDraftEdits],
  );

  const resetTrackedValue = useCallback(
    (editorId: string, target: TrackedEditorTarget, nextValue = "") => {
      flushDraftCheckpoint(editorId);
      removeTrailingDraftEdits(editorId);

      const session = ensureDraftSession(editorId, target, nextValue);
      if (session) {
        session.target = target;
        session.committedValue = nextValue;
        session.currentValue = nextValue;
        session.lastCheckpointValue = nextValue;
      }

      const adapter = editorsRef.current.get(editorId);
      if (adapter && adapter.getValue() !== nextValue) {
        adapter.setValue(nextValue);
      }
    },
    [ensureDraftSession, flushDraftCheckpoint, removeTrailingDraftEdits],
  );

  const flushActiveEditorDraft = useCallback(() => {
    const editorId = getTrackedEditorIdFromTarget(document.activeElement);
    if (!editorId) {
      return;
    }

    flushDraftCheckpoint(editorId);
  }, [flushDraftCheckpoint]);

  const applyHistoryEntry = useCallback(
    async (entry: HistoryEntry, direction: "undo" | "redo") => {
      const isUndo = direction === "undo";
      const entryPageId = getEntryPageId(entry);
      if (selectedPageIdRef.current !== entryPageId) {
        setSelectedPage(entryPageId);
      }

      switch (entry.type) {
        case "draft_edit": {
          const nextValue = isUndo ? entry.beforeValue : entry.afterValue;
          const session = ensureDraftSession(editorIdOrThrow(entry.editorId), entry.target, nextValue);
          if (session) {
            session.currentValue = nextValue;
            session.lastCheckpointValue = nextValue;
          }

          const editor = editorsRef.current.get(entry.editorId);
          if (editor) {
            editor.setValue(nextValue);
          }
          scheduleFocus(entry.editorId);
          return;
        }

        case "rename_page": {
          const nextTitle = isUndo ? entry.beforeTitle : entry.afterTitle;
          await renamePage({
            ownerKey,
            pageId: entry.pageId,
            title: nextTitle,
          });
          syncCommittedValue(entry.focusEditorId, nextTitle, {
            kind: "page_title",
            pageId: entry.pageId,
          });
          scheduleFocus(entry.focusEditorId);
          return;
        }

        case "update_node": {
          const nextSnapshot = isUndo ? entry.before : entry.after;
          await updateNode({
            ownerKey,
            nodeId: entry.nodeId,
            text: nextSnapshot.text,
            kind: nextSnapshot.kind,
            taskStatus: nextSnapshot.taskStatus,
          });
          syncCommittedValue(entry.focusEditorId, nextSnapshot.text, {
            kind: "node",
            pageId: entry.pageId,
            nodeId: entry.nodeId,
          });
          scheduleFocus(entry.focusEditorId);
          return;
        }

        case "move_node": {
          const placement = isUndo ? entry.beforePlacement : entry.afterPlacement;
          await moveNode({
            ownerKey,
            nodeId: entry.nodeId,
            pageId: placement.pageId,
            parentNodeId: placement.parentNodeId,
            afterNodeId: placement.afterNodeId,
          });
          scheduleFocus(entry.focusEditorId);
          return;
        }

        case "create_nodes": {
          for (const node of entry.nodes) {
            await setNodeTreeArchived({
              ownerKey,
              nodeId: node.nodeId,
              archived: isUndo,
            });
          }
          scheduleFocus(isUndo ? entry.focusAfterUndoId : entry.focusAfterRedoId);
          return;
        }

        case "archive_node_tree": {
          await setNodeTreeArchived({
            ownerKey,
            nodeId: entry.nodeId,
            archived: !isUndo,
          });
          scheduleFocus(isUndo ? entry.focusAfterUndoId : entry.focusAfterRedoId);
          return;
        }

        case "compound": {
          const orderedEntries = isUndo
            ? [...entry.entries].reverse()
            : entry.entries;

          for (const child of orderedEntries) {
            await applyHistoryEntry(child, direction);
          }

          scheduleFocus(isUndo ? entry.focusAfterUndoId : entry.focusAfterRedoId);
        }
      }
    },
    [
      ensureDraftSession,
      moveNode,
      ownerKey,
      renamePage,
      scheduleFocus,
      setNodeTreeArchived,
      setSelectedPage,
      syncCommittedValue,
      updateNode,
    ],
  );

  const runHistoryAction = useCallback(
    async (direction: "undo" | "redo") => {
      if (isApplyingHistory) {
        return;
      }

      flushActiveEditorDraft();
      const sourceStack = direction === "undo" ? undoStackRef.current : redoStackRef.current;
      const targetStack = direction === "undo" ? redoStackRef.current : undoStackRef.current;
      const entry = sourceStack[sourceStack.length - 1];
      if (!entry) {
        return;
      }

      setIsApplyingHistory(true);
      try {
        await applyHistoryEntry(entry, direction);
        sourceStack.pop();
        targetStack.push(entry);
        refreshHistoryState();
      } finally {
        setIsApplyingHistory(false);
      }
    },
    [applyHistoryEntry, flushActiveEditorDraft, isApplyingHistory, refreshHistoryState],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (!isModifier) {
        return;
      }

      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!isUndo && !isRedo) {
        return;
      }

      const trackedEditorId = getTrackedEditorIdFromTarget(event.target);
      if (!trackedEditorId && isTextEntryElement(event.target)) {
        return;
      }

      event.preventDefault();
      void runHistoryAction(isUndo ? "undo" : "redo");
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [runHistoryAction]);

  const value = useMemo(
    () => ({
      canUndo: historyState.undoCount > 0,
      canRedo: historyState.redoCount > 0,
      isApplyingHistory,
      focusElementAtEnd,
      registerEditor,
      syncCommittedValue,
      updateDraftValue,
      flushDraftCheckpoint,
      commitTrackedValue,
      resetTrackedValue,
      pushUndoEntry,
      undo: () => runHistoryAction("undo"),
      redo: () => runHistoryAction("redo"),
    }),
    [
      commitTrackedValue,
      flushDraftCheckpoint,
      historyState.redoCount,
      historyState.undoCount,
      isApplyingHistory,
      pushUndoEntry,
      registerEditor,
      resetTrackedValue,
      runHistoryAction,
      syncCommittedValue,
      updateDraftValue,
    ],
  );

  return value;
}

function editorIdOrThrow(editorId: string) {
  return editorId;
}
