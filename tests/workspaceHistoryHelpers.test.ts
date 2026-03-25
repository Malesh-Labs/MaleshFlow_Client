import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTrailingDraftEdits,
  limitHistoryEntries,
} from "../lib/domain/workspaceHistory";

test("limitHistoryEntries keeps the newest entries within the cap", () => {
  assert.deepEqual(limitHistoryEntries([1, 2, 3, 4], 2), [3, 4]);
});

test("extractTrailingDraftEdits only pulls the active editor draft tail", () => {
  const entries = [
    { type: "rename_page", pageId: "page-1" },
    { type: "draft_edit", editorId: "node-1", beforeValue: "a", afterValue: "ab" },
    { type: "draft_edit", editorId: "node-1", beforeValue: "ab", afterValue: "abc" },
    { type: "draft_edit", editorId: "node-2", beforeValue: "x", afterValue: "xy" },
  ];

  const extracted = extractTrailingDraftEdits(entries, "node-2");
  assert.equal(extracted.remainingEntries.length, 3);
  assert.deepEqual(extracted.draftEntries, [entries[3]]);
});
