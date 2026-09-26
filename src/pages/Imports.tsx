import { LIMITS } from '../../shared/entity-rules'
import { useEffect, useRef, useState } from 'react'
import WorkflowGuide from '../components/WorkflowGuide'
import AnnualGoalPicker from '../components/AnnualGoalPicker'
import ImportDeleteDialog, { type ImportDeleteTarget } from '../components/ImportDeleteDialog'
import ImportSourceReview from '../components/ImportSourceReview'
import { canRequestImportReview, importAnalysisRequest, importReconciliationText, importReviewCounts, importReviewRequired, importRowDisposition, importRowOutcomeLabel, importWorkFields, newImportCandidate, restoredImportOptions, selectImportTask, type ImportWorkFields } from '../import-review'
import {
  Archive,
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  FileInput,
  FileText,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import type {
  AiSettingsView,
  ImportBatch,
  ImportBatchSummary,
  ImportKind,
  ImportRow,
  IntegrationTokenView,
} from '../../shared/import-types'
import { canUseAccount } from '../../shared/auth-policy'
import { accountDisplayName } from '../account-options'
import {
  importedMonthlyResult,
  importedWeeklyStatus,
} from '../../shared/import-status'
import type { Navigate } from '../navigation'
import { api, json, finishSaved, SavedResultError } from '../api'
import { combineImportReferences, emptyImportReferences, ImportCandidateLookup, useImportReferences } from '../import-workspace'
import type { ImportCandidateKind, ImportReferences } from '../../shared/import-workspace'
import {
  filesFromTransfer,
  hasTransferredFiles,
  importFileError,
  importFileName,
} from '../import-input'
import {
  Badge,
  Empty,
  Field,
  Form,
  Modal,
  PageHeader,
  dateTime,
  type PageProps,
} from '../ui'
import '../imports.css'

const batchLabels = {
  uploaded: '待解析',
  parsed: '待校对',
  committed: '已保存',
}
const modes = [
  {
    id: 'existing',
    label: '导入已有计划',
    description: '确认后直接生效，保留原有成果和状态',
  },
  {
    id: 'draft',
    label: '生成新计划草稿',
    description: '用于新提报，按现有流程继续完善',
  },
  {
    id: 'history',
    label: '仅存历史资料',
    description: '保留原貌，供检索与导出',
  },
] as const
const monthlyResultLabels = {
  pending: '尚无成果记录',
  submitted: '成果已记录，验收待确认',
  accepted: '已验收（管理员确认）',
  not_completed: '未完成',
}
const weeklyResultLabels = {
  planned: '未开始 / 原状态未明确',
  doing: '进行中',
  blocked: '受阻',
  done: '已完成',
  not_done: '未完成',
}
function savedBatchLabel(mode: ImportBatch['mode']) {
  return mode === 'existing'
    ? '已有计划已导入生效'
    : mode === 'draft'
      ? '新计划草稿已生成'
      : '历史资料已保存'
}
function savedBatchCounts(batch: ImportBatch) {
  return `${importReconciliationText(batch.rows)}；本次新增 ${batch.committedCount || 0} 项${batch.mode === 'existing' ? `、原草稿转生效 ${batch.activatedCount || 0} 项` : ''}、已有记录 ${batch.skippedCount || 0} 项`
}
function optionalSourceGaps(row: ImportRow) {
  return [
    !row.dueDate && '截止日期',
    !row.expectedOutcome && (row.kind === 'monthly' ? '预期成果' : '本周承诺'),
    row.kind === 'monthly' && !row.acceptanceCriteria && '验收标准',
  ]
    .filter(Boolean)
    .join('、')
}
const scopes = [
  ['imports:read', '查看导入批次'],
  ['imports:write', '上传、解析和校对'],
  ['imports:commit', '确认写入'],
  ['data:read', '导出业务数据'],
] as const
type Bulk = {
  ownerId: string
  projectId: string
  category: string
  monthlyPlanId: string
  kind: '' | ImportKind
  nature: '' | 'regular' | 'temporary'
  month: string
  weekStart: string
  temporaryReason: string
}
interface HistoricalRecord {
  id: string
  version: number
  createdAt: string
  updatedAt: string
  importedBy: string
  batchId: string
  sourceId: string
  row: ImportRow
}
interface RestorePreview {
  canRestore: boolean
  fingerprint: string
  counts: Record<string, { total: number; insert: number; skip: number; replace: number }>
  issues: string[]
  notices: string[]
  missingUsers: { id: string; name: string; email: string; reason: string }[]
  mapping: Record<string, string>
}
const collectionLabels: Record<string, string> = {
  users: '账号匹配',
  projects: '项目档案',
  annualGoals: '年度目标',
  plans: '月度目标',
  tasks: '个人任务',
  weeklyRecords: '每周执行',
  history: '历史资料',
  publications: '发布快照',
  reports: '报告',
  reportAssets: '周报 / 月报 Word 文件与范例',
  reportTemplates: '周报 / 月报模板与确认规则',
  events: '变更记录',
  weeklyRules: '周提报规则',
  weeklyCycles: '周提报名单',
  weeklyDuties: '个人应交项',
  weeklySubmissions: '周提报收据',
  weeklyMissing: '截止缺交记录',
  weeklyAdjustments: '豁免与更正记录',
}
const emptyBulk: Bulk = {
  ownerId: '',
  projectId: '',
  category: '',
  monthlyPlanId: '',
  kind: '',
  nature: '',
  month: '',
  weekStart: '',
  temporaryReason: '',
}

async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('无法读取文件，请重新选择。'))
    reader.readAsDataURL(file)
  })
}

