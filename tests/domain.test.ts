import test from "node:test";
import assert from "node:assert/strict";
import {
  applySelectedLinkShortcut,
  convertHtmlClipboardToMarkdownText,
  extractLinkMatches,
  extractLinks,
  getExplicitWikiLinkPreviewText,
  replaceLinkMarkupWithLabels,
  rewriteMatchingPageWikiLinks,
  rewritePlainPageWikiLinksToNode,
  rewritePlainPageWikiLinksToTarget,
  sanitizeGeneratedWikiLinkLabel,
} from "../lib/domain/links";
import {
  cycleHeadingSyntax,
  isDimmedSyntaxLine,
  isSeparatorLineText,
  parseHeadingSyntax,
  stripDimmedSyntaxPrefix,
  stripHeadingSyntaxMarkers,
  stripNodeDisplaySyntaxMarkers,
} from "../lib/domain/displaySyntax";
import {
  buildJournalFeedbackUserPrompt,
  buildModelRewriteUserPrompt,
} from "../lib/domain/aiPrompts";
import { extractTagMatches, extractTags } from "../lib/domain/tags";
import { parseMarkdownFile, serializePageToMarkdown } from "../lib/domain/markdown";
import {
  buildDeterministicEmbedding,
  buildEmbeddingInput,
  buildRootEmbeddingInput,
  collectRootSubtreeLines,
  shouldGenerateEmbeddingForNodeText,
} from "../lib/domain/embeddings";
import {
  buildTaskCalendarIcs,
  normalizeCalendarTaskText,
} from "../lib/domain/calendar";
import {
  applySelectedInlineFormattingShortcut,
  hasRenderableInlineFormatting,
  stripInlineFormattingMarkers,
  splitTextForInlineFormatting,
} from "../lib/domain/inlineFormatting";
import {
  countLiteralOccurrences,
  replaceLiteralOccurrences,
} from "../lib/domain/findReplace";
import {
  buildFocusedOutlineContext,
  buildOutlineTree,
} from "../lib/domain/outline";
import {
  advanceRecurringDueDate,
  advanceRecurringDueDateRange,
  areRecurrenceFrequenciesEqual,
  dateInputValueToTimestamp,
  formatCompactDueDateRange,
  getRecurrenceLabel,
  getCompactRecurrenceLabel,
  isOverdueDueDate,
  isOverdueDueDateRange,
  parseRecurrenceFrequency,
  formatDueDateRange,
  timestampToDateInputValue,
} from "../lib/domain/recurrence";
import {
  buildDefaultMigrationLessonsDoc,
  normalizeImportedOutlineText,
} from "../lib/domain/migration";
import {
  appendAiMemoryStoreOutlineToMemory,
  buildAiWorkingMemoryTextContext,
  completeAiMemoryItemInText,
  extractAiMemoryCompletionText,
  extractAiMemoryImplicitStoreText,
  extractAiMemoryInlineChecklistOutline,
  extractAiMemoryRestoreText,
  extractAiMemoryStoreOutline,
  extractAiMemoryStoreText,
  matchAiMemoryCompletion,
  matchAiMemoryItems,
  removeAiMemoryInlineChecklistItem,
  restoreAiMemoryItemInText,
} from "../lib/domain/aiMemory";
import { parseImportedTextToOutlineNodes } from "../lib/domain/importer";
import {
  getEffectiveTaskDueDateRange,
  getPlannerDateRangeBoundary,
  plannerDayMatchesDueDateBoundary,
} from "../lib/domain/planner";
import {
  buildDeterministicPlannerSymbols,
  listFocusSymbolTextExemptNodeIds,
  normalizeGeneratedPlannerSymbols,
  normalizePlannerSymbolSourceText,
  parsePurePlannerNodeReference,
} from "../lib/domain/plannerSymbols";
import {
  buildPlannerLinkedTaskCopyText,
  findExistingPlannerDayForSidebarSourceTask,
  listEligiblePlannerSidebarSourceTasksFromNodes,
  shouldSyncPlannerLinkedRecurringSourceTaskCompletion,
} from "../convex/lib/planner";
import {
  buildDataDumpManifest,
  buildUniqueDataDumpPath,
  filterDataDumpNodes,
  isDataDumpExcluded,
  sanitizeDataDumpPathSegment,
} from "../lib/domain/dataDump";
import { chatPlanSchema } from "../lib/domain/chat";

test("extractLinks finds wiki links and node refs", () => {
  const links = extractLinks(
    "Plan [[Launch Page]], [[Launch Page|page:page_123]], [[page:page_456]] after reviewing ((node_123)), [[Attachment note|node:node_456]], and [OpenAI](openai.com).",
  );
  assert.deepEqual(links, [
    {
      kind: "page",
      label: "[[Launch Page]]",
      targetPageTitle: "Launch Page",
    },
    {
      kind: "page",
      label: "[[Launch Page|page:page_123]]",
      targetPageRef: "page_123",
    },
    {
      kind: "page",
      label: "[[page:page_456]]",
      targetPageRef: "page_456",
    },
    {
      kind: "node",
      label: "((node_123))",
      targetNodeRef: "node_123",
    },
    {
      kind: "node",
      label: "[[Attachment note|node:node_456]]",
      targetNodeRef: "node_456",
    },
    {
      kind: "external",
      label: "[OpenAI](openai.com)",
      text: "OpenAI",
      targetUrl: "openai.com",
    },
  ]);
});

test("chat plans can propose creating a child node under a parent", () => {
  const parsed = chatPlanSchema.parse({
    summary: "Add a date idea.",
    rationale: "The request maps to the Ava ideas parent.",
    preview: ['Add "sunset picnic" under "#temp do things with/for Ava"'],
    operations: [
      {
        type: "create_node",
        description: "Add sunset picnic under Ava date ideas",
        clientId: null,
        pageId: "page_123",
        nodeId: null,
        parentNodeId: "node_parent",
        parentClientId: null,
        afterNodeId: null,
        afterClientId: null,
        sourceNodeId: null,
        targetNodeId: null,
        title: null,
        text: "sunset picnic",
        kind: "note",
        taskStatus: null,
        noteCompleted: null,
        priority: null,
        dueAt: null,
        archived: null,
      },
    ],
  });

  assert.equal(parsed.operations[0]?.type, "create_node");
  assert.equal(parsed.operations[0]?.parentNodeId, "node_parent");
  assert.equal(parsed.operations[0]?.text, "sunset picnic");
});

test("chat plans can create children under a plan-local parent", () => {
  const parsed = chatPlanSchema.parse({
    summary: "Remember grouped items.",
    rationale: "The request is a memory checklist.",
    preview: ['Remember "things to do with Ava"', 'Remember "go to the beach"'],
    operations: [
      {
        type: "create_node",
        description: "Remember group",
        clientId: "memory_parent",
        pageId: "page_123",
        nodeId: null,
        parentNodeId: "live_section",
        parentClientId: null,
        afterNodeId: null,
        afterClientId: null,
        sourceNodeId: null,
        targetNodeId: null,
        title: null,
        text: "things to do with Ava",
        kind: "note",
        taskStatus: null,
        noteCompleted: false,
        priority: null,
        dueAt: null,
        archived: null,
      },
      {
        type: "create_node",
        description: "Remember child",
        clientId: "memory_child",
        pageId: "page_123",
        nodeId: null,
        parentNodeId: null,
        parentClientId: "memory_parent",
        afterNodeId: null,
        afterClientId: null,
        sourceNodeId: null,
        targetNodeId: null,
        title: null,
        text: "go to the beach",
        kind: "note",
        taskStatus: null,
        noteCompleted: false,
        priority: null,
        dueAt: null,
        archived: null,
      },
    ],
  });

  assert.equal(parsed.operations[1]?.parentClientId, "memory_parent");
});

test("chat plans can carry note completion operations", () => {
  const parsed = chatPlanSchema.parse({
    summary: "Complete memory.",
    rationale: "The memory item matches the completion request.",
    preview: ['Mark "watch backrooms" complete and move it to Previous'],
    operations: [
      {
        type: "update_node",
        description: "Mark watch backrooms complete",
        clientId: null,
        pageId: null,
        nodeId: "node_memory",
        parentNodeId: null,
        parentClientId: null,
        afterNodeId: null,
        afterClientId: null,
        sourceNodeId: null,
        targetNodeId: null,
        title: null,
        text: null,
        kind: "note",
        taskStatus: null,
        noteCompleted: true,
        priority: null,
        dueAt: null,
        archived: null,
      },
    ],
  });

  assert.equal(parsed.operations[0]?.type, "update_node");
  assert.equal(parsed.operations[0]?.noteCompleted, true);
});

test("chat plans can replace plain text AI working memory", () => {
  const parsed = chatPlanSchema.parse({
    summary: "Remember item.",
    rationale: "The request updates AI Working Memory.",
    preview: ['Remember "watch backrooms" in AI Working Memory'],
    operations: [
      {
        type: "set_ai_working_memory",
        description: "Update AI Working Memory",
        clientId: null,
        pageId: null,
        nodeId: null,
        parentNodeId: null,
        parentClientId: null,
        afterNodeId: null,
        afterClientId: null,
        sourceNodeId: null,
        targetNodeId: null,
        title: null,
        text: "# Live\n\n- [ ] watch backrooms\n\n# Previous\n",
        kind: null,
        taskStatus: null,
        noteCompleted: null,
        priority: null,
        dueAt: null,
        archived: null,
      },
    ],
  });

  assert.equal(parsed.operations[0]?.type, "set_ai_working_memory");
  assert.match(parsed.operations[0]?.text ?? "", /watch backrooms/);
});

