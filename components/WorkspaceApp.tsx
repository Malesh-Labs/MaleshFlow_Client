"use client";

import JSZip from "jszip";
import clsx from "clsx";
import { useAction, useMutation, useQuery } from "convex/react";
import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { buildOutlineTree, type OutlineTreeNode } from "@/lib/domain/outline";

type SearchResult = {
  node: Doc<"nodes">;
  page?: Doc<"pages"> | null;
  score?: number;
};

const SKIP = "skip" as const;

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
  ) as Array<OutlineTreeNode<{
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
  }>>;
}

export default function WorkspaceApp() {
  const convexConfigured = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);
  const { ownerKey, setOwnerKey, isReady } = useOwnerKey();
  const [draftOwnerKey, setDraftOwnerKey] = useState("");

  if (!convexConfigured) {
    return (
      <main className="min-h-screen bg-stone-950 text-stone-100 grid place-items-center p-6">
        <div className="w-full max-w-2xl rounded-[2rem] border border-stone-800 bg-stone-900/80 p-8 shadow-2xl shadow-black/30">
          <p className="text-xs uppercase tracking-[0.35em] text-amber-300/80">
            Configuration Needed
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white">
            Connect Convex to boot the workspace
          </h1>
          <p className="mt-4 text-sm leading-7 text-stone-400">
            Set `NEXT_PUBLIC_CONVEX_URL` for the Next.js app and configure the
            matching Convex deployment before using the outliner. The UI is in
            place; it just needs the live backend URL to hydrate.
          </p>
        </div>
      </main>
    );
  }

  if (!isReady) {
    return (
      <main className="min-h-screen bg-stone-950 text-stone-100 grid place-items-center">
        <div className="rounded-3xl border border-stone-800 bg-stone-900/80 px-6 py-5 text-sm text-stone-300">
          Loading workspace…
        </div>
      </main>
    );
  }

  if (!ownerKey) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.18),_transparent_30%),linear-gradient(180deg,#111827_0%,#020617_100%)] text-stone-100 grid place-items-center p-6">
        <div className="w-full max-w-md rounded-[2rem] border border-stone-800/80 bg-stone-950/90 p-8 shadow-2xl shadow-black/40">
          <p className="text-xs uppercase tracking-[0.35em] text-amber-300/80">
            Owner Access
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white">
            MaleshFlow
          </h1>
          <p className="mt-3 text-sm leading-6 text-stone-400">
            Enter the owner access token to unlock the workspace. If you
            haven&apos;t configured one yet in local development, any non-empty
            value will work until `OWNER_ACCESS_TOKEN` is set in both Next.js
            and Convex.
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
              className="w-full rounded-2xl border border-stone-800 bg-stone-900 px-4 py-3 text-sm text-white outline-none ring-0 transition focus:border-amber-400"
            />
            <button
              type="submit"
              className="w-full rounded-2xl bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-300"
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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [isPlanningChat, setIsPlanningChat] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [createPageTitle, setCreatePageTitle] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());

  const pages = useQuery(
    api.workspace.listPages,
    ownerKey ? { ownerKey } : SKIP,
  );
  const pageTree = useQuery(
    api.workspace.getPageTree,
    ownerKey && selectedPageId ? { ownerKey, pageId: selectedPageId } : SKIP,
  );
  const tasks = useQuery(
    api.workspace.listTasks,
    ownerKey ? { ownerKey } : SKIP,
  );
  const chatThread = useQuery(
    api.chatData.getChatThread,
    ownerKey && selectedPageId ? { ownerKey, pageId: selectedPageId } : SKIP,
  );

  const createPage = useMutation(api.workspace.createPage);
  const renamePage = useMutation(api.workspace.renamePage);
  const createNode = useMutation(api.workspace.createNode);
  const updateNode = useMutation(api.workspace.updateNode);
  const moveNode = useMutation(api.workspace.moveNode);
  const reorderNode = useMutation(api.workspace.reorderNode);
  const archiveNode = useMutation(api.workspace.archiveNode);
  const deleteNode = useMutation(api.workspace.deleteNode);
  const ensureChatThread = useMutation(api.chatData.ensureChatThread);
  const applyApprovedChatPlan = useMutation(api.chatData.applyApprovedChatPlan);

  const searchNodes = useAction(api.ai.searchNodes);
  const runChatPlanner = useAction(api.chat.runChatPlanner);
  const importMarkdownBundle = useAction(api.importExport.importMarkdownBundle);
  const exportWorkspace = useAction(api.importExport.exportWorkspace);

  useEffect(() => {
    if (!pages || pages.length === 0 || selectedPageId) {
      return;
    }

    setSelectedPageId(pages[0]!._id);
  }, [pages, selectedPageId]);

  useEffect(() => {
    if (!ownerKey || !selectedPageId) {
      return;
    }

    void ensureChatThread({ ownerKey, pageId: selectedPageId });
  }, [ensureChatThread, ownerKey, selectedPageId]);

  useEffect(() => {
    if (!ownerKey || deferredSearchQuery.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    void searchNodes({
      ownerKey,
      query: deferredSearchQuery,
      pageId: selectedPageId ?? undefined,
      limit: 8,
    })
      .then((results) => {
        if (!cancelled) {
          setSearchResults(results as SearchResult[]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deferredSearchQuery, ownerKey, searchNodes, selectedPageId]);

  const nodes = useMemo<Doc<"nodes">[]>(() => pageTree?.nodes ?? [], [pageTree]);
  const tree = useMemo(() => toTreeNodes(nodes), [nodes]);
  const nodeMap = useMemo(
    () => new Map<Id<"nodes">, Doc<"nodes">>(nodes.map((node) => [node._id, node])),
    [nodes],
  );

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,191,36,0.12),_transparent_25%),radial-gradient(circle_at_bottom_right,_rgba(14,165,233,0.12),_transparent_30%),linear-gradient(180deg,#fafaf9_0%,#f5f5f4_100%)] text-stone-900">
      <div className="mx-auto flex min-h-screen max-w-[1800px] flex-col p-4 md:p-6">
        <div className="grid min-h-[calc(100vh-2rem)] grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_360px]">
          <aside className="rounded-[2rem] border border-stone-200/80 bg-white/85 p-4 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.45)] backdrop-blur">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-[0.28em] text-stone-500">
                  Pages
                </p>
                <h2 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950">
                  Workspace
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setOwnerKey("")}
                className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-500 transition hover:border-stone-300 hover:text-stone-800"
              >
                Lock
              </button>
            </div>

            <form
              className="mt-5 flex gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                const title = createPageTitle.trim();
                if (!title) {
                  return;
                }
                const pageId = await createPage({ ownerKey, title });
                setCreatePageTitle("");
                setSelectedPageId(pageId);
              }}
            >
              <input
                value={createPageTitle}
                onChange={(event) => setCreatePageTitle(event.target.value)}
                placeholder="New page"
                className="min-w-0 flex-1 rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm outline-none transition focus:border-amber-400"
              />
              <button
                type="submit"
                className="rounded-2xl bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
              >
                Add
              </button>
            </form>

            <div className="mt-5 space-y-2">
              {(pages ?? []).map((page: Doc<"pages">) => (
                <button
                  key={page._id}
                  type="button"
                  onClick={() => setSelectedPageId(page._id)}
                  className={clsx(
                    "w-full rounded-2xl border px-3 py-3 text-left transition",
                    selectedPageId === page._id
                      ? "border-stone-900 bg-stone-950 text-white shadow-lg shadow-stone-950/10"
                      : "border-stone-200 bg-stone-50 text-stone-700 hover:border-stone-300 hover:bg-white",
                  )}
                >
                  <div className="text-sm font-semibold">{page.title}</div>
                  <div
                    className={clsx(
                      "mt-1 text-xs",
                      selectedPageId === page._id
                        ? "text-stone-300"
                        : "text-stone-500",
                    )}
                  >
                    /{page.slug}
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-6 rounded-[1.5rem] border border-stone-200 bg-stone-50 p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">
                  Tasks
                </p>
                <span className="rounded-full bg-stone-200 px-2.5 py-1 text-xs text-stone-700">
                  {tasks?.length ?? 0}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {(tasks ?? []).slice(0, 8).map((task: Doc<"nodes">) => (
                  <button
                    key={task._id}
                    type="button"
                    onClick={() => setSelectedPageId(task.pageId)}
                    className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-left text-sm text-stone-700 transition hover:border-stone-300"
                  >
                    <div className="line-clamp-2">{task.text || "Untitled task"}</div>
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <section className="rounded-[2rem] border border-stone-200/80 bg-white/85 p-4 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.45)] backdrop-blur md:p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-[0.28em] text-stone-500">
                  Infinite Outline
                </p>
                <div className="mt-2 flex items-center gap-3">
                  <h1 className="truncate text-3xl font-semibold tracking-tight text-stone-950">
                    {pageTree?.page.title ?? "Choose a page"}
                  </h1>
                  {pageTree?.page ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const nextTitle = window.prompt(
                          "Rename page",
                          pageTree.page.title,
                        );
                        if (!nextTitle || nextTitle.trim() === pageTree.page.title) {
                          return;
                        }
                        await renamePage({
                          ownerKey,
                          pageId: pageTree.page._id,
                          title: nextTitle.trim(),
                        });
                      }}
                      className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 transition hover:border-stone-300 hover:text-stone-900"
                    >
                      Rename
                    </button>
                  ) : null}
                </div>
                {pageTree?.backlinks?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {pageTree.backlinks.slice(0, 8).map((link: Doc<"links">) => (
                      <span
                        key={link._id}
                        className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-900"
                      >
                        Linked from {link.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative min-w-[260px]">
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Semantic search this page"
                    className="w-full rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm outline-none transition focus:border-sky-400"
                  />
                  {searchQuery.trim().length > 1 && (
                    <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-20 rounded-2xl border border-stone-200 bg-white p-2 shadow-2xl shadow-stone-900/10">
                      {isSearching ? (
                        <div className="px-3 py-2 text-sm text-stone-500">
                          Searching…
                        </div>
                      ) : searchResults.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-stone-500">
                          No matching nodes yet.
                        </div>
                      ) : (
                        searchResults.map((result) => (
                          <button
                            key={result.node._id}
                            type="button"
                            onClick={() => {
                              startTransition(() => {
                                setSelectedPageId(result.node.pageId);
                                setSearchQuery("");
                              });
                            }}
                            className="block w-full rounded-xl px-3 py-2 text-left transition hover:bg-stone-50"
                          >
                            <div className="text-sm font-medium text-stone-900">
                              {result.node.text || "Untitled node"}
                            </div>
                            <div className="mt-1 text-xs text-stone-500">
                              {result.page?.title ?? "Current page"}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => importInputRef.current?.click()}
                  disabled={isImporting}
                  className="rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm font-medium text-stone-700 transition hover:border-stone-300 hover:bg-stone-50 disabled:opacity-60"
                >
                  {isImporting ? "Importing…" : "Import Markdown"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setIsExporting(true);
                    try {
                      const bundle = await exportWorkspace({ ownerKey });
                      const zip = new JSZip();
                      for (const file of bundle as Array<{ path: string; content: string }>) {
                        zip.file(file.path, file.content);
                      }
                      const blob = await zip.generateAsync({ type: "blob" });
                      const url = window.URL.createObjectURL(blob);
                      const anchor = document.createElement("a");
                      anchor.href = url;
                      anchor.download = "maleshflow-export.zip";
                      anchor.click();
                      window.URL.revokeObjectURL(url);
                    } finally {
                      setIsExporting(false);
                    }
                  }}
                  disabled={isExporting}
                  className="rounded-2xl bg-sky-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-60"
                >
                  {isExporting ? "Exporting…" : "Export Markdown"}
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={async (event) => {
                    const files = Array.from(event.target.files ?? []);
                    if (files.length === 0) {
                      return;
                    }
                    setIsImporting(true);
                    try {
                      const payload = await Promise.all(
                        files.map(async (file) => ({
                          path: file.webkitRelativePath || file.name,
                          content: await file.text(),
                        })),
                      );
                      await importMarkdownBundle({
                        ownerKey,
                        files: payload,
                      });
                    } finally {
                      setIsImporting(false);
                      event.target.value = "";
                    }
                  }}
                  {...({
                    webkitdirectory: "true",
                    directory: "",
                  } as Record<string, string>)}
                />
              </div>
            </div>

            {!selectedPageId ? (
              <div className="mt-10 rounded-[1.75rem] border border-dashed border-stone-300 bg-stone-50 px-6 py-10 text-center text-stone-500">
                Create your first page to start outlining.
              </div>
            ) : (
              <div className="mt-8 space-y-3">
                <button
                  type="button"
                  onClick={async () => {
                    if (!selectedPageId) {
                      return;
                    }
                    await createNode({
                      ownerKey,
                      pageId: selectedPageId,
                      text: "",
                    });
                  }}
                  className="rounded-2xl border border-dashed border-stone-300 px-4 py-2 text-sm text-stone-600 transition hover:border-stone-400 hover:text-stone-900"
                >
                  Add top-level node
                </button>

                <div className="space-y-2">
                  {tree.map((node, index) => (
                    <OutlineNodeEditor
                      key={node._id}
                      node={node}
                      depth={0}
                      siblings={tree}
                      index={index}
                      ownerKey={ownerKey}
                      selectedPageId={selectedPageId}
                      allNodes={nodeMap}
                      createNode={createNode}
                      updateNode={updateNode}
                      moveNode={moveNode}
                      reorderNode={reorderNode}
                      archiveNode={archiveNode}
                      deleteNode={deleteNode}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>

          <aside className="rounded-[2rem] border border-stone-200/80 bg-stone-950 p-4 text-stone-100 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.45)] md:p-5">
            <p className="text-[11px] uppercase tracking-[0.28em] text-stone-500">
              Chat Actions
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
              Approval-first agent
            </h2>
            <div className="mt-5 space-y-3 overflow-y-auto pr-1">
              {(chatThread?.messages ?? []).map((message: Doc<"chatMessages">) => (
                <div
                  key={message._id}
                  className={clsx(
                    "rounded-[1.5rem] border p-4",
                    message.role === "user"
                      ? "border-stone-800 bg-stone-900"
                      : "border-stone-700 bg-stone-900/60",
                  )}
                >
                  <div className="text-xs uppercase tracking-[0.22em] text-stone-500">
                    {message.role}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-200">
                    {message.text}
                  </p>
                  {message.preview?.length ? (
                    <div className="mt-3 space-y-2 rounded-2xl bg-stone-950/80 p-3">
                      {message.preview.map((line: string) => (
                        <div key={line} className="text-sm text-stone-300">
                          {line}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {message.status === "pending_approval" ? (
                    <button
                      type="button"
                      onClick={async () => {
                        await applyApprovedChatPlan({
                          ownerKey,
                          messageId: message._id,
                        });
                      }}
                      className="mt-4 rounded-2xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-300"
                    >
                      Apply plan
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            <form
              className="mt-4 space-y-3"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!chatInput.trim()) {
                  return;
                }
                setIsPlanningChat(true);
                try {
                  await runChatPlanner({
                    ownerKey,
                    prompt: chatInput.trim(),
                    pageId: selectedPageId ?? undefined,
                    threadId: chatThread?.thread._id,
                  });
                  setChatInput("");
                } finally {
                  setIsPlanningChat(false);
                }
              }}
            >
              <textarea
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                rows={5}
                placeholder="Ask the workspace to reorganize todos, draft notes, or clean up this page."
                className="w-full rounded-[1.5rem] border border-stone-800 bg-stone-900 px-4 py-3 text-sm text-white outline-none transition focus:border-amber-400"
              />
              <button
                type="submit"
                disabled={isPlanningChat}
                className="w-full rounded-[1.5rem] bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:opacity-60"
              >
                {isPlanningChat ? "Planning…" : "Draft action plan"}
              </button>
            </form>
          </aside>
        </div>
      </div>
    </main>
  );
}

type OutlineNodeEditorProps = {
  node: OutlineTreeNode<{
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
  depth: number;
  siblings: Array<OutlineTreeNode<{
    _id: string;
    pageId: string;
    parentNodeId: string | null;
    position: number;
    text: string;
    kind: string;
    taskStatus: string | null;
    priority: string | null;
    dueAt: number | null;
    archived: boolean;
    sourceMeta?: Record<string, unknown> | null;
  }>>;
  index: number;
  ownerKey: string;
  selectedPageId: Id<"pages">;
  allNodes: Map<Id<"nodes">, Doc<"nodes">>;
  createNode: ReturnType<typeof useMutation<typeof api.workspace.createNode>>;
  updateNode: ReturnType<typeof useMutation<typeof api.workspace.updateNode>>;
  moveNode: ReturnType<typeof useMutation<typeof api.workspace.moveNode>>;
  reorderNode: ReturnType<typeof useMutation<typeof api.workspace.reorderNode>>;
  archiveNode: ReturnType<typeof useMutation<typeof api.workspace.archiveNode>>;
  deleteNode: ReturnType<typeof useMutation<typeof api.workspace.deleteNode>>;
};

function OutlineNodeEditor({
  node,
  depth,
  siblings,
  index,
  ownerKey,
  selectedPageId,
  allNodes,
  createNode,
  updateNode,
  moveNode,
  reorderNode,
  archiveNode,
  deleteNode,
}: OutlineNodeEditorProps) {
  const nodeId = node._id as Id<"nodes">;
  const parentNode = node.parentNodeId
    ? allNodes.get(node.parentNodeId as Id<"nodes">)
    : null;
  const previousSibling = siblings[index - 1] ?? null;

  const moveUp = async () => {
    const afterNodeId =
      index > 1 ? (siblings[index - 2]!._id as Id<"nodes">) : null;
    await reorderNode({
      ownerKey,
      nodeId,
      afterNodeId,
    });
  };

  const moveDown = async () => {
    const nextSibling = siblings[index + 1];
    if (!nextSibling) {
      return;
    }
    await reorderNode({
      ownerKey,
      nodeId,
      afterNodeId: nextSibling._id as Id<"nodes">,
    });
  };

  const indent = async () => {
    if (!previousSibling) {
      return;
    }
    await moveNode({
      ownerKey,
      nodeId,
      pageId: selectedPageId,
      parentNodeId: previousSibling._id as Id<"nodes">,
    });
  };

  const outdent = async () => {
    if (!parentNode) {
      return;
    }
    await moveNode({
      ownerKey,
      nodeId,
      pageId: selectedPageId,
      parentNodeId: parentNode.parentNodeId,
      afterNodeId: parentNode._id,
    });
  };

  return (
    <div className="space-y-2">
      <div
        className="rounded-[1.5rem] border border-stone-200 bg-stone-50/80 p-3 transition hover:border-stone-300 hover:bg-white"
        style={{ marginLeft: depth * 18 }}
      >
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={async () => {
              if (node.kind === "task") {
                await updateNode({
                  ownerKey,
                  nodeId,
                  taskStatus: node.taskStatus === "done" ? "todo" : "done",
                });
                return;
              }

              await updateNode({
                ownerKey,
                nodeId,
                kind: "task",
                taskStatus: "todo",
              });
            }}
            className={clsx(
              "mt-1 h-5 w-5 rounded-md border text-[11px] font-bold transition",
              node.kind === "task"
                ? node.taskStatus === "done"
                  ? "border-emerald-500 bg-emerald-500 text-white"
                  : "border-amber-500 bg-amber-100 text-amber-900"
                : "border-stone-300 bg-white text-stone-400",
            )}
          >
            {node.kind === "task" && node.taskStatus === "done" ? "✓" : ""}
          </button>

          <textarea
            key={`${node._id}:${node.updatedAt}`}
            defaultValue={node.text}
            onBlur={async (event) => {
              const nextText = event.currentTarget.value;
              if (nextText !== node.text) {
                await updateNode({
                  ownerKey,
                  nodeId,
                  text: nextText,
                });
              }
            }}
            rows={Math.max(1, node.text.split("\n").length)}
            placeholder="Write a note or task"
            className="min-h-[2.25rem] flex-1 resize-none bg-transparent text-sm leading-6 text-stone-800 outline-none"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={async () => {
              await createNode({
                ownerKey,
                pageId: selectedPageId,
                parentNodeId: nodeId,
                text: "",
              });
            }}
            className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition hover:border-stone-300 hover:text-stone-900"
          >
            + Child
          </button>
          <button
            type="button"
            onClick={async () => {
              await createNode({
                ownerKey,
                pageId: selectedPageId,
                parentNodeId: node.parentNodeId ? (node.parentNodeId as Id<"nodes">) : null,
                afterNodeId: nodeId,
                text: "",
              });
            }}
            className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition hover:border-stone-300 hover:text-stone-900"
          >
            + Sibling
          </button>
          <button
            type="button"
            onClick={moveUp}
            disabled={index === 0}
            className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition hover:border-stone-300 hover:text-stone-900 disabled:opacity-40"
          >
            Up
          </button>
          <button
            type="button"
            onClick={moveDown}
            disabled={index === siblings.length - 1}
            className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition hover:border-stone-300 hover:text-stone-900 disabled:opacity-40"
          >
            Down
          </button>
          <button
            type="button"
            onClick={indent}
            disabled={!previousSibling}
            className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition hover:border-stone-300 hover:text-stone-900 disabled:opacity-40"
          >
            Indent
          </button>
          <button
            type="button"
            onClick={outdent}
            disabled={!parentNode}
            className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition hover:border-stone-300 hover:text-stone-900 disabled:opacity-40"
          >
            Outdent
          </button>
          <button
            type="button"
            onClick={async () => {
              await archiveNode({ ownerKey, nodeId });
            }}
            className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition hover:border-stone-300 hover:text-stone-900"
          >
            Archive
          </button>
          <button
            type="button"
            onClick={async () => {
              await deleteNode({ ownerKey, nodeId });
            }}
            className="rounded-full border border-rose-200 px-3 py-1 text-rose-700 transition hover:border-rose-300 hover:bg-rose-50"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={async () => {
              await updateNode({
                ownerKey,
                nodeId,
                kind: node.kind === "task" ? "note" : "task",
                taskStatus: node.kind === "task" ? null : "todo",
              });
            }}
            className="rounded-full border border-sky-200 px-3 py-1 text-sky-700 transition hover:border-sky-300 hover:bg-sky-50"
          >
            {node.kind === "task" ? "Convert to note" : "Convert to task"}
          </button>
        </div>
      </div>

      {node.children.map((child, childIndex) => (
        <OutlineNodeEditor
          key={child._id}
          node={child}
          depth={depth + 1}
          siblings={node.children}
          index={childIndex}
          ownerKey={ownerKey}
          selectedPageId={selectedPageId}
          allNodes={allNodes}
          createNode={createNode}
          updateNode={updateNode}
          moveNode={moveNode}
          reorderNode={reorderNode}
          archiveNode={archiveNode}
          deleteNode={deleteNode}
        />
      ))}
    </div>
  );
}
