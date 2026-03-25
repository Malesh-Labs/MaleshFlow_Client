"use client";

import clsx from "clsx";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  useEffect,
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

const SKIP = "skip" as const;
const SIDEBAR_SECTIONS = ["Models", "Tasks", "Templates", "Journal"] as const;
const OWNER_KEY_STORAGE_KEY = "maleshflow-owner-key";
const OWNER_KEY_EVENT = "maleshflow-owner-key-change";

type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
type PageType = "default" | "model";
type UpdateNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.updateNode>>;
type CreateNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.createNode>>;
type DeleteNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.deleteNode>>;
type MoveNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.moveNode>>;

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
  const createNode = useMutation(api.workspace.createNode);
  const updateNode = useMutation(api.workspace.updateNode);
  const deleteNode = useMutation(api.workspace.deleteNode);
  const moveNode = useMutation(api.workspace.moveNode);
  const rewriteModelSection = useAction(api.chat.rewriteModelSection);

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
    if (!selectedPage || pageTitleDraft.trim() === selectedPage.title.trim()) {
      return;
    }

    await renamePage({
      ownerKey,
      pageId: selectedPage._id,
      title: pageTitleDraft.trim() || "Untitled",
    });
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
                <p className="text-xs uppercase tracking-[0.3em] text-[#8a6c2d]">
                  {pageMeta.sidebarSection}
                </p>
                <input
                  value={pageTitleDraft}
                  onChange={(event) => setPageTitleDraft(event.target.value)}
                  onBlur={() => void handleRenamePage()}
                  className="mt-4 w-full border-0 bg-transparent p-0 text-4xl font-semibold tracking-tight outline-none"
                />
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
                      updateNode={updateNode}
                      createNode={createNode}
                      deleteNode={deleteNode}
                      moveNode={moveNode}
                    />
                    <ModelSection
                      title="Recent"
                      sectionNode={recentExamplesSection}
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      nodeMap={nodeMap}
                      updateNode={updateNode}
                      createNode={createNode}
                      deleteNode={deleteNode}
                      moveNode={moveNode}
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <OutlineNodeList
                      nodes={genericRoots}
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      nodeMap={nodeMap}
                      updateNode={updateNode}
                      createNode={createNode}
                      deleteNode={deleteNode}
                      moveNode={moveNode}
                    />
                    <InlineComposer
                      ownerKey={ownerKey}
                      pageId={selectedPage._id}
                      parentNodeId={null}
                      afterNodeId={genericRoots[genericRoots.length - 1]?._id as Id<"nodes"> | undefined}
                      createNode={createNode}
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
  );
}