test("AI memory helpers extract store and completion text", () => {
  assert.equal(
    extractAiMemoryStoreText("hey i wanna make sure to watch backrooms"),
    "watch backrooms",
  );
  assert.equal(extractAiMemoryStoreText("remember to watch Backrooms!"), "watch Backrooms");
  assert.equal(extractAiMemoryImplicitStoreText("another movie idea, Backrooms"), "Backrooms");
  assert.equal(extractAiMemoryImplicitStoreText("Backrooms"), "Backrooms");
  assert.equal(extractAiMemoryImplicitStoreText("what movies should i watch?"), null);
  assert.equal(extractAiMemoryCompletionText("i watched backrooms"), "backrooms");
  assert.equal(
    extractAiMemoryCompletionText(
      "ok i went to the beach with ava you can mark it as done and move it to previous or whatever",
    ),
    "the beach with ava",
  );
  assert.equal(extractAiMemoryCompletionText("no i haven't bought her a bike yet"), null);
  assert.equal(
    extractAiMemoryRestoreText("i haven't bought ava a bike or bought her biikinis yet, see the previous items for context!!"),
    "bought ava a bike or bought her biikinis",
  );
  assert.equal(extractAiMemoryCompletionText("what movies should i watch?"), null);
});

test("AI memory helpers parse multiline checklist remembers", () => {
  assert.deepEqual(
    extractAiMemoryStoreOutline(`please remember the following things i want to do with [[Ava|node:123]]

[ ] ~~buy her bike~~
[ ] go to the beach`),
    {
      parentText: "things i want to do with Ava",
      items: [
        { text: "buy her bike", noteCompleted: true },
        { text: "go to the beach", noteCompleted: false },
      ],
    },
  );
});

test("AI memory helpers parse and remove flattened checklist items", () => {
  const outline = extractAiMemoryInlineChecklistOutline(
    "things i want to do with Ava [ ] buy her bike [ ] go to the beach",
  );

  assert.equal(outline?.parentText, "things i want to do with Ava");
  assert.deepEqual(
    outline?.items.map((item) => ({
      text: item.text,
      noteCompleted: item.noteCompleted,
    })),
    [
      { text: "buy her bike", noteCompleted: false },
      { text: "go to the beach", noteCompleted: false },
    ],
  );
  assert.equal(
    outline ? removeAiMemoryInlineChecklistItem(
      "things i want to do with Ava [ ] buy her bike [ ] go to the beach",
      outline.items[1]!,
    ) : null,
    "things i want to do with Ava [ ] buy her bike",
  );
});

test("plain text AI memory stores and completes grouped checklist items", () => {
  const outline = extractAiMemoryStoreOutline(`please remember the following things i want to do with [[Ava|node:123]]

[ ] ~~buy her bike~~
[ ] go to the beach`);
  assert.ok(outline);

  const storedText = appendAiMemoryStoreOutlineToMemory("", outline);
  const context = buildAiWorkingMemoryTextContext(storedText);
  assert.match(context.liveText, /go to the beach/);
  assert.match(context.previousText, /buy her bike/);

  const match = matchAiMemoryCompletion("the beach with ava", context.liveItems);
  assert.equal(match.kind, "single");
  assert.equal(match.kind === "single" ? match.item.text : "", "go to the beach");

  const completed =
    match.kind === "single"
      ? completeAiMemoryItemInText(storedText, match.item.nodeId)
      : null;
  assert.ok(completed);
  assert.doesNotMatch(
    buildAiWorkingMemoryTextContext(completed.text).liveText,
    /go to the beach/,
  );
  assert.match(
    buildAiWorkingMemoryTextContext(completed.text).previousText,
    /go to the beach \(things i want to do with Ava\)/,
  );
});

test("plain text AI memory restores previous grouped items back to live", () => {
  let memoryText = `# Live

- things i want to do with Ava
  - [ ] book boat day in waiks / sand bar
  - [ ] get massages

# Previous

- [x] buy her bike (things i want to do with Ava)
- [x] buy her bikinis (things i want to do with Ava)
`;
  const context = buildAiWorkingMemoryTextContext(memoryText);
  const restoreText =
    extractAiMemoryRestoreText(
      "i haven't bought ava a bike or bought her biikinis yet, see the previous items for context!!",
    ) ?? "";
  const matches = matchAiMemoryItems(
    restoreText,
    context.previousItems.map((item) => ({
      nodeId: item.nodeId,
      text: [item.text, item.parentText ?? "", item.path]
        .filter((value) => value.length > 0)
        .join(" "),
    })),
    { minimumScore: 45 },
  );

  assert.equal(matches.kind, "matches");
  assert.deepEqual(
    matches.kind === "matches"
      ? matches.items.map((match) => {
          const item = context.previousItems.find((entry) => entry.nodeId === match.nodeId);
          return item?.text;
        })
      : [],
    ["buy her bike", "buy her bikinis"],
  );

  for (const match of matches.kind === "matches" ? matches.items : []) {
    const original = context.previousItems.find((item) => item.nodeId === match.nodeId);
    const currentContext = buildAiWorkingMemoryTextContext(memoryText);
    const currentItem = currentContext.previousItems.find(
      (item) => item.text === original?.text && item.parentText === original?.parentText,
    );
    assert.ok(currentItem);
    const restored = restoreAiMemoryItemInText(memoryText, currentItem.nodeId);
    assert.ok(restored);
    memoryText = restored.text;
  }

  const restoredContext = buildAiWorkingMemoryTextContext(memoryText);
  assert.match(restoredContext.liveText, /\[ \] buy her bike/);
  assert.match(restoredContext.liveText, /\[ \] buy her bikinis/);
  assert.doesNotMatch(restoredContext.previousText, /buy her bike/);
  assert.doesNotMatch(restoredContext.previousText, /buy her bikinis/);
});

test("AI memory completion matching finds one active item or ambiguity", () => {
  assert.deepEqual(
    matchAiMemoryCompletion("backrooms", [
      { nodeId: "node_1", text: "watch backrooms" },
      { nodeId: "node_2", text: "read dune" },
    ]),
    {
      kind: "single",
      item: { nodeId: "node_1", text: "watch backrooms" },
    },
  );

  assert.deepEqual(
    matchAiMemoryCompletion("the beach with ava", [
      { nodeId: "node_1", text: "things i want to do with Ava go to the beach" },
      { nodeId: "node_2", text: "things i want to do with Ava book boat day" },
    ]),
    {
      kind: "single",
      item: {
        nodeId: "node_1",
        text: "things i want to do with Ava go to the beach",
      },
    },
  );

  assert.equal(
    matchAiMemoryCompletion("backrooms", [
      { nodeId: "node_1", text: "watch backrooms" },
      { nodeId: "node_2", text: "watch backrooms trailer" },
    ]).kind,
    "ambiguous",
  );
});

test("data dump exclusion flags are detected", () => {
  assert.equal(
    isDataDumpExcluded({ sourceMeta: { excludeFromDataDump: true } }),
    true,
  );
  assert.equal(
    isDataDumpExcluded({ sourceMeta: { excludeFromDataDump: false } }),
    false,
  );
  assert.equal(isDataDumpExcluded({ sourceMeta: null }), false);
});

test("filterDataDumpNodes omits excluded nodes and descendants", () => {
  const result = filterDataDumpNodes([
    { _id: "root", parentNodeId: null },
    { _id: "secret", parentNodeId: null, sourceMeta: { excludeFromDataDump: true } },
    { _id: "secret-child", parentNodeId: "secret" },
    { _id: "kept-sibling", parentNodeId: null },
  ]);

  assert.deepEqual(
    result.nodes.map((node) => node._id),
    ["root", "kept-sibling"],
  );
  assert.equal(result.excludedNodeCount, 2);
  assert.equal(result.excludedNodeSubtreeCount, 1);
  assert.deepEqual([...result.excludedRootIds], ["secret"]);
});

test("filterDataDumpNodes counts topmost excluded roots only", () => {
  const result = filterDataDumpNodes([
    { _id: "root", parentNodeId: null, sourceMeta: { excludeFromDataDump: true } },
    { _id: "child", parentNodeId: "root", sourceMeta: { excludeFromDataDump: true } },
    { _id: "grandchild", parentNodeId: "child" },
  ]);

  assert.deepEqual(result.nodes, []);
  assert.equal(result.excludedNodeCount, 3);
  assert.equal(result.excludedNodeSubtreeCount, 1);
  assert.deepEqual([...result.excludedRootIds], ["root"]);
});

test("data dump paths are safe and unique", () => {
  const usedPaths = new Set<string>();

  assert.equal(sanitizeDataDumpPathSegment("../"), "untitled");
  assert.equal(
    buildUniqueDataDumpPath({
      directory: ["pages", "..", "task/list"],
      name: "../Today.md",
      extension: "md",
      usedPaths,
    }),
    "pages/folder/task-list/Today.md",
  );
  assert.equal(
    buildUniqueDataDumpPath({
      directory: ["pages", "..", "task/list"],
      name: "../Today.md",
      extension: "md",
      usedPaths,
    }),
    "pages/folder/task-list/Today 2.md",
  );
});

