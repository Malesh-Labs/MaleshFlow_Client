import test from "node:test";
import assert from "node:assert/strict";
import { extractLinkMatches, extractLinks } from "../lib/domain/links";
import { extractTagMatches, extractTags } from "../lib/domain/tags";
import { parseMarkdownFile, serializePageToMarkdown } from "../lib/domain/markdown";
import {
  buildDeterministicEmbedding,
  buildEmbeddingInput,
  buildRootEmbeddingInput,
} from "../lib/domain/embeddings";

test("extractLinks finds wiki links and node refs", () => {
  const links = extractLinks(
    "Plan [[Launch Page]] after reviewing ((node_123)), [[Attachment note|node:node_456]], and [OpenAI](openai.com).",
  );
  assert.deepEqual(links, [
    {
      kind: "page",
      label: "[[Launch Page]]",
      targetPageTitle: "Launch Page",
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
