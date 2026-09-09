import { useEffect, useRef, useState } from 'react'
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
import { registrationApproved } from '../../shared/auth-policy'
import {
  importedMonthlyResult,
  importedWeeklyStatus,
} from '../../shared/import-status'
import type { Navigate } from '../navigation'
import { api, json } from '../api'
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
  return `新增 ${batch.committedCount || 0} 条${batch.mode === 'existing' ? `、原草稿转生效 ${batch.activatedCount || 0} 条` : ''}、重复跳过 ${batch.skippedCount || 0} 条`
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
  counts: Record<string, { total: number; insert: number; skip: number }>
  issues: string[]
  missingUsers: { id: string; name: string; email: string; reason: string }[]
  mapping: Record<string, string>
}
const collectionLabels: Record<string, string> = {
  users: '账号匹配',
  projects: '项目档案',
  annualGoals: '年度目标',
  plans: '月度计划',
  tasks: '个人任务',
  weeklyRecords: '每周执行',
  history: '历史资料',
  publications: '发布快照',
  reports: '报告',
  events: '变更记录',
}
const emptyBulk: Bulk = {
  ownerId: '',
  projectId: '',
  category: '',
  monthlyPlanId: '',
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
  data,
  refresh,
  notify,
  navigate,
}: PageProps & { navigate?: Navigate }) {
  const manager = data.user.role === 'manager'
  const [batches, setBatches] = useState<ImportBatchSummary[]>([])
  const [pendingOnly, setPendingOnly] = useState(false)
  const [batch, setBatch] = useState<ImportBatch | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [pasted, setPasted] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [parseKind, setParseKind] = useState<ImportKind>('monthly')
  const [period, setPeriod] = useState('')
  const [instruction, setInstruction] = useState('')
  const [forceRefresh, setForceRefresh] = useState(false)
  const [editing, setEditing] = useState<ImportRow | null>(null)
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
  const lock = useRef(false)
  const activeBatchId = useRef<string | null>(null)
  const interactionCount = useRef(0)
  const activeUsers = data.users.filter(
    (user) =>
      user.active &&
      registrationApproved(user) &&
      (manager || user.id === data.user.id),
  )
  const activeProjects = data.projects.filter(
    (project) => project.status === 'active',
  )
  const availablePlans = data.plans.filter((plan) => plan.status !== 'merged')
  const selected = batch?.rows.filter((row) => row.selected) || []
  const selectedIssues = selected.filter((row) => row.issues.length)
  const immutable = batch?.status === 'committed'
  const readOnlyEditor = immutable && !editingHistory
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
    return `${row.title} ${row.ownerName} ${row.projectName} ${row.month} ${row.weekStart} ${row.category} ${row.sourceText}`
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
      setSheetNames(next.sourceSheets.length ? [next.sourceSheets[0].name] : [])
      setInstruction('')
      setForceRefresh(false)
      setPeriod('')
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
          notify(`解析完成，共 ${next.rows.length} 条记录，请校对后保存。`)
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

  async function upload(file: File) {
    await run('正在保存原始文件', async () => {
      if (file.size > 10 * 1024 * 1024)
        throw new Error('文件大小不能超过 10 MB。请分批导入。')
      if (!/\.(xlsx|csv|tsv|txt|png|jpe?g|webp)$/i.test(file.name))
        throw new Error(
          '请选择 XLSX、CSV、TSV、TXT 或 PNG/JPG/WebP 图片。旧版 XLS 请先另存为 XLSX。',
        )
      const next = await api<ImportBatch>(
        '/imports',
        json({
          fileName: file.name,
          mode: 'existing',
          mimeType: file.type,
          base64: await fileBase64(file),
        }),
      )
      acceptBatch(next, true)
      notify('原始文件已保存，可设置解析选项并开始解析。')
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

  return (
    <div className="imports-page">
      <PageHeader
        title="数据导入"
        description="把已有表格、文字和截图变成可校对的数据，原始资料与导入批次始终可追溯。"
        actions={
          <Badge tone={configured ? 'green' : 'neutral'}>
            {configured ? 'AI 解析已配置' : 'AI 解析待配置'}
          </Badge>
        }
      />
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
      <section className="import-upload panel">
        <div className="import-upload-copy">
          <span className="import-upload-icon">
            <FileInput size={28} strokeWidth={1.6} />
          </span>
          <div>
            <h2>从现有资料开始</h2>
            <p>Excel / 钉钉导出表格、文字、截图，单个文件最大 10 MB。</p>
            <small>
              支持 XLSX、CSV、TSV、TXT、PNG、JPG、WebP。钉钉表格可先导出为
              Excel。
            </small>
          </div>
        </div>
        <div className="import-upload-actions">
          <input
            ref={fileInput}
            className="import-file-input"
            type="file"
            accept=".xlsx,.csv,.tsv,.txt,.png,.jpg,.jpeg,.webp"
            aria-label="选择导入文件"
            disabled={!!busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void upload(file)
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
            onClick={() => setShowPaste((value) => !value)}
          >
            <FileText size={16} />
            粘贴内容
          </button>
        </div>
        {showPaste && (
          <div className="import-paste">
            <Field label="粘贴表格或工作记录">
              <textarea
                rows={6}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                placeholder="直接粘贴 Excel 单元格、钉钉工作记录或旧计划文字…"
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
                    · {item.rowCount} 条
                  </span>
                  <small>{dateTime(item.createdAt)}</small>
                  {manager && (
                    <small>
                      整理：
                      {data.users.find((user) => user.id === item.ownerId)
                        ?.name || '原账号'}
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
                <a
                  className="button secondary"
                  href={`/api/imports/${batch.id}/source`}
                >
                  <Download size={15} />
                  原始文件
                </a>
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
                      ? '成员已整理完成，请确认导入已有计划'
                      : '已交管理员确认'}
                  </strong>
                  <p>
                    {dateTime(batch.reviewRequestedAt)} ·
                    确认后直接进入月度计划或每周执行，无需再次提报。继续修改校对内容会取消本次确认申请，保存后可重新交给管理员。
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
                      ? '已完成的分段结果保留，使用相同选项重试可继续处理。'
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
                            <option value="monthly">月度计划 / 历史月报</option>
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
                      <label className="import-force-refresh">
                        <input
                          type="checkbox"
                          checked={forceRefresh}
                          onChange={(event) =>
                            setForceRefresh(event.target.checked)
                          }
                        />
                        重新调用模型（不复用已有解析片段）
                      </label>
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
                          onClick={() =>
                            void run('正在启动智能解析', async () => {
                              const next = await api<ImportBatch>(
                                `/imports/${batch.id}/analyze`,
                                json({
                                  version: batch.version,
                                  ...(batch.kind === 'table'
                                    ? { sheets: sheetNames }
                                    : {}),
                                  instruction,
                                  forceRefresh,
                                  kind: parseKind,
                                  ...(period ? { period } : {}),
                                }),
                              )
                              acceptBatch(next)
                              notify(
                                next.analysis?.status === 'running'
                                  ? '后台解析已开始，可以离开页面后继续查看。'
                                  : '解析完成，请核对负责人、日期及关联关系。',
                              )
                            })
                          }
                        >
                          <Sparkles size={16} />
                          {batch.rows.length ? '重新解析' : '智能解析'}
                        </button>
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
                        <h3>批量匹配</h3>
                        <span>应用到勾选的 {selected.length} 条记录</span>
                      </div>
                      <div className="import-bulk-fields">
                        <select
                          aria-label="批量匹配负责人"
                          value={bulk.ownerId}
                          onChange={(event) =>
                            setBulk({ ...bulk, ownerId: event.target.value })
                          }
                        >
                          <option value="">负责人：保持原值</option>
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
                          aria-label="批量匹配周记录的月计划"
                          value={bulk.monthlyPlanId}
                          onChange={(event) =>
                            setBulk({
                              ...bulk,
                              monthlyPlanId: event.target.value,
                            })
                          }
                        >
                          <option value="">周记录关联月计划：保持原值</option>
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
                                batch.rows.map((row) =>
                                  !row.selected
                                    ? row
                                    : {
                                        ...row,
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
                                        row.kind === 'weekly'
                                          ? {
                                              monthlyPlanId: bulk.monthlyPlanId,
                                              linkedRowId: '',
                                              taskId: '',
                                            }
                                          : {}),
                                      },
                                ),
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
                        : `已勾选 ${selected.length} 条 · ${selectedIssues.length} 条有待补项`}
                    </span>
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
                                    void run('正在保存选择', () =>
                                      saveRows(
                                        batch.rows.map((row) => ({
                                          ...row,
                                          selected: checked,
                                        })),
                                      ),
                                    )
                                  }}
                                />
                              )}
                            </th>
                            <th>工作事项 / 来源</th>
                            <th>负责人 / 周期</th>
                            <th>项目 / 月计划关联</th>
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
                                      void run('正在保存选择', () =>
                                        saveRows(
                                          batch.rows.map((item) =>
                                            item.id === row.id
                                              ? { ...item, selected: checked }
                                              : item,
                                          ),
                                        ),
                                      )
                                    }}
                                  />
                                )}
                              </td>
                              <td>
                                <Badge>
                                  {row.kind === 'monthly' ? '月度' : '每周'}
                                </Badge>
                                <strong className="import-row-title">
                                  {row.title || '待补充工作事项'}
                                </strong>
                                {batch.mode === 'existing' && (
                                  <div className="import-row-destination">
                                    <strong>
                                      {row.kind === 'monthly'
                                        ? `${row.month || '月份待确认'} · 月度计划`
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
                                  {data.users.find(
                                    (user) => user.id === row.ownerId,
                                  )?.name ||
                                    row.ownerName ||
                                    '未识别负责人'}
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
                                    {data.plans.find(
                                      (plan) => plan.id === row.monthlyPlanId,
                                    )?.title ||
                                      (row.linkedRowId
                                        ? `同批次：${batch.rows.find((item) => item.id === row.linkedRowId)?.title || '月计划'}`
                                        : batch.mode === 'draft'
                                          ? '月计划待关联'
                                          : '未关联月计划')}
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
                                {row.issues.length ? (
                                  <ul className="import-issues">
                                    {row.issues.map((issue, index) => (
                                      <li key={index}>{issue}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <span className="import-valid">
                                    <Check size={13} />
                                    {immutable ? '已处理' : '规则校验通过'}
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
                                        ? '打开月计划'
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
                      title="未识别到工作记录"
                      description="可调整工作表、内容类型或补充说明后重新解析，原始文件已保留。"
                    />
                  )}
                  {!immutable && !!batch.rows.length && (
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
                              : '用于新计划提报，需补齐必要信息；月计划仍需提交审核发布，周记录按现有流程提交。'}{' '}
                          每次校对保存后，可随时离开再继续。
                        </p>
                      </div>
                      <button
                        className="button primary"
                        disabled={
                          batchBusy ||
                          !selected.length ||
                          (batch.mode !== 'history' &&
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
                                '已交管理员确认，确认后直接生效，无需再次提报。',
                              )
                              return
                            }
                            await refresh()
                            if (historyLoaded) await loadHistory()
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
                              ? '已交管理员确认'
                              : `交管理员确认 ${selected.length} 条`
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
                            <small>
                              {item.row.projectName ||
                                item.row.category ||
                                '未分类'}
                            </small>
                          </td>
                          <td>
                            {data.users.find(
                              (user) => user.id === item.row.ownerId,
                            )?.name ||
                              item.row.ownerName ||
                              '待确认'}
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
              导出项目、计划、执行记录与历史资料，用于整理、备份业务内容或迁移到其他系统。
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
                    ['plans', '月度计划'],
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
                    CSV（单一数据范围）
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
                数据包，先预览新增记录、相同记录和冲突。已存在的不同内容不会被覆盖，来源账号按邮箱匹配，也可明确指定现有账号。
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
                              <td>{count.skip}</td>
                              <td>
                                {Math.max(
                                  0,
                                  count.total - count.insert - count.skip,
                                )}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
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
                        await refresh()
                        if (historyLoaded) await loadHistory()
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
            <p>
              {historyRecord.row.ownerName || '负责人未注明'} ·{' '}
              {historyRecord.row.kind === 'monthly'
                ? historyRecord.row.month || '月份未注明'
                : historyRecord.row.weekStart || '所属周未注明'}{' '}
              · {historyRecord.row.sourceStatus || '原文状态未注明'}
            </p>
            <dl>
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
      {editing && (batch || editingHistory) && (
        <Modal
          title={
            editingHistory
              ? '纠正历史资料'
              : readOnlyEditor
                ? '查看导入记录'
                : '校对导入记录'
          }
          wide
          onClose={closeEditor}
        >
          <p className="modal-intro">
            {editingHistory
              ? '本次修改用于纠正已归档的历史资料，原始文字保持不变，纠正原因留档。关联的工作计划如需修改，请到相应计划页面处理。'
              : '校对后保存到当前批次。原始文字保留在下方，可随时对照。'}
          </p>
          <Form
            submitLabel={
              readOnlyEditor
                ? '关闭'
                : editingHistory
                  ? '保存历史纠正'
                  : '保存校对'
            }
            onCancel={closeEditor}
            onSubmit={async () => {
              if (editingHistory) {
                const saved = await api<HistoricalRecord>(
                  `/imports/history/${editingHistory.id}`,
                  json(
                    {
                      version: editingHistory.version,
                      row: editing,
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
                  batch.rows.map((row) =>
                    row.id === editing.id ? editing : row,
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
              <div className="import-form-grid">
                <Field label="内容类型">
                  <select
                    value={editing.kind}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        kind: event.target.value as ImportKind,
                      })
                    }
                  >
                    <option value="monthly">月度计划</option>
                    <option value="weekly">每周工作</option>
                  </select>
                </Field>
                <Field label="工作事项">
                  <input
                    value={editing.title}
                    maxLength={300}
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
                    {data.users
                      .filter(
                        (user) =>
                          activeUsers.some((active) => active.id === user.id) ||
                          user.id === editing.ownerId,
                      )
                      .map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name}
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
                    {data.projects
                      .filter(
                        (project) =>
                          project.status === 'active' ||
                          project.id === editing.projectId,
                      )
                      .map((project) => (
                        <option key={project.id} value={project.id}>
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
                <Field label="所属月份">
                  <input
                    type="month"
                    value={editing.month}
                    onChange={(event) =>
                      setEditing({ ...editing, month: event.target.value })
                    }
                  />
                </Field>
                <Field label="所属周（选择该周的日期）">
                  <input
                    type="date"
                    value={editing.weekStart}
                    onChange={(event) =>
                      setEditing({ ...editing, weekStart: event.target.value })
                    }
                  />
                </Field>
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
              {editing.kind === 'weekly' && (
                <div className="import-editor-relations">
                  <h3>周工作关联</h3>
                  <Field
                    label="关联已有个人任务"
                    hint={
                      batch?.mode === 'existing'
                        ? '原表已有任务可直接匹配；没有月计划关联也可导入生效。'
                        : '可关联自己的任务，或先选择月计划以新建任务。'
                    }
                  >
                    <select
                      value={editing.taskId}
                      onChange={(event) => {
                        const task = data.tasks.find(
                          (item) => item.id === event.target.value,
                        )
                        setEditing({
                          ...editing,
                          taskId: event.target.value,
                          ...(task
                            ? {
                                monthlyPlanId: task.monthlyPlanId || '',
                                ownerId: task.ownerId,
                                linkedRowId: '',
                              }
                            : {}),
                        })
                      }}
                    >
                      <option value="">新建个人任务</option>
                      {data.tasks
                        .filter(
                          (task) => manager || task.ownerId === data.user.id,
                        )
                        .map((task) => (
                          <option key={task.id} value={task.id}>
                            {task.title}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field
                    label="关联系统月计划"
                    hint={
                      batch?.mode === 'existing'
                        ? '原表没有明确关联时可留空，导入后显示“未关联月计划”。'
                        : undefined
                    }
                  >
                    <select
                      value={editing.monthlyPlanId}
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
                      {availablePlans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.month} · {plan.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="或关联本批次的月计划">
                    <select
                      value={editing.linkedRowId}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          linkedRowId: event.target.value,
                          monthlyPlanId: '',
                          taskId: '',
                        })
                      }
                    >
                      <option value="">不使用本批次月计划</option>
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