test("data dump manifest includes export and exclusion counts", () => {
  assert.deepEqual(
    buildDataDumpManifest({
      generatedAt: "2026-05-13T00:00:00.000Z",
      exportedPageCount: 2,
      excludedPageCount: 1,
      exportedArchivedNodeSubtreeCount: 3,
      excludedNodeSubtreeCount: 4,
      excludedNodeCount: 8,
      legacyFileCount: 5,
      contentFileCount: 7,
    }),
    {
      version: 1,
      generatedAt: "2026-05-13T00:00:00.000Z",
      counts: {
        exportedPages: 2,
        excludedPages: 1,
        exportedArchivedNodeSubtrees: 3,
        excludedNodeSubtrees: 4,
        excludedNodes: 8,
        legacyFiles: 5,
        contentFiles: 7,
      },
    },
  );
});

test("extractLinks finds plain external urls without swallowing punctuation", () => {
  const links = extractLinks(
    "Visit test.com, https://example.com/path, and www.openai.com for details.",
  );

  assert.deepEqual(links, [
    {
      kind: "external",
      label: "test.com",
      text: "test.com",
      targetUrl: "test.com",
    },
    {
      kind: "external",
      label: "https://example.com/path",
      text: "https://example.com/path",
      targetUrl: "https://example.com/path",
    },
    {
      kind: "external",
      label: "www.openai.com",
      text: "www.openai.com",
      targetUrl: "www.openai.com",
    },
  ]);
});

test("extractLinks finds plain email addresses", () => {
  const links = extractLinks(
    "Email sam@example.com or support@test.co.uk for details.",
  );

  assert.deepEqual(links, [
    {
      kind: "external",
      label: "sam@example.com",
      text: "sam@example.com",
      targetUrl: "mailto:sam@example.com",
    },
    {
      kind: "external",
      label: "support@test.co.uk",
      text: "support@test.co.uk",
      targetUrl: "mailto:support@test.co.uk",
    },
  ]);
});

test("extractLinks parses parent-inclusive node wiki links", () => {
  const links = extractLinks(
    "See [[node:node_123?parent]], [[Custom label|node:node_456?parent]], [[Autocomplete label|node:node_789]]?parent, [[node:node_tagged?hidetags]], [[Tagged trailing|node:node_trailing]]?hidetags, [[node:node_children?showChildren]], [[Lower children|node:node_lower?showchildren]], [[Mixed children|node:node_mixed?ShowChildren]], [[Trailing children|node:node_trailing_children]]?showChildren, and [[Tagged parent|node:node_both?parent&hideTags&showChildren]].",
  );

  assert.deepEqual(links, [
    {
      kind: "node",
      label: "[[node:node_123?parent]]",
      targetNodeRef: "node_123",
      includeParent: true,
    },
    {
      kind: "node",
      label: "[[Custom label|node:node_456?parent]]",
      targetNodeRef: "node_456",
      includeParent: true,
    },
    {
      kind: "node",
      label: "[[Autocomplete label|node:node_789]]?parent",
      targetNodeRef: "node_789",
      includeParent: true,
    },
    {
      kind: "node",
      label: "[[node:node_tagged?hidetags]]",
      targetNodeRef: "node_tagged",
      hideTags: true,
    },
    {
      kind: "node",
      label: "[[Tagged trailing|node:node_trailing]]?hidetags",
      targetNodeRef: "node_trailing",
      hideTags: true,
    },
    {
      kind: "node",
      label: "[[node:node_children?showChildren]]",
      targetNodeRef: "node_children",
      showChildren: true,
    },
    {
      kind: "node",
      label: "[[Lower children|node:node_lower?showchildren]]",
      targetNodeRef: "node_lower",
      showChildren: true,
    },
    {
      kind: "node",
      label: "[[Mixed children|node:node_mixed?ShowChildren]]",
      targetNodeRef: "node_mixed",
      showChildren: true,
    },
    {
      kind: "node",
      label: "[[Trailing children|node:node_trailing_children]]?showChildren",
      targetNodeRef: "node_trailing_children",
      showChildren: true,
    },
    {
      kind: "node",
      label: "[[Tagged parent|node:node_both?parent&hideTags&showChildren]]",
      targetNodeRef: "node_both",
      includeParent: true,
      hideTags: true,
      showChildren: true,
    },
  ]);
});

test("getExplicitWikiLinkPreviewText strips parent-inclusive node targets", () => {
  assert.equal(getExplicitWikiLinkPreviewText("[[node:node_123?parent]]"), "");
  assert.equal(getExplicitWikiLinkPreviewText("[[node:node_123]]?parent"), "");
  assert.equal(getExplicitWikiLinkPreviewText("[[node:node_123?hidetags]]"), "");
  assert.equal(getExplicitWikiLinkPreviewText("[[node:node_123]]?hidetags"), "");
  assert.equal(getExplicitWikiLinkPreviewText("[[node:node_123?parent&hidetags]]"), "");
  assert.equal(getExplicitWikiLinkPreviewText("[[node:node_123?showChildren]]"), "");
  assert.equal(getExplicitWikiLinkPreviewText("[[node:node_123]]?showChildren"), "");
  assert.equal(getExplicitWikiLinkPreviewText("[[node:node_123?parent&hideTags&showChildren]]"), "");
  assert.equal(
    getExplicitWikiLinkPreviewText("[[Custom label|node:node_456?parent]]"),
    "Custom label",
  );
  assert.equal(
    getExplicitWikiLinkPreviewText("[[Custom label|node:node_456]]?parent"),
    "Custom label",
  );
  assert.equal(
    getExplicitWikiLinkPreviewText("[[Custom label|node:node_456?hidetags]]"),
    "Custom label",
  );
  assert.equal(
    getExplicitWikiLinkPreviewText("[[Custom label|node:node_456]]?hidetags"),
    "Custom label",
  );
  assert.equal(
    getExplicitWikiLinkPreviewText("[[Custom label|node:node_456?showChildren]]"),
    "Custom label",
  );
  assert.equal(
    getExplicitWikiLinkPreviewText("[[Custom label|node:node_456]]?showChildren"),
    "Custom label",
  );
});

test("replaceLinkMarkupWithLabels consumes trailing parent node link options", () => {
  assert.equal(
    replaceLinkMarkupWithLabels("See [[Custom label|node:node_456]]?parent now."),
    "See Custom label now.",
  );
  assert.equal(
    replaceLinkMarkupWithLabels("See [[Custom label|node:node_456]]?hidetags now."),
    "See Custom label now.",
  );
  assert.equal(
    replaceLinkMarkupWithLabels("See [[Custom label|node:node_456]]?parent&hidetags now."),
    "See Custom label now.",
  );
  assert.equal(
    replaceLinkMarkupWithLabels("See [[Custom label|node:node_456]]?showChildren now."),
    "See Custom label now.",
  );
  assert.equal(
    replaceLinkMarkupWithLabels("See [[Custom label|node:node_456]]?hideTags&showChildren now."),
    "See Custom label now.",
  );
});

test("planner symbol helpers parse pure node references", () => {
  assert.deepEqual(parsePurePlannerNodeReference("[[node:node_123]]"), {
    nodeId: "node_123",
    explicitLabel: "",
  });
  assert.deepEqual(parsePurePlannerNodeReference("[[node:node_123]]?showChildren"), {
    nodeId: "node_123",
    explicitLabel: "",
  });
  assert.deepEqual(parsePurePlannerNodeReference("[[Custom label|node:node_456?hideTags]]"), {
    nodeId: "node_456",
    explicitLabel: "Custom label",
  });
  assert.deepEqual(parsePurePlannerNodeReference("((node_789))"), {
    nodeId: "node_789",
    explicitLabel: "",
  });
  assert.deepEqual(parsePurePlannerNodeReference("node:node_raw"), {
    nodeId: "node_raw",
    explicitLabel: "",
  });
  assert.equal(parsePurePlannerNodeReference("Before [[node:node_123]]"), null);
});

test("planner symbol helpers normalize source text without mutating links", () => {
  assert.equal(
    normalizePlannerSymbolSourceText("### **Review** [[Launch|page:page_1]] #work"),
    "Review Launch #work",
  );
  assert.equal(
    normalizePlannerSymbolSourceText("__Call__ [[Sam|node:node_1]]?hideTags"),
    "Call Sam",
  );
});

test("planner symbol helpers validate generated labels and deterministic fallback", () => {
  assert.equal(normalizeGeneratedPlannerSymbols(" ⚑ ✦ "), "⚑✦");
  assert.equal(normalizeGeneratedPlannerSymbols("🧾✨"), "🧾✨");
  assert.equal(normalizeGeneratedPlannerSymbols("work"), null);
  assert.equal(normalizeGeneratedPlannerSymbols("1"), null);
  assert.equal(normalizeGeneratedPlannerSymbols("⚑✦◆◎"), null);
  assert.equal(
    buildDeterministicPlannerSymbols("Call Sam"),
    buildDeterministicPlannerSymbols("Call Sam"),
  );
  assert.notEqual(
    buildDeterministicPlannerSymbols("Call Sam"),
    buildDeterministicPlannerSymbols("Write proposal"),
  );
});

