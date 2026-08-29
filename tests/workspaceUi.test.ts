import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPageBacklinkFindQuery,
  buildNodeSelectionIds,
  filterPageAndFavoriteResultsForCommandPalette,
  filterPagesForCommandPalette,
  getActiveLinkAutocompleteToken,
  getActiveTagAutocompleteToken,
  shouldAddSpaceAfterTagAutocomplete,
  splitFindQuerySegments,
} from "../lib/domain/workspaceUi";
import {
  readWorkspacePanelLocation,
  writeWorkspacePanelLocation,
} from "../lib/domain/workspaceLocation";

test("workspace panel locations round-trip without losing the page", () => {
  const searchParams = new URLSearchParams("page=page_123");
  writeWorkspacePanelLocation(searchParams, {
    kind: "palette",
    mode: "resolveLinks",
    nodeId: "node_456",
  });

  assert.equal(searchParams.get("page"), "page_123");
  assert.equal(searchParams.get("panel"), "resolve-links");
  assert.equal(searchParams.get("panelNode"), "node_456");
  assert.deepEqual(readWorkspacePanelLocation(searchParams), {
    kind: "palette",
    mode: "resolveLinks",
    nodeId: "node_456",
  });

  writeWorkspacePanelLocation(searchParams, { kind: "aiChat" });
  assert.deepEqual(readWorkspacePanelLocation(searchParams), { kind: "aiChat" });
  assert.equal(searchParams.get("panelNode"), null);

  writeWorkspacePanelLocation(searchParams, null);
  assert.equal(searchParams.toString(), "page=page_123");
});

test("unknown workspace panel locations are ignored", () => {
  assert.equal(
    readWorkspacePanelLocation(new URLSearchParams("panel=not-a-real-panel")),
    null,
  );
});

test("buildNodeSelectionIds returns the inclusive range between two nodes", () => {
  const selection = buildNodeSelectionIds(
    ["a", "b", "c", "d"],
    "b",
    "d",
  );

  assert.deepEqual([...selection], ["b", "c", "d"]);
});

test("getActiveTagAutocompleteToken does not consume the following word", () => {
  const token = getActiveTagAutocompleteToken("#pbuy milk", 2);

  assert.deepEqual(token, {
    startIndex: 0,
    endIndex: 2,
    query: "p",
  });
  assert.equal(shouldAddSpaceAfterTagAutocomplete("#pbuy milk", token!.endIndex), true);

  const nextValue =
    "#pbuy milk".slice(0, token!.startIndex) +
    "#perm" +
    (shouldAddSpaceAfterTagAutocomplete("#pbuy milk", token!.endIndex) ? " " : "") +
    "#pbuy milk".slice(token!.endIndex);
  assert.equal(nextValue, "#perm buy milk");
});

test("getActiveTagAutocompleteToken keeps normal tag replacement bounded", () => {
  const token = getActiveTagAutocompleteToken("call Ava #te", "call Ava #te".length);

  assert.deepEqual(token, {
    startIndex: 9,
    endIndex: 12,
    query: "te",
  });
  assert.equal(shouldAddSpaceAfterTagAutocomplete("call Ava #te", token!.endIndex), false);
});

test("getActiveLinkAutocompleteToken detects normal link autocomplete", () => {
  const token = getActiveLinkAutocompleteToken("call [[ava", "call [[ava".length);

  assert.deepEqual(token, {
    startIndex: 5,
    endIndex: 10,
    query: "ava",
    includeArchived: false,
  });
});

test("getActiveLinkAutocompleteToken detects archive link autocomplete", () => {
  const token = getActiveLinkAutocompleteToken("call [[[past", "call [[[past".length);

  assert.deepEqual(token, {
    startIndex: 5,
    endIndex: 12,
    query: "past",
    includeArchived: true,
  });
});

