"use client";

import clsx from "clsx";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type KeyboardEvent as TextareaKeyboardEvent,
  type ClipboardEvent as TextareaClipboardEvent,
} from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { buildOutlineTree, type OutlineTreeNode } from "@/lib/domain/outline";
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
const ARCHIVE_SECTION_LABEL = "Archive";
const OWNER_KEY_STORAGE_KEY = "maleshflow-owner-key";
const OWNER_KEY_EVENT = "maleshflow-owner-key-change";
const LAST_PAGE_STORAGE_KEY = "maleshflow-last-page-id";

type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
type SidebarGroupKey = SidebarSection | typeof ARCHIVE_SECTION_LABEL;
type PageType = "default" | "model" | "journal";
type PageDoc = Doc<"pages">;
type PaletteMode = "pages" | "nodes" | "chat";
const PALETTE_MODE_ORDER: PaletteMode[] = ["pages", "nodes", "chat"];
type NodeSearchResult = {
  node: Doc<"nodes">;
  page: PageDoc | null;
  score?: number;
  content?: string;
};
type KnowledgeChatResponse = {
  answer: string;
  sources: NodeSearchResult[];
  model: string;
  error: string | null;
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

type SectionSlot =
  | "model"
  | "recentExamples"
  | "journalThoughts"
  | "journalFeedback";

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
        : "default";

  return { sidebarSection, pageType };
}

function flattenTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTreeNodes(node.children)]);
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

function collectChildren(nodes: TreeNode[], excludedIds: Set<string>) {
  return nodes.filter((node) => !excludedIds.has(node._id));
}

