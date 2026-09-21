import type { EnqueueReportAgentInput, ReportAgentBinding, ReportAgentDataset, ReportAgentField, ReportAgentJobStatus, ReportAgentCell, ReportAgentJob } from '../../shared/report-agent'

export const agentDatasetLabels: Record<ReportAgentDataset, string> = { outcomes: '本周成果与进展', risks: '问题与阻塞', next_week: '下周工作安排' }
export const agentFieldLabels: Record<ReportAgentField, string> = {
  title: '工作事项', owner: '负责人', commitment: '本周承诺', outcome: '实际成果', status: '周阶段状态',
  evidence: '成果证据', blocker: '问题与阻塞', next_action: '下一步', monthly_goal: '关联月目标', manual: '人工补充（公司口径）',
}
export const agentBindingLabels: Record<ReportAgentBinding['kind'], string> = { keep: '保留原文（已核对固定内容）', clear: '清除原文', meta: '报告日期或标题', section: '生成文字段落', dataset: '按事项填入表格', manual: '每期由管理者补充' }
export const agentJobLabels: Record<ReportAgentJobStatus, string> = { queued: '排队中', running: '正在生成', ready: '已完成', needs_input: '需要补充', failed: '生成失败', cancelled: '已取消' }
export const agentTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
export const agentLabel = (label: string) => label.replace(/^t:(\d+)\s*/, (_, index: string) => `表格 ${Number(index) + 1} `)
export const agentRequestId = () => crypto.randomUUID()
export const agentAssetUrl = (id: string) => `/api/report-agent/assets/${encodeURIComponent(id)}/download`
export const agentReportUrl = (id: string, version: number) => `/api/report-agent/reports/${encodeURIComponent(id)}/docx?expectedVersion=${version}`
export const agentJobPending = (status: ReportAgentJobStatus) => status === 'queued' || status === 'running'
export type AgentPendingRequest = { key: string; id: string }
export async function submitAgentGeneration(request: { current: AgentPendingRequest | null }, parameters: Omit<EnqueueReportAgentInput, 'requestId'>, send: (input: EnqueueReportAgentInput) => Promise<ReportAgentJob>, createId: () => string = agentRequestId): Promise<ReportAgentJob> {
  const key = JSON.stringify(parameters)
  if (request.current?.key !== key) request.current = { key, id: createId() }
  const requestId = request.current.id
  // A rejected response may follow a committed job. Keep its identity for retry.
  const result = await send({ ...parameters, requestId })
  if (request.current?.id === requestId) request.current = null
  return result
}
export async function readAgentReportTarget(currentReportId: string, job: Pick<ReportAgentJob, 'reportId'> | null | undefined, allowLeave: () => boolean, read: (id: string) => Promise<void>): Promise<void> {
  if (!allowLeave()) return
  await read(job?.reportId || currentReportId)
}
export function editAgentCell(cell: ReportAgentCell, text: string): ReportAgentCell { return { ...cell, text, confirmed: cell.manual ? false : cell.confirmed } }
export async function readAgentFile(file: File): Promise<string> {
  if (!/\.docx$/i.test(file.name)) throw new Error('仅支持 .docx 文件；请先将旧 .doc 或 PDF 转换为 Word DOCX。')
  if (file.size > 12 * 1024 * 1024) throw new Error('单份 Word 文件不能超过 12 MiB。')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}，请重新选择文件。`))
    reader.readAsDataURL(file)
  })
}
