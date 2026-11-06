import type { ImportBatch } from './import-types'
import type { DingTalkMonthlyDiffStatus } from './dingtalk-documents'

export interface DingTalkDocumentStatus {
  configured: boolean
  folderName: string
  folderId: string
  message: string
  currentMonth: string
  timeZone: string
}
export interface DingTalkDocumentCandidate {
  id: string
  documentId: string
  documentTitle: string
  documentUrl: string
  sheetId: string
  sheetName: string
  path: string[]
  modifiedAt?: string
  recommended: boolean
}
export interface DingTalkDocumentDiscovery {
  id: string
  targetMonth: string
  complete: boolean
  warnings: string[]
  candidates: DingTalkDocumentCandidate[]
  recommendedCandidateId?: string
}
export interface DingTalkImportProvenance {
  sourceIdentity: string
  snapshotId: string
  documentId: string
  sheetId: string
  documentTitle: string
  sheetName: string
  documentUrl: string
  targetMonth: string
  contentHash: string
  fetchedAt: string
}
export interface DingTalkRowResolution {
  action: 'new' | 'link' | 'exclude'
  planId?: string
  reason: string
}
export interface DingTalkImportReviewRow {
  previousSourceText?: string
  rowId: string
  sourceRow: number
  title: string
  status: DingTalkMonthlyDiffStatus
  reason: string
  plans: { id: string; title: string; ownerName: string; month: string }[]
  resolution?: DingTalkRowResolution
  requiresResolution: boolean
}
export interface DingTalkBatchReview {
  batchId: string
  batchVersion: number
  source: DingTalkImportProvenance
  rows: DingTalkImportReviewRow[]
  removed: { title: string; planId: string }[]
  counts: Record<DingTalkMonthlyDiffStatus, number>
  warnings: string[]
}
export interface DingTalkResolveResult { batch: ImportBatch; review: DingTalkBatchReview }
