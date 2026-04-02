import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "../convex/_generated/dataModel";
import {
  WorkspaceHistoryProvider,
  focusElementAtEnd,
  getNodeEditorId,
  getPageTitleEditorId,
  type NodeValueSnapshot,
  type TrackedEditorTarget,
  useWorkspaceHistory,
  useWorkspaceHistoryController,
} from "../components/workspaceHistory";

const PAGE_ONE = "page-1" as Id<"pages">;
const PAGE_TWO = "page-2" as Id<"pages">;
const NODE_ONE = "node-1" as Id<"nodes">;
const NODE_TWO = "node-2" as Id<"nodes">;

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });

  const { window } = dom;
  Object.defineProperties(globalThis, {
    window: { value: window, configurable: true },
    document: { value: window.document, configurable: true },
    navigator: { value: window.navigator, configurable: true },
    HTMLElement: { value: window.HTMLElement, configurable: true },
    HTMLInputElement: { value: window.HTMLInputElement, configurable: true },
    HTMLTextAreaElement: { value: window.HTMLTextAreaElement, configurable: true },
    Event: { value: window.Event, configurable: true },
    KeyboardEvent: { value: window.KeyboardEvent, configurable: true },
    MouseEvent: { value: window.MouseEvent, configurable: true },
    InputEvent: { value: window.InputEvent, configurable: true },
    getComputedStyle: {
      value: window.getComputedStyle.bind(window),
      configurable: true,
    },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
  });

  const htmlElementPrototype = window.HTMLElement.prototype as HTMLElement & {
    attachEvent?: () => void;
    detachEvent?: () => void;
  };

  if (!htmlElementPrototype.attachEvent) {
    Object.defineProperty(htmlElementPrototype, "attachEvent", {
      value: () => undefined,
      configurable: true,
    });
  }

  if (!htmlElementPrototype.detachEvent) {
    Object.defineProperty(htmlElementPrototype, "detachEvent", {
      value: () => undefined,
      configurable: true,
    });
  }

  return dom;
}

function TrackedTitleInput({
  pageId,
  committedValue,
  onCommit,
}: {
  pageId: Id<"pages">;
  committedValue: string;
  onCommit: (nextValue: string) => Promise<void>;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState(committedValue);
  const draftRef = useRef(draft);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorId = getPageTitleEditorId(pageId);
  const target = useMemo(
    () =>
      ({
        kind: "page_title",
        pageId,
      } satisfies TrackedEditorTarget),
    [pageId],
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setDraft(committedValue);
  }, [committedValue]);

  useEffect(() => {
    return history.registerEditor(editorId, target, committedValue, {
      getElement: () => inputRef.current,
      getValue: () => draftRef.current,
      setValue: setDraft,
      focusAtEnd: () => focusElementAtEnd(inputRef.current),
    });
  }, [committedValue, editorId, history, target]);

  useEffect(() => {
    history.syncCommittedValue(editorId, committedValue, target);
  }, [committedValue, editorId, history, target]);

  const commitDraft = async () => {
    await onCommit(draft);
    const before = history.commitTrackedValue(editorId, target, draft);
    if (before !== draft) {
      history.pushUndoEntry({
        type: "rename_page",
        pageId,
        beforeTitle: before,
        afterTitle: draft,
        focusEditorId: editorId,
      });
    }
  };

  return (
    <div>
      <input
        ref={inputRef}
        data-testid="page-title"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          history.updateDraftValue(editorId, target, event.target.value);
        }}
        onBlur={() => void commitDraft()}
      />
      <button
        data-testid="checkpoint-title"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => history.flushDraftCheckpoint(editorId)}
      >
        Checkpoint Title
      </button>
      <button
        data-testid="commit-title"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void commitDraft()}
      >
        Commit Title
      </button>
    </div>
  );
}

