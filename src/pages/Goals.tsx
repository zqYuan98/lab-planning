import { useState } from 'react'
import type { AnnualGoalDetail, GoalsPage } from '../../shared/directory-workspace'
import DirectoryAccountPicker, { directoryAccountName } from '../components/DirectoryAccountPicker'
import DirectoryPagination, { firstDirectoryPage } from '../components/DirectoryPagination'
import { useWorkspaceQuery } from '../workspace-query'
import { Plus, Target } from 'lucide-react'
import type { AnnualGoal } from '../../shared/types'
import { api, json, finishSaved } from '../api'
import '../portfolio.css'
import {
  Badge,
  Empty,
  Field,
  Form,
  Modal,
  PageHeader,
  type PageProps,
} from '../ui'
export default function Goals({ data, notify }: PageProps) {
  const [year, setYear] = useState(new Date().getFullYear()),
    [editing, setEditing] = useState<AnnualGoal | 'new' | null>(null),
    [paging, setPaging] = useState(firstDirectoryPage),
    [detailId, setDetailId] = useState<string | null>(null)
  const goal = editing && editing !== 'new' ? editing : null,
    manager = data.user.role === 'manager'
  const scope = `${data.user.id}:${data.user.role}:${data.operationEpoch}:${data.accessScopeVersion}`
  const params = new URLSearchParams({ year: String(year), limit: '30' })
  if (paging.cursor) params.set('cursor', paging.cursor)
  const query = useWorkspaceQuery<GoalsPage>(`/workspace/annual-goals?${params}`, scope, undefined, { onCursorStale: () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging(firstDirectoryPage()); return `/workspace/annual-goals?${first}` } })
  const reloadFirst = async () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging(firstDirectoryPage()); await query.reload(`/workspace/annual-goals?${first}`) }
  const goals = query.value?.items ?? []
  return (
    <>
      <PageHeader
        eyebrow="DIRECTION / ANNUAL GOALS"
        title="年度目标"
        description="关联月度成果，按已验收的承接链计算年度进展，并保留人工覆盖。"
        actions={
          manager && (
            <button
              className="button primary"
              onClick={() => setEditing('new')}
            >
              <Plus size={17} />
              新增年度目标
            </button>
          )
        }
      />
      <div className="toolbar goals-toolbar">
        <label className="inline-field">
          目标年份
          <input
            type="number"
            min="2020"
            max="2100"
            value={year}
            onChange={(event) => { setYear(Number(event.target.value)); setPaging(firstDirectoryPage()) }}
          />
        </label>
        <p className="subtle-note">
          自动进展按本年度已验收承接链计算；同链跨月与拆分只计一次。当前仅汇总您有权查看的月目标。
        </p>
      </div>
      {query.error && <p className="error" role="alert">{query.error}<button className="text-button" onClick={() => { setPaging(firstDirectoryPage()); void reloadFirst().catch(() => {}) }}>重新读取</button></p>}
      {query.loading && !query.value && <p role="status">正在读取年度目标…</p>}
      {query.value && <><p className="form-hint">进行中 {query.value.counts.active} · 已完成 {query.value.counts.completed}</p><DirectoryPagination total={query.value.total} nextCursor={query.value.nextCursor} paging={paging} setPaging={setPaging} loading={query.loading} /></>}
      {goals.length ? (
        <div className="goal-list">
          {goals.map((item) => (
            <section key={item.id} className="panel goal-card">
              <div className="goal-heading">
                <span className="goal-icon">
                  <Target size={26} />
                </span>
                <div>
                  <Badge tone={item.status === 'completed' ? 'green' : 'blue'}>
                    {item.status === 'completed' ? '已完成' : '进行中'}
                  </Badge>
                  <h2>{item.title}</h2>
                </div>
                {manager && (
                  <button
                    className="button secondary"
                    onClick={() => setEditing(item)}
                  >
                    更新目标
                  </button>
                )}
              </div>
              <div className="goal-body">
                <div>
                  <span className="label-text">年度目标 / 衡量标准</span>
                  <p>{item.target}</p>
                  <span className="label-text">进展说明</span>
                  <p>{item.description || '尚未填写进展说明'}</p>
                  <small>负责人 · {directoryAccountName(item.owner)}</small>
                </div>
                <div className="goal-progress">
                  <strong>
                    {item.progressSummary.effectiveProgress ?? '—'}
                    {item.progressSummary.effectiveProgress !== null && <small>%</small>}
                  </strong>
                  <span>{item.progressSummary.manualOverride ? '人工覆盖' : '关联成果进展'}</span><p>自动值：{item.progressSummary.autoProgress === null ? '暂无关联' : `${item.progressSummary.autoProgress}%`} · 已验收 {item.progressSummary.acceptedChainCount}/{item.progressSummary.chainCount} 链</p><button className="text-button" onClick={() => setDetailId(item.id)}>查看关联月目标（{item.progressSummary.linkedPlanCount}）</button>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label={`${item.title}进展`}
                    aria-valuenow={item.progressSummary.effectiveProgress ?? undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div style={{ width: `${item.progressSummary.effectiveProgress ?? 0}%` }} />
                  </div>
                </div>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title="为这一年记录共同方向"
            description="可记录技术能力、项目交付、团队建设等年度目标。"
            action={
              manager && (
                <button
                  className="button secondary"
                  onClick={() => setEditing('new')}
                >
                  新增年度目标
                </button>
              )
            }
          />
        </div>
      )}
      {detailId && <AnnualDetail id={detailId} scope={scope} onClose={() => setDetailId(null)} />}
      {editing && (
        <Modal
          title={goal ? '更新年度目标' : '新增年度目标'}
          onClose={() => setEditing(null)}
          wide
        >
          <Form
            onCancel={() => setEditing(null)}
            onSubmit={async (event) => {
              const values = Object.fromEntries(
                new FormData(event.currentTarget),
              )
              const saved = await api<AnnualGoal>(
                goal ? `/annual-goals/${goal.id}` : '/annual-goals',
                json(
                  {
                    ...values,
                    ownerId: values.ownerId || goal?.ownerId,
                    year: Number(values.year),
                    progress: Number(values.progress),
                    ...(goal ? { version: goal.version } : {}),
                  },
                  goal ? 'PATCH' : 'POST',
                ),
              )
              notify('年度目标已保存')
              await finishSaved(async () => { await reloadFirst(); setEditing(null) }, saved.version)
              setEditing(null)
            }}
          >
            <Field label="目标名称">
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={goal?.title}
              />
            </Field>
            <div className="form-grid">
              <Field label="年份">
                <input
                  name="year"
                  type="number"
                  min="2020"
                  max="2100"
                  defaultValue={goal?.year || year}
                  required
                />
              </Field>
              <div className="field"><span>负责人</span>
                <DirectoryAccountPicker name="ownerId" defaultSelectedIds={[goal?.ownerId || data.user.id]} scope={`${scope}:${goal?.id ?? 'new'}`} />
              </div>
            </div>
            <Field label="目标及衡量标准">
              <textarea
                name="target"
                rows={3}
                required
                defaultValue={goal?.target}
              />
            </Field>
            <div className="form-grid">
              <Field label="进展方式"><select name="progressMode" defaultValue={goal?.progressMode ?? 'manual'}><option value="manual">人工覆盖</option><option value="linked">按关联成果自动计算</option></select></Field>
              <Field label="人工确认进展（%）" hint="切换到自动计算后，此人工值仍保留。">
                <input
                  name="progress"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  defaultValue={goal?.progress || 0}
                  required
                />
              </Field>
              {goal && (
                <Field label="状态">
                  <select name="status" defaultValue={goal.status}>
                    <option value="active">进行中</option>
                    <option value="completed">已完成</option>
                  </select>
                </Field>
              )}
            </div>
            <Field label="进展说明">
              <textarea
                name="description"
                rows={4}
                defaultValue={goal?.description}
                placeholder="说明已达成的事实、依据及后续重点"
              />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  )
}

function AnnualDetail({ id, scope, onClose }: { id: string; scope: string; onClose: () => void }) {
  const [paging, setPaging] = useState(firstDirectoryPage)
  const path = `/workspace/annual-goals/${encodeURIComponent(id)}?limit=20${paging.cursor ? `&cursor=${encodeURIComponent(paging.cursor)}` : ''}`
  const query = useWorkspaceQuery<AnnualGoalDetail>(path, scope, undefined, { onCursorStale: () => { setPaging(firstDirectoryPage()); return `/workspace/annual-goals/${encodeURIComponent(id)}?limit=20` } })
  const summary = query.value?.goal.progressSummary
  return <Modal title={query.value?.goal.title ?? '关联月目标'} onClose={onClose} wide>
    {query.error && <p role="alert" className="error">{query.error}<button onClick={() => { setPaging(firstDirectoryPage()); void query.reload(`/workspace/annual-goals/${encodeURIComponent(id)}?limit=20`).catch(() => {}) }}>重新读取</button></p>}
    {query.loading && !query.value && <p role="status">正在读取关联成果…</p>}
    {query.value && summary && <>
      <p>授权范围全部关联：{summary.linkedPlanCount} 项，{summary.chainCount} 条承接链；已验收 {summary.acceptedChainCount} 条，自动进展 {summary.autoProgress === null ? '暂无关联' : `${summary.autoProgress}%`}。{summary.manualOverride ? `当前人工覆盖 ${query.value.goal.progress}%。` : ''}</p>
      {query.value.items.map(plan => <article key={plan.id} className="context-box"><strong>{plan.month} · {plan.title}</strong><p>{plan.status === 'published' ? '已发布' : '未发布'} · {plan.acceptanceStatus === 'accepted' ? '已验收' : '待验收'}{plan.sourcePlanId ? ' · 承接事项' : ''}</p><p>{plan.expectedOutcome}</p></article>)}
      {!query.value.total && <p>暂无关联月目标。</p>}
      <DirectoryPagination total={query.value.total} nextCursor={query.value.nextCursor} paging={paging} setPaging={setPaging} loading={query.loading} />
    </>}
  </Modal>
}