function ModelSection({
  title,
  sectionNode,
  ownerKey,
  pageId,
  nodeMap,
  updateNode,
  createNode,
  deleteNode,
  moveNode,
}: {
  title: string;
  sectionNode: TreeNode | null;
  ownerKey: string;
  pageId: Id<"pages">;
  nodeMap: Map<string, Doc<"nodes">>;
  updateNode: UpdateNodeMutation;
  createNode: CreateNodeMutation;
  deleteNode: DeleteNodeMutation;
  moveNode: MoveNodeMutation;
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
          updateNode={updateNode}
          createNode={createNode}
          deleteNode={deleteNode}
          moveNode={moveNode}
        />
        <InlineComposer
          ownerKey={ownerKey}
          pageId={pageId}
          parentNodeId={(sectionNode?._id as Id<"nodes"> | undefined) ?? undefined}
          afterNodeId={(lastChild?._id as Id<"nodes"> | undefined) ?? undefined}
          createNode={createNode}
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
  updateNode,
  createNode,
  deleteNode,
  moveNode,
  depth = 0,
  parentNodeId = null,
}: {
  nodes: TreeNode[];
  ownerKey: string;
  pageId: Id<"pages">;
  nodeMap: Map<string, Doc<"nodes">>;
  updateNode: UpdateNodeMutation;
  createNode: CreateNodeMutation;
  deleteNode: DeleteNodeMutation;
  moveNode: MoveNodeMutation;
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
          updateNode={updateNode}
          createNode={createNode}
          deleteNode={deleteNode}
          moveNode={moveNode}
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
  updateNode,
  createNode,
  deleteNode,
  moveNode,
  depth = 0,
}: {
  node: TreeNode;
  previousSibling: TreeNode | null;
  ownerKey: string;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null;
  nodeMap: Map<string, Doc<"nodes">>;
  updateNode: UpdateNodeMutation;
  createNode: CreateNodeMutation;
  deleteNode: DeleteNodeMutation;
  moveNode: MoveNodeMutation;
  depth?: number;
}) {
  const [draft, setDraft] = useState(node.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const nodeMeta = getNodeMeta(node);
  const isLocked = nodeMeta.locked === true;

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [draft]);

  const applyParsedDraft = async (nextDraft: string) => {
    if (isLocked) {
      return { deleted: false };
    }

    const parsed = parseNodeDraft(nextDraft);
    if (parsed.shouldDelete) {
      await deleteNode({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
      });
      return { deleted: true };
    }

    if (
      parsed.text === node.text &&
      parsed.kind === node.kind &&
      parsed.taskStatus === node.taskStatus
    ) {
      return { deleted: false };
    }

    await updateNode({
      ownerKey,
      nodeId: node._id as Id<"nodes">,
      text: parsed.text,
      kind: parsed.kind,
      taskStatus: parsed.taskStatus,
    });

    return { deleted: false };
  };

  const handleSave = async () => {
    return await applyParsedDraft(draft);
  };

  const createSiblingNodesFromLines = async (lines: string[]) => {
    let lastCreatedId = node._id as Id<"nodes">;

    for (const line of lines) {
      const parsed = parseNodeDraft(line);
      if (parsed.shouldDelete) {
        continue;
      }

      lastCreatedId = await createNode({
        ownerKey,
        pageId,
        parentNodeId,
        afterNodeId: lastCreatedId,
        text: parsed.text,
        kind: parsed.kind,
        taskStatus: parsed.taskStatus,
      });
    }
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

    setDraft(firstLine);
    const result = await applyParsedDraft(firstLine);
    if (!result.deleted && restLines.length > 0) {
      await createSiblingNodesFromLines(restLines);
    }
  };

  const handleKeyDown = async (event: TextareaKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Backspace" && draft.length === 0 && !isLocked) {
      event.preventDefault();
      await deleteNode({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
      });
      return;
    }

    if (event.key === "Tab") {
      if (isLocked) {
        return;
      }

      event.preventDefault();
      const result = await handleSave();
      if (result.deleted) {
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

        await moveNode({
          ownerKey,
          nodeId: node._id as Id<"nodes">,
          pageId,
          parentNodeId: (parentNode.parentNodeId as Id<"nodes"> | null) ?? null,
          afterNodeId: parentNode._id as Id<"nodes">,
        });
        return;
      }

      if (!previousSibling) {
        return;
      }

      await moveNode({
        ownerKey,
        nodeId: node._id as Id<"nodes">,
        pageId,
        parentNodeId: previousSibling._id as Id<"nodes">,
      });
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

      setDraft(headDraft);
      const result = await applyParsedDraft(headDraft);
      if (result.deleted) {
        return;
      }

      const tailParsed = parseNodeDraft(tailDraft);
      await createNode({
        ownerKey,
        pageId,
        parentNodeId,
        afterNodeId: node._id as Id<"nodes">,
        text: tailParsed.shouldDelete ? "" : tailParsed.text,
        kind: tailParsed.shouldDelete ? "note" : tailParsed.kind,
        taskStatus: tailParsed.shouldDelete ? undefined : tailParsed.taskStatus,
      });
      return;
    }

    const result = await handleSave();
    if (result.deleted) {
      return;
    }

    const parsed = parseNodeDraft(draft);
    if (parsed.shouldDelete) {
      return;
    }

    await createNode({
      ownerKey,
      pageId,
      parentNodeId,
      afterNodeId: node._id as Id<"nodes">,
      text: "",
      kind: "note",
    });
  };

  return (
    <div className="space-y-2">
      <div style={{ marginLeft: `${depth * 20}px` }}>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
        updateNode={updateNode}
        createNode={createNode}
        deleteNode={deleteNode}
        moveNode={moveNode}
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
  createNode,
}: {
  ownerKey: string;
  pageId: Id<"pages">;
  parentNodeId: Id<"nodes"> | null | undefined;
  afterNodeId?: Id<"nodes">;
  createNode: CreateNodeMutation;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [draft]);

  const handleSubmit = async () => {
    const lines = splitPastedLines(draft);
    if (lines.length === 0) {
      return;
    }

    let lastCreatedId = afterNodeId;
    for (const line of lines) {
      const parsed = parseNodeDraft(line);
      if (parsed.shouldDelete) {
        continue;
      }

      lastCreatedId = await createNode({
        ownerKey,
        pageId,
        parentNodeId: parentNodeId ?? null,
        afterNodeId: lastCreatedId,
        text: parsed.text,
        kind: parsed.kind,
        taskStatus: parsed.taskStatus,
      });
    }

    setDraft("");
  };

  const handleKeyDown = async (event: TextareaKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    await handleSubmit();
  };

  const handlePaste = async (event: TextareaClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = event.clipboardData.getData("text");
    const lines = splitPastedLines(pastedText);
    if (lines.length <= 1) {
      return;
    }

    event.preventDefault();
    let lastCreatedId = afterNodeId;
    for (const line of lines) {
      const parsed = parseNodeDraft(line);
      if (parsed.shouldDelete) {
        continue;
      }

      lastCreatedId = await createNode({
        ownerKey,
        pageId,
        parentNodeId: parentNodeId ?? null,
        afterNodeId: lastCreatedId,
        text: parsed.text,
        kind: parsed.kind,
        taskStatus: parsed.taskStatus,
      });
    }
    setDraft("");
  };

  return (
    <textarea
      ref={textareaRef}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onPaste={(event) => void handlePaste(event)}
      onKeyDown={(event) => void handleKeyDown(event)}
      placeholder="New line…"
      rows={1}
      className="w-full resize-none overflow-hidden border-0 border-b border-transparent bg-transparent px-0 py-1 text-[15px] leading-7 outline-none transition focus:border-[#d8cfbf]"
    />
  );
}