test("planner symbol helpers exempt direct focus children before the first separator", () => {
  const focusChildren = [
    { _id: "a", text: "Morning routine" },
    { _id: "b", text: "Top priority" },
    { _id: "sep", text: "---" },
    { _id: "c", text: "Later task" },
  ];
  assert.deepEqual(listFocusSymbolTextExemptNodeIds(focusChildren), ["a", "b"]);
  assert.deepEqual(
    listFocusSymbolTextExemptNodeIds([
      { _id: "a", text: "Pinned" },
      { _id: "b", text: "Still text" },
    ]),
    ["a", "b"],
  );
  assert.deepEqual(
    listFocusSymbolTextExemptNodeIds([
      { _id: "sep", text: " --- " },
      { _id: "a", text: "Symbolified" },
    ]),
    [],
  );
});

test("sanitizeGeneratedWikiLinkLabel flattens nested wiki links", () => {
  assert.equal(
    sanitizeGeneratedWikiLinkLabel("here is a [[nested|node:123]] example"),
    "here is a nested example",
  );
});

test("convertHtmlClipboardToMarkdownText preserves anchor links from rich clipboard html", () => {
  const html = [
    "<div>Read <a href=\"https://apple.com\"><b>Apple</b> site</a></div>",
    "<div>Then visit <a href=\"https://openai.com\">https://openai.com</a><br>tomorrow</div>",
  ].join("");

  assert.equal(
    convertHtmlClipboardToMarkdownText(html),
    "Read [Apple site](https://apple.com)\nThen visit https://openai.com\ntomorrow\n",
  );
});

test("normalizeCalendarTaskText removes link markup and inline formatting", () => {
  assert.equal(
    normalizeCalendarTaskText("**Pay** __[taxes](https://example.com)__ for [[Home|page:abc]]"),
    "Pay taxes for Home",
  );
});

test("buildTaskCalendarIcs emits all-day events with exclusive end dates", () => {
  const start = dateInputValueToTimestamp("2026-08-20");
  const end = dateInputValueToTimestamp("2026-08-22");
  assert.ok(start);
  assert.ok(end);

  const ics = buildTaskCalendarIcs({
    calendarName: "MaleshFlow Tasks",
    events: [
      {
        uid: "task_1@maleshflow.tasks",
        summary: "Pay property tax",
        description: "Page: Home\nTags: #perm",
        dueAt: start,
        dueEndAt: end,
        updatedAt: new Date("2026-04-04T10:00:00.000Z").getTime(),
        categories: ["perm"],
      },
    ],
  });

  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Pay property tax/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260820/);
  assert.match(ics, /DTEND;VALUE=DATE:20260823/);
  assert.match(ics, /DESCRIPTION:Page: Home\\nTags: #perm/);
});

test("extractLinkMatches preserves ranges for inline rendering", () => {
  const matches = extractLinkMatches(
    "See [[Launch Page]], [[Attachment note|node:node_456]], and [OpenAI](openai.com).",
  );

  assert.deepEqual(
    matches.map((match) => ({
      start: match.start,
      end: match.end,
      kind: match.link.kind,
      label: match.link.label,
    })),
    [
      {
        start: 4,
        end: 19,
        kind: "page",
        label: "[[Launch Page]]",
      },
      {
        start: 21,
        end: 54,
        kind: "node",
        label: "[[Attachment note|node:node_456]]",
      },
      {
        start: 60,
        end: 80,
        kind: "external",
        label: "[OpenAI](openai.com)",
      },
    ],
  );
});

test("extractLinkMatches finds plain urls without duplicating markdown links", () => {
  const matches = extractLinkMatches(
    "See test.com, [OpenAI](openai.com), and https://example.com/path.",
  );

  assert.deepEqual(
    matches.map((match) => ({
      start: match.start,
      end: match.end,
      kind: match.link.kind,
      label: match.link.label,
    })),
    [
      {
        start: 4,
        end: 12,
        kind: "external",
        label: "test.com",
      },
      {
        start: 14,
        end: 34,
        kind: "external",
        label: "[OpenAI](openai.com)",
      },
      {
        start: 40,
        end: 64,
        kind: "external",
        label: "https://example.com/path",
      },
    ],
  );
});

test("extractLinkMatches finds plain email addresses without swallowing punctuation", () => {
  const matches = extractLinkMatches(
    "Reach me at sam@example.com, then use [docs](https://example.com).",
  );

  assert.deepEqual(
    matches.map((match) => ({
      start: match.start,
      end: match.end,
      kind: match.link.kind,
      label: match.link.label,
    })),
    [
      {
        start: 12,
        end: 27,
        kind: "external",
        label: "sam@example.com",
      },
      {
        start: 38,
        end: 65,
        kind: "external",
        label: "[docs](https://example.com)",
      },
    ],
  );
});

test("rewriteMatchingPageWikiLinks updates only matched resolved page links", () => {
  const text =
    "See [[Old Title]], [[old title]], [[Old Title|page:page_123]], [[page:page_123]], [[Custom label|page:page_123]], [[Other Page]], [[Label|node:node_123]], and [OpenAI](openai.com).";

  const rewritten = rewriteMatchingPageWikiLinks(
    text,
    (link) =>
      link.targetPageRef === "page_123" ||
      link.targetPageTitle?.toLowerCase() === "old title",
    "New Title",
    "Old Title",
  );

  assert.equal(
    rewritten,
    "See [[New Title]], [[New Title]], [[New Title|page:page_123]], [[page:page_123]], [[Custom label|page:page_123]], [[Other Page]], [[Label|node:node_123]], and [OpenAI](openai.com).",
  );
});

test("rewritePlainPageWikiLinksToNode converts only matching plain page wiki links", () => {
  const text =
    "See [[test]], [[Test]], [[Other]], [[Test|page:page_123]], [[Label|node:node_123]], and [[pipe|label]].";

  const rewritten = rewritePlainPageWikiLinksToNode(
    text,
    (link) => link.targetPageTitle?.toLowerCase() === "test",
    "node_456",
  );

  assert.deepEqual(rewritten, {
    value:
      "See [[test|node:node_456]], [[Test|node:node_456]], [[Other]], [[Test|page:page_123]], [[Label|node:node_123]], and [[pipe|label]].",
    occurrenceCount: 2,
  });
});

test("rewritePlainPageWikiLinksToTarget can resolve empty links to page refs", () => {
  const text =
    "See [[test]], [[Test]], [[Other]], [[Test|page:page_123]], and [[Label|node:node_123]].";

  const rewritten = rewritePlainPageWikiLinksToTarget(
    text,
    (link) => link.targetPageTitle?.toLowerCase() === "test",
    {
      kind: "page",
      ref: "page_456",
    },
  );

  assert.deepEqual(rewritten, {
    value:
      "See [[test|page:page_456]], [[Test|page:page_456]], [[Other]], [[Test|page:page_123]], and [[Label|node:node_123]].",
    occurrenceCount: 2,
  });
});

test("rewritePlainPageWikiLinksToNode returns null when no plain page links match", () => {
  assert.equal(
    rewritePlainPageWikiLinksToNode(
      "See [[Test|page:page_123]] and [[Label|node:node_123]].",
      (link) => link.targetPageTitle?.toLowerCase() === "test",
      "node_456",
    ),
    null,
  );
});

test("applySelectedLinkShortcut wraps plain text and converts markdown links to wiki links", () => {
  assert.deepEqual(
    applySelectedLinkShortcut("hello world", 0, 5),
    {
      value: "[hello]() world",
      selectionStart: 0,
      selectionEnd: 9,
    },
  );

  assert.deepEqual(
    applySelectedLinkShortcut("[hello](https://x.com)", 0, 22),
    {
      value: "[[hello]]",
      selectionStart: 0,
      selectionEnd: 9,
    },
  );

  assert.equal(
    applySelectedLinkShortcut("[[hello]]", 0, 9),
    null,
  );
});

test("extractTags finds hashtag tags with hyphens and slashes", () => {
  const tags = extractTags(
    "Track #dating-model and #work/personal notes, but ignore heading style # not-a-tag.",
  );

  assert.deepEqual(tags, ["dating-model", "work/personal"]);
});

test("extractTagMatches preserves ranges for inline rendering", () => {
  const matches = extractTagMatches("A #dating-model plan and a #work/personal note.");

  assert.deepEqual(
    matches.map((match) => ({
      start: match.start,
      end: match.end,
      label: match.label,
      value: match.value,
    })),
    [
      {
        start: 2,
        end: 15,
        label: "#dating-model",
        value: "dating-model",
      },
      {
        start: 27,
        end: 41,
        label: "#work/personal",
        value: "work/personal",
      },
    ],
  );
});

test("extractTagMatches recognizes tags inside italic markers", () => {
  const matches = extractTagMatches("__#work/job__ and __#malesh/labs/fanswap");

  assert.deepEqual(
    matches.map((match) => ({
      start: match.start,
      end: match.end,
      label: match.label,
      value: match.value,
    })),
    [
      {
        start: 2,
        end: 11,
        label: "#work/job",
        value: "work/job",
      },
      {
        start: 20,
        end: 40,
        label: "#malesh/labs/fanswap",
        value: "malesh/labs/fanswap",
      },
    ],
  );
});

