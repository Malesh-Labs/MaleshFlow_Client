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

test("filterPagesForCommandPalette matches page type search terms", () => {
  const results = filterPagesForCommandPalette(
    [
      {
        _id: "1",
        title: "Tokyo Notes",
        archived: false,
        position: 1024,
        searchTerms: ["Scratchpad", "Scratchpads"],
      },
      {
        _id: "2",
        title: "Dating Model",
        archived: false,
        position: 2048,
        searchTerms: ["Model", "Models"],
      },
      {
        _id: "3",
        title: "2026-03-31",
        archived: false,
        position: 3072,
        searchTerms: ["Journal"],
      },
    ],
    "scrat",
  );

  assert.deepEqual(
    results.map((page) => page._id),
    ["1"],
  );
});

test("filterPagesForCommandPalette matches note page type search terms", () => {
  const results = filterPagesForCommandPalette(
    [
      {
        _id: "1",
        title: "Loose Ideas",
        archived: false,
        position: 1024,
        searchTerms: ["Note", "Notes"],
      },
      {
        _id: "2",
        title: "Daily Journal",
        archived: false,
        position: 2048,
        searchTerms: ["Journal"],
      },
    ],
    "note",
  );

  assert.deepEqual(
    results.map((page) => page._id),
    ["1"],
  );
});

test("filterPagesForCommandPalette matches planner page type search terms", () => {
  const results = filterPagesForCommandPalette(
    [
      {
        _id: "1",
        title: "Week One",
        archived: false,
        position: 1024,
        searchTerms: ["Planner", "Planners"],
      },
      {
        _id: "2",
        title: "Daily Journal",
        archived: false,
        position: 2048,
        searchTerms: ["Journal"],
      },
    ],
    "plan",
  );

  assert.deepEqual(
    results.map((page) => page._id),
    ["1"],
  );
});

test("filterPagesForCommandPalette prefers most recently updated or created pages", () => {
  const results = filterPagesForCommandPalette(
    [
      {
        _id: "1",
        title: "Older",
        archived: false,
        position: 1024,
        createdAt: 100,
        updatedAt: 200,
      },
      {
        _id: "2",
        title: "Newest Edit",
        archived: false,
        position: 512,
        createdAt: 150,
        updatedAt: 900,
      },
      {
        _id: "3",
        title: "Newest Create",
        archived: false,
        position: 256,
        createdAt: 800,
      },
    ],
    "",
  );

  assert.deepEqual(
    results.map((page) => page._id),
    ["2", "3", "1"],
  );
});
