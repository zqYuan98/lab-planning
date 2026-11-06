import type { ImportRow } from './import-types'

/** Connector-normalized data. complete is true only after the whole range was read. */
export interface DingTalkSheetSnapshot {
  connectionId: string
  folderId: string
  documentId: string
  workbookId?: string
  documentTitle: string
  documentUrl: string
  path: string[]
  sheetId: string
  sheetName: string
  targetMonth: string
  range: string
  rows: { rowNumber: number; cells: string[] }[]
  merges: string[]
  /** false means the provider cannot certify whether merged cells exist. */
  mergesKnown?: boolean
  warnings?: string[]
  complete: boolean
  truncated?: boolean
  hasMore?: boolean
  readAt: string
  remoteVersion?: string
}

export interface DingTalkMonthlySourceRule {
  targetMonth: string
  reportMonth: string
  reportTitles: string[]
  sheetNames: string[]
}

export type DingTalkMonthlyColumn = 'number' | 'department' | 'indicatorType' | 'title' | 'content' | 'deliverable' | 'owner' | 'dueDate' | 'notes'
/** Zero-based indices within each normalized row's cells array. */
export type DingTalkMonthlyColumnMap = Record<DingTalkMonthlyColumn, number>

export interface DingTalkMappingIssue {
  sourceRow: number
  field: DingTalkMonthlyColumn | 'month'
  code: 'required' | 'invalid_date' | 'month_conflict' | 'year_inferred'
  message: string
  severity: 'error' | 'confirmation'
}

/** sourceKey/contentHash are fingerprints, never an authoritative permanent row ID. */
export interface DingTalkMappedRow {
  sourceRow: number
  sourceNumber: string
  department: string
  indicatorType: string
  notes: string
  sourceKey: string
  contentHash: string
  issues: DingTalkMappingIssue[]
  candidate: Partial<ImportRow> & Pick<ImportRow, 'kind' | 'sourceSheet' | 'sourceRow' | 'sourceText' | 'title' | 'ownerName' | 'month' | 'dueDate' | 'category' | 'expectedOutcome' | 'acceptanceCriteria'>
}

export interface DingTalkMonthlyMapping {
  rows: DingTalkMappedRow[]
  warnings: string[]
  issues: DingTalkMappingIssue[]
  canImport: boolean
  sourceItemCount: number
  contentHash: string
  headerRow: number
  columnMap: DingTalkMonthlyColumnMap
  excludedRows: { sourceRow: number; reason: 'header' | 'empty' | 'preamble' }[]
}

/** Persist these facts with the created/explicitly linked plan, independently of batches. */
export interface DingTalkImportedItem {
  sourceKey: string
  contentHash: string
  sourceNumber: string
  title: string
  ownerName: string
  planId: string
}

export interface DingTalkExistingPlanReference {
  id: string
  month: string
  title: string
  ownerName?: string
  ownerId?: string
}

export type DingTalkMonthlyDiffStatus = 'new' | 'imported' | 'changed' | 'ambiguous'
export interface DingTalkMonthlyRowDiff {
  sourceRow: number
  sourceKey: string
  status: DingTalkMonthlyDiffStatus
  planIds: string[]
  priorSourceKeys: string[]
  reason: string
}
export interface DingTalkMonthlyDiff {
  rows: DingTalkMonthlyRowDiff[]
  removed: DingTalkImportedItem[]
  counts: Record<DingTalkMonthlyDiffStatus, number>
}