function parseNodeDraft(draft: string) {
  const trimmed = draft.trim();

  if (trimmed.length === 0) {
    return { shouldDelete: true as const };
  }

  const doneMatch = trimmed.match(/^\[x\]\s*(.*)$/i);
  if (doneMatch) {
    const text = doneMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true as const }
      : {
          shouldDelete: false as const,
          text,
          kind: "task" as const,
          taskStatus: "done" as const,
        };
  }

  const todoMatch = trimmed.match(/^\[\s\]\s*(.*)$/);
  if (todoMatch) {
    const text = todoMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true as const }
      : {
          shouldDelete: false as const,
          text,
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

  const doneMatch = trimmed.match(/^\[x\]\s*(.*)$/i);
  if (doneMatch) {
    const text = doneMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true as const }
      : {
          shouldDelete: false as const,
          text,
          kind: "task" as const,
          taskStatus: "done" as const,
        };
  }

  const todoMatch = trimmed.match(/^\[\s\]\s*(.*)$/);
  if (todoMatch) {
    const text = todoMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true as const }
      : {
          shouldDelete: false as const,
          text,
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
  const doneMatch = draft.match(/^\[x\]\s?(.*)$/i);
  if (doneMatch) {
    return {
      text: doneMatch[1] ?? "",
      kind: "task" as const,
      taskStatus: "done" as const,
    };
  }

  const todoMatch = draft.match(/^\[\s\]\s?(.*)$/);
  if (todoMatch) {
    return {
      text: todoMatch[1] ?? "",
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

  return <ConfiguredWorkspace ownerKey={ownerKey} setOwnerKey={setOwnerKey} />;
}

function ConfiguredWorkspace({
  ownerKey,
  setOwnerKey,
}: {
  ownerKey: string;
  setOwnerKey: (nextValue: string) => void;
}) {
  const [selectedPageId, setSelectedPageId] = useState<Id<"pages"> | null>(null);
  const [pageTitleDraft, setPageTitleDraft] = useState("");
  const [modelChatInput, setModelChatInput] = useState("");
  const [chatStatus, setChatStatus] = useState("");
  const [journalFeedbackStatus, setJournalFeedbackStatus] = useState("");
  const [embeddingRebuildStatus, setEmbeddingRebuildStatus] = useState("");
  const [isCreatingPage, setIsCreatingPage] = useState<SidebarSection | null>(null);
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [isGeneratingJournalFeedback, setIsGeneratingJournalFeedback] = useState(false);
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("pages");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteHighlightIndex, setPaletteHighlightIndex] = useState(0);
  const [nodeSearchResults, setNodeSearchResults] = useState<NodeSearchResult[]>([]);
  const [isNodeSearchLoading, setIsNodeSearchLoading] = useState(false);
  const [knowledgeChatResponse, setKnowledgeChatResponse] = useState<KnowledgeChatResponse | null>(
    null,
  );
  const [isKnowledgeChatLoading, setIsKnowledgeChatLoading] = useState(false);
  const [pendingRevealNodeId, setPendingRevealNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<Set<SidebarGroupKey>>(
    () => new Set<SidebarGroupKey>([...SIDEBAR_SECTIONS, ARCHIVE_SECTION_LABEL]),
  );
  const [dragSelection, setDragSelection] = useState<{
    anchorNodeId: string;
    currentNodeId: string;
  } | null>(null);

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
  const pageTree = useQuery(
    api.workspace.getPageTree,
    ownerKey && isOwnerKeyValid && selectedPageId
      ? { ownerKey, pageId: selectedPageId }
      : SKIP,
  );

  const createPage = useMutation(api.workspace.createPage);
  const renamePage = useMutation(api.workspace.renamePage);
  const archivePage = useMutation(api.workspace.archivePage);
  const deletePageForever = useMutation(api.workspace.deletePageForever);
  const rebuildEmbeddings = useMutation(api.workspace.rebuildEmbeddings);
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
  const searchNodes = useAction(api.ai.searchNodes);
  const answerWorkspaceQuestion = useAction(api.ai.answerWorkspaceQuestion);
  const pageTitleInputRef = useRef<HTMLInputElement>(null);
  const pageTitleDraftRef = useRef(pageTitleDraft);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const hasResolvedInitialPageSelection = useRef(false);

  const clearNodeSelection = useCallback(() => {
    setSelectedNodeIds(new Set());
    setDragSelection(null);
  }, []);

  const toggleSidebarSection = useCallback((section: SidebarGroupKey) => {
    setCollapsedSidebarSections((current) => {
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  const openPalette = useCallback((mode: PaletteMode) => {
    setPaletteMode(mode);
    setPaletteQuery("");
    setPaletteHighlightIndex(0);
    setNodeSearchResults([]);
    setKnowledgeChatResponse(null);
    setIsKnowledgeChatLoading(false);
    setPaletteOpen(true);
  }, []);

  const history = useWorkspaceHistoryController({
    ownerKey,
    selectedPageId,
    setSelectedPageId,
    renamePage,
    updateNode,
    moveNode,
    setNodeTreeArchived,
    isDisabled: pageTree?.page?.archived ?? false,
  });

  const selectedPage = pageTree?.page ?? null;
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
  const tree = pageTree ? toTreeNodes(pageTree.nodes) : [];
  const nodeMap = new Map(
    (pageTree?.nodes ?? []).map((node) => [node._id as string, node]),
  );

  const modelSection = findSectionNode(tree, "model");
  const recentExamplesSection = findSectionNode(tree, "recentExamples");
  const journalThoughtsSection = findSectionNode(tree, "journalThoughts");
  const journalFeedbackSection = findSectionNode(tree, "journalFeedback");
  const genericRoots =
    pageMeta.pageType === "model"
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
      : tree;
  const modelVisibleRoots = [modelSection, recentExamplesSection].filter(
    (node): node is TreeNode => Boolean(node),
  );
  const journalVisibleRoots = [journalThoughtsSection, journalFeedbackSection].filter(
    (node): node is TreeNode => Boolean(node),
  );
  const visibleRows =
    pageMeta.pageType === "model"
      ? flattenTreeNodes([...modelVisibleRoots, ...genericRoots])
      : pageMeta.pageType === "journal"
        ? flattenTreeNodes([...journalVisibleRoots, ...genericRoots])
        : flattenTreeNodes(genericRoots);
  const visibleNodeOrder = visibleRows.map((node) => node._id);

  const groupedPages = SIDEBAR_SECTIONS.map((section) => ({
    section,
    pages:
      pages?.filter(
        (page) => !page.archived && getPageMeta(page).sidebarSection === section,
      ) ?? [],
  }));
  const archivedPages = pages?.filter((page) => page.archived) ?? [];
  const paletteResults = filterPagesForCommandPalette(
    pages ?? [],
    paletteQuery,
    14,
  );
  const activePaletteResultsCount =
    paletteMode === "pages"
      ? paletteResults.length
      : paletteMode === "nodes"
        ? nodeSearchResults.length
        : 0;
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
    if (isOwnerKeyValid === false) {
      setOwnerKey("");
    }
  }, [isOwnerKeyValid, setOwnerKey]);

  useEffect(() => {
    if (!pages) {
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

      const matchingPage = pages.find((page) => page._id === storedPageId);
      if (matchingPage) {
        setSelectedPageId(matchingPage._id);
      } else {
        window.localStorage.removeItem(LAST_PAGE_STORAGE_KEY);
      }
      return;
    }

    if (selectedPageId && !pages.some((page) => page._id === selectedPageId)) {
      setSelectedPageId(null);
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(LAST_PAGE_STORAGE_KEY);
      }
    }
  }, [pages, selectedPageId]);

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
    setPageTitleDraft(pageTree?.page?.title ?? "");
    setChatStatus("");
    setJournalFeedbackStatus("");
    clearNodeSelection();
  }, [clearNodeSelection, pageTree?.page?._id, pageTree?.page?.title]);

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

  useEffect(() => {
    const handleMouseUp = () => {
      setDragSelection(null);
    };

    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  useEffect(() => {
    if (!paletteOpen) {
      return;
    }

    setPaletteHighlightIndex(0);
    window.setTimeout(() => paletteInputRef.current?.focus(), 0);
  }, [paletteOpen, paletteMode]);

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
    if (paletteMode !== "chat") {
      setIsKnowledgeChatLoading(false);
      return;
    }
  }, [paletteMode]);

  useEffect(() => {
    if (!pendingRevealNodeId || !selectedPageId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-node-id="${pendingRevealNodeId}"]`,
      );

      if (!target) {
        return;
      }

      setSelectedNodeIds(new Set([pendingRevealNodeId]));
      target.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      setPendingRevealNodeId(null);
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [pendingRevealNodeId, selectedPageId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (isModifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette("pages");
        return;
      }

      if (isModifier && event.key.toLowerCase() === "o") {
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
          setNodeSearchResults([]);
          return;
        }

        if (selectedNodeIds.size > 0) {
          setSelectedNodeIds(new Set());
          setDragSelection(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openPalette, paletteOpen, selectedNodeIds.size]);

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
          : section === "Journal"
            ? "journal"
            : "default";
      const title =
        section === "Models"
          ? "Untitled Model"
          : section === "Journal"
            ? formatLocalDateTitle()
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
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteHighlightIndex(0);
    setPaletteMode("pages");
    setNodeSearchResults([]);
    setKnowledgeChatResponse(null);
    clearNodeSelection();
  }, [clearNodeSelection]);

  const handleSelectNodeSearchResult = useCallback((result: NodeSearchResult) => {
    if (!result.page) {
      return;
    }

    setSelectedPageId(result.page._id);
    setPendingRevealNodeId(result.node._id as string);
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteHighlightIndex(0);
    setPaletteMode("nodes");
    setKnowledgeChatResponse(null);
    clearNodeSelection();
  }, [clearNodeSelection]);

  const handleKnowledgeChat = useCallback(async () => {
    const question = paletteQuery.trim();
    if (question.length === 0) {
      setKnowledgeChatResponse(null);
      return;
    }

    setIsKnowledgeChatLoading(true);
    try {
      const response = (await answerWorkspaceQuestion({
        ownerKey,
        question,
        limit: 10,
      })) as KnowledgeChatResponse;
      setKnowledgeChatResponse(response);
    } catch (error) {
      setKnowledgeChatResponse({
        answer:
          error instanceof Error
            ? `Knowledge-base chat failed: ${error.message}`
            : "Knowledge-base chat failed.",
        sources: [],
        model: "gpt-5-mini",
        error: error instanceof Error ? error.message : "Unknown error.",
      });
    } finally {
      setIsKnowledgeChatLoading(false);
    }
  }, [answerWorkspaceQuestion, ownerKey, paletteQuery]);

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

  const handleRunModelChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPageId || modelChatInput.trim().length === 0 || isPageArchived) {
      return;
    }

    setIsSendingChat(true);
    setChatStatus("");
    try {
      const result = (await rewriteModelSection({
        ownerKey,
        pageId: selectedPageId,
        prompt: modelChatInput.trim(),
      })) as {
        summary: string;
      };
      setChatStatus(result.summary);
      setModelChatInput("");
    } catch (error) {
      setChatStatus(
        error instanceof Error
          ? error.message
          : "Could not update the model right now.",
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

      setPaletteMode(nextMode);
      setPaletteQuery("");
      setPaletteHighlightIndex(0);
      setNodeSearchResults([]);
      setKnowledgeChatResponse(null);
      setIsKnowledgeChatLoading(false);
      return;
    }

    if (paletteMode === "chat" && event.key === "Enter") {
      event.preventDefault();
      void handleKnowledgeChat();
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

      const highlighted = nodeSearchResults[paletteHighlightIndex];
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
      <main className="min-h-screen bg-[var(--workspace-bg)] text-[var(--workspace-text)]">
      <div className="mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex flex-col border-b border-[var(--workspace-border)] bg-[var(--workspace-sidebar-bg)] p-6 lg:border-b-0 lg:border-r">
          <div className="flex items-start justify-end gap-4">
                <button
                  type="button"
                  onClick={() => {
                    openPalette("pages");
              }}
              className="border border-[var(--workspace-border-control)] px-3 py-1 text-xs font-medium text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
            >
              Pages
            </button>
                <button
                  type="button"
                  onClick={() => {
                    openPalette("nodes");
                  }}
              className="border border-[var(--workspace-border-control)] px-3 py-1 text-xs font-medium text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                >
                  Semantic
                </button>
                <button
                  type="button"
                  onClick={() => {
                    openPalette("chat");
                  }}
                  className="border border-[var(--workspace-border-control)] px-3 py-1 text-xs font-medium text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
                >
                  Ask
                </button>
          </div>

          <div className="mt-10 flex-1 space-y-6">
            {groupedPages.map(({ section, pages: sectionPages }) => (
              <section
                key={section}
                className="border-t border-[var(--workspace-border-soft)] pt-6 first:border-t-0 first:pt-0"
              >
                <button
                  type="button"
                  onClick={() => toggleSidebarSection(section)}
                  className="flex w-full items-center justify-between text-left text-sm font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]"
                >
                  <span>{section}</span>
                  <span className="text-xs text-[var(--workspace-accent)]">
                    {collapsedSidebarSections.has(section) ? "+" : "-"}
                  </span>
                </button>
                {!collapsedSidebarSections.has(section) ? (
                  <>
                    <div className="mt-3 space-y-2">
                      {sectionPages.map((page) => (
                        <button
                          key={page._id}
                          type="button"
                          onClick={() => handleSelectPage(page._id)}
                          className={clsx(
                            "block w-full border-l-2 px-3 py-2 text-left text-sm transition",
                            selectedPageId === page._id
                              ? "border-[var(--workspace-brand)] bg-[var(--workspace-surface-accent)] text-[var(--workspace-brand)]"
                              : "border-transparent text-[var(--workspace-text-strong)] hover:border-[var(--workspace-border-hover)] hover:bg-[var(--workspace-surface-accent)]",
                          )}
                        >
                          {page.title}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCreatePage(section)}
                      disabled={isCreatingPage === section}
                      className="mt-3 w-full border border-dashed border-[var(--workspace-border-hover)] px-3 py-2 text-left text-sm font-medium text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:bg-[var(--workspace-surface-accent)] disabled:cursor-wait disabled:opacity-60"
                    >
                      {isCreatingPage === section ? "Creating page…" : `New ${section.slice(0, -1)}`}
                    </button>
                  </>
                ) : null}
              </section>
            ))}
            <section className="border-t border-[var(--workspace-border-soft)] pt-6">
              <button
                type="button"
                onClick={() => toggleSidebarSection(ARCHIVE_SECTION_LABEL)}
                className="flex w-full items-center justify-between text-left text-sm font-semibold uppercase tracking-[0.22em] text-[var(--workspace-text-faint)]"
              >
                <span>{ARCHIVE_SECTION_LABEL}</span>
                <span className="text-xs text-[var(--workspace-accent)]">
                  {collapsedSidebarSections.has(ARCHIVE_SECTION_LABEL) ? "+" : "-"}
                </span>
              </button>
              {!collapsedSidebarSections.has(ARCHIVE_SECTION_LABEL) ? (
                <div className="mt-3 space-y-2">
                  {archivedPages.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-[var(--workspace-text-faint)]">
                      No archived pages
                    </p>
                  ) : (
                    archivedPages.map((page) => (
                      <button
                        key={page._id}
                        type="button"
                        onClick={() => handleSelectPage(page._id)}
                        className={clsx(
                          "block w-full border-l-2 px-3 py-2 text-left text-sm transition",
                          selectedPageId === page._id
                            ? "border-[var(--workspace-brand)] bg-[var(--workspace-surface-accent)] text-[var(--workspace-brand)]"
                            : "border-transparent text-[var(--workspace-text-strong)] hover:border-[var(--workspace-border-hover)] hover:bg-[var(--workspace-surface-accent)]",
                        )}
                      >
                        <span>{page.title}</span>
                        <span className="ml-2 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                          Archived
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </section>
          </div>
          <div className="mt-6 pt-4">
            <div className="space-y-3">
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
                onClick={() => setOwnerKey("")}
                className="border border-[var(--workspace-border-control)] px-3 py-1 text-xs font-medium text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]"
              >
                Lock
              </button>
            </div>
          </div>
        </aside>

        <section className="p-6 md:p-10">
          {!selectedPage ? (
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
            <div className="flex min-h-[calc(100vh-5rem)] flex-col border border-[var(--workspace-border)] bg-[var(--workspace-surface)]">
              <div className="px-10 py-6 md:px-14">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.3em] text-[var(--workspace-accent)]">
                      <span>{pageMeta.sidebarSection}</span>
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
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void history.undo()}
                      disabled={!history.canUndo || history.isApplyingHistory || isPageArchived}
                      className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Undo
                    </button>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void history.redo()}
                      disabled={!history.canRedo || history.isApplyingHistory || isPageArchived}
                      className="border border-[var(--workspace-border)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-text-muted)] transition hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Redo
                    </button>
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
                <div className="mt-6 h-px bg-[var(--workspace-border-subtle)]" />
              </div>

              <div
                className="flex-1 px-10 py-6 md:px-14"
                onMouseDownCapture={(event) => {
                  if (
                    selectedNodeIds.size > 0 &&
                    !(event.target instanceof HTMLElement && event.target.closest("[data-selection-gutter='true']"))
                  ) {
                    clearNodeSelection();
                  }
                }}
              >
                {pageMeta.pageType === "model" ? (
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
                        selectedNodeIds={selectedNodeIds}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        depthOffset={1}
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
                        selectedNodeIds={selectedNodeIds}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        depthOffset={1}
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
                        selectedNodeIds={selectedNodeIds}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        depthOffset={1}
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
                        selectedNodeIds={selectedNodeIds}
                        onSelectionStart={beginNodeSelection}
                        onSelectionExtend={extendNodeSelection}
                        depthOffset={1}
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
                      selectedNodeIds={selectedNodeIds}
                      onSelectionStart={beginNodeSelection}
                      onSelectionExtend={extendNodeSelection}
                    />
                    <InlineComposer
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      parentNodeId={null}
                      afterNodeId={genericRoots[genericRoots.length - 1]?._id as Id<"nodes"> | undefined}
                      createNodesBatch={createNodesBatch}
                      readOnly={isPageArchived}
                      depth={0}
                    />
                  </div>
                )}
              </div>

              {pageMeta.pageType === "model" ? (
                <div className="border-t border-[var(--workspace-border-subtle)] px-10 py-5 md:px-14">
                  <form onSubmit={(event) => void handleRunModelChat(event)} className="space-y-3">
                    <input
                      value={modelChatInput}
                      onChange={(event) => setModelChatInput(event.target.value)}
                      placeholder="Ask AI..."
                      disabled={isPageArchived}
                      className="w-full border-0 border-b border-[var(--workspace-border)] bg-transparent px-0 py-2 text-sm outline-none disabled:text-[var(--workspace-text-muted)]"
                    />
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm text-[var(--workspace-text-subtle)]">
                        {isPageArchived ? "Archived pages are read-only." : chatStatus}
                      </p>
                      <button
                        type="submit"
                        disabled={isSendingChat || modelChatInput.trim().length === 0 || isPageArchived}
                        className="border border-[var(--workspace-brand)] px-4 py-2 text-sm font-semibold text-[var(--workspace-brand)] transition hover:bg-[var(--workspace-brand)] hover:text-[var(--workspace-inverse-text)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isSendingChat ? "Thinking…" : "Send"}
                      </button>
                    </div>
                  </form>
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
            setNodeSearchResults([]);
            setKnowledgeChatResponse(null);
            setIsKnowledgeChatLoading(false);
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
                    setPaletteMode("pages");
                    setPaletteQuery("");
                    setPaletteHighlightIndex(0);
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
                    setPaletteMode("nodes");
                    setPaletteQuery("");
                    setPaletteHighlightIndex(0);
                    setNodeSearchResults([]);
                    setKnowledgeChatResponse(null);
                    setIsKnowledgeChatLoading(false);
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
                    setPaletteMode("chat");
                    setPaletteQuery("");
                    setPaletteHighlightIndex(0);
                    setNodeSearchResults([]);
                    setKnowledgeChatResponse(null);
                    setIsKnowledgeChatLoading(false);
                  }}
                  className={clsx(
                    "border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] transition",
                    paletteMode === "chat"
                      ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                      : "border-[var(--workspace-border)] text-[var(--workspace-text-muted)] hover:border-[var(--workspace-accent)] hover:text-[var(--workspace-text)]",
                  )}
                >
                  Ask
                </button>
              </div>
              <div className="flex items-center gap-3">
                <input
                  ref={paletteInputRef}
                  value={paletteQuery}
                  onChange={(event) => {
                    setPaletteQuery(event.target.value);
                    setPaletteHighlightIndex(0);
                    if (paletteMode === "chat") {
                      setKnowledgeChatResponse(null);
                    }
                  }}
                  onKeyDown={handlePaletteKeyDown}
                  placeholder={
                    paletteMode === "pages"
                      ? "Search pages..."
                      : paletteMode === "nodes"
                        ? "Search notes and tasks semantically across the workspace..."
                        : "Ask your knowledge base a question..."
                  }
                  className="w-full border-0 bg-transparent p-0 text-lg outline-none"
                />
                {paletteMode === "chat" ? (
                  <button
                    type="button"
                    onClick={() => void handleKnowledgeChat()}
                    disabled={isKnowledgeChatLoading || paletteQuery.trim().length === 0}
                    className="border border-[var(--workspace-brand)] bg-[var(--workspace-brand)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--workspace-inverse-text)] transition hover:bg-[var(--workspace-brand-hover)] disabled:cursor-wait disabled:opacity-60"
                  >
                    Ask
                  </button>
                ) : null}
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto py-2">
              {paletteMode === "pages" ? (
                paletteResults.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">No matching pages.</p>
                ) : (
                paletteResults.map((page, index) => {
                  const pageInfo = getPageMeta(page);
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
                          {pageInfo.sidebarSection}
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
                  const pageInfo = getPageMeta(result.page);
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
                          {result.page ? ` • ${pageInfo.sidebarSection}` : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                        <span>{result.node.kind === "task" ? "Task" : "Note"}</span>
                      </span>
                    </button>
                  );
                })
              ) : paletteQuery.trim().length === 0 ? (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
                  Ask questions across all active notes and tasks in all active pages.
                </p>
              ) : isKnowledgeChatLoading ? (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">Thinking with your knowledge base…</p>
              ) : knowledgeChatResponse ? (
                <div className="space-y-4 px-5 py-4">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                      Answer
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--workspace-text)]">
                      {knowledgeChatResponse.answer}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-accent)]">
                      Sources
                    </p>
                    <div className="mt-2 space-y-2">
                      {knowledgeChatResponse.sources.length === 0 ? (
                        <p className="text-sm text-[var(--workspace-text-subtle)]">No source snippets available.</p>
                      ) : (
                        knowledgeChatResponse.sources.map((result, index) => {
                          const pageInfo = getPageMeta(result.page);
                          return (
                            <button
                              key={`${result.node._id}:${index}`}
                              type="button"
                              onClick={() => handleSelectNodeSearchResult(result)}
                              className="block w-full border border-[var(--workspace-border-subtle)] bg-[var(--workspace-surface-muted)] px-4 py-3 text-left transition hover:border-[var(--workspace-border-hover)] hover:bg-[var(--workspace-surface-hover)]"
                            >
                              <span className="block truncate text-sm font-medium text-[var(--workspace-text)]">
                                {result.node.text || "(empty line)"}
                              </span>
                              <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                                {result.page?.title ?? "Unknown page"}
                                {result.page ? ` • ${pageInfo.sidebarSection}` : ""}
                              </span>
                              {result.content && result.content.trim() !== result.node.text.trim() ? (
                                <span className="mt-2 block whitespace-pre-wrap text-xs leading-6 text-[var(--workspace-text-subtle)]">
                                  {result.content}
                                </span>
                              ) : null}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-[var(--workspace-border-subtle)] pt-3 text-[11px] uppercase tracking-[0.18em] text-[var(--workspace-text-faint)]">
                    <span>{knowledgeChatResponse.model}</span>
                    <span>{knowledgeChatResponse.error ? "OpenAI issue surfaced" : "Grounded with semantic retrieval"}</span>
                  </div>
                </div>
              ) : (
                <p className="px-5 py-4 text-sm text-[var(--workspace-text-subtle)]">
                  Press Enter to ask your knowledge base.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
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
  selectedNodeIds,
  onSelectionStart,
  onSelectionExtend,
  depthOffset = 0,
  action = null,
  statusMessage = "",
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
  selectedNodeIds: Set<string>;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
  depthOffset?: number;
  action?: ReactNode;
  statusMessage?: string;
}) {
  const lastChild = sectionNode
    ? sectionNode.children[sectionNode.children.length - 1] ?? null
    : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {statusMessage ? (
        <p className="mt-2 text-sm text-[var(--workspace-text-subtle)]">{statusMessage}</p>
      ) : null}
      <div className="mt-2 border-b border-[var(--workspace-border)]" />
      <div className="mt-4 space-y-1">
        <OutlineNodeList
          nodes={sectionNode?.children ?? []}
          ownerKey={ownerKey}
          pageId={pageId}
          nodeMap={nodeMap}
          createNodesBatch={createNodesBatch}
          updateNode={updateNode}
          moveNode={moveNode}
          splitNode={splitNode}
          replaceNodeAndInsertSiblings={replaceNodeAndInsertSiblings}
          setNodeTreeArchived={setNodeTreeArchived}
          depth={depthOffset}
          isPageReadOnly={isPageReadOnly}
          selectedNodeIds={selectedNodeIds}
          onSelectionStart={onSelectionStart}
          onSelectionExtend={onSelectionExtend}
        />
        <InlineComposer
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={(sectionNode?._id as Id<"nodes"> | undefined) ?? undefined}
          afterNodeId={(lastChild?._id as Id<"nodes"> | undefined) ?? undefined}
          createNodesBatch={createNodesBatch}
          readOnly={isPageReadOnly}
          depth={depthOffset}
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
  selectedNodeIds,
  onSelectionStart,
  onSelectionExtend,
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
  selectedNodeIds: Set<string>;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
}) {
  return (
    <>
      {nodes.map((node, index) => (
        <OutlineNodeEditor
          key={`${node._id}:${node.updatedAt}`}
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
          depth={depth}
          isPageReadOnly={isPageReadOnly}
          isSelected={selectedNodeIds.has(node._id)}
          selectedNodeIds={selectedNodeIds}
          onSelectionStart={onSelectionStart}
          onSelectionExtend={onSelectionExtend}
        />
      ))}
    </>
  );
}

function OutlineNodeEditor({
  node,
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
  isSelected,
  selectedNodeIds,
  onSelectionStart,
  onSelectionExtend,
}: {
  node: TreeNode;
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
  isSelected: boolean;
  selectedNodeIds: Set<string>;
  onSelectionStart: (nodeId: string) => void;
  onSelectionExtend: (nodeId: string) => void;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState(node.text);
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);

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
  const isVisualEmptyLine = draft.trim() === ".";
  const shouldRevealVisualEmptyLine = isFocused || isSelected;

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

        afterPlacement = buildNodePlacement(
          pageId,
          previousSibling._id as Id<"nodes">,
          null,
        );
        await moveNode({
          ownerKey,
          nodeId: node._id as Id<"nodes">,
          pageId,
          parentNodeId: previousSibling._id as Id<"nodes">,
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
      const normalizedHead = parseSplitSegmentDraft(headDraft, segmentFallback);
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
      return;
    }

    const result = await commitNodeText(draft);
    if (result.deleted) {
      return;
    }

    const createdNodes = (await createNodesBatch({
      ownerKey,
      pageId,
      nodes: [
        {
          parentNodeId,
          afterNodeId: node._id as Id<"nodes">,
          text: "",
          kind: "note",
          taskStatus: null,
        },
      ],
    })) as Doc<"nodes">[];

    const createEntry: HistoryEntry | null =
      createdNodes[0]
        ? {
            type: "create_nodes",
            pageId,
            nodes: [
              toCreatedNodeSnapshot(
                createdNodes[0],
                node._id as Id<"nodes">,
              ),
            ],
            focusAfterUndoId: editorId,
            focusAfterRedoId: getNodeEditorId(createdNodes[0]._id),
          }
        : null;

    if (result.updateEntry && createEntry) {
      history.pushUndoEntry({
        type: "compound",
        pageId,
        entries: [result.updateEntry, createEntry],
        focusAfterUndoId: editorId,
        focusAfterRedoId: createEntry.focusAfterRedoId,
      });
      return;
    }

    if (result.updateEntry) {
      history.pushUndoEntry(result.updateEntry);
      return;
    }

    if (createEntry) {
      history.pushUndoEntry(createEntry);
    }
  };

  return (
    <div className="space-y-0.5">
      <div
        data-node-shell
        data-node-id={node._id}
        className={clsx("rounded-sm transition", isSelected ? "bg-[var(--workspace-sidebar-bg)]" : "")}
        style={{ marginLeft: `${depth * 18}px` }}
      >
        <div className="flex items-start gap-2">
          <button
            type="button"
            data-selection-gutter="true"
            aria-label="Select line"
            onMouseDown={(event) => {
              event.preventDefault();
              onSelectionStart(node._id);
            }}
            onMouseEnter={() => onSelectionExtend(node._id)}
            className="mt-1 h-5 w-3 flex-none cursor-default border-r border-transparent text-transparent"
          >
            |
          </button>
          <div className="flex h-6 w-5 flex-none items-center justify-center text-[var(--workspace-accent)]">
            {isLocked || (isVisualEmptyLine && !shouldRevealVisualEmptyLine) ? null : node.kind === "task" ? (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void handleToggleTask()}
                disabled={isDisabled}
                className={clsx(
                  "flex h-4 w-4 items-center justify-center border text-[10px] transition",
                  node.taskStatus === "done"
                    ? "border-[var(--workspace-brand)] bg-[var(--workspace-brand)] text-[var(--workspace-inverse-text)]"
                    : "border-[var(--workspace-border-hover)] bg-[var(--workspace-surface)] text-transparent hover:border-[var(--workspace-accent)]",
                  isDisabled ? "cursor-not-allowed opacity-70" : "",
                )}
              >
                x
              </button>
            ) : (
              <span className="text-base leading-none text-[var(--workspace-accent)]">•</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                history.updateDraftValue(editorId, editorTarget, event.target.value);
              }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => void handleSave()}
              onBlurCapture={() => setIsFocused(false)}
              onPaste={(event) => void handlePaste(event)}
              onKeyDown={(event) => void handleKeyDown(event)}
              placeholder="Write a line…"
              disabled={isDisabled}
              rows={1}
              className={clsx(
                "w-full resize-none overflow-hidden border-0 border-b border-transparent bg-transparent px-0 py-0.5 text-[15px] leading-6 outline-none transition focus:border-[var(--workspace-border)] disabled:text-[var(--workspace-text-muted)]",
                node.taskStatus === "done" ? "text-[var(--workspace-text-faint)] line-through" : "",
                isVisualEmptyLine && !shouldRevealVisualEmptyLine ? "text-transparent" : "",
              )}
            />
          </div>
        </div>
      </div>
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
        selectedNodeIds={selectedNodeIds}
        onSelectionStart={onSelectionStart}
        onSelectionExtend={onSelectionExtend}
      />
    </div>
  );
}

function InlineComposer({
  ownerKey,
  pageId,
  parentNodeId,
  afterNodeId,
  createNodesBatch,
  readOnly = false,
  depth = 0,
}: {
  ownerKey: string;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null | undefined;
  afterNodeId?: Id<"nodes">;
  createNodesBatch: CreateNodesBatchMutation;
  readOnly?: boolean;
  depth?: number;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const editorId = getComposerEditorId(pageId, parentNodeId ?? null);
  const editorTarget = useMemo(
    () =>
      ({
        kind: "composer",
        pageId,
        parentNodeId: parentNodeId ?? null,
      } satisfies TrackedEditorTarget),
    [pageId, parentNodeId],
  );

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

  const submitLines = async (value: string) => {
    if (readOnly) {
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
  };

  const handleKeyDown = async (event: TextareaKeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) {
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    await submitLines(draft);
  };

  const handlePaste = async (event: TextareaClipboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) {
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

  return (
    <div style={{ marginLeft: `${depth * 18 + 26}px` }}>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          history.updateDraftValue(editorId, editorTarget, event.target.value);
        }}
        onBlur={() => history.flushDraftCheckpoint(editorId)}
        onPaste={(event) => void handlePaste(event)}
        onKeyDown={(event) => void handleKeyDown(event)}
        placeholder="New line…"
        disabled={readOnly}
        rows={1}
        className="w-full resize-none overflow-hidden border-0 border-b border-transparent bg-transparent px-0 py-0.5 text-[15px] leading-6 outline-none transition focus:border-[var(--workspace-border)] disabled:text-[var(--workspace-text-muted)]"
      />
    </div>
  );
}
