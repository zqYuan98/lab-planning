/** Stable within one immutable source asset. All indexes are zero based. */
export type DocxRegionId = string
export interface DocxRegionBase {
  id: DocxRegionId
  text: string
  supported: boolean
  reasons: string[]
}
export interface DocxParagraphRegion extends DocxRegionBase { kind: 'paragraph'; paragraphIndex: number }
export interface DocxCellRegion extends DocxRegionBase { kind: 'cell'; tableIndex: number; rowIndex: number; cellIndex: number }
export interface DocxTableRegion extends DocxRegionBase {
  kind: 'table'
  tableIndex: number
  rows: string[][]
  /** Actual tc counts, not logical columns after gridSpan. */
  columnCounts: number[]
  headerRows: number
}
export type DocxRegion = DocxParagraphRegion | DocxCellRegion | DocxTableRegion
export interface DocxInspection {
  sha256: string
  rendererVersion: string
  regions: DocxRegion[]
  warnings: string[]
  fonts: string[]
  partNames: string[]
}
/** Only materialized values cross this boundary; no paths, expressions or business bindings. */
export type DocxEdit =
  | { kind: 'text'; regionId: DocxRegionId; text: string }
  | { kind: 'clear' | 'keep'; regionId: DocxRegionId }
  | { kind: 'rows'; regionId: DocxRegionId; headerRows: number; templateRow: number; startRow: number; endRow: number; rows: string[][] }
// Row endRow is exclusive. An empty rows array removes the selected data rows.
export interface DocxLimits {
  maxBytes: number
  maxExpandedBytes: number
  maxEntries: number
  maxXmlBytes: number
  maxTextChars: number
  maxRows: number
  maxCells: number
}
export interface DocxRenderOptions extends Partial<DocxLimits> { expectedSha256?: string }