test("getActiveLinkAutocompleteToken ignores the inner double marker inside archive autocomplete", () => {
  const token = getActiveLinkAutocompleteToken("[[[past", "[[[past".length);

  assert.deepEqual(token, {
    startIndex: 0,
    endIndex: 7,
    query: "past",
    includeArchived: true,
  });
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

test("filterPagesForCommandPalette matches archived page state", () => {
  const results = filterPagesForCommandPalette(
    [
      { _id: "1", title: "Current Notes", archived: false, position: 1024 },
      { _id: "2", title: "Old Ideas", archived: true, position: 2048 },
      { _id: "3", title: "Past Plans", archived: true, position: 3072 },
    ],
    "archive",
  );

  assert.deepEqual(
    results.map((page) => page._id),
    ["2", "3"],
  );
});

test("filterPagesForCommandPalette matches fuzzy scattered-letter queries", () => {
  const results = filterPagesForCommandPalette(
    [
      { _id: "1", title: "Daily Journal", archived: false, position: 1024 },
      { _id: "2", title: "Coffee Shop List", archived: false, position: 2048 },
      { _id: "3", title: "Groceries", archived: false, position: 3072 },
    ],
    "cofshl",
  );
  assert.deepEqual(
    results.map((page) => page._id),
    ["2"],
  );

  const multiWord = filterPagesForCommandPalette(
    [
      { _id: "1", title: "Daily Journal", archived: false, position: 1024 },
      { _id: "2", title: "Weekly Journal Review", archived: false, position: 2048 },
    ],
    "wee jour",
  );
  assert.deepEqual(
    multiWord.map((page) => page._id),
    ["2"],
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

test("page palette search pins exact pages above all favorite matches", () => {
  const favorites = Array.from({ length: 14 }, (_, index) => ({
    _id: `favorite-${index}`,
    title: index === 0 ? "Meta" : `Unrelated favorite ${index}`,
    archived: false,
    position: index,
    searchTerms: ["some metadata"],
  }));
  const pages = [
    {
      _id: "meta-page",
      title: "Meta",
      archived: false,
      position: 1024,
    },
  ];

  const results = filterPageAndFavoriteResultsForCommandPalette(
    favorites,
    pages,
    " META ",
    14,
  );

  assert.equal(results[0]?._id, "meta-page");
  assert.equal(results.length, 14);
});

test("page palette archive query returns every archived page after an exact title", () => {
  const archivedPages = Array.from({ length: 16 }, (_, index) => ({
    _id: `archived-${index}`,
    title: `Past page ${index}`,
    archived: true,
    position: index,
    updatedAt: 100 - index,
  }));
  const results = filterPageAndFavoriteResultsForCommandPalette(
    [],
    [
      {
        _id: "exact-active-page",
        title: "Archive",
        archived: false,
        position: 1024,
      },
      ...archivedPages,
    ],
    "archive",
    14,
  );

  assert.equal(results[0]?._id, "exact-active-page");
  assert.equal(results.length, 17);
  assert.deepEqual(
    results.slice(1).map((page) => page._id),
    archivedPages.map((page) => page._id),
  );
});

test("page palette keeps favorites first before a query is entered", () => {
  const results = filterPageAndFavoriteResultsForCommandPalette(
    [
      {
        _id: "favorite",
        title: "Favorite",
        archived: false,
        position: 0,
      },
    ],
    [
      {
        _id: "recent-page",
        title: "Recent page",
        archived: false,
        position: 1024,
        updatedAt: 500,
      },
    ],
    "",
  );

  assert.deepEqual(
    results.map((result) => result._id),
    ["favorite", "recent-page"],
  );
});

test("splitFindQuerySegments splits OR queries and ignores empty segments", () => {
  assert.deepEqual(
    splitFindQuerySegments(" page:abc || [[Launch Page]] ||  || [[Other]] "),
    ["page:abc", "[[Launch Page]]", "[[Other]]"],
  );
});

test("buildPageBacklinkFindQuery combines page id and wiki title", () => {
  assert.equal(
    buildPageBacklinkFindQuery({
      _id: "page_123",
      title: "Launch Page",
    }),
    "page:page_123 || [[Launch Page]]",
  );
});
