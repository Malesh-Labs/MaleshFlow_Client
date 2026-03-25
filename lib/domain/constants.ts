export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "done",
  "cancelled",
] as const;

export const NODE_KINDS = ["note", "task"] as const;

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;

export const CHAT_OPERATION_TYPES = [
  "create_page",
  "rename_page",
  "create_node",
  "update_node",
  "move_node",
  "archive_node",
  "delete_node",
  "merge_node",
] as const;

export const EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_POSITION_GAP = 1024;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type NodeKind = (typeof NODE_KINDS)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ChatOperationType = (typeof CHAT_OPERATION_TYPES)[number];

export type MarkdownImportFile = {
  path: string;
  content: string;
};

export type SourceMeta = {
  sourceType?: string;
  sourcePath?: string;
  sourceLine?: number;
  headingDepth?: number;
  importRunId?: string;
  externalId?: string;
};
