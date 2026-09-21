import { z } from 'zod'
import { HttpError } from './store.ts'
const id = z.string().min(1).max(200), version = z.number().int().positive(), text = z.string().max(20000)
const dataset = z.enum(['outcomes', 'risks', 'next_week'])
export const reportAgentColumnSchema = z.object({ label: z.string().min(1).max(200), field: z.enum(['title', 'owner', 'commitment', 'outcome', 'status', 'evidence', 'blocker', 'next_action', 'monthly_goal', 'manual']), required: z.boolean() }).strict()
export const reportAgentBindingSchema = z.object({ regionId: id, label: z.string().min(1).max(200), kind: z.enum(['keep', 'clear', 'meta', 'section', 'dataset', 'manual']), required: z.boolean(), value: text.optional(),
  meta: z.enum(['period', 'week_end', 'week_range', 'captured_at', 'title', 'author', 'department']).optional(), section: dataset.optional(), dataset: dataset.optional(), startRow: z.number().int().min(0).optional(), endRow: z.number().int().positive().optional(), columns: z.array(reportAgentColumnSchema).max(30).optional() }).strict()
export const reportAgentCellSchema = z.object({ text, factIds: z.array(id).max(1000), manual: z.boolean(), confirmed: z.boolean(), source: z.string().max(2000) }).strict()
export const reportAgentBlockSchema = z.object({ id, regionId: id, label: z.string().max(200), kind: z.enum(['text', 'table']), required: z.boolean(), content: reportAgentCellSchema, columns: z.array(reportAgentColumnSchema).max(30), rows: z.array(z.array(reportAgentCellSchema).max(30)).max(1000) }).strict()
export const uploadReportAssetSchema = z.object({ filename: z.string().min(1).max(255), contentBase64: z.string().min(1).max(17 * 1024 * 1024), purpose: z.enum(['template', 'example']), requestId: id.optional() }).strict()
export const createReportTemplateSchema = z.object({ name: z.string().trim().min(1).max(200), sourceAssetId: id, exampleAssetIds: z.array(id).max(10).optional(), effectiveWeek: id, requestId: id.optional() }).strict()
export const updateReportTemplateSchema = z.object({ expectedVersion: version, name: z.string().trim().min(1).max(200), bindings: z.array(reportAgentBindingSchema).max(1000), rules: z.array(z.string().min(1).max(2000)).max(30), rulesConfirmed: z.boolean(), exampleAssetIds: z.array(id).max(10), effectiveWeek: id }).strict()
export const reportTemplateReviewSchema = z.object({ expectedVersion: version, layoutVerified: z.boolean(), layoutNote: z.string().trim().min(1).max(2000) }).strict()
export const enqueueReportAgentSchema = z.object({ requestId: id, templateId: id, period: id, useAi: z.boolean(), sourceReportId: id.optional(), refreshSnapshot: z.boolean().optional() }).strict()
export const rewriteReportAgentSchema = z.object({ requestId: id, expectedVersion: version, blockId: id, useAi: z.boolean() }).strict()
export const learnReportTemplateSchema = z.object({ requestId: id, expectedVersion: version, useAi: z.boolean() }).strict()
export const editReportAgentSchema = z.object({ expectedVersion: version, title: z.string().trim().min(1).max(200), blocks: z.array(reportAgentBlockSchema).max(1000) }).strict()
export const finalizeReportAgentSchema = z.object({ expectedVersion: version, reviewNote: z.string().trim().min(1).max(2000) }).strict()
export const updateReportAgentScheduleSchema = z.object({ expectedVersion: version, enabled: z.boolean(), actorId: id, templateId: z.string().max(200), weekday: z.number().int().min(1).max(7), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), targetWeek: z.enum(['current', 'previous']), useAi: z.boolean() }).strict()
export function parseAgentInput<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new HttpError(400, '报告输入格式无效，请检查必填项和文本长度。'); return result.data }
