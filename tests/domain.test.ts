import test from "node:test";
import assert from "node:assert/strict";
import {
  applySelectedLinkShortcut,
  extractLinkMatches,
  extractLinks,
  rewriteMatchingPageWikiLinks,
} from "../lib/domain/links";
import { parseHeadingSyntax } from "../lib/domain/displaySyntax";
import { extractTagMatches, extractTags } from "../lib/domain/tags";
import { parseMarkdownFile, serializePageToMarkdown } from "../lib/domain/markdown";
import {
  buildDeterministicEmbedding,
  buildEmbeddingInput,
  buildRootEmbeddingInput,
} from "../lib/domain/embeddings";
import { splitTextForInlineFormatting } from "../lib/domain/inlineFormatting";

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

test("splitTextForInlineFormatting applies strike, italic, and bold markers", () => {
  const { segments, nextState } = splitTextForInlineFormatting(
    "Before ~~gone~~ __soft__ **strong** after",
  );

  assert.deepEqual(
    segments.map((segment) => ({
      text: segment.text,
      strike: segment.strike,
      italic: segment.italic,
      bold: segment.bold,
    })),
    [
      {
        text: "Before ",
        strike: false,
        italic: false,
        bold: false,
      },
      {
        text: "gone",
        strike: true,
        italic: false,
        bold: false,
      },
      {
        text: " ",
        strike: false,
        italic: false,
        bold: false,
      },
      {
        text: "soft",
        strike: false,
        italic: true,
        bold: false,
      },
      {
        text: " ",
        strike: false,
        italic: false,
        bold: false,
      },
      {
        text: "strong",
        strike: false,
        italic: false,
        bold: true,
      },
      {
        text: " after",
        strike: false,
        italic: false,
        bold: false,
      },
    ],
  );

  assert.deepEqual(nextState, {
    strike: false,
    italic: false,
    bold: false,
  });
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
