import { z } from "zod";

export type ScreenshotImportNode = {
  text: string;
  kind: "note" | "task";
  taskStatus: "todo" | "done" | null;
  noteCompleted: boolean;
  children: ScreenshotImportNode[];
};

export const screenshotImportNodeSchema: z.ZodType<ScreenshotImportNode> = z.lazy(() =>
  z.object({
    text: z.string(),
    kind: z.enum(["note", "task"]),
    taskStatus: z.enum(["todo", "done"]).nullable(),
    noteCompleted: z.boolean(),
    children: z.array(screenshotImportNodeSchema),
  }),
);

export const screenshotImportResultSchema = z.object({
  summary: z.string(),
  warnings: z.array(z.string()).max(8),
  nodes: z.array(screenshotImportNodeSchema).max(300),
});

export type ScreenshotImportResult = z.infer<typeof screenshotImportResultSchema>;

export function normalizeScreenshotImportNodes(
  nodes: ScreenshotImportNode[],
): ScreenshotImportNode[] {
  return nodes
    .map((node) => {
      const text = node.text.trim();
      if (text.length === 0) {
        return null;
      }

      const kind = node.kind === "task" ? "task" : "note";
      return {
        text,
        kind,
        taskStatus: kind === "task" ? (node.taskStatus ?? "todo") : null,
        noteCompleted: kind === "note" ? node.noteCompleted === true : false,
        children: normalizeScreenshotImportNodes(node.children ?? []),
      } satisfies ScreenshotImportNode;
    })
    .filter((node): node is ScreenshotImportNode => node !== null);
}
