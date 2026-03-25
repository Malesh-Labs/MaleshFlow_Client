"use client";

import clsx from "clsx";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { buildOutlineTree, type OutlineTreeNode } from "@/lib/domain/outline";

const SKIP = "skip" as const;
const SIDEBAR_SECTIONS = ["Models", "Tasks", "Templates", "Journal"] as const;

type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
type PageType = "default" | "model";
type UpdateNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.updateNode>>;
type CreateNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.createNode>>;
type DeleteNodeMutation = ReturnType<typeof useMutation<typeof api.workspace.deleteNode>>;

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
  const [{ ownerKey, isReady }, setState] = useState(() => {
    if (typeof window === "undefined") {
      return { ownerKey: "", isReady: false };
    }

    return {
      ownerKey: window.localStorage.getItem("maleshflow-owner-key") ?? "",
      isReady: true,
    };
  });

  const updateOwnerKey = (nextValue: string) => {
    setState({ ownerKey: nextValue, isReady: true });
    if (typeof window !== "undefined" && nextValue.trim().length > 0) {
      window.localStorage.setItem("maleshflow-owner-key", nextValue);
    } else if (typeof window !== "undefined") {
      window.localStorage.removeItem("maleshflow-owner-key");
    }
  };

  return { ownerKey, setOwnerKey: updateOwnerKey, isReady };
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

