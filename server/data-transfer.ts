import ExcelJS from 'exceljs'
import type { Entity, MonthlyPlan, User } from '../shared/types.ts'
import type { HistoricalRecord } from './import-service.ts'
import { visibleImportHistory } from './import-service.ts'
import { Domain } from './domain.ts'
import { HttpError, Store } from './store.ts'
import { businessEventCollections, collectionNames, emptyCollections, parsePacket, projectRow, rowReferences, type BusinessCollections, type BusinessDataPacket, type TransferCollection, type TransferType } from './data-transfer-schema.ts'
import { collaborationCollectionNames, emptyCollaborationCollections } from './collaboration-transfer.ts'
import { reportAgentTransferCollections, emptyReportAgentCollections } from './report-agent-transfer.ts'

export type { BusinessDataPacket, BusinessCollections, TransferType } from './data-transfer-schema.ts'
export { previewRestore, restoreBusinessData } from './data-restore.ts'
export interface ExportOptions { type?: TransferType; month?: string; ownerId?: string; projectId?: string }
const exportTypes = ['all', 'plans', 'weeklyRecords', 'projects', 'tasks', 'annualGoals', 'history']

function overlapsMonth(weekStart: string, month: string): boolean {
  const start = new Date(`${weekStart}T00:00:00Z`)
  if (!Number.isFinite(start.getTime())) return false
  start.setUTCDate(start.getUTCDate() + 6)
  return weekStart.slice(0, 7) <= month && start.toISOString().slice(0, 7) >= month
}

