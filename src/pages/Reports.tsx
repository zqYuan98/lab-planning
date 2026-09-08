import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  CheckCheck,
  Download,
  FileText,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
} from 'lucide-react'
import type {
  Bootstrap,
  MonthlyPlan,
  Report,
  ReportSchedule,
} from '../../shared/types'
import { api, json } from '../api'
import {
  Badge,
  Empty,
  Field,
  Modal,
  PageHeader,
  currentMonth,
  monday,
} from '../ui'
import {
  acceptanceLabels,
  rateLabel,
  reportMetrics,
  snapshotWarnings,
  weeklyAssociationLabel,
  weeklyStatusLabels,
} from '../../server/report-metrics'
import '../reports.css'
import type { NavigationIntent } from '../navigation'

type Props = {
  data: Bootstrap
  refresh: () => Promise<void>
  notify: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
  intent?: NavigationIntent
}
const dateTime = (date: string) =>
  new Date(date).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })

export default function Reports({
  data,
  refresh,
  notify,
  onDirtyChange,
  intent,
}: Props) {
  const [selectedId, setSelectedId] = useState(''),
    [selected, setSelected] = useState<Report | null>(null)
  const [type, setType] = useState<Report['type']>('weekly'),
    [period, setPeriod] = useState(monday())
  const [title, setTitle] = useState(''),
    [narrative, setNarrative] = useState(''),
    [view, setView] = useState<'editor' | 'source'>('editor')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [highlightIds, setHighlightIds] = useState<string[]>([])
  const [schedule, setSchedule] = useState<ReportSchedule | null>(null),
    [scheduleOpen, setScheduleOpen] = useState(false)
  const [finalizeOpen, setFinalizeOpen] = useState(false)
  const history = useMemo(
    () =>
      [...data.reports].sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.revision - a.revision,
      ),
    [data.reports],
  )
  const unsaved = Boolean(
    selected && (title !== selected.title || narrative !== selected.narrative),
  )
  const editable = selected?.status === 'draft'
  const metrics = selected ? reportMetrics(selected.snapshot) : null
  const warnings = selected ? snapshotWarnings(selected) : []
  useEffect(() => {
    onDirtyChange?.(unsaved)
    return () => onDirtyChange?.(false)
  }, [unsaved, onDirtyChange])

  function choose(report: Report) {
    setSelectedId(report.id)
    setSelected(report)
    setTitle(report.title)
    setNarrative(report.narrative)
    setHighlightIds([])
    setError('')
  }
  useEffect(() => {
    if (selectedId) return
    if (intent?.action === 'write-weekly') {
      const draft = history.find(
        (report) =>
          report.type === 'weekly' &&
          report.period === monday() &&
          report.status === 'draft',
      )
      if (draft) choose(draft)
      return
    }
    if (history[0]) choose(history[0])
  }, [history, selectedId, intent?.action])
  useEffect(() => {
    if (!unsaved) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [unsaved])
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }
  const canLeave = () =>
    !unsaved || window.confirm('当前汇报正文尚未保存。继续将放弃这些编辑。')
  async function generate(reportType = type, reportPeriod = period) {
    if (!canLeave()) return
    await action(async () => {
      const report = await api<Report>(
        '/reports',
        json({ type: reportType, period: reportPeriod }),
      )
      choose(report)
      setView('editor')
      await refresh()
      notify(
        `已生成${reportType === 'weekly' ? '周报' : '月报'}第 ${report.revision} 版草稿。`,
      )
    })
  }
  async function save() {
    if (!selected) return
    await action(async () => {
      const report = await api<Report>(
        `/reports/${selected.id}`,
        json({ version: selected.version, title, narrative }, 'PATCH'),
      )
      choose(report)
      await refresh()
      notify('汇报草稿已保存，源事实保持生成时状态。')
    })
  }
  async function openSchedule() {
    await action(async () => {
      setSchedule(await api<ReportSchedule>('/report-schedule'))
      setScheduleOpen(true)
    })
  }
  function insertHighlights() {
    if (!selected || !highlightIds.length) return
    const s = selected.snapshot
    const rows =
      selected.type === 'weekly'
        ? s.weeklyRecords
            .filter((r) => highlightIds.includes(r.id))
            .map(
              (r) =>
                `- ${s.tasks.find((t) => t.id === r.taskId)?.title || r.commitment}｜${weeklyStatusLabels[r.status]}；实际成果：${r.actualOutcome || '待补充'}`,
            )
        : s.plans
            .filter((p) => highlightIds.includes(p.id))
            .map(
              (p) =>
                `- ${p.title}｜${acceptanceLabels[p.acceptanceStatus]}；实际成果：${p.actualOutcome || '待补充'}`,
            )
    setNarrative(
      `${narrative}\n\n## 重点工作 TOP ${rows.length}\n${rows.join('\n')}`,
    )
    notify('重点已加入正文。全量统计没有变化，请保存草稿。')
  }
  if (data.user.role !== 'manager')
    return (
      <Empty
        title="报告中心面向部门管理者"
        description="你的周计划和实际成果会进入管理者汇报。"
      />
    )
  return (
    <div className="reports-page">
      <PageHeader
        eyebrow="MANAGEMENT / REPORTS"
        title="报告中心"
        description="让计划、成果与管理判断各有依据。"
        actions={
          <button
            className="button secondary"
            disabled={busy}
            onClick={openSchedule}
          >
            <CalendarClock size={17} />
            自动草稿设置
          </button>
        }
      />
      {intent?.action === 'write-weekly' && !selected && (
        <div className="navigation-context">
          <span>
            本周尚无可编辑草稿，点击下方「生成汇报草稿」开始撰写。原有定稿将保留。
          </span>
        </div>
      )}
      <section className="report-generator" aria-label="生成管理者汇报">
        <div>
          <FileText size={22} />
          <span>
            <strong>从当前事实生成新版本</strong>
            <small>生成时固定数据，之后的计划调整保留在下一版。</small>
          </span>
        </div>
        <label>
          <span className="sr-only">报告类型</span>
          <select
            value={type}
            onChange={(e) => {
              const next = e.target.value as Report['type']
              setType(next)
              setPeriod(next === 'weekly' ? monday() : currentMonth())
            }}
          >
            <option value="weekly">部门周报</option>
            <option value="monthly">部门月报</option>
          </select>
        </label>
        <label>
          <span className="sr-only">报告周期</span>
          <input
            aria-label="报告周期"
            type={type === 'weekly' ? 'date' : 'month'}
            required
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </label>
        <button
          className="button primary"
          disabled={busy || !period}
          onClick={() => generate()}
        >
          <Plus size={17} />
          {busy ? '处理中…' : '生成汇报草稿'}
        </button>
      </section>
      {error && (
        <div role="alert" className="error report-error">
          {error}
        </div>
      )}
      <div className="report-workspace">
        <aside className="report-history" aria-label="报告历史版本">
          <div className="report-history-title">
            <h2>汇报档案</h2>
            <span>{history.length}</span>
          </div>
          {history.length ? (
            history.map((r) => (
              <button
                key={r.id}
                className={`report-history-item ${selectedId === r.id ? 'is-selected' : ''}`}
                aria-pressed={selectedId === r.id}
                disabled={busy}
                onClick={() => {
                  if (canLeave()) choose(r)
                }}
              >
                <span className="report-history-type">
                  {r.type === 'weekly' ? '周报' : '月报'}{' '}
                  <small>V{r.revision}</small>
                </span>
                <strong>{r.period}</strong>
                <span>
                  <Badge tone={r.status === 'finalized' ? 'green' : 'amber'}>
                    {r.status === 'finalized' ? '已定稿' : '待确认草稿'}
                  </Badge>
                  <small>{dateTime(r.createdAt).split(' ')[0]}</small>
                </span>
              </button>
            ))
          ) : (
            <p className="report-quiet">生成第一份报告后，版本会保存在这里。</p>
          )}
        </aside>
        <section className="report-document">
          {!selected || !metrics ? (
            <Empty
              title="准备好本期汇报"
              description="选择周报或月报与周期，系统会读取全量计划和实际进展，形成可编辑、可追溯的中文草稿。"
            />
          ) : (
            <>
              <header className="report-document-header">
                <div>
                  <span className="report-overline">
                    {selected.type === 'weekly'
                      ? 'WEEKLY REVIEW'
                      : 'MONTHLY REVIEW'}{' '}
                    / V{selected.revision}
                  </span>
                  <h2>{selected.title}</h2>
                  <p>数据截至 {dateTime(selected.createdAt)} · 上海时间</p>
                </div>
                <Badge tone={editable ? 'amber' : 'green'}>
                  {editable
                    ? unsaved
                      ? '编辑未保存'
                      : '草稿已保存'
                    : '已定稿 · 内容锁定'}
                </Badge>
              </header>
              <div
                className="report-source-stats"
                aria-label="固定快照全量统计"
              >
                <div>
                  <span>已发布月计划</span>
                  <strong>
                    {metrics.monthly.total}
                    <small>项</small>
                  </strong>
                  <p>
                    {metrics.monthly.accepted} 项已验收 ·{' '}
                    {metrics.monthly.awaitingReview} 项待验收
                  </p>
                </div>
                <div>
                  <span>月度验收完成率</span>
                  <strong
                    className={
                      metrics.monthly.rate === null ? 'report-no-rate' : ''
                    }
                  >
                    {rateLabel(metrics.monthly.rate)}
                  </strong>
                  <p>分母为快照中的已发布月计划</p>
                </div>
                <div>
                  <span>已提交周记录</span>
                  <strong>
                    {metrics.weekly.total}
                    <small>条</small>
                  </strong>
                  <p>
                    {metrics.weekly.done} 条成员自报完成 ·{' '}
                    {metrics.weekly.drafts} 条未提交草稿
                  </p>
                </div>
                <div>
                  <span>周度自报完成率</span>
                  <strong
                    className={
                      metrics.weekly.rate === null ? 'report-no-rate' : ''
                    }
                  >
                    {rateLabel(metrics.weekly.rate)}
                  </strong>
                  <p>反映成员执行进展，月成果另行验收</p>
                </div>
              </div>
              <p className="report-stat-note">
                月计划范围：
                {[...new Set(selected.snapshot.plans.map((p) => p.month))]
                  .sort()
                  .join('、') || '暂无月计划'}
                。统计来自生成时的全量源记录，选择重点、修改正文不会改变统计；跨月周记录在月报中作为进展参考，不重复计作月度成果。
              </p>
              <nav className="report-tabs" aria-label="报告内容">
                <button
                  aria-pressed={view === 'editor'}
                  onClick={() => setView('editor')}
                >
                  汇报正文
                </button>
                <button
                  aria-pressed={view === 'source'}
                  onClick={() => setView('source')}
                >
                  源事实与计划版本
                </button>
              </nav>
              {view === 'editor' ? (
                <div className="report-edit-area">
                  {warnings.length > 0 && (
                    <details className="report-checks">
                      <summary>{warnings.length} 项待补充或待确认</summary>
                      <ul>
                        {warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <Field label="报告标题">
                    <input
                      value={title}
                      maxLength={200}
                      disabled={!editable || busy}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </Field>
                  <Field
                    label="管理者汇报正文"
                    hint="支持 Markdown。这里只编辑汇报文字；如需纠正实际成果，请到原计划更新并生成新版本。"
                  >
                    <textarea
                      className="report-narrative"
                      value={narrative}
                      disabled={!editable || busy}
                      onChange={(e) => setNarrative(e.target.value)}
                      spellCheck={false}
                    />
                  </Field>
                  {editable && (
                    <details className="report-highlights">
                      <summary>选择重点工作，加入正文</summary>
                      <p>
                        选取范围只影响重点展示；上方的全量统计始终保持原口径。
                      </p>
                      <div>
                        {(selected.type === 'weekly'
                          ? selected.snapshot.weeklyRecords
                              .filter((r) => r.submitted)
                              .map((r) => ({
                                id: r.id,
                                title:
                                  selected.snapshot.tasks.find(
                                    (t) => t.id === r.taskId,
                                  )?.title || r.commitment,
                                status: weeklyStatusLabels[r.status],
                              }))
                          : selected.snapshot.plans
                              .filter((p) => p.status === 'published')
                              .map((p) => ({
                                id: p.id,
                                title: p.title,
                                status: acceptanceLabels[p.acceptanceStatus],
                              }))
                        ).map((row) => (
                          <label key={row.id}>
                            <input
                              type="checkbox"
                              checked={highlightIds.includes(row.id)}
                              onChange={(e) =>
                                setHighlightIds(
                                  e.target.checked
                                    ? [...highlightIds, row.id]
                                    : highlightIds.filter(
                                        (id) => id !== row.id,
                                      ),
                                )
                              }
                            />
                            <span>{row.title}</span>
                            <small>{row.status}</small>
                          </label>
                        ))}
                      </div>
                      <button
                        className="button secondary"
                        disabled={busy || !highlightIds.length}
                        onClick={insertHighlights}
                      >
                        将选中的 {highlightIds.length} 项加入正文
                      </button>
                    </details>
                  )}
                  {editable && (
                    <div className="report-ai">
                      <div>
                        <Sparkles size={17} />
                        <span>
                          {data.aiConfigured
                            ? '可将已保存正文和计划事实发送到已配置的 AI 服务润色；结果仍需管理者确认。'
                            : '当前使用规则生成，所有汇报功能均可使用。配置 AI 服务后可手动润色。'}
                        </span>
                      </div>
                      <button
                        className="button secondary"
                        disabled={busy || unsaved || !data.aiConfigured}
                        onClick={() =>
                          action(async () => {
                            const r = await api<Report>(
                              `/reports/${selected.id}/polish`,
                              json({ version: selected.version }),
                            )
                            choose(r)
                            await refresh()
                            notify('AI 润色已保存为草稿，请核对事实与措辞。')
                          })
                        }
                      >
                        <Sparkles size={15} />
                        发送事实并润色
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <SourceFacts report={selected} />
              )}
              <footer className="report-document-footer">
                <div className="report-downloads">
                  <a
                    className="button secondary"
                    href={`/api/reports/${selected.id}/export?format=docx`}
                  >
                    <Download size={16} />
                    下载 Word
                  </a>
                  <a
                    className="button secondary"
                    href={`/api/reports/${selected.id}/export?format=md`}
                  >
                    Markdown
                  </a>
                </div>
                <div>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => generate(selected.type, selected.period)}
                  >
                    <RefreshCw size={15} />
                    重新生成新版本
                  </button>
                  {editable && (
                    <>
                      <button
                        className="button secondary"
                        disabled={busy || !unsaved || !title.trim()}
                        onClick={save}
                      >
                        <Save size={16} />
                        保存草稿
                      </button>
                      <button
                        className="button primary"
                        disabled={busy || unsaved}
                        onClick={() => setFinalizeOpen(true)}
                      >
                        <CheckCheck size={16} />
                        确认定稿
                      </button>
                    </>
                  )}
                </div>
              </footer>
              {unsaved && (
                <p className="report-export-note">
                  下载内容以已保存版本为准，请先保存当前编辑。
                </p>
              )}
            </>
          )}
        </section>
      </div>
      {finalizeOpen && selected && (
        <Modal title="确认本期汇报定稿" onClose={() => setFinalizeOpen(false)}>
          <p className="report-modal-copy">
            将「{selected.title}」第 {selected.revision}{' '}
            版保存为正式汇报。正文和引用数据会锁定；后续调整通过生成新版本保留历史。
          </p>
          {warnings.length > 0 && (
            <p className="report-modal-warning">
              源记录中还有 {warnings.length}{' '}
              项待补充或待确认，已随报告明确标记。请确认汇报已如实说明。
            </p>
          )}
          <div className="form-footer">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setFinalizeOpen(false)}
            >
              继续核对
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const r = await api<Report>(
                    `/reports/${selected.id}/finalize`,
                    json({ version: selected.version }),
                  )
                  choose(r)
                  setFinalizeOpen(false)
                  await refresh()
                  notify('汇报已定稿，源快照与正文已锁定。')
                })
              }
            >
              确认定稿
            </button>
          </div>
        </Modal>
      )}
      {scheduleOpen && schedule && (
        <Modal
          title="自动生成待确认草稿"
          onClose={() => setScheduleOpen(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              action(async () => {
                setSchedule(
                  await api<ReportSchedule>(
                    '/report-schedule',
                    json(schedule, 'PUT'),
                  ),
                )
                setScheduleOpen(false)
                notify('自动草稿设置已保存。')
              })
            }}
          >
            <p className="report-modal-copy">
              按上海时间生成规则草稿，保存后等待管理者确认。同一周期自动生成一次，服务需在触发日运行；不会自动润色或发送外部通知。
            </p>
            <label className="report-schedule-toggle">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(e) =>
                  setSchedule({ ...schedule, enabled: e.target.checked })
                }
              />
              <span>启用自动生成</span>
              <Badge tone={schedule.enabled ? 'green' : 'neutral'}>
                {schedule.enabled ? '已开启' : '默认关闭'}
              </Badge>
            </label>
            <div className="report-schedule-grid">
              <Field label="周报触发日">
                <select
                  value={schedule.weeklyDay}
                  onChange={(e) =>
                    setSchedule({
                      ...schedule,
                      weeklyDay: Number(e.target.value),
                    })
                  }
                >
                  {['一', '二', '三', '四', '五', '六', '日'].map(
                    (label, i) => (
                      <option key={i} value={i + 1}>
                        星期{label}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="周报时间">
                <input
                  type="time"
                  required
                  value={schedule.weeklyTime}
                  onChange={(e) =>
                    setSchedule({ ...schedule, weeklyTime: e.target.value })
                  }
                />
              </Field>
              <Field label="月报触发日">
                <select
                  value={schedule.monthlyDay}
                  onChange={(e) =>
                    setSchedule({
                      ...schedule,
                      monthlyDay: Number(e.target.value),
                    })
                  }
                >
                  <option value={0}>每月最后一天（生成当月）</option>
                  {Array.from({ length: 28 }, (_, i) => (
                    <option key={i} value={i + 1}>
                      每月 {i + 1} 日（生成上月）
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="月报时间">
                <input
                  type="time"
                  required
                  value={schedule.monthlyTime}
                  onChange={(e) =>
                    setSchedule({ ...schedule, monthlyTime: e.target.value })
                  }
                />
              </Field>
            </div>
            <p className="report-quiet">
              周报生成触发日所在周。时区固定为 Asia/Shanghai。
            </p>
            <div className="form-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setScheduleOpen(false)}
              >
                取消
              </button>
              <button className="button primary" type="submit" disabled={busy}>
                保存设置
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}

function SourceFacts({ report }: { report: Report }) {
  const s = report.snapshot
  const person = (id: string) =>
    s.users.find((u) => u.id === id)?.name || '未找到负责人'
  const originals = new Map<string, MonthlyPlan>()
  for (const publication of s.publications)
    for (const plan of publication.plans)
      if (!originals.has(plan.id)) originals.set(plan.id, plan)
  return (
    <div className="report-facts">
      <section>
        <h3>年度目标 · 独立记录</h3>
        <p>仅引用生成时已记录的年度进展，不使用月计划完成条数推算。</p>
        {s.annualGoals.length ? (
          <div className="report-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>目标</th>
                  <th>目标值 / 验收方向</th>
                  <th>负责人</th>
                  <th>确认进展</th>
                </tr>
              </thead>
              <tbody>
                {s.annualGoals.map((g) => (
                  <tr key={g.id}>
                    <td>{g.title}</td>
                    <td>{g.target}</td>
                    <td>{person(g.ownerId)}</td>
                    <td className="report-number">{g.progress}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="report-empty-inline">本年度尚未记录目标。</p>
        )}
      </section>
      <section>
        <h3>发布版本与原计划对照</h3>
        {s.publications.length ? (
          <div className="report-publications">
            {s.publications.map((p) => (
              <div key={p.id}>
                <Badge tone="green">
                  {p.month} · V{p.revision}
                </Badge>
                <span>{dateTime(p.createdAt)}</span>
                <p>{p.reason || '首次发布或未补充说明'}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="report-empty-inline">本期尚无发布版本。</p>
        )}
        {originals.size > 0 && (
          <div className="report-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>月计划</th>
                  <th>首次发布承诺</th>
                  <th>当前承诺</th>
                </tr>
              </thead>
              <tbody>
                {s.plans
                  .filter((p) => originals.has(p.id))
                  .map((p) => (
                    <tr key={p.id}>
                      <td>{p.title}</td>
                      <td>
                        {originals.get(p.id)!.expectedOutcome}
                        <small>截止 {originals.get(p.id)!.dueDate}</small>
                      </td>
                      <td>
                        {p.expectedOutcome}
                        <small>截止 {p.dueDate}</small>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="report-change-log">
          <summary>查看 {s.changes.length} 条提报与调整记录</summary>
          {s.changes.map((e) => (
            <div key={e.id}>
              <strong>
                {s.plans.find((p) => p.id === e.entityId)?.title || e.entityId}{' '}
                · {e.action}
              </strong>
              <span>
                {person(e.actorId)} / {dateTime(e.createdAt)}
              </span>
              <p>{e.reason || '未附加原因'}</p>
            </div>
          ))}
        </details>
      </section>
      <section>
        <h3>完整月计划与成果验收</h3>
        {s.plans.length ? (
          <div className="report-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>月计划 / 负责人</th>
                  <th>承诺与验收标准</th>
                  <th>实际成果</th>
                  <th>验收状态</th>
                </tr>
              </thead>
              <tbody>
                {s.plans.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.title}
                      <small>
                        {person(p.ownerId)} · {p.month}
                      </small>
                      <Badge
                        tone={p.status === 'published' ? 'green' : 'amber'}
                      >
                        {p.status === 'published'
                          ? '已发布'
                          : p.status === 'merged'
                            ? '已合并，不计统计'
                            : '未发布，不计正式统计'}
                      </Badge>
                    </td>
                    <td>
                      {p.expectedOutcome}
                      <small>验收：{p.acceptanceCriteria}</small>
                      <small>截止：{p.dueDate}</small>
                    </td>
                    <td>
                      {p.actualOutcome || '尚未填写实际成果'}
                      {p.acceptanceNote && <small>{p.acceptanceNote}</small>}
                    </td>
                    <td>{acceptanceLabels[p.acceptanceStatus]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="report-empty-inline">暂无月计划。</p>
        )}
      </section>
      <section>
        <h3>完整周记录与成员自报</h3>
        {s.weeklyRecords.length ? (
          <div className="report-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>任务 / 周期</th>
                  <th>本周承诺</th>
                  <th>实际成果 / 证据</th>
                  <th>阻塞与下一步</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {s.weeklyRecords.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {s.tasks.find((t) => t.id === r.taskId)?.title ||
                        r.taskId}
                      <small>
                        {person(r.ownerId)} · {r.weekStart}
                      </small>
                      <small>{weeklyAssociationLabel(s, r)}</small>
                    </td>
                    <td>{r.commitment}</td>
                    <td>
                      {r.actualOutcome || '尚未填写实际成果'}
                      {r.evidenceUrl ? (
                        <a
                          href={r.evidenceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看证据
                        </a>
                      ) : (
                        <small>证据待补充</small>
                      )}
                    </td>
                    <td>
                      {r.blocker || '未填写阻塞'}
                      <small>下一步：{r.nextAction || '待补充'}</small>
                    </td>
                    <td>
                      {weeklyStatusLabels[r.status]}
                      {!r.submitted && <small>未提交草稿，不计正式统计</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="report-empty-inline">暂无当期周记录。</p>
        )}
      </section>
      <section>
        <h3>下月安排与发布状态</h3>
        {s.nextPlans.length ? (
          <div className="report-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>事项</th>
                  <th>预期成果</th>
                  <th>负责人 / 截止</th>
                  <th>承诺状态</th>
                </tr>
              </thead>
              <tbody>
                {s.nextPlans.map((p) => (
                  <tr key={p.id}>
                    <td>{p.title}</td>
                    <td>{p.expectedOutcome}</td>
                    <td>
                      {person(p.ownerId)}
                      <small>{p.dueDate}</small>
                    </td>
                    <td>
                      <Badge
                        tone={p.status === 'published' ? 'green' : 'amber'}
                      >
                        {p.status === 'published' ? '已发布承诺' : '未发布草案'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="report-empty-inline">下月计划待提报。</p>
        )}
      </section>
    </div>
  )
}