function TrackedNodeInput({
  pageId,
  nodeId,
  committedValue,
  onCommit,
}: {
  pageId: Id<"pages">;
  nodeId: Id<"nodes">;
  committedValue: string;
  onCommit: (nextValue: string) => Promise<void>;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState(committedValue);
  const draftRef = useRef(draft);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorId = getNodeEditorId(nodeId);
  const target = useMemo(
    () =>
      ({
        kind: "node",
        pageId,
        nodeId,
      } satisfies TrackedEditorTarget),
    [nodeId, pageId],
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setDraft(committedValue);
  }, [committedValue]);

  useEffect(() => {
    return history.registerEditor(editorId, target, committedValue, {
      getElement: () => inputRef.current,
      getValue: () => draftRef.current,
      setValue: setDraft,
      focusAtEnd: () => focusElementAtEnd(inputRef.current),
    });
  }, [committedValue, editorId, history, target]);

  useEffect(() => {
    history.syncCommittedValue(editorId, committedValue, target);
  }, [committedValue, editorId, history, target]);

  const commitDraft = async () => {
    await onCommit(draft);
    const before = history.commitTrackedValue(editorId, target, draft);
    if (before !== draft) {
      const beforeSnapshot: NodeValueSnapshot = {
        text: before,
        kind: "note",
        taskStatus: null,
        noteCompleted: false,
      };
      const afterSnapshot: NodeValueSnapshot = {
        text: draft,
        kind: "note",
        taskStatus: null,
        noteCompleted: false,
      };
      history.pushUndoEntry({
        type: "update_node",
        pageId,
        nodeId,
        before: beforeSnapshot,
        after: afterSnapshot,
        focusEditorId: editorId,
      });
    }
  };

  return (
    <div>
      <input
        ref={inputRef}
        data-testid="node-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          history.updateDraftValue(editorId, target, event.target.value);
        }}
        onBlur={() => void commitDraft()}
      />
      <button
        data-testid="commit-node"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void commitDraft()}
      >
        Commit Node
      </button>
    </div>
  );
}

function HistoryHarness() {
  const [selectedPageId, setSelectedPageId] = useState(PAGE_ONE);
  const [pageTitles, setPageTitles] = useState<Record<string, string>>({
    [PAGE_ONE]: "Page One",
    [PAGE_TWO]: "Page Two",
  });
  const [nodeTexts, setNodeTexts] = useState<Record<string, string>>({
    [NODE_ONE]: "Alpha",
    [NODE_TWO]: "Beta",
  });

  const history = useWorkspaceHistoryController({
    ownerKey: "owner",
    selectedPageId,
    setSelectedPageId: (pageId) => {
      if (pageId) {
        setSelectedPageId(pageId);
      }
    },
    renamePage: async ({ pageId, title }) => {
      setPageTitles((current) => ({
        ...current,
        [pageId]: title,
      }));
    },
    updateNode: async ({ nodeId, text }) => {
      setNodeTexts((current) => ({
        ...current,
        [nodeId]: text ?? current[nodeId],
      }));
    },
    moveNode: async () => undefined,
    setNodeTreeArchived: async () => undefined,
    draftCheckpointDelayMs: 20,
  });

  const currentNodeId = selectedPageId === PAGE_ONE ? NODE_ONE : NODE_TWO;

  return (
    <WorkspaceHistoryProvider value={history}>
      <div>
        <div data-testid="selected-page">{selectedPageId}</div>
        <button data-testid="select-page-1" onClick={() => setSelectedPageId(PAGE_ONE)}>
          Page 1
        </button>
        <button data-testid="select-page-2" onClick={() => setSelectedPageId(PAGE_TWO)}>
          Page 2
        </button>
        <button
          data-testid="undo"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void history.undo()}
          disabled={!history.canUndo}
        >
          Undo
        </button>
        <button
          data-testid="redo"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void history.redo()}
          disabled={!history.canRedo}
        >
          Redo
        </button>
        <TrackedTitleInput
          pageId={selectedPageId}
          committedValue={pageTitles[selectedPageId]}
          onCommit={async (nextValue) => {
            setPageTitles((current) => ({
              ...current,
              [selectedPageId]: nextValue,
            }));
          }}
        />
        <TrackedNodeInput
          pageId={selectedPageId}
          nodeId={currentNodeId}
          committedValue={nodeTexts[currentNodeId]}
          onCommit={async (nextValue) => {
            setNodeTexts((current) => ({
              ...current,
              [currentNodeId]: nextValue,
            }));
          }}
        />
        <input data-testid="chat-input" defaultValue="" />
      </div>
    </WorkspaceHistoryProvider>
  );
}

test("live typing undo and redo works inside a node editor", { concurrency: false }, async () => {
  const dom = installDom();
  const user = userEvent.setup({ document: dom.window.document });
  const view = render(<HistoryHarness />);

  const nodeInput = view.getByTestId("node-input") as HTMLInputElement;
  await user.click(nodeInput);
  await user.clear(nodeInput);
  await user.type(nodeInput, "Alpha plus");
  await waitFor(() => {
    assert.equal((view.getByTestId("undo") as HTMLButtonElement).disabled, false);
  });

  await user.keyboard("{Control>}z{/Control}");
  assert.equal(nodeInput.value, "Alpha");

  await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  assert.equal(nodeInput.value, "Alpha plus");

  cleanup();
  dom.window.close();
});
