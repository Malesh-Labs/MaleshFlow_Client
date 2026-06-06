import { z } from "zod";
import { CHAT_OPERATION_TYPES, NODE_KINDS, TASK_PRIORITIES, TASK_STATUSES } from "./constants";

export const chatOperationSchema = z.object({
  type: z.enum(CHAT_OPERATION_TYPES),
  description: z.string(),
  pageId: z.string().nullable(),
  nodeId: z.string().nullable(),
  parentNodeId: z.string().nullable(),
  afterNodeId: z.string().nullable(),
  sourceNodeId: z.string().nullable(),
  targetNodeId: z.string().nullable(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  kind: z.enum(NODE_KINDS).nullable(),
  taskStatus: z.enum(TASK_STATUSES).nullable(),
  priority: z.enum(TASK_PRIORITIES).nullable(),
  dueAt: z.number().nullable(),
  archived: z.boolean().nullable(),
});

export const chatPlanSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  preview: z.array(z.string()).max(12),
  operations: z.array(chatOperationSchema).max(12),
});

export type ChatOperation = z.infer<typeof chatOperationSchema>;
export type ChatPlan = z.infer<typeof chatPlanSchema>;
