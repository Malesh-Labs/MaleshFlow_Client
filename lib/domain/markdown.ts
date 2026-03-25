import slugify from "slugify";
import type { MarkdownImportFile, NodeKind, SourceMeta, TaskStatus } from "./constants";
import { getAppendPosition } from "./positions";

type ImportedNode = {
  tempId: string;
  parentTempId: string | null;
  text: string;
  kind: NodeKind;
  taskStatus: TaskStatus | null;
  position: number;
  sourceMeta: SourceMeta;
};

export type ParsedImportPage = {
  title: string;
  slug: string;
  sourcePath: string;
  nodes: ImportedNode[];
};

type StackEntry = {
  level: number;
  tempId: string;
};

function getPageTitle(filePath: string) {
  const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
  const cleaned = baseName.replace(/[_-]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : "Untitled";
}

function getPageSlug(title: string) {
  return slugify(title, { lower: true, strict: true }) || "untitled";
}

function getIndentLevel(rawIndent: string) {
  const normalized = rawIndent.replace(/\t/g, "  ");
  return Math.max(0, Math.floor(normalized.length / 2));
}

export function parseMarkdownBundle(files: MarkdownImportFile[]) {
  return files
    .filter((file) => file.path.toLowerCase().endsWith(".md"))
    .map((file) => parseMarkdownFile(file));
}

export function parseMarkdownFile(file: MarkdownImportFile): ParsedImportPage {
  const title = getPageTitle(file.path);
  const slug = getPageSlug(title);
  const lines = file.content.replace(/\r\n/g, "\n").split("\n");
  const stack: StackEntry[] = [];
  const nodes: ImportedNode[] = [];
  let cursor: ImportedNode | null = null;

  const pushNode = (
    level: number,
    node: Omit<ImportedNode, "parentTempId" | "position">,
  ) => {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
      stack.pop();
    }

    const parentTempId = stack[stack.length - 1]?.tempId ?? null;
    const siblingCount = nodes.filter(
      (existing) => existing.parentTempId === parentTempId,
    ).length;

    const fullNode: ImportedNode = {
      ...node,
      parentTempId,
      position: getAppendPosition(siblingCount * 1024),
    };

    nodes.push(fullNode);
    stack.push({ level, tempId: fullNode.tempId });
    cursor = fullNode;
  };

  lines.forEach((line, index) => {
    const trimmed = line.trimEnd();
    if (trimmed.trim().length === 0) {
      cursor = null;
      return;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      pushNode(0, {
        tempId: `node_${index}`,
        text: headingMatch[2]!.trim(),
        kind: "note",
        taskStatus: null,
        sourceMeta: {
          sourceType: "markdown-heading",
          sourcePath: file.path,
          sourceLine: index + 1,
          headingDepth: headingMatch[1]!.length,
        },
      });
      return;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const level = getIndentLevel(listMatch[1] ?? "") + 1;
      const itemBody = listMatch[3]!.trim();
      const checkboxMatch = itemBody.match(/^\[([ xX])\]\s+(.+)$/);
      pushNode(level, {
        tempId: `node_${index}`,
        text: checkboxMatch ? checkboxMatch[2]!.trim() : itemBody,
        kind: checkboxMatch ? "task" : "note",
        taskStatus: checkboxMatch
          ? checkboxMatch[1]!.toLowerCase() === "x"
            ? "done"
            : "todo"
          : null,
        sourceMeta: {
          sourceType: "markdown-list",
          sourcePath: file.path,
          sourceLine: index + 1,
        },
      });
      return;
    }

    if (cursor) {
      cursor.text = `${cursor.text}\n${trimmed.trim()}`;
      return;
    }

    pushNode(0, {
      tempId: `node_${index}`,
      text: trimmed.trim(),
      kind: "note",
      taskStatus: null,
      sourceMeta: {
        sourceType: "markdown-paragraph",
        sourcePath: file.path,
        sourceLine: index + 1,
      },
    });
  });

  if (nodes.length === 0 && file.content.trim().length > 0) {
    nodes.push({
      tempId: "node_0",
      parentTempId: null,
      text: file.content.trim(),
      kind: "note",
      taskStatus: null,
      position: 1024,
      sourceMeta: {
        sourceType: "markdown-document",
        sourcePath: file.path,
        sourceLine: 1,
      },
    });
  }

  return {
    title,
    slug,
    sourcePath: file.path,
    nodes,
  };
}

type ExportPage = {
  title: string;
};

type ExportNode = {
  _id: string;
  parentNodeId: string | null;
  text: string;
  kind: string;
  taskStatus: string | null;
  position: number;
  sourceMeta?: { headingDepth?: number } | null;
};

export function serializePageToMarkdown(
  page: ExportPage,
  nodes: ExportNode[],
) {
  const byParent = new Map<string | null, ExportNode[]>();
  for (const node of [...nodes].sort((left, right) => left.position - right.position)) {
    const parentNodes = byParent.get(node.parentNodeId) ?? [];
    parentNodes.push(node);
    byParent.set(node.parentNodeId, parentNodes);
  }

  const renderNode = (node: ExportNode, depth: number): string[] => {
    const headingDepth = node.sourceMeta?.headingDepth;
    const lines: string[] = [];

    if (headingDepth && depth === 0) {
      lines.push(`${"#".repeat(headingDepth)} ${node.text}`);
    } else if (node.kind === "task") {
      const box = node.taskStatus === "done" ? "[x]" : "[ ]";
      lines.push(`${"  ".repeat(depth)}- ${box} ${node.text}`);
    } else {
      lines.push(`${"  ".repeat(depth)}- ${node.text}`);
    }

    for (const child of byParent.get(node._id) ?? []) {
      lines.push(...renderNode(child, headingDepth && depth === 0 ? 0 : depth + 1));
    }

    return lines;
  };

  const lines = [`# ${page.title}`, ""];
  for (const root of byParent.get(null) ?? []) {
    lines.push(...renderNode(root, 0), "");
  }

  return lines.join("\n").trimEnd() + "\n";
}