export default function Imports({
  data: shell,
  refresh: refreshShell,
  notify,
  navigate,
}: PageProps & { navigate?: Navigate }) {
  const manager = shell.user.role === 'manager'
  const [batches, setBatches] = useState<ImportBatchSummary[]>([])
  const [pendingOnly, setPendingOnly] = useState(false)
  const [batch, setBatch] = useState<ImportBatch | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [pasted, setPasted] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [uploadResults, setUploadResults] = useState<
    { name: string; status: 'waiting' | 'uploading' | 'saved' | 'failed'; error?: string }[]
  >([])
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [parseKind, setParseKind] = useState<ImportKind>('monthly')
  const [period, setPeriod] = useState('')
  const [instruction, setInstruction] = useState('')
  const [editing, setEditing] = useState<ImportRow | null>(null)
  const detachedWorkSource = useRef<{ rowId: string; fields: ImportWorkFields } | null>(null)
  const [exclusion, setExclusion] = useState<{ ids: string[]; reason: string; kind: 'task' | 'duplicate' | 'not_task' } | null>(null)
  const [editingHistory, setEditingHistory] = useState<HistoricalRecord | null>(
    null,
  )
  const [correctionReason, setCorrectionReason] = useState('')
  const [bulk, setBulk] = useState<Bulk>(emptyBulk)
  const [ai, setAi] = useState<AiSettingsView | null>(null)
  const [configured, setConfigured] = useState(false)
  const [tokens, setTokens] = useState<IntegrationTokenView[]>([])
  const [newToken, setNewToken] = useState('')
  const [tokenName, setTokenName] = useState('')
  const [tokenScopes, setTokenScopes] = useState<string[]>([
    'imports:read',
    'imports:write',
  ])
  const [exportType, setExportType] = useState('all')
  const [exportFormat, setExportFormat] = useState('xlsx')
  const [history, setHistory] = useState<HistoricalRecord[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyLimit, setHistoryLimit] = useState(50)
  const [historyRecord, setHistoryRecord] = useState<HistoricalRecord | null>(
    null,
  )
  const [deleteTarget, setDeleteTarget] = useState<ImportDeleteTarget | null>(null)
  const [restorePacket, setRestorePacket] = useState<unknown>(null)
  const [restoreFileName, setRestoreFileName] = useState('')
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(
    null,
  )
  const [restoreMapping, setRestoreMapping] = useState<Record<string, string>>(
    {},
  )
  const [restoreCandidates, setRestoreCandidates] = useState<
    RestorePreview['missingUsers']
  >([])
  const [restoreResult, setRestoreResult] = useState<{
    restored: number
    skipped: number
  } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const pasteInput = useRef<HTMLTextAreaElement>(null)
  const dragDepth = useRef(0)
  const lock = useRef(false)
  const activeBatchId = useRef<string | null>(null)
  const interactionCount = useRef(0)
  const scope = `${shell.user.id}:${shell.user.role}:${shell.operationEpoch}:${shell.accessScopeVersion}`
  const [candidatePages, setCandidatePages] = useState<Partial<Record<ImportCandidateKind, ImportReferences>>>({})
  const [savedRead, setSavedRead] = useState<SavedResultError | null>(null)
  const currentRows = [...(batch?.rows || []), ...(editing ? [editing] : []), ...(historyRecord ? [historyRecord.row] : []), ...(editingHistory ? [editingHistory.row] : []), ...history.filter(item => `${item.row.title} ${item.row.ownerName} ${item.row.projectName} ${item.row.month} ${item.row.weekStart} ${item.row.category} ${item.row.sourceText} ${item.row.isTemporary ? '临时交办' : ''} ${item.row.temporaryReason || ''}`.toLowerCase().includes(historyQuery.trim().toLowerCase())).slice(0, historyLimit).map(item => item.row)]
  const uniqueIds = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))].sort()
  const references = useImportReferences({
    users: uniqueIds([shell.user.id, ...batches.map(item => item.ownerId), bulk.ownerId, ...Object.values(restoreMapping), ...Object.values(restorePreview?.mapping || {}), ...currentRows.flatMap(row => [row.ownerId, ...(row.collaboratorIds || [])])]),
    projects: uniqueIds([bulk.projectId, ...currentRows.map(row => row.projectId)]),
    plans: uniqueIds([bulk.monthlyPlanId, ...currentRows.map(row => row.monthlyPlanId)]),
    tasks: uniqueIds(currentRows.map(row => row.taskId)),
  }, scope)
  const data = { ...shell, ...combineImportReferences(emptyImportReferences(), ...Object.values(candidatePages), references.value) }
  const acceptCandidates = (kind: ImportCandidateKind, value: ImportReferences) => setCandidatePages(previous => ({ ...previous, [kind]: value }))
  const candidateLookups = (kinds: ImportCandidateKind[]) => <details className="form-hint"><summary>搜索更多成员、项目或关联事项</summary>{kinds.map(kind => <ImportCandidateLookup key={kind} kind={kind} scope={scope} ownerId={kind === 'tasks' ? editing?.ownerId : ''} onItems={acceptCandidates} />)}</details>
  const refresh = async () => { await references.reload(); await refreshShell() }
  const activeUsers = data.users.filter(
    (user) =>
      canUseAccount(user) &&
      (manager || user.id === data.user.id),
  )
  const activeProjects = data.projects.filter(
    (project) => project.status === 'active',
  )
  const availablePlans = data.plans.filter((plan) => plan.status !== 'merged' && plan.visibility !== 'historical' && plan.visibility !== 'reference' && (manager || !plan.projectId || !data.projects.some(project => project.id === plan.projectId && project.status !== 'active')))
  const selected = batch?.rows.filter((row) => row.selected) || []
  const selectedIssues = selected.filter((row) => row.issues.length)
  const reviewCounts = importReviewCounts(batch?.rows || [])
  const immutable = batch?.status === 'committed'
  const readOnlyEditor = immutable && !editingHistory
  const editingNew = !!editing?.id.startsWith('new:') && !editingHistory
  const editingTaskLocked = !editingHistory && !readOnlyEditor && !!editing?.taskId
  const editingTask =
    editing?.kind === 'weekly' && editingTaskLocked
      ? data.tasks.find((task) => task.id === editing.taskId)
      : undefined
  const editingTemporary = editingTask?.isTemporary ?? !!editing?.isTemporary
  const parsing = batch?.analysis?.status === 'running'
  const batchBusy = !!busy || parsing
  const visibleBatches = pendingOnly
    ? batches.filter(
        (item) => item.reviewRequestedAt && item.status !== 'committed',
      )
    : batches
  const pendingCount = batches.filter(
    (item) => item.reviewRequestedAt && item.status !== 'committed',
  ).length
  const visibleHistory = history.filter((item) => {
    const row = item.row
    return `${row.title} ${row.ownerName} ${row.projectName} ${row.month} ${row.weekStart} ${row.category} ${row.sourceText} ${row.isTemporary ? '临时交办' : ''} ${row.temporaryReason || ''}`
      .toLowerCase()
      .includes(historyQuery.trim().toLowerCase())
  })

  function acceptBatch(next: ImportBatch, resetSheets = false) {
    activeBatchId.current = next.id
    setBatch(next)
    try {
      localStorage.setItem(`lab-import-batch:${data.user.id}`, next.id)
    } catch {
      /* Batch remains saved on the server. */
    }
    setBatches((previous) => [
      { ...next, rowCount: next.rows.length },
      ...previous.filter((item) => item.id !== next.id),
    ])
    if (resetSheets) {
      const options = restoredImportOptions(next)
      setSheetNames(options.sheetNames)
      setInstruction(options.instruction)
      setParseKind(options.kind)
      setPeriod(options.period)
      setBulk(emptyBulk)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const results = await Promise.allSettled([
        api<ImportBatchSummary[]>('/imports'),
        manager
          ? api<AiSettingsView>('/ai/settings')
          : api<{ configured: boolean }>('/ai/status'),
        manager
          ? api<IntegrationTokenView[]>('/integration-tokens')
          : Promise.resolve([] as IntegrationTokenView[]),
      ])
      if (cancelled) return
      if (results[0].status === 'fulfilled') {
        const loadedBatches = results[0].value
        setBatches((previous) =>
          interactionCount.current
            ? [
                ...previous,
                ...loadedBatches.filter(
                  (item) =>
                    !previous.some((existing) => existing.id === item.id),
                ),
              ]
            : loadedBatches,
        )
        let remembered = ''
        try {
          remembered =
            localStorage.getItem(`lab-import-batch:${data.user.id}`) || ''
        } catch {
          /* Storage may be unavailable. */
        }
        const previous =
          results[0].value.find((item) => item.id === remembered) ||
          results[0].value.find((item) => item.analysis?.status === 'running')
        if (previous) {
          try {
            const restored = await api<ImportBatch>(`/imports/${previous.id}`)
            if (!cancelled && !interactionCount.current)
              acceptBatch(restored, true)
          } catch (cause) {
            if (!cancelled)
              setError(cause instanceof Error ? cause.message : '批次读取失败')
          }
        }
      }
      if (cancelled) return
      if (results[1].status === 'fulfilled') {
        setConfigured(results[1].value.configured)
        if (manager) setAi(results[1].value as AiSettingsView)
      }
      if (results[2].status === 'fulfilled') setTokens(results[2].value)
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected')
        setError(
          failed.reason instanceof Error
            ? failed.reason.message
            : '数据读取失败',
        )
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [manager])

  useEffect(() => {
    if (!batch || batch.analysis?.status !== 'running') return
    const id = batch.id
    setPollError('')
    let cancelled = false
    let timer: number
    async function poll() {
      try {
        const next = await api<ImportBatch>(`/imports/${id}`)
        if (cancelled || activeBatchId.current !== id) return
        setPollError('')
        acceptBatch(next)
        if (next.analysis?.status === 'completed')
          notify(`解析完成，生成 ${next.rows.length} 项候选。请对照原始资料核对是否收全。`)
        if (next.analysis?.status !== 'running') return
      } catch (cause) {
        if (cancelled) return
        setPollError(
          cause instanceof Error
            ? cause.message
            : '读取解析进度失败，将自动重试。',
        )
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2000)
    }
    timer = window.setTimeout(() => void poll(), 2000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [batch?.id, batch?.analysis?.status])

  async function run(label: string, action: () => Promise<void>) {
    if (lock.current) return
    interactionCount.current++
    lock.current = true
    setBusy(label)
    setError('')
    try {
      await action()
    } catch (cause) {
      if (cause instanceof SavedResultError) setSavedRead(cause)
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
    } finally {
      lock.current = false
      setBusy('')
    }
  }

  async function saveRows(rows: ImportRow[], mode = batch!.mode) {
    if (!batch) return
    if (batch.analysis?.status === 'running')
      throw new Error('当前批次正在解析，请等待完成后校对。')
    const saved = await api<ImportBatch>(
      `/imports/${batch.id}`,
      json({ version: batch.version, rows, mode }, 'PATCH'),
    )
    acceptBatch(saved)
  }

  async function saveCompletionReview(sourceItemCount: number) {
    if (!batch) return
    await run('正在保存完整性核对', async () => {
      acceptBatch(await api<ImportBatch>(`/imports/${batch.id}`, json({
        version: batch.version, mode: batch.mode, rows: batch.rows,
        completionReview: { confirmed: true, sourceItemCount },
      }, 'PATCH')))
      notify('完整性核对已记录，可以确认保存。')
    })
  }

  function selectRows(ids: string[], checked: boolean) {
    if (!batch) return
    if (!checked) {
      const row = ids.length === 1 ? batch.rows.find(row => row.id === ids[0]) : undefined
      setExclusion({ ids, reason: row?.exclusionReason || '', kind: row?.exclusionKind || 'task' })
      return
    }
    void run('正在保存选择', () => saveRows(batch.rows.map(row => ids.includes(row.id)
      ? { ...row, selected: true, exclusionReason: '', exclusionKind: 'task' } : row)))
  }

  async function parseSource(resumeFailed = false) {
    if (!batch) return
    const options = resumeFailed ? restoredImportOptions(batch) : { sheetNames, instruction, period, kind: parseKind }
    await run(resumeFailed ? '正在续跑上次解析' : '正在启动智能识别', async () => {
      const next = await api<ImportBatch>(`/imports/${batch.id}/analyze`, json(importAnalysisRequest(batch, options, resumeFailed)))
      acceptBatch(next)
      if (resumeFailed) {
        setSheetNames(options.sheetNames); setInstruction(options.instruction)
        setPeriod(options.period); setParseKind(options.kind)
      }
      notify(next.analysis?.status === 'running'
        ? '后台识别已开始，可以离开页面后继续查看。'
        : '识别完成，请对照原始资料核对是否收全。')
    })
  }

  async function upload(files: File[], transferIssues: string[] = []) {
    if (lock.current) {
      setError('当前操作尚未完成，请稍后重新拖入、粘贴或选择文件。')
      return
    }
    if (!files.length) {
      if (transferIssues.length) setError(transferIssues.join(' '))
      return
    }
    await run('正在保存原始文件', async () => {
      setUploadResults(files.map((file) => ({ name: importFileName(file), status: 'waiting' })))
      let saved = 0
      const failures = [...transferIssues]
      for (const [index, file] of files.entries()) {
        const name = importFileName(file)
        const updateResult = (status: 'uploading' | 'saved' | 'failed', error?: string) =>
          setUploadResults((previous) => previous.map((result, resultIndex) =>
            resultIndex === index ? { name, status, error } : result,
          ))
        setBusy(`正在保存原始文件 ${index + 1}/${files.length}：${name}`)
        try {
          const validationError = importFileError(file)
          if (validationError) throw new Error(validationError)
          updateResult('uploading')
          const next = await api<ImportBatch>(
            '/imports',
            json({
              fileName: name,
              mode: 'existing',
              mimeType: file.type,
              base64: await fileBase64(file),
            }),
          )
          acceptBatch(next, true)
          saved++
          updateResult('saved')
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : '保存失败，请重新上传。'
          failures.push(`${name}：${message}`)
          updateResult('failed', message)
        }
      }
      if (saved)
        notify(`已保存 ${saved} 个文件，每个文件对应一个导入批次，请逐一解析和校对。`)
      if (failures.length)
        setError(`有 ${failures.length} 项未保存。${transferIssues.join(' ')}${files.length ? '请查看文件处理结果后重试。' : ''}`)
    })
  }

  async function loadHistory() {
    setHistory(await api<HistoricalRecord[]>('/imports/history'))
    setHistoryLoaded(true)
  }

  async function previewPacket(
    packet: unknown,
    mapping: Record<string, string>,
    fresh = false,
  ) {
    const preview = await api<RestorePreview>(
      '/data/restore/preview',
      json({ packet, mapping }),
    )
    setRestorePreview(preview)
    setRestoreCandidates((previous) =>
      fresh
        ? preview.missingUsers
        : [
            ...previous,
            ...preview.missingUsers.filter(
              (user) => !previous.some((item) => item.id === user.id),
            ),
          ],
    )
  }

  function closeEditor() {
    setEditing(null)
    detachedWorkSource.current = null
    setEditingHistory(null)
    setCorrectionReason('')
  }
  function correctHistory(record: HistoricalRecord) {
    setEditingHistory(record)
    setEditing({ ...record.row })
    setHistoryRecord(null)
    setCorrectionReason('')
  }
  function openImportedResult(row: ImportRow) {
    if (!navigate || !row.result) return
    if (row.result.collection === 'plans')
      navigate('monthly', { id: row.result.id, month: row.month })
    if (row.result.collection === 'weeklyRecords')
      navigate('weekly', { id: row.result.id, weekStart: row.weekStart })
  }

  function requestHistoryDelete(record: HistoricalRecord) {
    setHistoryRecord(null)
    setDeleteTarget({ kind: 'history', id: record.id, version: record.version, title: record.row.title || '未命名工作记录' })
  }

  function finishDelete(target: ImportDeleteTarget, deletedHistoryCount: number) {
    if (target.kind === 'batch') {
      setBatches((previous) => previous.filter((item) => item.id !== target.id))
      setHistory((previous) => previous.filter((item) => item.batchId !== target.id))
      if (activeBatchId.current === target.id) {
        activeBatchId.current = null
        setBatch(null)
        setPollError('')
        setSheetNames([])
        setBulk(emptyBulk)
        closeEditor()
      }
      try {
        const key = `lab-import-batch:${data.user.id}`
        if (localStorage.getItem(key) === target.id) localStorage.removeItem(key)
      } catch { /* The server deletion has already succeeded. */ }
      notify(`导入批次已删除${deletedHistoryCount ? `，同时删除 ${deletedHistoryCount} 条历史资料` : ''}。已生成的计划和报告保留。`)
    } else {
      setHistory((previous) => previous.filter((item) => item.id !== target.id))
      notify('历史资料已删除，来源批次及其他记录保留。')
    }
    setError('')
    setDeleteTarget(null)
  }

  return (
    <div
      className="imports-page"
      onDragEnter={(event) => {
        if (!hasTransferredFiles(event.dataTransfer)) return
        event.preventDefault()
        dragDepth.current++
        setDraggingFiles(true)
      }}
      onDragOver={(event) => {
        if (!hasTransferredFiles(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
      }}
      onDragLeave={(event) => {
        if (!hasTransferredFiles(event.dataTransfer)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDraggingFiles(false)
      }}
      onDrop={(event) => {
        if (!hasTransferredFiles(event.dataTransfer)) return
        event.preventDefault()
        dragDepth.current = 0
        setDraggingFiles(false)
        const { files, issues } = filesFromTransfer(event.dataTransfer)
        void upload(files, issues)
      }}
    >
      {references.error && <div role="alert">{references.error}<button className="button secondary" onClick={() => void references.reload().catch(() => {})}>重读关联信息</button></div>}
      {savedRead && <div role="status">{savedRead.message}<button className="button secondary" disabled={!!busy} onClick={() => void run('正在重读保存结果', async () => { await savedRead.retry(); setSavedRead(null) })}>只重试读取</button></div>}
      <PageHeader
        title="数据导入"
        description="把已有表格、文字和截图变成可校对的数据，支持管理导入批次与历史资料。"
        actions={
          <Badge tone={configured ? 'green' : 'neutral'}>
            {configured ? 'AI 解析已配置' : 'AI 解析待配置'}
          </Badge>
        }
      />
      <WorkflowGuide title="资料导入流程说明">
        <div className="import-journey" aria-label="导入流程">
          {['保存原始资料', '智能识别字段', '校对与批量匹配', '导入已有计划'].map(
            (label, index) => (
              <div key={label}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                {label}
                {index < 3 && <ArrowRight size={15} />}
              </div>
            ),
          )}
        </div>
        </WorkflowGuide>
      {error && (
        <div className="error import-error" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <div className="import-progress" role="status">
          <LoaderCircle size={16} className="spin" />
          {busy}…
        </div>
      )}
      <section
        className={`import-upload panel${draggingFiles ? ' is-dragging' : ''}`}
        tabIndex={0}
        aria-label="文件拖放与粘贴导入区域"
        aria-describedby="import-upload-help"
        aria-busy={!!busy}
        onPaste={(event) => {
          if (!hasTransferredFiles(event.clipboardData)) return
          event.preventDefault()
          const { files, issues } = filesFromTransfer(event.clipboardData)
          void upload(files, issues)
        }}
      >
        <div className="import-upload-copy">
          <span className="import-upload-icon">
            <FileInput size={28} strokeWidth={1.6} />
          </span>
          <div>
            <h2>从现有资料开始</h2>
            <p id="import-upload-help">将文件或图片拖到此页，或点击此区域后按 Ctrl / ⌘ + V 粘贴截图。</p>
            <small>
              支持 XLSX、CSV、TSV、TXT、PNG、JPG、WebP。钉钉表格可先导出为
              Excel。支持多文件，每个文件单独建立批次，单个文件最大 10 MB。
            </small>
          </div>
        </div>
        <div className="import-upload-actions">
          <input
            ref={fileInput}
            className="import-file-input"
            type="file"
            multiple
            accept=".xlsx,.csv,.tsv,.txt,.png,.jpg,.jpeg,.webp"
            aria-label="选择导入文件"
            disabled={!!busy}
            onChange={(event) => {
              const files = Array.from(event.target.files || [])
              event.target.value = ''
              if (files.length) void upload(files)
            }}
          />
          <button
            className="button primary"
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={16} />
            上传文件
          </button>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => {
              setShowPaste((value) => !value)
              if (!showPaste) window.setTimeout(() => pasteInput.current?.focus(), 0)
            }}
          >
            <FileText size={16} />
            粘贴内容
          </button>
        </div>
        {draggingFiles && (
          <div className="import-drop-status" role="status">
            <Upload size={18} />
            {busy ? '当前操作进行中，请稍后重新拖入文件' : '松开即可保存文件或图片，支持一次拖入多个文件'}
          </div>
        )}
        {uploadResults.length > 0 && (
          <ul className="import-upload-results" aria-label="文件处理结果" aria-live="polite">
            {uploadResults.map((result, index) => (
              <li key={index} className={result.status === 'failed' ? 'has-error' : ''}>
                <span>{result.name}</span>
                <small>
                  {result.status === 'waiting' ? '等待保存' : result.status === 'uploading' ? '正在保存…' : result.status === 'saved' ? '已保存为导入批次' : result.error}
                </small>
              </li>
            ))}
          </ul>
        )}
        {showPaste && (
          <div className="import-paste">
            <Field label="粘贴表格或工作记录">
              <textarea
                ref={pasteInput}
                rows={6}
                disabled={!!busy}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                placeholder="直接粘贴 Excel 单元格、钉钉工作记录或旧计划文字；粘贴截图或文件会直接保存为导入批次…"
              />
            </Field>
            <button
              className="button primary"
              disabled={!!busy || !pasted.trim()}
              onClick={() =>
                void run('正在保存文字资料', async () => {
                  const next = await api<ImportBatch>(
                    '/imports',
                    json({
                      fileName: '粘贴内容.txt',
                      text: pasted,
                      mode: 'existing',
                    }),
                  )
                  acceptBatch(next, true)
                  setPasted('')
                  setShowPaste(false)
                  notify('文字资料已保存')
                })
              }
            >
              保存并准备解析
            </button>
          </div>
        )}
      </section>
      <div className="import-workspace">
        <aside className="import-batches panel" aria-label="已保存导入批次">
          <div className="import-section-title">
            <h2>
              导入批次 <span>{batches.length}</span>
            </h2>
            <button
              className="icon-button"
              aria-label="刷新导入批次"
              disabled={!!busy}
              onClick={() =>
                void run('正在读取导入批次', async () => {
                  setBatches(await api<ImportBatchSummary[]>('/imports'))
                  if (batch)
                    acceptBatch(await api<ImportBatch>(`/imports/${batch.id}`))
                })
              }
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <p className="import-aside-note">
            已上传资料会保留，随时回来继续校对。
          </p>
          {manager && (
            <label className="import-pending-filter">
              <input
                type="checkbox"
                checked={pendingOnly}
                onChange={(event) => setPendingOnly(event.target.checked)}
              />
              待确认的已有计划 <span>{pendingCount}</span>
            </label>
          )}
          {loading ? (
            <p className="import-muted">正在读取…</p>
          ) : visibleBatches.length ? (
            <div className="import-batch-list">
              {visibleBatches.map((item) => (
                <button
                  key={item.id}
                  className={`import-batch-item ${item.id === batch?.id ? 'active' : ''}`}
                  disabled={!!busy}
                  onClick={() =>
                    void run('正在打开导入批次', async () =>
                      acceptBatch(
                        await api<ImportBatch>(`/imports/${item.id}`),
                        true,
                      ),
                    )
                  }
                >
                  <strong>{item.fileName}</strong>
                  <span>
                    {item.analysis?.status === 'running'
                      ? '正在解析'
                      : item.reviewRequestedAt && item.status !== 'committed'
                        ? '待管理员确认'
                        : batchLabels[item.status]}{' '}
                    · 候选 {item.rowCount} 项{item.excludedCount ? ` · ${item.excludedCount} 项未导入` : ''}
                  </span>
                  <small>{dateTime(item.createdAt)}</small>
                  {manager && (
                    <small>
                      整理：
                      {accountDisplayName(data.users.find((user) => user.id === item.ownerId), '原账号')}
                    </small>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="import-muted">
              {pendingOnly ? '暂无待确认的已有计划' : '还没有导入资料'}
            </p>
          )}
        </aside>
        <section className="import-detail panel">
          {!batch ? (
            <Empty
              title="资料先保存，再按需整理"
              description="上传文件，或从左侧打开已保存批次。已有计划确认后可直接生效，原表未注明的非必要字段保留为空。"
            />
          ) : (
            <>
              <div className="import-detail-heading">
                <div>
                  <div className="import-detail-label">
                    {batch.kind === 'image'
                      ? '图片资料'
                      : batch.kind === 'table'
                        ? '表格资料'
                        : '文字资料'}{' '}
                    ·{' '}
                    {batch.reviewRequestedAt && !immutable
                      ? '待管理员确认'
                      : batchLabels[batch.status]}
                  </div>
                  <h2>{batch.fileName}</h2>
                  <p>{dateTime(batch.updatedAt)} 更新</p>
                </div>
                <div className="import-detail-actions">
                  <a className="button secondary" href={`/api/imports/${batch.id}/source`}>
                    <Download size={15} />
                    原始文件
                  </a>
                  {(manager || batch.ownerId === data.user.id) && (
                    <button
                      className="button secondary import-delete-button"
                      disabled={batchBusy || loading}
                      title={parsing ? '解析完成后可删除此批次' : '删除导入批次及其归档历史资料'}
                      onClick={() => setDeleteTarget({ kind: 'batch', id: batch.id, version: batch.version, title: batch.fileName })}
                    >
                      <Trash2 size={15} />
                      删除批次
                    </button>
                  )}
                </div>
              </div>
              {!!batch.warnings.length && (
                <div className="import-notice">
                  {batch.warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                </div>
              )}
              {batch.reviewRequestedAt && !immutable && (
                <div className="import-confirmation-note">
                  <strong>
                    {manager
                      ? '成员提交了导入资料，请核对完整性及待补项'
                      : '已交管理员核对'}
                  </strong>
                  <p>
                    {dateTime(batch.reviewRequestedAt)} ·
                    确认后直接进入月度目标或每周执行，无需再次提报。继续修改校对内容会取消本次确认申请，保存后可重新交给管理员。
                  </p>
                </div>
              )}
              {parsing && (
                <div className="import-analysis" role="status">
                  <LoaderCircle size={18} className="spin" />
                  <div>
                    <strong>正在分段解析资料</strong>
                    <p>
                      已完成 {batch.analysis?.completedChunks || 0} /{' '}
                      {batch.analysis?.totalChunks || 0}{' '}
                      段。大表格可能需要几分钟，进度会自动保存，可以稍后回来继续。
                    </p>
                    {pollError && (
                      <p role="alert">{pollError}，正在重新读取进度。</p>
                    )}
                  </div>
                </div>
              )}
              {batch.analysis?.status === 'failed' && (
                <div className="import-notice" role="alert">
                  <strong>解析未完成</strong>
                  <p>
                    {batch.analysis.error || '服务暂时未完成解析，请重试。'}
                  </p>
                  <small>
                    {batch.analysis.completedChunks > 0
                      ? '已完成的分段结果保留；“继续上次解析”沿用保存的选项及分段，“重新识别”会重新调用 AI。'
                      : '原始资料已保留，修正问题后可直接重试，无需重新上传。'}
                  </small>
                </div>
              )}
              {immutable && (
                <div className="import-fork">
                  <div>
                    <strong>同一个文件，继续整理</strong>
                    <p>
                      可继续解析其他工作表或重新整理。原始文件直接复用，已保存的数据会按来源去重。
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    disabled={batchBusy}
                    onClick={() =>
                      void run('正在新建整理批次', async () => {
                        acceptBatch(
                          await api<ImportBatch>(
                            `/imports/${batch.id}/fork`,
                            json({}),
                          ),
                          true,
                        )
                        notify('已复用原始文件，请选择要继续处理的内容。')
                      })
                    }
                  >
                    <FileInput size={16} />
                    继续处理此文件
                  </button>
                </div>
              )}
              {!immutable && (
                <details
                  className="import-parser"
                  open={batch.status === 'uploaded'}
                >
                  <summary>
                    <span>
                      <Sparkles size={16} />
                      {batch.rows.length ? '重新解析资料' : '选择内容并解析'}
                    </span>
                    <ChevronDown size={16} />
                  </summary>
                  <div className="import-parser-body">
                    <fieldset
                      className="import-parser-fields"
                      disabled={batchBusy}
                    >
                      {!!batch.sourceSheets.length && (
                        <fieldset className="import-sheet-picker">
                          <legend>选择需要解析的工作表</legend>
                          {batch.sourceSheets.map((sheet) => (
                            <label key={sheet.name}>
                              <input
                                type="checkbox"
                                checked={sheetNames.includes(sheet.name)}
                                disabled={!!busy}
                                onChange={(event) =>
                                  setSheetNames((previous) =>
                                    event.target.checked
                                      ? [...previous, sheet.name]
                                      : previous.filter(
                                          (name) => name !== sheet.name,
                                        ),
                                  )
                                }
                              />
                              <span>
                                {sheet.name}
                                <small>{sheet.rowCount} 行</small>
                              </span>
                            </label>
                          ))}
                        </fieldset>
                      )}
                      <div className="import-form-grid">
                        <Field label="主要内容类型">
                          <select
                            value={parseKind}
                            onChange={(event) => {
                              setParseKind(event.target.value as ImportKind)
                              setPeriod('')
                            }}
                          >
                            <option value="monthly">月度目标 / 历史月报</option>
                            <option value="weekly">每周工作 / 历史周报</option>
                          </select>
                        </Field>
                        <Field
                          label="补充所属周期（可选）"
                          hint="只在原始资料未说明周期时提供。"
                        >
                          <input
                            type={parseKind === 'monthly' ? 'month' : 'date'}
                            value={period}
                            onChange={(event) => setPeriod(event.target.value)}
                          />
                        </Field>
                      </div>
                      <Field label="补充解析说明（可选）">
                        <textarea
                          rows={2}
                          value={instruction}
                          onChange={(event) =>
                            setInstruction(event.target.value)
                          }
                          placeholder="例如：只整理研发组；张三和王五是负责人；“本月产出”对应实际成果。"
                          maxLength={4000}
                        />
                      </Field>
                      <p className="import-reparse-note">重新识别会重新调用 AI。发现遗漏后，请重新识别或直接补录候选；已有校对和完整性确认需要重做。</p>
                      <div className="import-parser-footer">
                        <p>
                          {batch.kind === 'image'
                            ? '图片将发送到已配置的图片模型，请使用支持图片输入的模型。'
                            : '所选内容将发送到已配置的 AI 服务，解析结果保存后可逐条校对。'}
                          {batch.rows.length > 0 &&
                            ' 重新解析会替换当前批次的校对结果。'}
                        </p>
                        <button
                          className="button primary"
                          disabled={
                            batchBusy ||
                            !configured ||
                            (batch.sourceSheets.length > 0 &&
                              !sheetNames.length)
                          }
                          onClick={() => void parseSource()}
                        >
                          <Sparkles size={16} />
                          {batch.rows.length ? '重新识别（重新调用 AI）' : '智能识别'}
                        </button>
                        {batch.analysis?.status === 'failed' && batch.analysisOptions && <button
                          className="button secondary" disabled={batchBusy || !configured}
                          onClick={() => void parseSource(true)}
                        >继续上次解析（保留已完成分段）</button>}
                      </div>
                      {!configured && (
                        <p className="import-notice">
                          {manager
                            ? '请先在下方“AI 模型设置”中配置服务。'
                            : '请联系管理员配置 AI 解析服务。'}
                        </p>
                      )}
                    </fieldset>
                  </div>
                </details>
              )}
              <ImportSourceReview key={batch.id} batch={batch} disabled={batchBusy}
                reviewerName={data.users.find(user => user.id === batch.completionReview?.reviewedBy)?.name}
                onConfirm={saveCompletionReview} />
              {!immutable && !batch.rows.length && <button className="button secondary" disabled={batchBusy}
                onClick={() => setEditing(newImportCandidate(batch, crypto.randomUUID()))}
              >按原始资料手动补录事项</button>}
              {(batch.status !== 'uploaded' || batch.rows.length > 0) && (
                <>
                  {!immutable && (
                    <div className="import-mode">
                      <div>
                        <h3>选择保存方式</h3>
                        <p>
                          已在使用的计划可直接导入生效；新提报与历史资料也可分别保存。
                        </p>
                      </div>
                      <div className="import-mode-options">
                        {modes.map((mode) => (
                          <label
                            key={mode.id}
                            className={batch.mode === mode.id ? 'active' : ''}
                          >
                            <input
                              type="radio"
                              name="import-mode"
                              value={mode.id}
                              checked={batch.mode === mode.id}
                              disabled={batchBusy}
                              onChange={() =>
                                void run('正在保存导入方式', () =>
                                  saveRows(batch.rows, mode.id),
                                )
                              }
                            />
                            <span>
                              <strong>{mode.label}</strong>
                              <small>{mode.description}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {!immutable && !!batch.rows.length && (
                    <div className="import-bulk">
                      <div className="import-section-title">
                        <h3>批量设置</h3>
                        <span>应用到勾选的 {selected.length} 条记录</span>
                      </div>
                      <div className="import-bulk-plan">
                        <Field label="纳入计划">
                          <select
                            aria-label="批量纳入计划"
                            value={bulk.kind}
                            onChange={(event) =>
                              setBulk({ ...bulk, kind: event.target.value as Bulk['kind'], month: '', weekStart: '' })
                            }
                          >
                            <option value="">保持原计划类型</option>
                            <option value="monthly">月度计划</option>
                            <option value="weekly">每周计划</option>
                          </select>
                        </Field>
                        <Field label="任务性质">
                          <select
                            aria-label="批量设置任务性质"
                            value={bulk.nature}
                            onChange={(event) =>
                              setBulk({ ...bulk, nature: event.target.value as Bulk['nature'], temporaryReason: '' })
                            }
                          >
                            <option value="">保持原任务性质</option>
                            <option value="regular">常规工作</option>
                            <option value="temporary">临时交办</option>
                          </select>
                        </Field>
                        {bulk.kind && (
                          <Field label={bulk.kind === 'monthly' ? '所属月份（留空保留原值）' : '所属周（留空保留原值）'}>
                            <input
                              type={bulk.kind === 'monthly' ? 'month' : 'date'}
                              value={bulk.kind === 'monthly' ? bulk.month : bulk.weekStart}
                              onChange={(event) => setBulk({ ...bulk, [bulk.kind === 'monthly' ? 'month' : 'weekStart']: event.target.value })}
                            />
                          </Field>
                        )}
                        {bulk.nature === 'temporary' && (
                          <div className="import-bulk-reason">
                            <Field label="交办说明（入计划前必填）" hint="例如：领导临时交办客户演示，下周三前完成。留空时保留各条原说明，也可逐条补充。">
                              <textarea
                                aria-label="批量交办说明"
                                rows={2}
                                maxLength={2000}
                                value={bulk.temporaryReason}
                                onChange={(event) => setBulk({ ...bulk, temporaryReason: event.target.value })}
                              />
                            </Field>
                          </div>
                        )}
                      </div>
                      {!!selected.some((row) => row.taskId) && (
                        <p className="import-bulk-hint">已关联个人任务的记录沿用该任务的性质与月度关联，批量设置不会将它改为新任务。</p>
                      )}
                      {candidateLookups(['users', 'projects', 'plans'])}
                      <div className="import-bulk-fields">
                        <select
                          aria-label="批量匹配负责人"
                          value={bulk.ownerId}
                          onChange={(event) =>
                            setBulk({ ...bulk, ownerId: event.target.value })
                          }
                        >
                          <option value="">负责人：保持原值</option>
                          {bulk.ownerId && !activeUsers.some(user => user.id === bulk.ownerId) && <option value={bulk.ownerId} disabled>已选成员（正在核对或不可用）</option>}
                          {activeUsers.map((user) => (
                            <option key={user.id} value={user.id}>
                              {user.name}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="批量匹配项目"
                          value={bulk.projectId}
                          onChange={(event) =>
                            setBulk({ ...bulk, projectId: event.target.value })
                          }
                        >
                          <option value="">项目：保持原值</option>
                          <option value="__clear">清空项目（部门工作）</option>
                          {bulk.projectId && bulk.projectId !== '__clear' && !activeProjects.some(project => project.id === bulk.projectId) && <option value={bulk.projectId} disabled>已选项目（正在核对或不可用）</option>}
                          {activeProjects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label="批量工作类别"
                          value={bulk.category}
                          onChange={(event) =>
                            setBulk({ ...bulk, category: event.target.value })
                          }
                          placeholder="工作类别（可选）"
                        />
                        <select
                          aria-label="批量匹配周记录的月度目标"
                          value={bulk.monthlyPlanId}
                          disabled={bulk.nature === 'temporary'}
                          onChange={(event) =>
                            setBulk({
                              ...bulk,
                              monthlyPlanId: event.target.value,
                            })
                          }
                        >
                          <option value="">周记录关联月度目标：保持原值</option>
                          {bulk.monthlyPlanId && !availablePlans.some(plan => plan.id === bulk.monthlyPlanId) && <option value={bulk.monthlyPlanId} disabled>已选目标（正在核对或仅供历史引用）</option>}
                          {availablePlans.map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {plan.month} · {plan.title}
                            </option>
                          ))}
                        </select>
                        <button
                          className="button secondary"
                          disabled={
                            batchBusy ||
                            !selected.length ||
                            !Object.values(bulk).some(Boolean)
                          }
                          onClick={() =>
                            void run('正在保存批量匹配', async () => {
                              await saveRows(
                                batch.rows.map((row) => {
                                  if (!row.selected) return row
                                  const task = row.taskId ? data.tasks.find((item) => item.id === row.taskId) : undefined
                                  const kind = row.taskId ? row.kind : bulk.kind || row.kind
                                  const isTemporary = task?.isTemporary ?? (row.taskId ? !!row.isTemporary : bulk.nature ? bulk.nature === 'temporary' : !!row.isTemporary)
                                  return {
                                        ...row,
                                         kind,
                                         ...(kind === 'monthly' ? { taskCompleted: false, completionNote: '' } : {}),
                                        isTemporary,
                                        temporaryReason: task
                                          ? task.temporaryReason
                                          : isTemporary
                                            ? (!row.taskId && bulk.nature === 'temporary' && bulk.temporaryReason.trim()) || row.temporaryReason || ''
                                            : '',
                                        ...(bulk.month && kind === 'monthly' ? { month: bulk.month } : {}),
                                        ...(bulk.weekStart && kind === 'weekly' ? { weekStart: bulk.weekStart } : {}),
                                        ...(bulk.ownerId
                                          ? {
                                              ownerId: bulk.ownerId,
                                              ownerName:
                                                data.users.find(
                                                  (user) =>
                                                    user.id === bulk.ownerId,
                                                )?.name || row.ownerName,
                                            }
                                          : {}),
                                        ...(bulk.projectId
                                          ? {
                                              projectId:
                                                bulk.projectId === '__clear'
                                                  ? ''
                                                  : bulk.projectId,
                                              projectName:
                                                data.projects.find(
                                                  (project) =>
                                                    project.id ===
                                                    bulk.projectId,
                                                )?.name || '',
                                            }
                                          : {}),
                                        ...(bulk.category
                                          ? { category: bulk.category }
                                          : {}),
                                        ...(bulk.monthlyPlanId &&
                                        kind === 'weekly' && !isTemporary && !row.taskId
                                          ? {
                                              monthlyPlanId: bulk.monthlyPlanId,
                                              linkedRowId: '',
                                            }
                                          : {}),
                                        ...(!row.taskId && (kind === 'monthly' || isTemporary) ? { monthlyPlanId: '', linkedRowId: '' } : {}),
                                      }
                                }),
                              )
                              setBulk(emptyBulk)
                              notify('批量匹配已保存')
                            })
                          }
                        >
                          应用并保存
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="import-rows-heading">
                    <h3>
                      {immutable ? '保存结果' : '核对解析结果'}{' '}
                      <span>{batch.rows.length} 条</span>
                    </h3>
                    <span>
                      {immutable
                        ? savedBatchCounts(batch)
                        : `${importReconciliationText(batch.rows)} · ${selectedIssues.length} 项有待补项`}
                    </span>
                    {!immutable && <button className="button secondary" disabled={batchBusy}
                      onClick={() => setEditing(newImportCandidate(batch, crypto.randomUUID()))}
                    >补录遗漏事项</button>}
                  </div>
                  {batch.rows.length ? (
                    <div className="table-scroll import-table-scroll">
                      <table className="import-table">
                        <thead>
                          <tr>
                            <th className="import-check">
                              {!immutable && (
                                <input
                                  type="checkbox"
                                  aria-label="选择全部解析记录"
                                  checked={batch.rows.every(
                                    (row) => row.selected,
                                  )}
                                  disabled={batchBusy}
                                  onChange={(event) => {
                                    const checked = event.target.checked
                                    selectRows(batch.rows.map(row => row.id), checked)
                                  }}
                                />
                              )}
                            </th>
                            <th>工作事项 / 来源</th>
                            <th>负责人 / 周期</th>
                            <th>项目 / 月度目标关联</th>
                            <th>待核对</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {batch.rows.map((row) => (
                            <tr
                              key={row.id}
                              className={
                                !row.selected ? 'import-row-unselected' : ''
                              }
                            >
                              <td className="import-check">
                                {immutable ? (
                                  row.result ? (
                                    <Check size={16} />
                                  ) : (
                                    '—'
                                  )
                                ) : (
                                  <input
                                    type="checkbox"
                                    aria-label={`选择记录：${row.title || row.id}`}
                                    checked={row.selected}
                                    disabled={batchBusy}
                                    onChange={(event) => {
                                      const checked = event.target.checked
                                      selectRows([row.id], checked)
                                    }}
                                  />
                                )}
                              </td>
                              <td>
                                <Badge>
                                  {row.kind === 'monthly' ? '月度' : '每周'}
                                </Badge>
                                {row.isTemporary && <span className="import-temporary-badge">临时交办</span>}
                                <strong className="import-row-title">
                                  {row.title || '待补充工作事项'}
                                </strong>
                                {!row.selected && <p className="import-exclusion-reason">{row.exclusionKind === 'duplicate' ? '重复候选' : row.exclusionKind === 'not_task' ? '非工作事项' : '本次不导入的工作'}：{row.exclusionReason || (immutable ? '历史未记录排除原因' : '请填写排除原因')}</p>}
                                {row.isTemporary && <small className="import-temporary-reason">交办说明：{row.temporaryReason || '待补充'}</small>}
                                {batch.mode === 'existing' && (
                                  <div className="import-row-destination">
                                    <strong>
                                      {row.kind === 'monthly'
                                        ? `${row.month || '月份待确认'} · 月度目标`
                                        : `${row.weekStart || '所属周待确认'} · 每周执行`}
                                    </strong>
                                    <span>
                                      {row.kind === 'monthly'
                                        ? monthlyResultLabels[
                                            importedMonthlyResult(row)
                                          ]
                                        : weeklyResultLabels[
                                            importedWeeklyStatus(row)
                                          ]}
                                    </span>
                                    {row.sourceStatus && (
                                      <span>原文状态：{row.sourceStatus}</span>
                                    )}
                                    {row.actualOutcome && (
                                      <span className="import-row-outcome">
                                        成果：{row.actualOutcome}
                                      </span>
                                    )}
                                  </div>
                                )}
                                <details className="import-source">
                                  <summary>
                                    {row.sourceSheet || '原始资料'}
                                    {row.sourceRow
                                      ? ` · 第 ${row.sourceRow} 行`
                                      : ''}
                                  </summary>
                                  <pre>{row.sourceText || '暂无来源文字'}</pre>
                                </details>
                              </td>
                              <td>
                                <strong>
                                  {accountDisplayName(data.users.find(
                                    (user) => user.id === row.ownerId,
                                  ), row.ownerName || '未识别负责人')}
                                </strong>
                                <small>
                                  {row.kind === 'monthly'
                                    ? row.month || '月份待确认'
                                    : row.weekStart || '所属周待确认'}
                                </small>
                                <small>
                                  {row.dueDate
                                    ? `截止 ${row.dueDate}`
                                    : batch.mode === 'draft'
                                      ? '截止日期待确认'
                                      : '截止日期：原表未注明'}
                                </small>
                                {!!row.collaboratorIds?.length && <small>协作：{row.collaboratorIds.map(id => data.users.find(user => user.id === id)?.name || '原成员').join('、')}</small>}
                                {!!row.collaboratorNames?.length && <small>原文协作人：{row.collaboratorNames.join('、')}</small>}
                                <small>来源：{row.workSource === 'leader' ? '领导交办' : row.workSource === 'self' ? '自主安排' : row.workSource === 'coordination' ? '协同事项' : '待核对'}{row.assignedBy ? ` · ${row.assignedBy}` : ''}{row.assignedOn ? ` · ${row.assignedOn}` : ''}</small>
                                {row.kind === 'weekly' && <small>整件任务：{row.taskCompleted ? '已明确整体完成' : row.taskCompleted === false ? '尚未整体完成' : '整体完成待核对'}</small>}
                              </td>
                              <td>
                                {data.projects.find(
                                  (project) => project.id === row.projectId,
                                )?.name ||
                                  row.projectName ||
                                  row.category ||
                                  '未匹配'}
                                {row.kind === 'weekly' && (
                                  <small>
                                    {row.isTemporary
                                      ? '临时任务，无需关联月度目标'
                                      : data.plans.find(
                                      (plan) => plan.id === row.monthlyPlanId,
                                    )?.title ||
                                      (row.linkedRowId
                                        ? `同批次：${batch.rows.find((item) => item.id === row.linkedRowId)?.title || '月度目标'}`
                                        : batch.mode === 'draft'
                                          ? '月度目标待关联'
                                          : '未关联月度目标')}
                                  </small>
                                )}
                                {batch.mode === 'existing' &&
                                  optionalSourceGaps(row) && (
                                    <small className="import-source-gap">
                                      {optionalSourceGaps(row)}
                                      ：原表未注明，可直接保留。
                                    </small>
                                  )}
                              </td>
                              <td>
                                {importRowDisposition(row) === 'excluded' ? <span className="import-excluded">{importRowOutcomeLabel(row)}</span> : row.result ? <span className="import-valid"><Check size={13} />{importRowOutcomeLabel(row)}</span> : row.issues.length ? (
                                  <ul className="import-issues">
                                    {row.issues.map((issue, index) => (
                                      <li key={index}>{issue}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <span className="import-valid">
                                    <Check size={13} />
                                    待处理 · 字段校验通过
                                  </span>
                                )}
                              </td>
                              <td>
                                <button
                                  className="import-edit-button"
                                  disabled={batchBusy}
                                  onClick={() => setEditing({ ...row })}
                                >
                                  {immutable ? '查看' : '校对'}
                                </button>
                                {immutable &&
                                  navigate &&
                                  row.result &&
                                  ['plans', 'weeklyRecords'].includes(
                                    row.result.collection,
                                  ) && (
                                    <button
                                      className="import-edit-button import-result-link"
                                      onClick={() => openImportedResult(row)}
                                    >
                                      {row.result.collection === 'plans'
                                        ? '打开月度目标'
                                        : '打开周记录'}
                                      <ArrowRight size={12} />
                                    </button>
                                  )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      title={canRequestImportReview(manager, batch) ? '当前没有本人可见的候选' : '未识别到工作记录'}
                      description={canRequestImportReview(manager, batch) ? '其他成员的候选由管理员核对。可以将本批次交管理员接续处理，无需重新解析。' : '可调整工作表、内容类型或补充说明后重新解析，原始文件已保留。'}
                    />
                  )}
                  {!immutable && (!!batch.rows.length || canRequestImportReview(manager, batch)) && (
                    <div className="import-commit">
                      <div>
                        <strong>
                          {batch.mode === 'existing'
                            ? '已有计划确认后直接生效'
                            : batch.mode === 'history'
                              ? '保留历史资料，不要求重复填报'
                              : '校对完成后生成新计划草稿'}
                        </strong>
                        <p>
                          {batch.mode === 'existing'
                            ? `${manager ? '本次确认会直接写入对应月份与周，并保留实际成果及核对后的状态。' : '校对后交管理员确认一次，确认后直接进入对应月份与周，无需成员再次提报。'} 原表未注明的验收标准、预期成果与截止日期可留空；原文“完成”不自动等于已验收。同来源的既有草稿会沿用原编号转为生效计划。`
                            : batch.mode === 'history'
                              ? '勾选记录将与来源一起归档。缺失字段可保留为空，历史状态不自动算作当前成果。'
                              : manager ? '用于新目标或周任务草稿，需补齐必要信息；常规月度目标由管理员发布，临时交办需填写说明。' : '成员可导入自己的周任务草稿及临时月度草稿，临时交办需填写说明。常规团队月度目标由管理员创建；已有计划可交管理员确认。'}{' '}
                          每次校对保存后，可随时离开再继续。
                        </p>
                        {importReviewRequired(batch) && <p className="import-commit-warning">{!manager && batch.mode === 'existing' ? '可先交管理员核对资料；管理员补齐完整性核对后才能正式导入。' : '请先在“对照原始资料”中保存完整性核对。'}</p>}
                        {!!reviewCounts.missingReasons && <p className="import-commit-warning">{reviewCounts.missingReasons} 项未选择且缺少排除原因，正式导入前需要补齐。</p>}
                        {!!reviewCounts.excluded && <p className="import-commit-warning">本次有 {reviewCounts.excluded} 项未选择，将保留候选和原因，不写入计划。</p>}
                      </div>
                      <button
                        className="button primary"
                        disabled={
                          batchBusy ||
                          ((manager || batch.mode !== 'existing') && (!selected.length || reviewCounts.missingReasons > 0 || importReviewRequired(batch))) ||
                          (!manager && batch.mode === 'draft' && selected.some(row => row.kind === 'monthly' && !row.isTemporary)) ||
                          ((manager || batch.mode !== 'existing') && batch.mode !== 'history' &&
                            selectedIssues.length > 0) ||
                          (batch.mode === 'existing' &&
                            !manager &&
                            !!batch.reviewRequestedAt)
                        }
                        onClick={() =>
                          void run('正在保存确认结果', async () => {
                            const next = await api<ImportBatch>(
                              `/imports/${batch.id}/${batch.mode === 'existing' && !manager ? 'request-confirmation' : 'commit'}`,
                              json({ version: batch.version }),
                            )
                            acceptBatch(next)
                            if (next.status !== 'committed') {
                              notify(
                                '已交管理员核对；补齐待补项和完整性确认后，由管理员正式导入。',
                              )
                              return
                            }
                            await finishSaved(async () => { await refresh(); if (historyLoaded) await loadHistory() }, next.version)
                            notify(
                              `${savedBatchLabel(next.mode)}：${savedBatchCounts(next)}。`,
                            )
                          })
                        }
                      >
                        <Archive size={16} />
                        {batch.mode === 'existing'
                          ? manager
                            ? `确认 ${selected.length} 条并生效`
                            : batch.reviewRequestedAt
                              ? '已交管理员核对'
                              : '交管理员核对本批次'
                          : batch.mode === 'history'
                            ? `保存 ${selected.length} 条历史资料`
                            : `生成 ${selected.length} 条新草稿`}
                      </button>
                    </div>
                  )}
                  {immutable && (
                    <div className="import-saved">
                      <Check size={17} />
                      <span>
                        {savedBatchLabel(batch.mode)} ·{' '}
                        {batch.committedAt ? dateTime(batch.committedAt) : ''}
                        。此批次已锁定，原始资料可随时下载。
                      </span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
      <div className="import-tools">
        <details
          className="import-tool panel"
          onToggle={(event) => {
            if (event.currentTarget.open && !historyLoaded && !lock.current)
              void run('正在读取历史资料', loadHistory)
          }}
        >
          <summary>
            <span>
              <Archive size={18} />
              <strong>已保存历史资料</strong>
              <small>搜索、查看与追溯来源</small>
            </span>
            <ChevronDown size={17} />
          </summary>
          <div className="import-tool-body">
            <div className="import-history-search">
              <input
                aria-label="搜索历史资料"
                placeholder="搜索工作事项、负责人、月份或原文"
                value={historyQuery}
                onChange={(event) => {
                  setHistoryQuery(event.target.value)
                  setHistoryLimit(50)
                }}
              />
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void run('正在刷新历史资料', loadHistory)}
              >
                <RefreshCw size={15} />
                刷新资料
              </button>
            </div>
            <p className="import-history-count">
              当前可见 {visibleHistory.length}{' '}
              条记录。归档保留历史事实，缺失字段可在来源批次中查看。
            </p>
            {visibleHistory.length ? (
              <>
                <div className="table-scroll">
                  <table className="import-history-table">
                    <thead>
                      <tr>
                        <th>工作事项</th>
                        <th>负责人</th>
                        <th>周期</th>
                        <th>原始状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleHistory.slice(0, historyLimit).map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>
                              {item.row.title || '未命名工作记录'}
                            </strong>
                            {item.row.isTemporary && <span className="import-temporary-badge">临时交办</span>}
                            <small>
                              {item.row.projectName ||
                                item.row.category ||
                                '未分类'}
                            </small>
                          </td>
                          <td>
                            {accountDisplayName(data.users.find(
                              (user) => user.id === item.row.ownerId,
                            ), item.row.ownerName || '待确认')}
                          </td>
                          <td>
                            {item.row.kind === 'monthly'
                              ? item.row.month || '月份未注明'
                              : item.row.weekStart || '所属周未注明'}
                          </td>
                          <td>{item.row.sourceStatus || '未注明'}</td>
                          <td>
                            <div className="import-history-detail-actions">
                              <button
                                className="import-edit-button"
                                onClick={() => setHistoryRecord(item)}
                              >
                                查看
                              </button>
                              <button
                                className="import-edit-button"
                                disabled={!!busy}
                                onClick={() => correctHistory(item)}
                              >
                                纠正
                              </button>
                              {(manager || item.importedBy === data.user.id || item.row.ownerId === data.user.id) && (
                                <button
                                  className="import-edit-button import-delete-button"
                                  disabled={!!busy}
                                  aria-label={`删除历史资料：${item.row.title || '未命名工作记录'}`}
                                  onClick={() => requestHistoryDelete(item)}
                                >
                                  删除
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {visibleHistory.length > historyLimit && (
                  <button
                    className="button secondary import-load-more"
                    onClick={() => setHistoryLimit((value) => value + 50)}
                  >
                    再显示 50 条
                  </button>
                )}
              </>
            ) : (
              <Empty
                title={
                  historyLoaded ? '暂无匹配的历史资料' : '尚未读取历史资料'
                }
                description={
                  historyLoaded
                    ? '资料归档后将在这里保存，可按工作内容或日期检索。'
                    : '点击刷新资料读取当前可见记录。'
                }
              />
            )}
          </div>
        </details>
        {manager && (
          <details className="import-tool panel">
            <summary>
              <span>
                <Settings2 size={18} />
                <strong>AI 模型设置</strong>
                <small>文字解析与图片识别</small>
              </span>
              <ChevronDown size={17} />
            </summary>
            <div className="import-tool-body">
              {ai ? (
                <Form
                  key={`${ai.baseUrl}-${ai.model}-${ai.visionModel}-${ai.hasApiKey}`}
                  submitLabel="保存模型配置"
                  onSubmit={async (event) => {
                    const form = event.currentTarget
                    const fields = Object.fromEntries(new FormData(form))
                    const saved = await api<AiSettingsView>(
                      '/ai/settings',
                      json(fields, 'PUT'),
                    )
                    setAi(saved)
                    setConfigured(saved.configured)
                    const keyInput = form.elements.namedItem('apiKey')
                    if (keyInput instanceof HTMLInputElement)
                      keyInput.value = ''
                    notify('模型配置已保存')
                  }}
                >
                  <div className="import-form-grid">
                    <Field
                      label="兼容 OpenAI 的 API 地址"
                      hint="例如 https://api.example.com/v1"
                    >
                      <input
                        name="baseUrl"
                        type="url"
                        defaultValue={ai.baseUrl}
                        required
                        placeholder="https://api.example.com/v1"
                      />
                    </Field>
                    <Field
                      label="API Key"
                      hint={
                        ai.hasApiKey
                          ? '已保存密钥；留空保留现有密钥。'
                          : '密钥只用于服务端请求，不会在页面回显。'
                      }
                    >
                      <input
                        name="apiKey"
                        type="password"
                        autoComplete="new-password"
                        placeholder={
                          ai.hasApiKey ? '已配置，留空不修改' : '输入 API Key'
                        }
                      />
                    </Field>
                    <Field label="文字解析模型">
                      <input
                        name="model"
                        required
                        defaultValue={ai.model}
                        placeholder="填写服务提供的模型 ID"
                      />
                    </Field>
                    <Field
                      label="图片识别模型"
                      hint="请选择支持图片输入的模型；可与文字模型使用同一个模型。"
                    >
                      <input
                        name="visionModel"
                        defaultValue={ai.visionModel}
                        placeholder="支持图片输入的模型 ID"
                      />
                    </Field>
                  </div>
                  <div className="import-settings-test">
                    <span>
                      当前配置来源：
                      {ai.source === 'environment'
                        ? '服务器环境配置'
                        : ai.source === 'settings'
                          ? '系统内配置'
                          : '尚未配置'}
                    </span>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={!!busy || !configured}
                      onClick={() =>
                        void run('正在测试已保存的模型配置', async () => {
                          await api('/ai/test', json({}))
                          notify('AI 服务连接测试成功')
                        })
                      }
                    >
                      测试已保存配置
                    </button>
                  </div>
                </Form>
              ) : (
                <p className="import-muted">
                  模型设置尚未读取成功，请刷新页面重试。
                </p>
              )}
            </div>
          </details>
        )}
        <details className="import-tool panel">
          <summary>
            <span>
              <Download size={18} />
              <strong>业务数据导出</strong>
              <small>Excel / CSV / JSON</small>
            </span>
            <ChevronDown size={17} />
          </summary>
          <div className="import-tool-body">
            <p>
              导出项目、计划、执行记录与历史资料，用于整理、备份业务内容或迁移到其他系统。管理者选择「全部业务数据」与 JSON 时，版本 4 数据包同时包含周报模板、Word 原件、范例和归档文件；自动生成任务与定时设置不会随恢复重新执行。
            </p>
            <div className="import-export-fields">
              <Field label="数据范围">
                <select
                  value={exportType}
                  onChange={(event) => {
                    setExportType(event.target.value)
                    if (event.target.value === 'all' && exportFormat === 'csv')
                      setExportFormat('xlsx')
                  }}
                >
                  {[
                    ['all', '全部业务数据'],
                    ['plans', '月度目标'],
                    ['weeklyRecords', '每周执行记录'],
                    ['projects', '项目档案'],
                    ['tasks', '个人任务'],
                    ['annualGoals', '年度目标'],
                    ['history', '历史导入资料'],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="导出格式">
                <select
                  value={exportFormat}
                  onChange={(event) => setExportFormat(event.target.value)}
                >
                  <option value="xlsx">Excel (.xlsx)</option>
                  <option value="csv" disabled={exportType === 'all'}>
                    CSV（辅助数据，非正式报告）
                  </option>
                  <option value="json">JSON（结构化数据）</option>
                </select>
              </Field>
              <a
                className="button primary"
                href={`/api/data/export?format=${exportFormat}&type=${exportType}`}
              >
                <Download size={16} />
                下载数据
              </a>
            </div>
          </div>
        </details>
        {manager && (
          <details className="import-tool panel">
            <summary>
              <span>
                <Upload size={18} />
                <strong>恢复业务数据包</strong>
                <small>校验、账号映射与迁移</small>
              </span>
              <ChevronDown size={17} />
            </summary>
            <div className="import-tool-body">
              <p>
                选择本系统此前导出的 JSON
                数据包，先预览新增记录、相同记录和冲突。已存在的不同内容不会被覆盖，来源账号按邮箱匹配，也可明确指定现有账号。支持旧版和版本 4 数据包；含 Word 文件后超过 32 MB 的完整备份，请使用数据库备份恢复。
              </p>
              <Field label="选择业务数据包（JSON，最大 32 MB）">
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={!!busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    void run('正在检查业务数据包', async () => {
                      setRestorePreview(null)
                      setRestorePacket(null)
                      setRestoreMapping({})
                      setRestoreCandidates([])
                      setRestoreResult(null)
                      setRestoreFileName(file.name)
                      if (file.size > 32 * 1024 * 1024)
                        throw new Error('数据包不能超过 32 MB。')
                      if (!/\.json$/i.test(file.name))
                        throw new Error('请选择本系统导出的 JSON 业务数据包。')
                      let packet: unknown
                      try {
                        packet = JSON.parse(await file.text())
                      } catch {
                        throw new Error(
                          '文件不是有效 JSON，请检查导出的数据包。',
                        )
                      }
                      setRestorePacket(packet)
                      await previewPacket(packet, {}, true)
                    })
                  }}
                />
              </Field>
              {restoreFileName && (
                <p className="import-restore-file">
                  待恢复文件：{restoreFileName}
                </p>
              )}
              {!!restoreCandidates.length && (
                <div className="import-restore-mapping">
                  <h3>补充账号映射</h3>
                  <p>
                    来源账号不自动创建；请为以下人员选择对应的现有成员。姓名、邮箱保留用于核对。
                  </p>
                  {candidateLookups(['users'])}
                  {restoreCandidates.map((source) => (
                    <Field
                      key={source.id}
                      label={`${source.name || '未命名账号'} · ${source.email || source.id}`}
                      hint={
                        restorePreview?.mapping[source.id]
                          ? '已匹配到选定账号。'
                          : source.reason
                      }
                    >
                      <select
                        value={
                          restoreMapping[source.id] ||
                          restorePreview?.mapping[source.id] ||
                          ''
                        }
                        disabled={!!busy || !!restoreResult}
                        onChange={(event) => {
                          const mapping = { ...restoreMapping }
                          if (event.target.value)
                            mapping[source.id] = event.target.value
                          else delete mapping[source.id]
                          setRestoreMapping(mapping)
                          setRestorePreview(null)
                          void run('正在重新校验账号映射', () =>
                            previewPacket(restorePacket, mapping),
                          )
                        }}
                      >
                        <option value="">请选择对应成员</option>
                        {(restoreMapping[source.id] || restorePreview?.mapping[source.id]) && !activeUsers.some(user => user.id === (restoreMapping[source.id] || restorePreview?.mapping[source.id])) && <option value={restoreMapping[source.id] || restorePreview?.mapping[source.id]} disabled>已选成员（正在核对或不可用）</option>}
                        {activeUsers.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name} · {user.email}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
              )}
              {restorePreview && (
                <>
                  <div className="table-scroll">
                    <table className="import-restore-table">
                      <thead>
                        <tr>
                          <th>数据集合</th>
                          <th>包内记录</th>
                          <th>拟新增</th>
                          <th>未使用默认规则替换</th>
                          <th>相同 / 账号匹配</th>
                          <th>同 ID 冲突</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(restorePreview.counts).map(
                          ([name, count]) => (
                            <tr key={name}>
                              <td>{collectionLabels[name] || name}</td>
                              <td>{count.total}</td>
                              <td>{count.insert}</td>
                              <td>{count.replace}</td>
                              <td>{count.skip}</td>
                              <td>
                                {Math.max(
                                  0,
                                  count.total - count.insert - count.skip - count.replace,
                                )}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                  {restorePreview.notices.length > 0 && (
                    <div className="import-restore-ready" role="status">
                      {restorePreview.notices.map((notice) => <p key={notice}>{notice}</p>)}
                    </div>
                  )}
                  {restorePreview.issues.length > 0 ? (
                    <div className="import-restore-issues" role="alert">
                      <strong>
                        请先处理 {restorePreview.issues.length} 项缺失或冲突
                      </strong>
                      <ul>
                        {restorePreview.issues.map((issue, index) => (
                          <li key={index}>{issue}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="import-restore-ready">
                      <Check size={16} />
                      校验通过，可确认恢复。账号仅做映射，不导入密码或会话。
                    </div>
                  )}
                </>
              )}
              {restorePacket !== null && !restoreResult && (
                <div className="import-restore-actions">
                  <button
                    className="button secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void run('正在重新预览数据包', () =>
                        previewPacket(restorePacket, restoreMapping),
                      )
                    }
                  >
                    重新预览
                  </button>
                  <button
                    className="button primary"
                    disabled={!!busy || !restorePreview?.canRestore}
                    onClick={() =>
                      void run('正在恢复业务数据', async () => {
                        if (!restorePreview?.canRestore) return
                        const result = await api<{
                          restored: number
                          skipped: number
                        }>(
                          '/data/restore/commit',
                          json({
                            packet: restorePacket,
                            mapping: restoreMapping,
                            fingerprint: restorePreview.fingerprint,
                          }),
                        )
                        setRestoreResult(result)
                        setRestorePreview(null)
                        await finishSaved(async () => { await refresh(); if (historyLoaded) await loadHistory() })
                        notify(
                          `业务数据恢复完成：新增 ${result.restored} 条，跳过 ${result.skipped} 条相同记录。`,
                        )
                      })
                    }
                  >
                    确认恢复业务数据
                  </button>
                </div>
              )}
              {restoreResult && (
                <div className="import-restore-ready">
                  <Check size={17} />
                  恢复完成：新增 {restoreResult.restored} 条，跳过{' '}
                  {restoreResult.skipped} 条相同记录。
                </div>
              )}
            </div>
          </details>
        )}
        {manager && (
          <details className="import-tool panel">
            <summary>
              <span>
                <KeyRound size={18} />
                <strong>智能体与 API 接入</strong>
                <small>独立令牌、按权限调用</small>
              </span>
              <ChevronDown size={17} />
            </summary>
            <div className="import-tool-body">
              <p>
                为智能体创建独立令牌。上传、解析、校对与确认写入使用同一套导入流程；按需要授予权限，令牌
                30 天后到期。
              </p>
              <Form
                submitLabel="创建接入令牌"
                onSubmit={async () => {
                  if (!tokenScopes.length)
                    throw new Error('请至少选择一项权限。')
                  const result = await api<
                    IntegrationTokenView & { token: string }
                  >(
                    '/integration-tokens',
                    json({
                      name: tokenName,
                      scopes: tokenScopes,
                      expiresInDays: 30,
                    }),
                  )
                  setNewToken(result.token)
                  setTokenName('')
                  setTokens(
                    await api<IntegrationTokenView[]>('/integration-tokens'),
                  )
                }}
              >
                <Field label="接入名称">
                  <input
                    value={tokenName}
                    onChange={(event) => setTokenName(event.target.value)}
                    required
                    maxLength={100}
                    placeholder="例如：部门历史周报整理助手"
                  />
                </Field>
                <fieldset className="import-token-scopes">
                  <legend>允许的操作</legend>
                  {scopes.map(([scope, label]) => (
                    <label key={scope}>
                      <input
                        type="checkbox"
                        checked={tokenScopes.includes(scope)}
                        onChange={(event) =>
                          setTokenScopes((previous) =>
                            event.target.checked
                              ? [...previous, scope]
                              : previous.filter((item) => item !== scope),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </Form>
              {newToken && (
                <div className="import-token-once" role="status">
                  <strong>接入令牌仅在本次显示，请现在保存。</strong>
                  <textarea
                    aria-label="新建接入令牌"
                    readOnly
                    value={newToken}
                    rows={3}
                  />
                  <div>
                    <button
                      className="button secondary"
                      onClick={() =>
                        void run('正在复制令牌', async () => {
                          await navigator.clipboard.writeText(newToken)
                          notify('令牌已复制')
                        })
                      }
                    >
                      复制令牌
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => setNewToken('')}
                    >
                      我已保存，隐藏令牌
                    </button>
                  </div>
                </div>
              )}
              <div className="import-token-list">
                {tokens.map((token) => (
                  <div key={token.id}>
                    <div>
                      <strong>{token.name}</strong>
                      <small>{token.scopes.join(' · ')}</small>
                      <small>
                        {token.revokedAt
                          ? `已撤销 · ${dateTime(token.revokedAt)}`
                          : `到期时间 · ${dateTime(token.expiresAt)}`}
                      </small>
                    </div>
                    <button
                      className="button secondary"
                      disabled={!!busy || !!token.revokedAt}
                      onClick={() =>
                        void run('正在撤销接入令牌', async () => {
                          await api(
                            `/integration-tokens/${token.id}/revoke`,
                            json({}),
                          )
                          setTokens(
                            await api<IntegrationTokenView[]>(
                              '/integration-tokens',
                            ),
                          )
                          setNewToken('')
                          notify('令牌已撤销')
                        })
                      }
                    >
                      {token.revokedAt ? '已撤销' : '撤销'}
                    </button>
                  </div>
                ))}
              </div>
              <details className="import-api-guide">
                <summary>查看 API 调用方式</summary>
                <p>
                  请求头使用 <code>Authorization: Bearer &lt;接入令牌&gt;</code>
                  ，写入请求使用 <code>Content-Type: application/json</code>
                  。以下地址相对于当前系统域名。
                </p>
                <pre>
                  {
                    'GET /api/v1/schema\nGET /api/v1/context\n\nPOST /api/v1/imports\n  { "fileName": "旧周报.txt", "text": "待解析的工作记录" }\n\nPOST /api/v1/imports/:id/analyze\n  { "version": 1, "kind": "weekly" }\n\nGET /api/v1/imports/:id\n  持续读取，直到 analysis.status 为 completed\n\nPATCH /api/v1/imports/:id\n  { "version": 最新批次版本, "mode": "history", "rows": [校对后的完整记录] }\n\nPOST /api/v1/imports/:id/commit\n  { "version": 最新批次版本 }\n\nGET /api/v1/data/export?format=json&type=all'
                  }
                </pre>
                <p>
                  每次修改使用最近响应中的
                  version；重复确认已保存的批次不会再次生成数据。mode 可选择
                  existing（已有计划直接生效）、draft（新计划草稿）或
                  history（历史资料）。existing
                  的确认生效仅限管理员；成员准备好后使用
                  /imports/:id/request-confirmation 交管理员确认。
                </p>
                <p>
                  智能体已有结构化结果时，可直接提交到以下入口，省去文件解析。sourceKey
                  使用外部资料的稳定标识，权限和后续校对流程保持一致。
                </p>
                <pre>
                  {
                    'POST /api/v1/imports/structured\n{\n  "sourceKey": "external-report-2026-09",\n  "mode": "history",\n  "rows": [{\n    "kind": "monthly",\n    "sourceRow": 1,\n    "title": "示例工作事项",\n    "ownerName": "原资料负责人",\n    "month": "2026-09",\n    "sourceText": "原始记录正文"\n  }]\n}'
                  }
                </pre>
              </details>
            </div>
          </details>
        )}
      </div>
      {historyRecord && (
        <Modal title="历史工作资料" wide onClose={() => setHistoryRecord(null)}>
          <div className="import-history-detail">
            <h3>{historyRecord.row.title || '未命名工作记录'}</h3>
            {historyRecord.row.isTemporary && <span className="import-temporary-badge">临时交办</span>}
            <p>
              {historyRecord.row.ownerName || '负责人未注明'} ·{' '}
              {historyRecord.row.kind === 'monthly'
                ? historyRecord.row.month || '月份未注明'
                : historyRecord.row.weekStart || '所属周未注明'}{' '}
              · {historyRecord.row.sourceStatus || '原文状态未注明'}
            </p>
            <dl>
              <div><dt>任务性质</dt><dd>{historyRecord.row.isTemporary ? '临时交办' : '常规工作'}</dd></div>
              {historyRecord.row.kind === 'monthly' && historyRecord.row.annualGoalId && <div><dt>年度目标关联</dt><dd>已保留关联</dd></div>}
              {historyRecord.row.kind === 'weekly' && <>
                <div><dt>预计投入（人日）</dt><dd>{historyRecord.row.plannedEffortDays ?? '未填写'}</dd></div>
                <div><dt>实际投入（人日）</dt><dd>{historyRecord.row.actualEffortDays ?? '未填写'}</dd></div>
                <div><dt>任务剩余工作量（人日）</dt><dd>{historyRecord.row.remainingEffortDays ?? '未填写'}</dd></div>
              </>}
              {historyRecord.row.isTemporary && <div><dt>交办说明</dt><dd>{historyRecord.row.temporaryReason || '原始资料未注明'}</dd></div>}
              {(
                [
                  ['projectName', '项目'],
                  ['category', '工作类别'],
                  ['dueDate', '截止日期'],
                  ['expectedOutcome', '预期成果 / 本周承诺'],
                  ['acceptanceCriteria', '验收标准'],
                  ['actualOutcome', '实际成果'],
                  ['blocker', '阻塞或未完成原因'],
                  ['nextAction', '下一步'],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{historyRecord.row[key] || '原始资料未注明'}</dd>
                </div>
              ))}
            </dl>
            <details className="import-source import-editor-source" open>
              <summary>
                来源原文 · {historyRecord.row.sourceSheet || '原始资料'}
                {historyRecord.row.sourceRow
                  ? ` · 第 ${historyRecord.row.sourceRow} 行`
                  : ''}
              </summary>
              <pre>{historyRecord.row.sourceText || '暂无原文'}</pre>
            </details>
            <small>归档时间：{dateTime(historyRecord.createdAt)}</small>
          </div>
          <div className="form-footer">
            <button
              className="button secondary"
              onClick={() => setHistoryRecord(null)}
            >
              关闭
            </button>
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => correctHistory(historyRecord)}
            >
              纠正历史资料
            </button>
            {(manager || historyRecord.importedBy === data.user.id || historyRecord.row.ownerId === data.user.id) && (
              <button className="button secondary import-delete-button" disabled={!!busy} onClick={() => requestHistoryDelete(historyRecord)}>
                <Trash2 size={15} />
                删除历史资料
              </button>
            )}
            {(manager || historyRecord.importedBy === data.user.id) && (
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() =>
                  void run('正在打开来源批次', async () => {
                    acceptBatch(
                      await api<ImportBatch>(
                        `/imports/${historyRecord.batchId}`,
                      ),
                      true,
                    )
                    setHistoryRecord(null)
                    document
                      .querySelector('.import-workspace')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  })
                }
              >
                打开来源批次
              </button>
            )}
          </div>
        </Modal>
      )}
      {deleteTarget && (
        <ImportDeleteDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onPendingChange={(pending) => {
            lock.current = pending
            if (pending) interactionCount.current++
            setBusy(pending ? '正在删除导入资料' : '')
          }}
          onDeleted={finishDelete}
        />
      )}
      {exclusion && batch && <Modal title={`排除 ${exclusion.ids.length} 项候选`} onClose={() => setExclusion(null)}>
        <p className="modal-intro">这些事项会保留在批次中并标为“未导入”。请记录为什么不纳入本次计划，方便以后核对。</p>
        <Form submitLabel="保存排除原因" onCancel={() => setExclusion(null)} onSubmit={async () => {
          if (!exclusion.reason.trim()) throw new Error('请填写排除原因')
          await saveRows(batch.rows.map(row => exclusion.ids.includes(row.id)
            ? { ...row, selected: false, exclusionReason: exclusion.reason.trim(), exclusionKind: exclusion.kind } : row))
          setExclusion(null)
          notify('已记录排除原因；完整性核对需要重新确认。')
        }}>
          <Field label="排除类型"><select value={exclusion.kind} onChange={event => setExclusion({ ...exclusion, kind: event.target.value as typeof exclusion.kind })}>
            <option value="task">本次不导入的工作（仍计入原文事项数）</option><option value="duplicate">重复候选（不重复计数）</option><option value="not_task">非工作事项（如表头、说明）</option>
          </select></Field>
          <Field label="排除原因"><textarea required maxLength={1000} rows={3} value={exclusion.reason}
            placeholder="例如：已另行登记，原任务编号为…；本项仅为背景说明…"
            onChange={event => setExclusion({ ...exclusion, reason: event.target.value })} /></Field>
        </Form>
      </Modal>}
      {editing && (batch || editingHistory) && (
        <Modal
          title={
            editingHistory
              ? '纠正历史资料'
              : readOnlyEditor
                ? '查看导入记录'
                : editingNew ? '补录遗漏事项' : '校对导入记录'
          }
          wide
          onClose={closeEditor}
        >
          <p className="modal-intro">
            {editingHistory
              ? '本次修改用于纠正已归档的历史资料，原始文字保持不变，纠正原因留档。关联的工作计划如需修改，请到相应计划页面处理。'
              : editingNew ? '对照原始资料补录遗漏的独立事项，填写真实来源。保存候选后仍需完整性核对，才会写入计划。' : '校对后保存到当前批次。原始文字保留在下方，可随时对照。'}
          </p>
          <Form
            submitLabel={
              readOnlyEditor
                ? '关闭'
                : editingHistory
                  ? '保存历史纠正'
                  : editingNew ? '保存补录候选' : '保存校对'
            }
            onCancel={closeEditor}
            onSubmit={async () => {
              const cleanEditing = { ...editing, collaboratorNames: editing.collaboratorNames?.map(name => name.trim()).filter(Boolean) }
              const reviewed = editingTask ? { ...cleanEditing, isTemporary: editingTask.isTemporary, temporaryReason: editingTask.temporaryReason, ...importWorkFields(editingTask) } : cleanEditing
              if (editingHistory) {
                const saved = await api<HistoricalRecord>(
                  `/imports/history/${editingHistory.id}`,
                  json(
                    {
                      version: editingHistory.version,
                      row: reviewed,
                      reason: correctionReason,
                    },
                    'PATCH',
                  ),
                )
                setHistory((previous) =>
                  previous.map((item) => (item.id === saved.id ? saved : item)),
                )
                setHistoryRecord(saved)
              } else if (!readOnlyEditor && batch)
                await saveRows(
                  editingNew ? [...batch.rows, reviewed] : batch.rows.map((row) =>
                    row.id === editing.id ? reviewed : row,
                  ),
                )
              if (!readOnlyEditor)
                notify(
                  editingHistory
                    ? '历史资料已纠正，原始来源和修改记录均已保留。'
                    : '校对结果已保存',
                )
              closeEditor()
            }}
          >
            <fieldset
              className="import-editor-fields"
              disabled={readOnlyEditor}
            >
              {!readOnlyEditor && candidateLookups(['users', 'projects', 'plans', 'tasks'])}
              {editingNew && <div className="import-editor-source-input">
                <h3>遗漏事项的原始来源</h3>
                <div className="import-form-grid">
                  <Field label="来源工作表 / 资料位置">
                    {batch?.sourceSheets.length ? <select required value={editing.sourceSheet} onChange={event => setEditing({ ...editing, sourceSheet: event.target.value })}>
                      <option value="">请选择工作表</option>
                      {batch.sourceSheets.map(sheet => <option value={sheet.name} key={sheet.name}>{sheet.name}</option>)}
                    </select> : <input value={editing.sourceSheet} placeholder="例如：原始图片、第二段" onChange={event => setEditing({ ...editing, sourceSheet: event.target.value })} />}
                  </Field>
                  <Field label="原始行号 / 事项序号"><input required type="number" min="1" step="1" value={editing.sourceRow} onChange={event => setEditing({ ...editing, sourceRow: Number(event.target.value) })} /></Field>
                </div>
                <Field label="原文内容" hint="按原资料填写，不编造原文；同一源行有多事项时可分别补录。"><textarea required rows={3} maxLength={20000} value={editing.sourceText} onChange={event => setEditing({ ...editing, sourceText: event.target.value })} /></Field>
              </div>}
              {!editingHistory && <div className="import-editor-selection">
                <label><input type="checkbox" checked={editing.selected} onChange={event => setEditing({ ...editing, selected: event.target.checked, exclusionReason: event.target.checked ? '' : editing.exclusionReason })} />纳入本次导入</label>
                {!editing.selected && <>
                  <Field label="排除类型"><select value={editing.exclusionKind || 'task'} onChange={event => setEditing({ ...editing, exclusionKind: event.target.value as ImportRow['exclusionKind'] })}>
                    <option value="task">本次不导入的工作（仍计入原文事项数）</option><option value="duplicate">重复候选（不重复计数）</option><option value="not_task">非工作事项（如表头、说明）</option>
                  </select></Field>
                  <Field label="排除原因"><textarea required={!readOnlyEditor} maxLength={1000} rows={2} value={editing.exclusionReason || ''} placeholder={readOnlyEditor ? '历史未记录排除原因' : '请说明为什么不纳入本批次'} onChange={event => setEditing({ ...editing, exclusionReason: event.target.value })} /></Field>
                </>}
              </div>}
              <div className="import-editor-destination">
                <div className="import-form-grid">
                <Field label="纳入计划" hint={editingTaskLocked ? '已关联个人任务，保持纳入每周计划。' : undefined}>
                  <select
                    value={editing.kind}
                    disabled={editingTaskLocked}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        kind: event.target.value as ImportKind,
                        ...(event.target.value === 'monthly' ? { taskId: '', taskCompleted: false, completionNote: '' } : {}),
                        ...(event.target.value === 'monthly' || editingTemporary ? { monthlyPlanId: '', linkedRowId: '' } : {}),
                      })
                    }
                  >
                    <option value="monthly">月度计划</option>
                    <option value="weekly">每周计划</option>
                  </select>
                </Field>
                <Field label="任务性质" hint={editingTaskLocked ? '沿用已有任务的性质与交办说明，不在导入时修改。' : '领导交办、突发支持等工作可标记为临时交办。'}>
                  <select
                    value={editingTemporary ? 'temporary' : 'regular'}
                    disabled={editingTaskLocked}
                    onChange={(event) => {
                      const isTemporary = event.target.value === 'temporary'
                      setEditing({ ...editing, isTemporary, temporaryReason: isTemporary ? editing.temporaryReason || '' : '', ...(isTemporary && editing.kind === 'weekly' ? { monthlyPlanId: '', linkedRowId: '' } : {}) })
                    }}
                  >
                    <option value="regular">常规工作</option>
                    <option value="temporary">临时交办</option>
                  </select>
                </Field>
                <Field label={editing.kind === 'monthly' ? '所属月份' : '所属周（选择该周的日期）'}>
                  <input
                    type={editing.kind === 'monthly' ? 'month' : 'date'}
                    value={editing.kind === 'monthly' ? editing.month : editing.weekStart}
                    onChange={(event) => setEditing({ ...editing, [editing.kind === 'monthly' ? 'month' : 'weekStart']: event.target.value })}
                  />
                </Field>
                </div>
                {editingTemporary && (
                  <Field label={batch?.mode === 'history' || editingHistory ? '交办说明' : '交办说明（入计划前必填）'} hint="说明交办来源、临时背景或要求。可以先保存校对，纳入计划前再补齐。">
                    <textarea
                      rows={2}
                      maxLength={2000}
                      value={editingTask?.temporaryReason ?? editing.temporaryReason ?? ''}
                      disabled={editingTaskLocked}
                      onChange={(event) => setEditing({ ...editing, temporaryReason: event.target.value })}
                    />
                  </Field>
                )}
              </div>
              <div className="import-form-grid">
                <Field label="工作事项">
                  <input
                    value={editing.title}
                    maxLength={LIMITS.title}
                    onChange={(event) =>
                      setEditing({ ...editing, title: event.target.value })
                    }
                  />
                </Field>
                <Field label="原文负责人">
                  <input
                    value={editing.ownerName}
                    onChange={(event) =>
                      setEditing({ ...editing, ownerName: event.target.value })
                    }
                  />
                </Field>
                <Field label="匹配系统成员">
                  <select
                    value={editing.ownerId}
                    onChange={(event) =>
                      setEditing({ ...editing, ownerId: event.target.value })
                    }
                  >
                    <option value="">暂不匹配</option>
                    {editing.ownerId && !data.users.some(user => user.id === editing.ownerId) && <option value={editing.ownerId} disabled>已选成员（正在核对或无访问权限）</option>}
                    {data.users
                      .filter(
                        (user) =>
                          activeUsers.some((active) => active.id === user.id) ||
                          user.id === editing.ownerId,
                      )
                      .map((user) => (
                        <option key={user.id} value={user.id} disabled={!canUseAccount(user)}>
                          {accountDisplayName(user)}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="原文项目名称">
                  <input
                    value={editing.projectName}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        projectName: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="匹配系统项目">
                  <select
                    value={editing.projectId}
                    onChange={(event) =>
                      setEditing({ ...editing, projectId: event.target.value })
                    }
                  >
                    <option value="">暂不匹配 / 部门工作</option>
                    {editing.projectId && !data.projects.some(project => project.id === editing.projectId) && <option value={editing.projectId} disabled>已选项目（正在核对或无访问权限）</option>}
                    {data.projects
                      .filter(
                        (project) =>
                          project.status === 'active' ||
                          project.id === editing.projectId,
                      )
                      .map((project) => (
                        <option key={project.id} value={project.id} disabled={project.status !== 'active'}>
                          {project.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="工作类别">
                  <input
                    value={editing.category}
                    onChange={(event) =>
                      setEditing({ ...editing, category: event.target.value })
                    }
                  />
                </Field>
                <Field label="工作来源" hint="临时工作不自动等于领导交办；按原文或明确安排选择。">
                  <select value={editingTask ? editingTask.workSource || '' : editing.workSource || ''} disabled={editingTaskLocked} onChange={event => setEditing({ ...editing, workSource: event.target.value as ImportRow['workSource'] })}>
                    <option value="">来源待核对</option><option value="leader">领导交办</option><option value="self">自主安排</option><option value="coordination">协同事项</option>
                  </select>
                </Field>
                <Field label="交办人" hint={editingTaskLocked ? '沿用已有任务；需更正时请到原任务处理。' : undefined}><input maxLength={LIMITS.assignedBy} disabled={editingTaskLocked} value={editingTask ? editingTask.assignedBy || '' : editing.assignedBy || ''} onChange={event => setEditing({ ...editing, assignedBy: event.target.value })} /></Field>
                <Field label="交办日期"><input type="date" disabled={editingTaskLocked} value={editingTask ? editingTask.assignedOn || '' : editing.assignedOn || ''} onChange={event => setEditing({ ...editing, assignedOn: event.target.value })} /></Field>
                <Field label="原文协作人" hint={editing.kind === 'monthly' ? '用顿号或逗号分隔；在下方明确匹配系统成员。' : '周任务由个人负责；原文有多人协作时请分别拆项或改为月目标，名单不要直接作为个人责任。'}>
                  <input value={(editing.collaboratorNames || []).join('、')} onChange={event => setEditing({ ...editing, collaboratorNames: event.target.value.split(/[、,，;；\n]/) })} />
                </Field>
                <Field
                  label="原文状态"
                  hint="保留原始状态；原文“完成”不自动等于管理员已验收。"
                >
                  <input
                    value={editing.sourceStatus}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        sourceStatus: event.target.value,
                      })
                    }
                  />
                </Field>
                {batch?.mode === 'existing' &&
                  !editingHistory &&
                  (editing.kind === 'monthly' ? (
                    <Field
                      label="导入后的成果状态"
                      hint="计划确认后直接生效。原表已有成果会一起保留；已验收仅由管理员明确选择。"
                    >
                      <select
                        value={importedMonthlyResult(editing)}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            monthlyResult: event.target
                              .value as ImportRow['monthlyResult'],
                          })
                        }
                      >
                        {Object.entries(monthlyResultLabels)
                          .filter(
                            ([status]) =>
                              manager ||
                              status !== 'accepted' ||
                              editing.monthlyResult === 'accepted',
                          )
                          .map(([status, label]) => (
                            <option
                              key={status}
                              value={status}
                              disabled={!manager && status === 'accepted'}
                            >
                              {label}
                            </option>
                          ))}
                      </select>
                    </Field>
                  ) : (
                    <Field
                      label="导入后的执行状态"
                      hint="按原文状态识别，可在此校正；实际成果保持原文。"
                    >
                      <select
                        value={importedWeeklyStatus(editing)}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            weeklyStatus: event.target
                              .value as ImportRow['weeklyStatus'],
                          })
                        }
                      >
                        {Object.entries(weeklyResultLabels).map(
                          ([status, label]) => (
                            <option key={status} value={status}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </Field>
                  ))}
                <Field
                  label="截止日期"
                  hint={
                    batch?.mode === 'existing'
                      ? '原表未注明时可留空。'
                      : undefined
                  }
                >
                  <input
                    type="date"
                    value={editing.dueDate}
                    onChange={(event) =>
                      setEditing({ ...editing, dueDate: event.target.value })
                    }
                  />
                </Field>
              </div>
              {editing.kind === 'monthly' && <Field label="关联年度目标" hint="仅关联同年度目标；留空表示未关联。">
                {/^(20\d\d)-\d\d$/.test(editing.month) ? <AnnualGoalPicker key={`${scope}:${editing.id}:${editing.month.slice(0, 4)}`} year={Number(editing.month.slice(0, 4))} value={editing.annualGoalId || ''} scope={scope} onChange={value => setEditing({ ...editing, annualGoalId: value || null })} /> : <p>先填写所属月份后选择年度目标。</p>}
              </Field>}
              {editing.kind === 'weekly' && <div className="form-grid">
                {([['plannedEffortDays', '本周预计投入'], ['actualEffortDays', '本周实际投入'], ['remainingEffortDays', '任务剩余工作量']] as const).map(([field, label]) => <Field key={field} label={`${label}（人日）`} hint={field === 'remainingEffortDays' && editingTaskLocked ? '沿用现有任务；更正请到原任务处理。' : '按 0.5 人日填写；空白表示未知，0 表示零投入。'}>
                  <input type="number" min="0" step="0.5" disabled={field === 'remainingEffortDays' && editingTaskLocked} value={field === 'remainingEffortDays' && editingTask ? editingTask.remainingEffortDays ?? '' : editing[field] ?? ''} onChange={event => setEditing({ ...editing, [field]: event.target.value === '' ? null : Number(event.target.value) })} />
                </Field>)}
              </div>}
              {(editing.kind === 'monthly' || !!editing.collaboratorIds?.length) && <div className="import-editor-collaborators">
                <h3>明确匹配协作成员</h3>
                <p>协作参与与负责人分别记录；请核对同名和无法匹配的原文姓名。</p>
                <div className="import-collaborator-options">{data.users.filter(user => canUseAccount(user) || editing.collaboratorIds?.includes(user.id)).map(user => <label key={user.id}>
                  <input type="checkbox" checked={editing.collaboratorIds?.includes(user.id) || false} disabled={!canUseAccount(user) && !editing.collaboratorIds?.includes(user.id)}
                    onChange={event => setEditing({ ...editing, collaboratorIds: event.target.checked ? [...(editing.collaboratorIds || []), user.id] : (editing.collaboratorIds || []).filter(id => id !== user.id) })} />
                  {accountDisplayName(user)}
                </label>)}</div>
              </div>}
              {editing.kind === 'weekly' && !editingHistory && batch?.mode === 'existing' && <div className="import-overall-completion">
                <h3>整件任务是否完成</h3>
                <p>本周阶段完成不会自动结束整件任务。只有全部工作已完成且无需继续推进，才确认整体完成。</p>
                {editingTaskLocked ? <p>已关联现有个人任务，整体完成状态请到原任务核对与修改。</p> : <>
                  <label><input type="checkbox" checked={editing.taskCompleted === true} onChange={event => setEditing({ ...editing, taskCompleted: event.target.checked, completionNote: event.target.checked ? editing.completionNote || '' : '' })} />确认整件任务已完成</label>
                  {editing.taskCompleted && <Field label="整体完成依据"><textarea required maxLength={2000} rows={2} value={editing.completionNote || ''} onChange={event => setEditing({ ...editing, completionNote: event.target.value })} placeholder="说明整个事项已完成的依据，而非仅本周的阶段成果" /></Field>}
                </>}
              </div>}
              {editing.kind === 'weekly' && (
                <div className="import-editor-relations">
                  <h3>周工作关联</h3>
                  <Field
                    label="关联已有个人任务"
                    hint={
                      editingTemporary
                        ? '临时任务可直接纳入本周，无需先创建月度目标；也可匹配已有任务。'
                        : batch?.mode === 'existing'
                        ? '原表已有任务可直接匹配；没有月度目标关联也可导入生效。'
                        : '可关联自己的任务，或先选择月度目标以新建任务。'
                    }
                  >
                    <select
                      value={editing.taskId}
                      onChange={(event) => {
                        const task = data.tasks.find(
                          (item) => item.id === event.target.value,
                        )
                        if (task && !editing.taskId) detachedWorkSource.current = { rowId: editing.id, fields: importWorkFields(editing) }
                        const previousSource = detachedWorkSource.current?.rowId === editing.id ? detachedWorkSource.current.fields : undefined
                        setEditing(selectImportTask(editing, task, previousSource))
                        if (!task) detachedWorkSource.current = null
                      }}
                    >
                      <option value="">新建个人任务</option>
                      {editing.taskId && !data.tasks.some(task => task.id === editing.taskId) && <option value={editing.taskId} disabled>已关联任务（正在核对或无访问权限）</option>}
                      {data.tasks
                        .filter(
                          (task) => task.id === editing.taskId ||
                            (!task.cancellation && (manager || task.ownerId === data.user.id) && activeUsers.some(user => user.id === task.ownerId)),
                        )
                        .map((task) => (
                          <option key={task.id} value={task.id} disabled={!!task.cancellation || !activeUsers.some(user => user.id === task.ownerId)}>
                            {task.title}{task.cancellation ? ' · 已作废' : task.isTemporary ? ' · 临时交办' : ''}{!activeUsers.some(user => user.id === task.ownerId) ? ' · 责任人账号不可用' : ''}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {editingTemporary ? (
                    <p className="import-relation-hint">临时交办直接关联个人任务，无需关联月度目标。</p>
                  ) : <>
                  <Field
                    label="关联系统月度目标"
                    hint={
                      editingTaskLocked
                        ? '沿用已有任务的月度关联。如需新建任务，请先在上方选择“新建个人任务”。'
                        : batch?.mode === 'existing'
                        ? '原表没有明确关联时可留空，导入后显示“未关联月度目标”。'
                        : undefined
                    }
                  >
                    <select
                      value={editing.monthlyPlanId}
                      disabled={editingTaskLocked}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          monthlyPlanId: event.target.value,
                          linkedRowId: '',
                          taskId: '',
                        })
                      }
                    >
                      <option value="">暂不关联</option>
                      {editing.monthlyPlanId && !availablePlans.some(plan => plan.id === editing.monthlyPlanId) && <option value={editing.monthlyPlanId} disabled>{data.plans.find(plan => plan.id === editing.monthlyPlanId)?.title || '已关联目标'} · 正在核对或仅供历史引用</option>}
                      {availablePlans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.month} · {plan.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="或关联本批次的月度目标">
                    <select
                      value={editing.linkedRowId}
                      disabled={editingTaskLocked}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          linkedRowId: event.target.value,
                          monthlyPlanId: '',
                          taskId: '',
                        })
                      }
                    >
                      <option value="">不使用本批次月度目标</option>
                      {(editingHistory ? [] : batch?.rows || [])
                        .filter(
                          (row) =>
                            row.kind === 'monthly' &&
                            row.selected &&
                            row.id !== editing.id,
                        )
                        .map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.month || '月份待确认'} ·{' '}
                            {row.title || '未命名事项'}
                          </option>
                        ))}
                    </select>
                  </Field>
                  </>}
                </div>
              )}
              {(
                [
                  ['expectedOutcome', '预期成果 / 本周承诺'],
                  ['acceptanceCriteria', '验收标准'],
                  ['actualOutcome', '实际成果'],
                  ['blocker', '阻塞或未完成原因'],
                  ['nextAction', '下一步'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <textarea
                    rows={3}
                    value={editing[key]}
                    onChange={(event) =>
                      setEditing({ ...editing, [key]: event.target.value })
                    }
                  />
                </Field>
              ))}
            </fieldset>
            {editingHistory && (
              <Field
                label="纠正原因"
                hint="说明原记录哪里有误以及本次修改依据。"
              >
                <textarea
                  rows={2}
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  required
                  maxLength={1000}
                />
              </Field>
            )}
            <details className="import-source import-editor-source" open>
              <summary>
                来源原文 · {editing.sourceSheet || '原始资料'}
                {editing.sourceRow ? ` · 第 ${editing.sourceRow} 行` : ''}
              </summary>
              <pre>{editing.sourceText || '暂无原文'}</pre>
            </details>
            {!!editing.issues.length && (
              <div className="import-notice">
                <strong>上次保存时的待补项</strong>
                {editing.issues.map((issue, index) => (
                  <p key={index}>{issue}</p>
                ))}
                <small>
                  本次修改保存后重新校验。已有计划与历史资料保留原表未注明的非必要字段。
                </small>
              </div>
            )}
          </Form>
        </Modal>
      )}
    </div>
  )
}