export default function WorkspaceApp() {
  const convexConfigured = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);
  const { ownerKey, setOwnerKey, isReady } = useOwnerKey();
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

  if (!isReady) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f7f4ec] text-[#1b1916]">
        <div className="rounded-[1.5rem] border border-[#d8cfbf] bg-white px-5 py-4 text-sm">
          Loading workspace…
        </div>
      </main>
    );
  }

  if (!ownerKey) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f7f4ec] p-6 text-[#1b1916]">
        <div className="w-full max-w-md rounded-[2rem] border border-[#d8cfbf] bg-white p-8 shadow-[0_30px_90px_-45px_rgba(53,41,24,0.45)]">
          <p className="text-xs uppercase tracking-[0.3em] text-[#8a6c2d]">
            Owner Access
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">
            MaleshFlow
          </h1>
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
              className="w-full rounded-[1.25rem] border border-[#d8cfbf] bg-[#fcfbf8] px-4 py-3 text-sm outline-none transition focus:border-[#8a6c2d]"
            />
            <button
              type="submit"
              className="w-full rounded-[1.25rem] bg-[#1f4a45] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#163733]"
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
  const [isCreatingPage, setIsCreatingPage] = useState<SidebarSection | null>(null);
  const [isSendingChat, setIsSendingChat] = useState(false);

  const pages = useQuery(api.workspace.listPages, ownerKey ? { ownerKey } : SKIP);
  const pageTree = useQuery(
    api.workspace.getPageTree,
    ownerKey && selectedPageId ? { ownerKey, pageId: selectedPageId } : SKIP,
  );

  const createPage = useMutation(api.workspace.createPage);
  const renamePage = useMutation(api.workspace.renamePage);
  const createNode = useMutation(api.workspace.createNode);
  const updateNode = useMutation(api.workspace.updateNode);
  const deleteNode = useMutation(api.workspace.deleteNode);
  const runChatPlanner = useAction(api.chat.runChatPlanner);

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
  }, [pageTree?.page?._id, pageTree?.page?.title]);

  const selectedPage = pageTree?.page ?? null;
  const pageMeta = getPageMeta(selectedPage);
  const tree = pageTree ? toTreeNodes(pageTree.nodes) : [];

  const modelSection = findModelSection(tree, "model");
  const recentExamplesSection = findModelSection(tree, "recentExamples");
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

  const handleCreateRootNode = async () => {
    if (!selectedPage) {
      return;
    }

    await createNode({
      ownerKey,
      pageId: selectedPage._id,
      parentNodeId: null,
      text: "",
      kind: "note",
    });
  };

  const handleCreateSectionNode = async (parentNodeId: Id<"nodes">) => {
    if (!selectedPage) {
      return;
    }

    await createNode({
      ownerKey,
      pageId: selectedPage._id,
      parentNodeId,
      text: "",
      kind: "note",
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
      const result = await runChatPlanner({
        ownerKey,
        pageId: selectedPageId,
        prompt: modelChatInput.trim(),
      });
      const preview = (result.plan.preview ?? []).slice(0, 2).join(" ");
      setChatStatus(preview || result.plan.summary);
      setModelChatInput("");
    } catch {
      setChatStatus("Could not run the model chat right now.");
    } finally {
      setIsSendingChat(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f7f4ec] text-[#1b1916]">
      <div className="mx-auto grid min-h-screen max-w-[1600px] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-b border-[#d8cfbf] bg-[#efe7d9] p-6 lg:border-b-0 lg:border-r">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-[#8a6c2d]">
                Workspace
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">
                MaleshFlow
              </h1>
            </div>
            <button
              type="button"
              onClick={() => setOwnerKey("")}
              className="rounded-full border border-[#c9bda8] px-3 py-1 text-xs font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916]"
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
                        "block w-full rounded-[1.1rem] px-4 py-3 text-left text-sm transition",
                        selectedPageId === page._id
                          ? "bg-[#1f4a45] text-white shadow-[0_14px_40px_-20px_rgba(31,74,69,0.7)]"
                          : "bg-[#f8f3ea] text-[#433d35] hover:bg-white",
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
                  className="mt-3 w-full rounded-[1.1rem] border border-dashed border-[#bcae96] px-4 py-3 text-left text-sm font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:bg-[#f8f3ea] disabled:cursor-wait disabled:opacity-60"
                >
                  {isCreatingPage === section ? "Creating page…" : `New ${section.slice(0, -1)}`}
                </button>
              </section>
            ))}
          </div>
        </aside>

        <section className="p-6 md:p-10">
          {!selectedPage ? (
            <div className="grid min-h-[60vh] place-items-center rounded-[2rem] border border-dashed border-[#d8cfbf] bg-white/70 p-8 text-center">
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
            <div className="flex min-h-[calc(100vh-5rem)] flex-col rounded-[2rem] border border-[#d8cfbf] bg-white shadow-[0_30px_90px_-45px_rgba(53,41,24,0.45)]">
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
                      onAdd={() =>
                        modelSection
                          ? void handleCreateSectionNode(modelSection._id as Id<"nodes">)
                          : undefined
                      }
                      ownerKey={ownerKey}
                      updateNode={updateNode}
                      createNode={createNode}
                      deleteNode={deleteNode}
                    />
                    <ModelSection
                      title="Recent Examples"
                      sectionNode={recentExamplesSection}
                      onAdd={() =>
                        recentExamplesSection
                          ? void handleCreateSectionNode(recentExamplesSection._id as Id<"nodes">)
                          : undefined
                      }
                      ownerKey={ownerKey}
                      updateNode={updateNode}
                      createNode={createNode}
                      deleteNode={deleteNode}
                    />
                    {genericRoots.length > 0 ? (
                      <div className="rounded-[1.5rem] border border-[#ebe2d2] bg-[#fcfbf8] p-5">
                        <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-[#7a6e5f]">
                          Other Notes
                        </h3>
                        <div className="mt-4 space-y-3">
                          {genericRoots.map((node) => (
                            <OutlineNodeEditor
                              key={`${node._id}:${node.updatedAt}`}
                              node={node}
                              ownerKey={ownerKey}
                              pageId={selectedPage._id}
                              updateNode={updateNode}
                              createNode={createNode}
                              deleteNode={deleteNode}
                            />
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCreateRootNode()}
                          className="mt-4 rounded-full border border-[#c9bda8] px-4 py-2 text-sm font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916]"
                        >
                          Add note
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {genericRoots.map((node) => (
                      <OutlineNodeEditor
                        key={`${node._id}:${node.updatedAt}`}
                        node={node}
                        ownerKey={ownerKey}
                        pageId={selectedPage._id}
                        updateNode={updateNode}
                        createNode={createNode}
                        deleteNode={deleteNode}
                      />
                    ))}
                    <button
                      type="button"
                      onClick={() => void handleCreateRootNode()}
                      className="rounded-full border border-[#c9bda8] px-4 py-2 text-sm font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916]"
                    >
                      Add root note
                    </button>
                  </div>
                )}
              </div>

              {pageMeta.pageType === "model" ? (
                <div className="border-t border-[#ebe2d2] px-6 py-5 md:px-8">
                  <form
                    onSubmit={(event) => void handleRunModelChat(event)}
                    className="space-y-3"
                  >
                    <div className="rounded-[1.4rem] border border-[#d8cfbf] bg-[#fcfbf8] px-4 py-3">
                      <input
                        value={modelChatInput}
                        onChange={(event) => setModelChatInput(event.target.value)}
                        placeholder="Ask this model page to generate or reorganize examples…"
                        className="w-full border-0 bg-transparent p-0 text-sm outline-none"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm text-[#6a6257]">
                        {chatStatus || "Chat lives at the bottom of model pages."}
                      </p>
                      <button
                        type="submit"
                        disabled={isSendingChat || modelChatInput.trim().length === 0}
                        className="rounded-full bg-[#1f4a45] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#163733] disabled:cursor-not-allowed disabled:opacity-60"
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
    </main>
  );
}

function ModelSection({
  title,
  sectionNode,
  onAdd,
  ownerKey,
  updateNode,
  createNode,
  deleteNode,
}: {
  title: string;
  sectionNode: TreeNode | null;
  onAdd: () => void;
  ownerKey: string;
  updateNode: UpdateNodeMutation;
  createNode: CreateNodeMutation;
  deleteNode: DeleteNodeMutation;
}) {
  return (
    <div className="rounded-[1.6rem] border border-[#ebe2d2] bg-[#fcfbf8] p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-full border border-[#c9bda8] px-4 py-2 text-sm font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916]"
        >
          Add item
        </button>
      </div>
      <div className="mt-4 space-y-3">
        {sectionNode?.children.map((child) => (
          <OutlineNodeEditor
            key={`${child._id}:${child.updatedAt}`}
            node={child}
            ownerKey={ownerKey}
            pageId={child.pageId as Id<"pages">}
            updateNode={updateNode}
            createNode={createNode}
            deleteNode={deleteNode}
          />
        ))}
        {!sectionNode || sectionNode.children.length === 0 ? (
          <p className="rounded-[1.1rem] border border-dashed border-[#d8cfbf] px-4 py-5 text-sm text-[#807667]">
            Nothing here yet.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function OutlineNodeEditor({
  node,
  ownerKey,
  pageId,
  updateNode,
  createNode,
  deleteNode,
  depth = 0,
}: {
  node: TreeNode;
  ownerKey: string;
  pageId: Id<"pages">;
  updateNode: UpdateNodeMutation;
  createNode: CreateNodeMutation;
  deleteNode: DeleteNodeMutation;
  depth?: number;
}) {
  const [draft, setDraft] = useState(node.text);

  const nodeMeta = getNodeMeta(node);
  const isLocked = nodeMeta.locked === true;
  const isTask = node.kind === "task";

  const handleSave = async () => {
    if (draft === node.text) {
      return;
    }

    await updateNode({
      ownerKey,
      nodeId: node._id as Id<"nodes">,
      text: draft,
    });
  };

  return (
    <div className="space-y-3">
      <div
        className="rounded-[1.15rem] border border-[#ebe2d2] bg-white p-3"
        style={{ marginLeft: `${depth * 20}px` }}
      >
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() =>
              void updateNode({
                ownerKey,
                nodeId: node._id as Id<"nodes">,
                kind: isTask ? "note" : "task",
                taskStatus: isTask ? null : "todo",
              })
            }
            className={clsx(
              "mt-1 h-5 w-5 rounded border transition",
              isTask
                ? "border-[#1f4a45] bg-[#1f4a45]"
                : "border-[#c9bda8] bg-transparent",
            )}
            aria-label={isTask ? "Convert to note" : "Convert to task"}
          >
            {isTask ? <span className="block text-[10px] text-white">✓</span> : null}
          </button>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void handleSave()}
            placeholder="Write something…"
            disabled={isLocked}
            rows={Math.max(1, draft.split("\n").length)}
            className="min-h-[1.75rem] flex-1 resize-none border-0 bg-transparent p-0 text-[15px] leading-7 outline-none disabled:text-[#5c5348]"
          />
        </div>
        {!isLocked ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                void createNode({
                  ownerKey,
                  pageId,
                  parentNodeId: node._id as Id<"nodes">,
                  text: "",
                  kind: "note",
                })
              }
              className="rounded-full border border-[#c9bda8] px-3 py-1 text-xs font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916]"
            >
              Add child
            </button>
            {isTask ? (
              <button
                type="button"
                onClick={() =>
                  void updateNode({
                    ownerKey,
                    nodeId: node._id as Id<"nodes">,
                    taskStatus: node.taskStatus === "done" ? "todo" : "done",
                  })
                }
                className="rounded-full border border-[#c9bda8] px-3 py-1 text-xs font-medium text-[#5c5348] transition hover:border-[#8a6c2d] hover:text-[#1b1916]"
              >
                {node.taskStatus === "done" ? "Mark todo" : "Mark done"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                void deleteNode({
                  ownerKey,
                  nodeId: node._id as Id<"nodes">,
                })
              }
              className="rounded-full border border-[#e4c2bf] px-3 py-1 text-xs font-medium text-[#99504b] transition hover:border-[#c36d66] hover:text-[#7a2821]"
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
      {node.children.map((child) => (
        <OutlineNodeEditor
          key={`${child._id}:${child.updatedAt}`}
          node={child}
          ownerKey={ownerKey}
          pageId={pageId}
          updateNode={updateNode}
          createNode={createNode}
          deleteNode={deleteNode}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
