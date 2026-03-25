"use client";

import clsx from "clsx";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as TextareaKeyboardEvent,
  type ClipboardEvent as TextareaClipboardEvent,
} from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { buildOutlineTree, type OutlineTreeNode } from "@/lib/domain/outline";
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
const SIDEBAR_SECTIONS = ["Models", "Tasks", "Templates", "Journal"] as const;
const OWNER_KEY_STORAGE_KEY = "maleshflow-owner-key";
const OWNER_KEY_EVENT = "maleshflow-owner-key-change";

type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
type PageType = "default" | "model";
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

type ModelChatDebug = {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response:
    | {
        summary: string;
        modelLines: string[];
      }
    | null;
  error: string | null;
};

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
  const pageType: PageType = sourceMeta.pageType === "model" ? "model" : "default";

  return { sidebarSection, pageType };
}

function getNodeMeta(node: Doc<"nodes"> | TreeNode | null | undefined) {
  if (!node || typeof node.sourceMeta !== "object" || !node.sourceMeta) {
    return {};
  }

  return node.sourceMeta as Record<string, unknown>;
}

function findModelSection(nodes: TreeNode[], slot: "model" | "recentExamples") {
  return nodes.find((node) => getNodeMeta(node).sectionSlot === slot) ?? null;
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
      <main className="grid min-h-screen place-items-center bg-[#f7f4ec] p-6 text-[#1b1916]">
        <div className="w-full max-w-xl rounded-[2rem] border border-[#d8cfbf] bg-white p-8 shadow-[0_30px_90px_-45px_rgba(53,41,24,0.45)]">
          <p className="text-xs uppercase tracking-[0.3em] text-[#8a6c2d]">
            Configuration Needed
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">
            Connect Convex to load the workspace
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-7 text-[#6a6257]">
            Set `NEXT_PUBLIC_CONVEX_URL` for the Next.js app and connect the
            matching Convex deployment before using the editor.
          </p>
        </div>
      </main>
    );
  }

  if (!ownerKey) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f7f4ec] p-6 text-[#1b1916]">
        <div className="w-full max-w-md border border-[#d8cfbf] bg-white p-8 shadow-[0_30px_90px_-45px_rgba(53,41,24,0.45)]">
          <p className="text-xs uppercase tracking-[0.3em] text-[#8a6c2d]">
            Owner Access
          </p>
          <p className="mt-3 text-sm leading-6 text-[#6a6257]">
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
              className="w-full border border-[#d8cfbf] bg-[#fcfbf8] px-4 py-3 text-sm outline-none transition focus:border-[#8a6c2d]"
            />
            <button
              type="submit"
              className="w-full bg-[#1f4a45] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#163733]"
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
  const [modelChatDebug, setModelChatDebug] = useState<ModelChatDebug | null>(null);
  const [isCreatingPage, setIsCreatingPage] = useState<SidebarSection | null>(null);
  const [isSendingChat, setIsSendingChat] = useState(false);

  const isOwnerKeyValid = useQuery(
    api.workspace.validateOwnerKey,
    ownerKey ? { ownerKey } : SKIP,
  );
  const pages = useQuery(
    api.workspace.listPages,
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
  const createNodesBatch = useMutation(api.workspace.createNodesBatch);
  const updateNode = useMutation(api.workspace.updateNode);
  const moveNode = useMutation(api.workspace.moveNode);
  const splitNode = useMutation(api.workspace.splitNode);
  const replaceNodeAndInsertSiblings = useMutation(
    api.workspace.replaceNodeAndInsertSiblings,
  );
  const setNodeTreeArchived = useMutation(api.workspace.setNodeTreeArchived);
  const rewriteModelSection = useAction(api.chat.rewriteModelSection);
  const pageTitleInputRef = useRef<HTMLInputElement>(null);
  const pageTitleDraftRef = useRef(pageTitleDraft);

  const history = useWorkspaceHistoryController({
    ownerKey,
    selectedPageId,
    setSelectedPageId,
    renamePage,
    updateNode,
    moveNode,
    setNodeTreeArchived,
  });

  useEffect(() => {
    pageTitleDraftRef.current = pageTitleDraft;
  }, [pageTitleDraft]);

  useEffect(() => {
    if (isOwnerKeyValid === false) {
      setOwnerKey("");
    }
  }, [isOwnerKeyValid, setOwnerKey]);

  useEffect(() => {
    if (!pages || pages.length === 0) {
      return;
    }

    if (!selectedPageId || !pages.some((page) => page._id === selectedPageId)) {
      setSelectedPageId(pages[0]!._id);
    }
  }, [pages, selectedPageId]);

  useEffect(() => {
    setPageTitleDraft(pageTree?.page?.title ?? "");
    setChatStatus("");
    setModelChatDebug(null);
  }, [pageTree?.page?._id, pageTree?.page?.title]);

  const selectedPage = pageTree?.page ?? null;
  const pageMeta = getPageMeta(selectedPage);
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

  const modelSection = findModelSection(tree, "model");
  const recentExamplesSection = findModelSection(tree, "recentExamples");
  const visibleModelChatDebug = modelChatDebug ?? {
    model: "gpt-5-mini",
    systemPrompt: "",
    userPrompt: "",
    response: null,
    error: null,
  };
  const genericRoots =
    pageMeta.pageType === "model"
      ? collectChildren(
          tree,
          new Set([modelSection?._id, recentExamplesSection?._id].filter(Boolean) as string[]),
        )
      : tree;

  const groupedPages = SIDEBAR_SECTIONS.map((section) => ({
    section,
    pages:
      pages?.filter((page) => getPageMeta(page).sidebarSection === section) ?? [],
  }));

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
      const pageType: PageType = section === "Models" ? "model" : "default";
      const title =
        section === "Models"
          ? "Untitled Model"
          : section === "Journal"
            ? "New Journal Page"
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

  const handleRunModelChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedPageId || modelChatInput.trim().length === 0) {
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
        debug: ModelChatDebug;
      };
      setChatStatus(result.summary);
      setModelChatDebug(result.debug);
      setModelChatInput("");
    } catch (error) {
      setChatStatus(
        error instanceof Error
          ? error.message
          : "Could not update the model right now.",
      );
      setModelChatDebug(null);
    } finally {
      setIsSendingChat(false);
    }
  };

  return (
    <WorkspaceHistoryProvider value={history}>
      <main className="min-h-screen bg-[#f7f4ec] text-[#1b1916]">
      <div className="mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-b border-[#d8cfbf] bg-[#efe7d9] p-6 lg:border-b-0 lg:border-r">
          <div className="flex items-start justify-end gap-4">
            <button
              type="button"
              onClick={() => setOwnerKey("")}
              className="border border-[#c9bda8] px-3 py-1 text-xs font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916]"
            >
              Lock
            </button>
          </div>

          <div className="mt-10 space-y-8">
            {groupedPages.map(({ section, pages: sectionPages }) => (
              <section key={section}>
                <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-[#7a6e5f]">
                  {section}
                </h2>
                <div className="mt-3 space-y-2">
                  {sectionPages.map((page) => (
                    <button
                      key={page._id}
                      type="button"
                      onClick={() => setSelectedPageId(page._id)}
                      className={clsx(
                        "block w-full border-l-2 px-3 py-2 text-left text-sm transition",
                        selectedPageId === page._id
                          ? "border-[#1f4a45] bg-[#f8f3ea] text-[#1f4a45]"
                          : "border-transparent text-[#433d35] hover:border-[#bcae96] hover:bg-[#f8f3ea]",
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
                  className="mt-3 w-full border border-dashed border-[#bcae96] px-3 py-2 text-left text-sm font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:bg-[#f8f3ea] disabled:cursor-wait disabled:opacity-60"
                >
                  {isCreatingPage === section ? "Creating page…" : `New ${section.slice(0, -1)}`}
                </button>
              </section>
            ))}
          </div>
        </aside>

        <section className="p-6 md:p-10">
          {!selectedPage ? (
            <div className="grid min-h-[60vh] place-items-center border border-dashed border-[#d8cfbf] bg-white/70 p-8 text-center">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-[#8a6c2d]">
                  Empty Workspace
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                  Create your first page from the sidebar
                </h2>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[calc(100vh-5rem)] flex-col border border-[#d8cfbf] bg-white">
              <div className="border-b border-[#ebe2d2] px-6 py-6 md:px-8">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs uppercase tracking-[0.3em] text-[#8a6c2d]">
                      {pageMeta.sidebarSection}
                    </p>
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
                      className="mt-4 w-full border-0 bg-transparent p-0 text-4xl font-semibold tracking-tight outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void history.undo()}
                      disabled={!history.canUndo || history.isApplyingHistory}
                      className="border border-[#d8cfbf] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Undo
                    </button>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void history.redo()}
                      disabled={!history.canRedo || history.isApplyingHistory}
                      className="border border-[#d8cfbf] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Redo
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex-1 px-6 py-6 md:px-8">
                {pageMeta.pageType === "model" ? (
                  <div className="space-y-8">
                    <ModelSection
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
                    />
                    <ModelSection
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
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
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
                    />
                    <InlineComposer
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      parentNodeId={null}
                      afterNodeId={genericRoots[genericRoots.length - 1]?._id as Id<"nodes"> | undefined}
                      createNodesBatch={createNodesBatch}
                    />
                  </div>
                )}
              </div>

              {pageMeta.pageType === "model" ? (
                <div className="border-t border-[#ebe2d2] px-6 py-5 md:px-8">
                  <form onSubmit={(event) => void handleRunModelChat(event)} className="space-y-3">
                    <input
                      value={modelChatInput}
                      onChange={(event) => setModelChatInput(event.target.value)}
                      placeholder="Ask AI..."
                      className="w-full border-0 border-b border-[#d8cfbf] bg-transparent px-0 py-2 text-sm outline-none"
                    />
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm text-[#6a6257]">{chatStatus}</p>
                      <button
                        type="submit"
                        disabled={isSendingChat || modelChatInput.trim().length === 0}
                        className="border border-[#1f4a45] px-4 py-2 text-sm font-semibold text-[#1f4a45] transition hover:bg-[#1f4a45] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isSendingChat ? "Thinking…" : "Send"}
                      </button>
                    </div>
                  </form>
                  <div className="mt-4 space-y-4 border-t border-[#ebe2d2] pt-4 text-xs text-[#5c5348]">
                    <p className="font-semibold uppercase tracking-[0.22em] text-[#8a6c2d]">
                      AI Debug
                    </p>
                    <div>
                      <p className="font-semibold uppercase tracking-[0.18em] text-[#8a6c2d]">
                        OpenAI Request
                      </p>
                      <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap border border-[#ebe2d2] bg-[#fcfbf8] p-4 font-mono text-[13px] leading-6">
{JSON.stringify(
  {
    model: visibleModelChatDebug.model,
    systemPrompt:
      visibleModelChatDebug.systemPrompt || "(send a message to populate this)",
    userPrompt:
      visibleModelChatDebug.userPrompt || "(send a message to populate this)",
  },
  null,
  2,
)}
                      </pre>
                    </div>
                    <div>
                      <p className="font-semibold uppercase tracking-[0.18em] text-[#8a6c2d]">
                        OpenAI Response
                      </p>
                      <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap border border-[#ebe2d2] bg-[#fcfbf8] p-4 font-mono text-[13px] leading-6">
{JSON.stringify(
  visibleModelChatDebug.error
    ? { error: visibleModelChatDebug.error }
    : visibleModelChatDebug.response ?? {
        status: "No response yet",
      },
  null,
  2,
)}
                      </pre>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
      </main>
    </WorkspaceHistoryProvider>
  );
}

function ModelSection({
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
}) {
  const lastChild = sectionNode
    ? sectionNode.children[sectionNode.children.length - 1] ?? null
    : null;

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-2 border-b border-[#d8cfbf]" />
      <div className="mt-4 space-y-2">
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
        />
        <InlineComposer
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={(sectionNode?._id as Id<"nodes"> | undefined) ?? undefined}
          afterNodeId={(lastChild?._id as Id<"nodes"> | undefined) ?? undefined}
          createNodesBatch={createNodesBatch}
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
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState(node.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);

  const nodeMeta = getNodeMeta(node);
  const isLocked = nodeMeta.locked === true;
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
    const beforeParsed = parseNodeDraft(beforeValue);
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
    if (isLocked) {
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

    const parsed = parseNodeDraft(nextDraft);
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

  const handlePaste = async (event: TextareaClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = event.clipboardData.getData("text");
    const lines = splitPastedLines(pastedText);
    if (lines.length <= 1 || isLocked) {
      return;
    }

    event.preventDefault();
    const [firstLine, ...restLines] = lines;
    if (!firstLine) {
      return;
    }

    const firstParsed = parseNodeDraft(firstLine);
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
    if (event.key === "Backspace" && draft.length === 0 && !isLocked) {
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
      if (isLocked) {
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

    if (event.key !== "Enter" || isLocked) {
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
    <div className="space-y-2">
      <div style={{ marginLeft: `${depth * 20}px` }}>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            history.updateDraftValue(editorId, editorTarget, event.target.value);
          }}
          onBlur={() => void handleSave()}
          onPaste={(event) => void handlePaste(event)}
          onKeyDown={(event) => void handleKeyDown(event)}
          placeholder="Write a line…"
          disabled={isLocked}
          rows={1}
          className="w-full resize-none overflow-hidden border-0 border-b border-transparent bg-transparent px-0 py-1 text-[15px] leading-7 outline-none transition focus:border-[#d8cfbf] disabled:text-[#5c5348]"
        />
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
}: {
  ownerKey: string;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null | undefined;
  afterNodeId?: Id<"nodes">;
  createNodesBatch: CreateNodesBatchMutation;
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
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    await submitLines(draft);
  };

  const handlePaste = async (event: TextareaClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = event.clipboardData.getData("text");
    const lines = splitPastedLines(pastedText);
    if (lines.length <= 1) {
      return;
    }

    event.preventDefault();
    await submitLines(pastedText);
  };

  return (
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
      rows={1}
      className="w-full resize-none overflow-hidden border-0 border-b border-transparent bg-transparent px-0 py-1 text-[15px] leading-7 outline-none transition focus:border-[#d8cfbf]"
    />
  );
}
