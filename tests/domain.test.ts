import test from "node:test";
import assert from "node:assert/strict";
import { extractLinks } from "../lib/domain/links";
import { parseMarkdownFile, serializePageToMarkdown } from "../lib/domain/markdown";
import { buildDeterministicEmbedding, buildEmbeddingInput } from "../lib/domain/embeddings";

test("extractLinks finds wiki links and node refs", () => {
  const links = extractLinks("Plan [[Launch Page]] after reviewing ((node_123)).");
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
  ]);
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