/** Dependency records accompany selected rows so a JSON export remains usable for migration. */
export function exportBusinessData(store: Store, actor: User, options: ExportOptions = {}): BusinessDataPacket {
  const type = options.type || 'all'
  if (!exportTypes.includes(type)) throw new HttpError(400, '不支持的数据导出类型')
  if (options.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(options.month)) throw new HttpError(400, '导出月份须为 YYYY-MM')
  for (const filter of [options.ownerId, options.projectId]) if (filter !== undefined && (typeof filter !== 'string' || filter.length > 200)) throw new HttpError(400, '导出筛选条件无效')
  return store.transaction(() => {
    const visible = new Domain(store).bootstrap(actor, false, true)
    const isManager = actor.role === 'manager'
    const complete = type === 'all' && !options.month && !options.ownerId && !options.projectId
    const sources: BusinessCollections = {
      ...emptyCollaborationCollections(),
      ...emptyReportAgentCollections(),
      users: visible.users, projects: visible.projects, annualGoals: visible.annualGoals, plans: visible.plans, tasks: visible.tasks, weeklyRecords: visible.weeklyRecords,
      history: visibleImportHistory(store, actor),
      publications: visible.publications, reports: visible.reports,
      // Authentication, API connections and tokens are deliberately outside a business-data packet.
      events: isManager ? store.list<BusinessCollections['events'][number]>('events').filter(event => Object.hasOwn(businessEventCollections, event.entityType)) : [],
      weeklyRules: isManager ? store.list('weeklyRules') : [],
      weeklyCycles: isManager ? store.list('weeklyCycles') : [],
      weeklyDuties: store.list<BusinessCollections['weeklyDuties'][number]>('weeklyDuties').filter(row => isManager || row.ownerId === actor.id),
      weeklySubmissions: store.list<BusinessCollections['weeklySubmissions'][number]>('weeklySubmissions').filter(row => isManager || row.ownerId === actor.id),
      weeklyMissing: store.list<BusinessCollections['weeklyMissing'][number]>('weeklyMissing').filter(row => isManager || row.ownerId === actor.id),
      weeklyAdjustments: store.list<BusinessCollections['weeklyAdjustments'][number]>('weeklyAdjustments').filter(row => isManager || row.ownerId === actor.id),
      weeklyPlanReviews: store.list<BusinessCollections['weeklyPlanReviews'][number]>('weeklyPlanReviews').filter(row => isManager || row.ownerId === actor.id),
    }
    if (isManager) for (const name of reportAgentTransferCollections) (sources[name] as Entity[]) = store.list<Entity>(name)
    for (const name of collaborationCollectionNames) (sources[name] as Entity[]) = store.list<Entity & { ownerId: string; taskId?: string; parentTaskId?: string }>(name)
      .filter(row => (isManager || row.ownerId === actor.id) && visible.tasks.some(task => task.id === (row.taskId ?? row.parentTaskId)))
    const plans = new Map(visible.plans.map(row => [row.id, row]))
    const matches = (name: TransferCollection, value: Entity) => {
      const row = value as unknown as Record<string, unknown>
      if (name === 'users' || name === 'events') return complete
      if ((reportAgentTransferCollections as readonly string[]).includes(name)) return complete
      if ((collaborationCollectionNames as readonly string[]).includes(name)) {
        const task = visible.tasks.find(task => task.id === (row.taskId ?? row.parentTaskId))
        return !!task && (!options.ownerId || task.ownerId === options.ownerId) && (!options.projectId || plans.get(String(task.monthlyPlanId))?.projectId === options.projectId)
          && (!options.month || task.dueDate.startsWith(options.month) || plans.get(String(task.monthlyPlanId))?.month === options.month)
      }
      if (name === 'weeklyRules' || name === 'weeklyCycles') return complete
      if ((name === 'reports' || name === 'publications') && (options.ownerId || options.projectId)) return false
      if (name === 'history') {
        const record = value as HistoricalRecord
        return (!options.ownerId || record.row.ownerId === options.ownerId) && (!options.projectId || record.row.projectId === options.projectId)
          && (!options.month || record.row.month === options.month || overlapsMonth(record.row.weekStart, options.month))
      }
      if (options.ownerId && row.ownerId !== options.ownerId) return false
      if (options.projectId) {
        const project = name === 'projects' ? row.id : name === 'plans' ? row.projectId : plans.get(String(row.monthlyPlanId))?.projectId
        if (project !== options.projectId) return false
      }
      if (!options.month) return true
      if (name === 'plans' || name === 'publications') return row.month === options.month
      if (name === 'weeklyRecords') return overlapsMonth(String(row.weekStart), options.month)
      if (['weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'weeklyPlanReviews'].includes(name)) return overlapsMonth(String(row.cycleWeek), options.month)
      if (name === 'tasks') return String(row.dueDate).startsWith(options.month) || plans.get(String(row.monthlyPlanId))?.month === options.month
      if (name === 'annualGoals') return row.year === Number(options.month.slice(0, 4))
      if (name === 'reports') return row.type === 'monthly' ? row.period === options.month : overlapsMonth(String(row.period), options.month)
      return type === 'projects'
    }
    const maps = Object.fromEntries(collectionNames.map(name => [name, new Map((sources[name] as Entity[]).map(row => [row.id, row]))])) as Record<TransferCollection, Map<string, Entity>>
    const selected = Object.fromEntries(collectionNames.map(name => [name, new Set<string>()])) as Record<TransferCollection, Set<string>>
    const queue: Array<{ name: TransferCollection; row: Entity }> = []
    const add = (name: TransferCollection, id: string) => {
      const row = maps[name].get(id)
      if (!row || selected[name].has(id)) return
      selected[name].add(id); queue.push({ name, row })
    }
    for (const name of collectionNames) {
      if (type !== 'all' && name !== type) continue
      for (const row of sources[name] as Entity[]) if (matches(name, row)) add(name, row.id)
    }
    for (let index = 0; index < queue.length; index++) {
      const { name, row } = queue[index]
      for (const ref of rowReferences(name, row)) add(ref.collection, ref.id)
      if (name === 'weeklySubmissions') for (const review of sources.weeklyPlanReviews) if (review.submissionId === row.id) add('weeklyPlanReviews', review.id)
      if (name === 'tasks') for (const collection of collaborationCollectionNames) for (const entry of sources[collection] as (Entity & { taskId?: string; parentTaskId?: string })[]) if ((entry.taskId ?? entry.parentTaskId) === row.id) add(collection, entry.id)
      if (name === 'plans' && (row as MonthlyPlan).status === 'published') {
        const plan = row as MonthlyPlan
        for (const publication of sources.publications) if (publication.month === plan.month && publication.revision === plan.publishedVersion) add('publications', publication.id)
      }
      if (isManager && !['users', 'events', 'publications'].includes(name)) {
        for (const event of sources.events) if (businessEventCollections[event.entityType] === name && event.entityId === row.id) add('events', event.id)
      }
    }
    const collections = emptyCollections()
    for (const name of collectionNames) (collections[name] as unknown[]) = (sources[name] as Entity[]).filter(row => selected[name].has(row.id)).map(row => projectRow(name, row))
    return parsePacket({ application: 'lab-planning', formatVersion: reportAgentTransferCollections.some(name => collections[name].length) || collections.reports.some(report => report.agent) ? 4 : collaborationCollectionNames.some(name => collections[name].length) ? 3 : 2, exportedAt: new Date().toISOString(), collections })
  })
}

function cellText(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  // Excel/LibreOffice can interpret these leading characters as formulas, including after whitespace.
  return /^[\s]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text
}
function csvRows(packet: BusinessDataPacket, type: TransferType): Record<string, unknown>[] {
  if (type === 'all') return collectionNames.flatMap(name => (packet.collections[name] as Entity[]).map(row => ({ collection: name, ...readableRow(name, row) })))
  return packet.collections[type] as unknown as Record<string, unknown>[]
}
function readableRow(name: TransferCollection, row: unknown): Record<string, unknown> {
  const value = row as Record<string, unknown>
  if (name !== 'reportAssets') return value
  const { contentBase64: _bytes, inspection: _inspection, ...metadata } = value
  return metadata
}

export function exportCsv(input: BusinessDataPacket, type: TransferType = 'all'): string {
  const packet = parsePacket(input)
  if (!exportTypes.includes(type)) throw new HttpError(400, '不支持的 CSV 导出类型')
  const rows = csvRows(packet, type)
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))]
  if (!headers.length) headers.push('id')
  const quote = (value: unknown) => `"${cellText(value).replace(/"/g, '""')}"`
  return '\uFEFF' + [headers.map(quote).join(','), ...rows.map(row => headers.map(header => quote(row[header])).join(','))].join('\r\n') + '\r\n'
}

