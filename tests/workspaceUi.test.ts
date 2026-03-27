import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNodeSelectionIds,
  filterPagesForCommandPalette,
} from "../lib/domain/workspaceUi";

test("buildNodeSelectionIds returns the inclusive range between two nodes", () => {
  const selection = buildNodeSelectionIds(
    ["a", "b", "c", "d"],
    "b",
    "d",
  );

  assert.deepEqual([...selection], ["b", "c", "d"]);
});

test("filterPagesForCommandPalette prioritizes active prefix matches before archived pages", () => {
  const results = filterPagesForCommandPalette(
    [
      { _id: "1", title: "Dating Notes", archived: false, position: 1024 },
      { _id: "2", title: "Modern Dating", archived: true, position: 512 },
      { _id: "3", title: "Daily Journal", archived: false, position: 2048 },
      { _id: "4", title: "Dating Scripts", archived: false, position: 3072 },
    ],
    "dat",
  );

  assert.deepEqual(
    results.map((page) => page._id),
    ["1", "4", "2"],
  );
});
