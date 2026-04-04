import test from "node:test";
import assert from "node:assert/strict";
import {
  applySelectedLinkShortcut,
  extractLinkMatches,
  extractLinks,
  rewriteMatchingPageWikiLinks,
} from "../lib/domain/links";
import { parseHeadingSyntax } from "../lib/domain/displaySyntax";
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
  shouldGenerateEmbeddingForNodeText,
} from "../lib/domain/embeddings";
import {
  applySelectedInlineFormattingShortcut,
  hasRenderableInlineFormatting,
  splitTextForInlineFormatting,
} from "../lib/domain/inlineFormatting";
import {
  countLiteralOccurrences,
  replaceLiteralOccurrences,
} from "../lib/domain/findReplace";
import {
  advanceRecurringDueDate,
  advanceRecurringDueDateRange,
  areRecurrenceFrequenciesEqual,
  dateInputValueToTimestamp,
  getRecurrenceLabel,
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
import { parseImportedTextToOutlineNodes } from "../lib/domain/importer";
import { getEffectiveTaskDueDateRange } from "../lib/domain/planner";

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

test("getEffectiveTaskDueDateRange inherits due dates from ancestor task items", () => {
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
    dueAt: parentTask.dueAt,
    dueEndAt: parentTask.dueEndAt,
  });
  assert.deepEqual(getEffectiveTaskDueDateRange(grandchildTask, nodes), {
    dueAt: parentTask.dueAt,
    dueEndAt: parentTask.dueEndAt,
  });
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
    thoughtLines: ["First thought", "Second thought"],
  });

  assert.match(prompt, /User note to honor first: Be blunt but kind\./);
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
