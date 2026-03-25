import { z } from "zod";
import { CHAT_OPERATION_TYPES, NODE_KINDS, TASK_PRIORITIES, TASK_STATUSES } from "./constants";

export const chatOperationSchema = z.object({
  type: z.enum(CHAT_OPERATION_TYPES),
  description: z.string(),
  pageId: z.string().optional(),
  nodeId: z.string().optional(),
  parentNodeId: z.string().nullable().optional(),
  afterNodeId: z.string().nullable().optional(),
  sourceNodeId: z.string().optional(),
  targetNodeId: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  kind: z.enum(NODE_KINDS).optional(),
  taskStatus: z.enum(TASK_STATUSES).nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).nullable().optional(),
  dueAt: z.number().nullable().optional(),
  archived: z.boolean().optional(),
});

export const chatPlanSchema = z.object({
  summary: z.string(),
  rationale: z.string(),
  preview: z.array(z.string()).max(12),
  operations: z.array(chatOperationSchema).max(12),
});

export type ChatOperation = z.infer<typeof chatOperationSchema>;
export type ChatPlan = z.infer<typeof chatPlanSchema>;