test("extractTags ignores hash fragments inside markdown links", () => {
  const tags = extractTags(
    "See [Wikimedia](https://wikimediafoundation.org/about/jobs/#section-1) and keep #real-tag.",
  );

  assert.deepEqual(tags, ["real-tag"]);
});

test("extractTags ignores hash fragments inside plain urls", () => {
  const tags = extractTags(
    "Use https://example.com/docs#section-2 for context, then check #follow-up.",
  );

  assert.deepEqual(tags, ["follow-up"]);
});

test("parseHeadingSyntax recognizes markdown-style heading prefixes", () => {
  assert.deepEqual(parseHeadingSyntax("# Big heading"), {
    level: 1,
    text: "Big heading",
  });
  assert.deepEqual(parseHeadingSyntax("## Medium heading"), {
    level: 2,
    text: "Medium heading",
  });
  assert.deepEqual(parseHeadingSyntax("### Small heading"), {
    level: 3,
    text: "Small heading",
  });
  assert.deepEqual(parseHeadingSyntax("#not a heading"), {
    level: null,
    text: "#not a heading",
  });
});

test("isSeparatorLineText recognizes trimmed visual separators", () => {
  assert.equal(isSeparatorLineText("---"), true);
  assert.equal(isSeparatorLineText("  ---  "), true);
  assert.equal(isSeparatorLineText("----"), false);
  assert.equal(isSeparatorLineText("[ ] ---"), false);
});

test("cycleHeadingSyntax cycles plain text through heading levels and back", () => {
  assert.deepEqual(cycleHeadingSyntax("Plan today", 4, 4), {
    value: "# Plan today",
    selectionStart: 6,
    selectionEnd: 6,
  });
  assert.deepEqual(cycleHeadingSyntax("# Plan today", 2, 2), {
    value: "## Plan today",
    selectionStart: 3,
    selectionEnd: 3,
  });
  assert.deepEqual(cycleHeadingSyntax("## Plan today", 3, 3), {
    value: "### Plan today",
    selectionStart: 4,
    selectionEnd: 4,
  });
  assert.deepEqual(cycleHeadingSyntax("### Plan today", 4, 4), {
    value: "Plan today",
    selectionStart: 0,
    selectionEnd: 0,
  });
});

test("cycleHeadingSyntax preserves selection relative to visible heading text", () => {
  assert.deepEqual(cycleHeadingSyntax("# Big heading", 6, 13), {
    value: "## Big heading",
    selectionStart: 7,
    selectionEnd: 14,
  });
});

test("stripHeadingSyntaxMarkers removes heading markers without changing plain text", () => {
  assert.equal(stripHeadingSyntaxMarkers("### Big heading"), "Big heading");
  assert.equal(stripHeadingSyntaxMarkers("Plain text"), "Plain text");
});

test("stripNodeDisplaySyntaxMarkers removes dimmed and heading source syntax", () => {
  assert.equal(isDimmedSyntaxLine("%% ### Big heading"), true);
  assert.equal(stripDimmedSyntaxPrefix("%% ### Big heading"), "### Big heading");
  assert.equal(stripNodeDisplaySyntaxMarkers("%% ### Big heading"), "Big heading");
  assert.equal(stripNodeDisplaySyntaxMarkers("%% Plain text"), "Plain text");
  assert.equal(stripNodeDisplaySyntaxMarkers("### Big heading"), "Big heading");
  assert.equal(stripNodeDisplaySyntaxMarkers("Plain text"), "Plain text");
});

test("parseImportedTextToOutlineNodes normalizes Dynalist links and separators", () => {
  const nodes = parseImportedTextToOutlineNodes([
    "#perm [transfer](https://dynalist.io/d/gZbxdAfe_LzJ-ZNaczyYnfou#z=9ny-nVGCTvJEz_HNjOW9-S_J) from [Dad](https://dynalist.io/d/ZmhlkDoH3vv2Xjn6sR_PmsKv#z=NP7B6Ch5MiRkUML-C5YZ3xvq)",
    "—————————",
  ].join("\n"));

  assert.deepEqual(nodes, [
    {
      text: "#perm [[transfer]] from [[Dad]]",
      kind: "note",
      taskStatus: null,
      noteCompleted: false,
      dueAt: null,
      dueEndAt: null,
      recurrenceFrequency: null,
      lockKind: false,
      children: [],
    },
    {
      text: "---",
      kind: "note",
      taskStatus: null,
      noteCompleted: false,
      dueAt: null,
      dueEndAt: null,
      recurrenceFrequency: null,
      lockKind: false,
      children: [],
    },
  ]);
});

test("collectRootSubtreeLines preserves nesting and task markers", () => {
  const lines = collectRootSubtreeLines("root", [
    {
      _id: "root",
      parentNodeId: null,
      position: 1,
      text: "Root",
      kind: "note",
      taskStatus: null,
    },
    {
      _id: "child-note",
      parentNodeId: "root",
      position: 1,
      text: "Draft plan",
      kind: "note",
      taskStatus: null,
    },
    {
      _id: "child-task",
      parentNodeId: "root",
      position: 2,
      text: "Ship fix",
      kind: "task",
      taskStatus: "todo",
    },
    {
      _id: "grandchild-task",
      parentNodeId: "child-task",
      position: 1,
      text: "Verify deploy",
      kind: "task",
      taskStatus: "done",
    },
  ]);

  assert.deepEqual(lines, [
    "- Draft plan",
    "- [ ] Ship fix",
    "  - [x] Verify deploy",
  ]);
});

test("getEffectiveTaskDueDateRange only uses the task item's own due date", () => {
  const parentTask = {
    _id: "parent",
    kind: "task",
    parentNodeId: null,
    dueAt: new Date("2026-06-10T12:00:00.000Z").getTime(),
    dueEndAt: new Date("2026-06-12T12:00:00.000Z").getTime(),
  };
  const childTask = {
    _id: "child",
    kind: "task",
    parentNodeId: "parent",
    dueAt: null,
    dueEndAt: null,
  };
  const grandchildTask = {
    _id: "grandchild",
    kind: "task",
    parentNodeId: "child",
    dueAt: null,
    dueEndAt: null,
  };
  const nodes = new Map(
    [parentTask, childTask, grandchildTask].map((node) => [node._id, node]),
  );

  assert.deepEqual(getEffectiveTaskDueDateRange(childTask, nodes), {
    dueAt: null,
    dueEndAt: null,
  });
  assert.deepEqual(getEffectiveTaskDueDateRange(grandchildTask, nodes), {
    dueAt: null,
    dueEndAt: null,
  });
});