export async function exportXlsx(input: BusinessDataPacket): Promise<Buffer> {
  const packet = parsePacket(input)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'lab-planning'
  workbook.created = new Date(packet.exportedAt)
  const meta = workbook.addWorksheet('导出说明')
  meta.addRows([
    ['应用', packet.application], ['数据格式版本', packet.formatVersion], ['导出时间', packet.exportedAt],
    ['恢复说明', '跨系统完整恢复请使用 JSON 迁移包；Excel 用于阅读、筛选和整理。'],
    ['关联资料', '各表包含必要关联记录。周报 Word 文件在 JSON 包中保留原件，Excel 仅列文件信息；其他导入原始附件及账号密码不在业务导出范围内。'],
    ['长字段', '超过 Excel 单元格限制的内容按 __part2、__part3 等列拆分，按列顺序拼接即可还原文字。'],
  ])
  meta.columns = [{ width: 22 }, { width: 100 }]
  for (const name of collectionNames) {
    const values = (packet.collections[name] as unknown[]).map(row => readableRow(name, row))
    if (!values.length) continue
    const sheet = workbook.addWorksheet(name)
    const expanded = values.map(row => Object.fromEntries(Object.entries(row).flatMap(([key, value]): Array<[string, string | number | boolean]> => {
      if (typeof value === 'number' || typeof value === 'boolean') return [[key, value]]
      const text = cellText(value)
      const pieces: Array<[string, string]> = []
      let start = 0
      do {
        let end = Math.min(start + 32000, text.length)
        // Do not split UTF-16 surrogate pairs between cells, which would damage emoji on serialization.
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
        pieces.push([pieces.length ? `${key}__part${pieces.length + 1}` : key, text.slice(start, end)])
        start = end
      } while (start < text.length)
      return pieces
    })))
    const headers = [...new Set(expanded.flatMap(row => Object.keys(row)))]
    if (headers.length > 16000) throw new HttpError(400, '字段数量超过 Excel 限制，请使用 JSON 导出')
    sheet.columns = headers.map(key => ({ header: key, key, width: ['id', 'ownerId', 'actorId', 'sourceId'].includes(key) ? 28 : 36 }))
    sheet.addRows(expanded)
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: values.length + 1, column: headers.length } }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245E55' } }
    sheet.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; row.height = 32 })
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