test("planner sidebar dated tasks are eligible for matching planner days", () => {
  const plannerDate = dateInputValueToTimestamp("2026-05-14");
  const nextDate = dateInputValueToTimestamp("2026-05-15");
  assert.ok(plannerDate);
  assert.ok(nextDate);

  const nodes = [
    {
      _id: "sidebar",
      pageId: "planner",
      parentNodeId: null,
      position: 1024,
      text: "Sidebar",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: { sectionSlot: "plannerSidebar" },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: "dated-task",
      pageId: "planner",
      parentNodeId: "sidebar",
      position: 1024,
      text: "Dated sidebar task",
      kind: "task",
      taskStatus: "todo",
      priority: null,
      dueAt: plannerDate,
      dueEndAt: null,
      archived: false,
      sourceMeta: { sourceType: "manual" },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: "tomorrow-task",
      pageId: "planner",
      parentNodeId: "sidebar",
      position: 2048,
      text: "Tomorrow sidebar task",
      kind: "task",
      taskStatus: "todo",
      priority: null,
      dueAt: nextDate,
      dueEndAt: null,
      archived: false,
      sourceMeta: { sourceType: "manual" },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: "day-task",
      pageId: "planner",
      parentNodeId: null,
      position: 3072,
      text: "Existing day task",
      kind: "task",
      taskStatus: "todo",
      priority: null,
      dueAt: plannerDate,
      dueEndAt: null,
      archived: false,
      sourceMeta: { sourceType: "manual" },
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  assert.deepEqual(
    listEligiblePlannerSidebarSourceTasksFromNodes(nodes as never, {
      plannerDate,
    }).map((node) => node._id),
    ["dated-task"],
  );
});

test("planner date ranges only auto-link on boundary days", () => {
  const rangeStart = dateInputValueToTimestamp("2026-05-14");
  const rangeMiddle = dateInputValueToTimestamp("2026-05-15");
  const rangeEnd = dateInputValueToTimestamp("2026-05-16");
  assert.ok(rangeStart);
  assert.ok(rangeMiddle);
  assert.ok(rangeEnd);

  assert.equal(
    plannerDayMatchesDueDateBoundary({
      dayTimestamp: rangeStart,
      dueAt: rangeStart,
      dueEndAt: rangeEnd,
    }),
    true,
  );
  assert.equal(
    getPlannerDateRangeBoundary({
      dayTimestamp: rangeStart,
      dueAt: rangeStart,
      dueEndAt: rangeEnd,
    }),
    "begins",
  );
  assert.equal(
    plannerDayMatchesDueDateBoundary({
      dayTimestamp: rangeMiddle,
      dueAt: rangeStart,
      dueEndAt: rangeEnd,
    }),
    false,
  );
  assert.equal(
    getPlannerDateRangeBoundary({
      dayTimestamp: rangeMiddle,
      dueAt: rangeStart,
      dueEndAt: rangeEnd,
    }),
    null,
  );
  assert.equal(
    plannerDayMatchesDueDateBoundary({
      dayTimestamp: rangeEnd,
      dueAt: rangeStart,
      dueEndAt: rangeEnd,
    }),
    true,
  );
  assert.equal(
    getPlannerDateRangeBoundary({
      dayTimestamp: rangeEnd,
      dueAt: rangeStart,
      dueEndAt: rangeEnd,
    }),
    "ends",
  );
  assert.equal(
    plannerDayMatchesDueDateBoundary({
      dayTimestamp: rangeStart,
      dueAt: rangeStart,
      dueEndAt: null,
    }),
    true,
  );
  assert.equal(
    getPlannerDateRangeBoundary({
      dayTimestamp: rangeStart,
      dueAt: rangeStart,
      dueEndAt: null,
    }),
    null,
  );
});

test("planner sidebar date range tasks skip middle planner days", () => {
  const rangeStart = dateInputValueToTimestamp("2026-05-14");
  const rangeMiddle = dateInputValueToTimestamp("2026-05-15");
  const rangeEnd = dateInputValueToTimestamp("2026-05-16");
  assert.ok(rangeStart);
  assert.ok(rangeMiddle);
  assert.ok(rangeEnd);

  const nodes = [
    {
      _id: "sidebar",
      pageId: "planner",
      parentNodeId: null,
      position: 1024,
      text: "Sidebar",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: { sectionSlot: "plannerSidebar" },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: "range-task",
      pageId: "planner",
      parentNodeId: "sidebar",
      position: 1024,
      text: "Range sidebar task",
      kind: "task",
      taskStatus: "todo",
      priority: null,
      dueAt: rangeStart,
      dueEndAt: rangeEnd,
      archived: false,
      sourceMeta: { sourceType: "manual" },
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  assert.deepEqual(
    listEligiblePlannerSidebarSourceTasksFromNodes(nodes as never, {
      plannerDate: rangeStart,
    }).map((node) => node._id),
    ["range-task"],
  );
  assert.deepEqual(
    listEligiblePlannerSidebarSourceTasksFromNodes(nodes as never, {
      plannerDate: rangeMiddle,
    }).map((node) => node._id),
    [],
  );
  assert.deepEqual(
    listEligiblePlannerSidebarSourceTasksFromNodes(nodes as never, {
      plannerDate: rangeEnd,
    }).map((node) => node._id),
    ["range-task"],
  );

  const plannedNodes = [
    ...nodes,
    {
      _id: "start-day",
      pageId: "planner",
      parentNodeId: null,
      position: 2048,
      text: "Thursday",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: { plannerKind: "plannerDay", plannerDate: rangeStart },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: "middle-day",
      pageId: "planner",
      parentNodeId: null,
      position: 3072,
      text: "Friday",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: { plannerKind: "plannerDay", plannerDate: rangeMiddle },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: "end-day",
      pageId: "planner",
      parentNodeId: null,
      position: 4096,
      text: "Saturday",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: { plannerKind: "plannerDay", plannerDate: rangeEnd },
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  assert.equal(
    findExistingPlannerDayForSidebarSourceTask(
      plannedNodes as never,
      nodes[1] as never,
    )?._id,
    "start-day",
  );
  assert.equal(
    findExistingPlannerDayForSidebarSourceTask(
      [
        ...plannedNodes,
        {
          _id: "existing-start-link",
          pageId: "planner",
          parentNodeId: "start-day",
          position: 1024,
          text: "[[node:range-task]] (begins)",
          kind: "task",
          taskStatus: "todo",
          priority: null,
          dueAt: null,
          dueEndAt: null,
          archived: false,
          sourceMeta: {
            plannerKind: "plannerLinkedTask",
            sourceTaskNodeId: "range-task",
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ] as never,
      nodes[1] as never,
    )?._id,
    "end-day",
  );

  assert.equal(
    buildPlannerLinkedTaskCopyText(nodes[1] as never, rangeStart),
    "[[node:range-task]] (begins)",
  );
  assert.equal(
    buildPlannerLinkedTaskCopyText(nodes[1] as never, rangeEnd),
    "[[node:range-task]] (ends)",
  );
});

test("planner sidebar recurring task can target an existing planned day once", () => {
  const currentDate = dateInputValueToTimestamp("2026-05-14");
  const nextDate = dateInputValueToTimestamp("2026-05-15");
  const laterDate = dateInputValueToTimestamp("2026-05-16");
  assert.ok(currentDate);
  assert.ok(nextDate);
  assert.ok(laterDate);

  const sourceTask = {
    _id: "recurring-sidebar-task",
    pageId: "planner",
    parentNodeId: "sidebar",
    position: 1024,
    text: "Recurring sidebar task",
    kind: "task",
    taskStatus: "todo",
    priority: null,
    dueAt: nextDate,
    dueEndAt: null,
    archived: false,
    sourceMeta: { sourceType: "manual", recurrenceFrequency: "daily" },
    createdAt: 1,
    updatedAt: 1,
  };
  const nodes = [
    {
      _id: "sidebar",
      pageId: "planner",
      parentNodeId: null,
      position: 1024,
      text: "Sidebar",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: { sectionSlot: "plannerSidebar" },
      createdAt: 1,
      updatedAt: 1,
    },
    sourceTask,
    {
      _id: "current-day",
      pageId: "planner",
      parentNodeId: null,
      position: 2048,
      text: "Thursday",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: { plannerKind: "plannerDay", plannerDate: currentDate },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: "next-day",
      pageId: "planner",
      parentNodeId: null,
      position: 3072,
      text: "Friday",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      dueEndAt: null,
      archived: false,
      sourceMeta: { plannerKind: "plannerDay", plannerDate: nextDate },
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  assert.equal(
    findExistingPlannerDayForSidebarSourceTask(nodes as never, sourceTask as never)?._id,
    "next-day",
  );

  assert.equal(
    findExistingPlannerDayForSidebarSourceTask(
      [
        ...nodes,
        {
          _id: "existing-link",
          pageId: "planner",
          parentNodeId: "next-day",
          position: 1024,
          text: "[[node:recurring-sidebar-task]]",
          kind: "task",
          taskStatus: "todo",
          priority: null,
          dueAt: null,
          dueEndAt: null,
          archived: false,
          sourceMeta: {
            plannerKind: "plannerLinkedTask",
            sourceTaskNodeId: "recurring-sidebar-task",
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ] as never,
      sourceTask as never,
    ),
    null,
  );

  assert.equal(
    findExistingPlannerDayForSidebarSourceTask(
      nodes as never,
      { ...sourceTask, dueAt: laterDate } as never,
    ),
    null,
  );
});

test("planner linked recurring source completion syncs once", () => {
  const dueAt = dateInputValueToTimestamp("2026-05-14");
  assert.ok(dueAt);

  assert.equal(
    shouldSyncPlannerLinkedRecurringSourceTaskCompletion(
      {
        sourceMeta: {
          plannerKind: "plannerLinkedTask",
          sourceTaskNodeId: "source-task",
        },
      } as never,
      {
        dueAt,
        sourceMeta: {
          recurrenceFrequency: "weekly",
        },
      } as never,
    ),
    true,
  );

  assert.equal(
    shouldSyncPlannerLinkedRecurringSourceTaskCompletion(
      {
        sourceMeta: {
          plannerKind: "plannerLinkedTask",
          sourceTaskNodeId: "source-task",
          sourceTaskCompletionSyncedAt: dueAt,
        },
      } as never,
      {
        dueAt,
        sourceMeta: {
          recurrenceFrequency: "weekly",
        },
      } as never,
    ),
    false,
  );

  assert.equal(
    shouldSyncPlannerLinkedRecurringSourceTaskCompletion(
      {
        sourceMeta: {
          plannerKind: "plannerLinkedTask",
          sourceTaskNodeId: "source-task",
        },
      } as never,
      {
        dueAt: null,
        sourceMeta: {
          recurrenceFrequency: "weekly",
        },
      } as never,
    ),
    false,
  );
});

test("parseImportedTextToOutlineNodes converts due markers into real task schedule data", () => {
  const nodes = parseImportedTextToOutlineNodes([
    "#perm renew car registration !(2027-02-09 | 1y)",
    "~~#temp insurance renews !(2026-07-07 | 6m)~~",
  ].join("\n"));

  assert.deepEqual(nodes, [
    {
      text: "#perm renew car registration",
      kind: "task",
      taskStatus: "todo",
      noteCompleted: false,
      dueAt: dateInputValueToTimestamp("2027-02-09"),
      dueEndAt: null,
      recurrenceFrequency: "yearly",
      lockKind: true,
      children: [],
    },
    {
      text: "~~#temp insurance renews~~",
      kind: "task",
      taskStatus: "todo",
      noteCompleted: false,
      dueAt: dateInputValueToTimestamp("2026-07-07"),
      dueEndAt: null,
      recurrenceFrequency: {
        interval: 6,
        unit: "month",
      },
      lockKind: true,
      children: [],
    },
  ]);
});

test("parseImportedTextToOutlineNodes converts date ranges into real task range metadata", () => {
  const nodes = parseImportedTextToOutlineNodes(
    "[[trip]] to [[SD]] + [[LA]] !(2026-04-08 - 2026-04-21)",
  );

  assert.deepEqual(nodes, [
    {
      text: "[[trip]] to [[SD]] + [[LA]]",
      kind: "task",
      taskStatus: "todo",
      noteCompleted: false,
      dueAt: dateInputValueToTimestamp("2026-04-08"),
      dueEndAt: dateInputValueToTimestamp("2026-04-21"),
      recurrenceFrequency: null,
      lockKind: true,
      children: [],
    },
  ]);
});

test("parseImportedTextToOutlineNodes ignores imported times in due markers for now", () => {
  const nodes = parseImportedTextToOutlineNodes(
    "[[trip]] to [[SD]] !(2026-06-11 13:00)",
  );

  assert.deepEqual(nodes, [
    {
      text: "[[trip]] to [[SD]]",
      kind: "task",
      taskStatus: "todo",
      noteCompleted: false,
      dueAt: dateInputValueToTimestamp("2026-06-11"),
      dueEndAt: null,
      recurrenceFrequency: null,
      lockKind: true,
      children: [],
    },
  ]);
});

test("parseImportedTextToOutlineNodes preserves full-line strikethrough as text formatting", () => {
  const nodes = parseImportedTextToOutlineNodes(
    "~~#perm [costco membership](https://dynalist.io/d/gZbxdAfe_LzJ-ZNaczyYnfou#z=H5s8GLBy4E5_PVXp4-V2Vvcb) renews !(2026-05-17)~~",
  );

  assert.deepEqual(nodes, [
    {
      text: "~~#perm [[costco membership]] renews~~",
      kind: "task",
      taskStatus: "todo",
      noteCompleted: false,
      dueAt: dateInputValueToTimestamp("2026-05-17"),
      dueEndAt: null,
      recurrenceFrequency: null,
      lockKind: true,
      children: [],
    },
  ]);
});

test("splitTextForInlineFormatting applies strike, italic, and bold markers", () => {
  const { segments, nextState } = splitTextForInlineFormatting(
    "Before ~~gone~~ __soft__ **strong** `code` after",
  );

  assert.deepEqual(
    segments.map((segment) => ({
      text: segment.text,
      strike: segment.strike,
      italic: segment.italic,
      bold: segment.bold,
      code: segment.code,
    })),
    [
      {
        text: "Before ",
        strike: false,
        italic: false,
        bold: false,
        code: false,
      },
      {
        text: "gone",
        strike: true,
        italic: false,
        bold: false,
        code: false,
      },
      {
        text: " ",
        strike: false,
        italic: false,
        bold: false,
        code: false,
      },
      {
        text: "soft",
        strike: false,
        italic: true,
        bold: false,
        code: false,
      },
      {
        text: " ",
        strike: false,
        italic: false,
        bold: false,
        code: false,
      },
      {
        text: "strong",
        strike: false,
        italic: false,
        bold: true,
        code: false,
      },
      {
        text: " ",
        strike: false,
        italic: false,
        bold: false,
        code: false,
      },
      {
        text: "code",
        strike: false,
        italic: false,
        bold: false,
        code: true,
      },
      {
        text: " after",
        strike: false,
        italic: false,
        bold: false,
        code: false,
      },
    ],
  );

  assert.deepEqual(nextState, {
    strike: false,
    italic: false,
    bold: false,
    code: false,
  });
});

test("splitTextForInlineFormatting keeps markers literal inside inline code", () => {
  const { segments, nextState } = splitTextForInlineFormatting(
    "before `__test__ **bold** ~~gone~~` after",
  );

  assert.deepEqual(
    segments.map((segment) => ({
      text: segment.text,
      strike: segment.strike,
      italic: segment.italic,
      bold: segment.bold,
      code: segment.code,
    })),
    [
      {
        text: "before ",
        strike: false,
        italic: false,
        bold: false,
        code: false,
      },
      {
        text: "__test__ **bold** ~~gone~~",
        strike: false,
        italic: false,
        bold: false,
        code: true,
      },
      {
        text: " after",
        strike: false,
        italic: false,
        bold: false,
        code: false,
      },
    ],
  );
  assert.deepEqual(nextState, {
    strike: false,
    italic: false,
    bold: false,
    code: false,
  });
});

test("replaceLiteralOccurrences replaces exact literal matches and counts them", () => {
  assert.equal(countLiteralOccurrences("alpha beta alpha", "alpha"), 2);
  assert.equal(countLiteralOccurrences("alpha beta", "gamma"), 0);

  assert.deepEqual(
    replaceLiteralOccurrences("alpha beta alpha", "alpha", "omega"),
    {
      value: "omega beta omega",
      occurrenceCount: 2,
    },
  );

  assert.equal(
    replaceLiteralOccurrences("alpha beta", "gamma", "omega"),
    null,
  );
});

test("hasRenderableInlineFormatting detects plain inline emphasis without requiring links", () => {
  assert.equal(hasRenderableInlineFormatting("plain text"), false);
  assert.equal(hasRenderableInlineFormatting("__soft__ text"), true);
  assert.equal(hasRenderableInlineFormatting("**strong** text"), true);
  assert.equal(hasRenderableInlineFormatting("~~gone~~ text"), true);
  assert.equal(hasRenderableInlineFormatting("`code` text"), true);
  assert.equal(hasRenderableInlineFormatting("__"), false);
});

test("stripInlineFormattingMarkers removes inline emphasis tokens but keeps text", () => {
  assert.equal(
    stripInlineFormattingMarkers("Before ~~gone~~ __soft__ **strong** `code` after"),
    "Before gone soft strong code after",
  );
});

test("applySelectedInlineFormattingShortcut wraps and unwraps selected text", () => {
  assert.deepEqual(
    applySelectedInlineFormattingShortcut("hello world", 0, 5, "__"),
    {
      value: "__hello__ world",
      selectionStart: 2,
      selectionEnd: 7,
    },
  );

  assert.deepEqual(
    applySelectedInlineFormattingShortcut("__hello__ world", 0, 9, "__"),
    {
      value: "hello world",
      selectionStart: 0,
      selectionEnd: 5,
    },
  );

  assert.deepEqual(
    applySelectedInlineFormattingShortcut("hello world", 6, 11, "**"),
    {
      value: "hello **world**",
      selectionStart: 8,
      selectionEnd: 13,
    },
  );

  assert.deepEqual(
    applySelectedInlineFormattingShortcut("hello world", 0, 5, "~~"),
    {
      value: "~~hello~~ world",
      selectionStart: 2,
      selectionEnd: 7,
    },
  );
});

test("buildModelRewriteUserPrompt prepends an optional user note", () => {
  const prompt = buildModelRewriteUserPrompt({
    pageTitle: "Signals",
    request: "Refresh the model.",
    userNote: "Lean more practical than abstract.",
    existingModelLines: ["Current line"],
    recentExampleLines: ["Recent line"],
    recentConversationLines: ["user: prior note"],
  });

  assert.match(prompt, /User note to honor first: Lean more practical than abstract\./);
  assert.match(prompt, /Request: Refresh the model\./);
  assert.match(prompt, /Current Model lines:\n- Current line/);
});

test("buildJournalFeedbackUserPrompt prepends an optional user note", () => {
  const prompt = buildJournalFeedbackUserPrompt({
    pageTitle: "2026-04-03",
    userNote: "Be blunt but kind.",
    whatHappenedLines: ["Met with Alex"],
    thoughtLines: ["First thought", "Second thought"],
  });

  assert.match(prompt, /User note to honor first: Be blunt but kind\./);
  assert.match(prompt, /What happened:\n- Met with Alex/);
  assert.match(prompt, /Thoughts\/Stuff:\n- First thought\n- Second thought/);
});

test("recurring due dates can advance from the original due date or today", () => {
  const dueAt = new Date(2026, 3, 1, 12, 0, 0, 0).getTime();

  assert.equal(
    advanceRecurringDueDate({
      dueAt,
      frequency: "weekly",
      mode: "dueDate",
    }),
    new Date(2026, 3, 8, 12, 0, 0, 0).getTime(),
  );

  assert.equal(
    advanceRecurringDueDate({
      dueAt,
      frequency: "weekly",
      mode: "today",
      now: new Date(2026, 3, 10, 8, 30, 0, 0),
    }),
    new Date(2026, 3, 17, 12, 0, 0, 0).getTime(),
  );

  assert.equal(
    advanceRecurringDueDate({
      dueAt,
      frequency: {
        interval: 10,
        unit: "day",
      },
      mode: "dueDate",
    }),
    new Date(2026, 3, 11, 12, 0, 0, 0).getTime(),
  );
});

test("recurring date ranges advance together and overdue uses the end date", () => {
  const advanced = advanceRecurringDueDateRange({
    dueAt: dateInputValueToTimestamp("2026-04-08")!,
    dueEndAt: dateInputValueToTimestamp("2026-04-21"),
    frequency: "monthly",
    mode: "dueDate",
  });

  assert.equal(
    timestampToDateInputValue(advanced.dueAt),
    "2026-05-08",
  );
  assert.equal(
    timestampToDateInputValue(advanced.dueEndAt),
    "2026-05-21",
  );

  assert.equal(
    formatDueDateRange(
      dateInputValueToTimestamp("2026-04-08"),
      dateInputValueToTimestamp("2026-04-21"),
    ).length > 0,
    true,
  );

  assert.equal(
    isOverdueDueDateRange(
      dateInputValueToTimestamp("2026-04-08"),
      dateInputValueToTimestamp("2026-04-21"),
      new Date(2026, 3, 22, 12, 0, 0, 0),
    ),
    true,
  );
});

test("custom recurrence labels and parsing work for widened cadence values", () => {
  assert.equal(
    getRecurrenceLabel({
      interval: 10,
      unit: "day",
    }),
    "Every 10 days",
  );

  assert.deepEqual(
    parseRecurrenceFrequency({
      interval: 3,
      unit: "week",
    }),
    {
      interval: 3,
      unit: "week",
    },
  );

  assert.equal(
    areRecurrenceFrequenciesEqual(
      { interval: 10, unit: "day" },
      { interval: 10, unit: "day" },
    ),
    true,
  );
});

test("compact date and recurrence labels fit small badges", () => {
  assert.equal(
    formatCompactDueDateRange(
      dateInputValueToTimestamp("2026-04-08"),
      null,
      new Date(2026, 0, 1, 12, 0, 0, 0),
    ),
    "04/08",
  );

  assert.equal(
    formatCompactDueDateRange(
      dateInputValueToTimestamp("2027-04-08"),
      null,
      new Date(2026, 0, 1, 12, 0, 0, 0),
    ),
    "04/08/27",
  );

  assert.equal(
    formatCompactDueDateRange(
      dateInputValueToTimestamp("2026-04-08"),
      dateInputValueToTimestamp("2026-04-21"),
      new Date(2026, 0, 1, 12, 0, 0, 0),
    ),
    "04/08-04/21",
  );

  assert.equal(getCompactRecurrenceLabel("daily"), "1d");
  assert.equal(getCompactRecurrenceLabel("weekly"), "1w");
  assert.equal(getCompactRecurrenceLabel({ interval: 2, unit: "day" }), "2d");
  assert.equal(getCompactRecurrenceLabel({ interval: 2, unit: "week" }), "2w");
  assert.equal(getCompactRecurrenceLabel({ interval: 3, unit: "month" }), "3mo");
  assert.equal(getCompactRecurrenceLabel({ interval: 4, unit: "year" }), "4y");
});

test("due dates round-trip through date input helpers and overdue checks", () => {
  const timestamp = dateInputValueToTimestamp("2026-04-03");
  assert.equal(timestampToDateInputValue(timestamp), "2026-04-03");
  assert.equal(
    isOverdueDueDate(
      timestamp,
      new Date(2026, 3, 4, 8, 0, 0, 0),
    ),
    true,
  );
  assert.equal(
    isOverdueDueDate(
      timestamp,
      new Date(2026, 3, 3, 8, 0, 0, 0),
    ),
    false,
  );
});

test("parseMarkdownFile converts headings, bullets, and tasks into nodes", () => {
  const page = parseMarkdownFile({
    path: "Projects/Roadmap.md",
    content: "# Vision\n- Outline the arc\n  - [ ] Ship alpha\n",
  });

  assert.equal(page.title, "Roadmap");
  assert.equal(page.nodes.length, 3);
  assert.equal(page.nodes[0]?.text, "Vision");
  assert.equal(page.nodes[1]?.kind, "note");
  assert.equal(page.nodes[2]?.kind, "task");
  assert.equal(page.nodes[2]?.taskStatus, "todo");
  assert.equal(page.nodes[2]?.parentTempId, page.nodes[1]?.tempId);
});

test("normalizeImportedOutlineText collapses long separator glyphs", () => {
  assert.equal(
    normalizeImportedOutlineText("alpha\n—————————\nomega"),
    "alpha\n---\nomega",
  );
});

test("normalizeImportedOutlineText rewrites imported work tag aliases", () => {
  assert.equal(
    normalizeImportedOutlineText(
      "#work-misc-5 #work-tech-7 renew customer flow",
    ),
    "#malesh/labs/fanswap renew customer flow",
  );
  assert.equal(
    normalizeImportedOutlineText(
      "#work-misc-2 #work-tech-5 improve importer",
    ),
    "#malesh/labs/flow improve importer",
  );
  assert.equal(
    normalizeImportedOutlineText(
      "#work-tech #work-job ship release",
    ),
    "#work/job ship release",
  );
  assert.equal(
    normalizeImportedOutlineText(
      "#work-tech #work-job-4 review launch",
    ),
    "#work/job review launch",
  );
  assert.equal(
    normalizeImportedOutlineText(
      "#personal-hobby-misc make more music",
    ),
    "#hobby make more music",
  );
});

test("normalizeImportedOutlineText removes imported duration markers", () => {
  assert.equal(
    normalizeImportedOutlineText(
      "call dentist (20 min)",
    ),
    "call dentist",
  );
  assert.equal(
    normalizeImportedOutlineText(
      "#hobby sketch (30 min) tonight",
    ),
    "#hobby sketch tonight",
  );
});

test("buildDefaultMigrationLessonsDoc seeds dynalist-specific guidance", () => {
  const doc = buildDefaultMigrationLessonsDoc("dynalist");
  assert.match(doc, /Dynalist Migration Lessons/);
  assert.match(doc, /\[\[label\]\]/);
  assert.match(doc, /---/);
});

test("serializePageToMarkdown emits readable markdown with tasks", () => {
  const markdown = serializePageToMarkdown(
    { title: "Inbox" },
    [
      {
        _id: "1",
        parentNodeId: null,
        text: "Capture loose thoughts",
        kind: "note",
        taskStatus: null,
        position: 1024,
      },
      {
        _id: "2",
        parentNodeId: "1",
        text: "Turn this into a task",
        kind: "task",
        taskStatus: "done",
        position: 2048,
      },
    ],
  );

  assert.match(markdown, /# Inbox/);
  assert.match(markdown, /- Capture loose thoughts/);
  assert.match(markdown, /- \[x\] Turn this into a task/);
});

test("buildFocusedOutlineContext shows immediate parent and focused branch only", () => {
  const tree = buildOutlineTree([
    {
      _id: "root",
      pageId: "page",
      parentNodeId: null,
      position: 1,
      text: "Root",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      archived: false,
    },
    {
      _id: "child",
      pageId: "page",
      parentNodeId: "root",
      position: 1,
      text: "Child",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      archived: false,
    },
    {
      _id: "sibling",
      pageId: "page",
      parentNodeId: "root",
      position: 2,
      text: "Sibling",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      archived: false,
    },
    {
      _id: "grandchild",
      pageId: "page",
      parentNodeId: "child",
      position: 1,
      text: "Grandchild",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      archived: false,
    },
  ]);

  const context = buildFocusedOutlineContext(tree, "child");

  assert.equal(context.focusedNode?._id, "child");
  assert.equal(context.parentNode?._id, "root");
  assert.equal(context.rootParentNodeId, null);
  assert.deepEqual(
    context.roots.map((node) => ({
      id: node._id,
      children: node.children.map((child) => child._id),
    })),
    [{ id: "root", children: ["child"] }],
  );
  assert.deepEqual(
    context.roots[0]?.children[0]?.children.map((child) => child._id),
    ["grandchild"],
  );
});

test("buildFocusedOutlineContext returns the focused root when it has no parent", () => {
  const tree = buildOutlineTree([
    {
      _id: "root",
      pageId: "page",
      parentNodeId: null,
      position: 1,
      text: "Root",
      kind: "note",
      taskStatus: null,
      priority: null,
      dueAt: null,
      archived: false,
    },
  ]);

  const context = buildFocusedOutlineContext(tree, "root");

  assert.equal(context.focusedNode?._id, "root");
  assert.equal(context.parentNode, null);
  assert.equal(context.roots[0]?._id, "root");
});

test("buildDeterministicEmbedding is stable and uses contextual input", () => {
  const input = buildEmbeddingInput({
    pageTitle: "Weekly Review",
    ancestors: ["Projects", "Launch"],
    nodeText: "Email the beta waitlist",
  });
  const first = buildDeterministicEmbedding(input);
  const second = buildDeterministicEmbedding(input);

  assert.equal(first.length, 1536);
  assert.deepEqual(first, second);
});

test("shouldGenerateEmbeddingForNodeText skips trivial placeholder lines", () => {
  assert.equal(shouldGenerateEmbeddingForNodeText("---"), false);
  assert.equal(shouldGenerateEmbeddingForNodeText("."), false);
  assert.equal(shouldGenerateEmbeddingForNodeText("real note"), true);
});

test("buildRootEmbeddingInput includes root-level subtree context", () => {
  const input = buildRootEmbeddingInput({
    pageTitle: "Dating Model",
    rootText: "Model",
    subtreeLines: [
      "Be playful and grounded",
      "  [ ] Ask better follow-up questions",
      "Use concrete examples",
    ],
  });

  assert.match(input, /Page: Dating Model/);
  assert.match(input, /Root: Model/);
  assert.match(input, /Subtree:/);
  assert.match(input, /\[ \] Ask better follow-up questions/);
});
