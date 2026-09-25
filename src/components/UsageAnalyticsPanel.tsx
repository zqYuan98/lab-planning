import { useEffect, useMemo, useRef, useState } from 'react'
import type { UsageSettingsView, UsageSummary } from '../../shared/usage-analytics'
import { usageActionLabels, usagePageLabels } from '../../shared/usage-analytics'
import { createUsageSettingsReader, usageRequest } from '../usage-analytics'
import { finishSaved, SavedResultError } from '../api'
import { captureMutationContext } from '../mutation-response'
import { StaleReadError } from '../latest-read'
import { Field, Form, type PageProps } from '../ui'
import DirectoryAccountPicker from './DirectoryAccountPicker'

export default function UsageAnalyticsPanel({ data, notify }: PageProps) {
  const [view, setView] = useState<UsageSettingsView | null>(null), [summary, setSummary] = useState<UsageSummary | null>(null), [error, setError] = useState('')
  const [days, setDays] = useState(28)
  const [savedReadError, setSavedReadError] = useState(false), [saving, setSaving] = useState(false)
  const sending = useRef(false), context = captureMutationContext()
  const revision = useMemo(() => ({ minimum: 0 }), [data.user.id, data.user.role, context])
  const reader = useRef<ReturnType<typeof createUsageSettingsReader> | null>(null)
  useEffect(() => { setView(null); setSummary(null); setSavedReadError(false) }, [revision])
  useEffect(() => {
    const instance = createUsageSettingsReader(days, ({ settings, summary }) => {
      if (settings.settings.version < revision.minimum) throw new StaleReadError()
      revision.minimum = settings.settings.version
      setView(settings); setSummary(summary); setSavedReadError(false)
    }, error => setError(error instanceof Error ? error.message : ''))
    reader.current = instance
    if (data.user.role === 'manager') void instance.read().catch(() => {})
    return () => { instance.dispose(); if (reader.current === instance) reader.current = null }
  }, [days, revision, data.user.role])
  if (data.user.role !== 'manager') return null
  return <section className="notification-settings-card"><h2>最小使用率统计</h2>
    <p>默认关闭。开启后仅统计成员访问固定页面和成功操作的次数，管理者、观察者及排除的测试账号不计入。数据仅保存在本机，不采集正文、输入、附件、网址参数、IP 或浏览器信息。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {view ? <>
      <p role="status">当前状态：{view.effectiveEnabled ? '已开启' : '已暂停'} · 当前版本：{view.buildVersion}</p>
      {view.storageUnavailable && <p className="error" role="alert">统计存储不可用，采集和设置保存已暂停。业务功能不受影响，请联系维护人员检查统计存储。</p>}
      {view.activationRequired && <p className="note">数据环境已恢复或切换，统计已暂停。核对排除账号后重新开启；保存设置会清空旧环境的统计并开始新的观察期。</p>}
      {!view.storageUnavailable && !savedReadError && <Form key={view.settings.version} submitLabel="保存使用率设置" onSubmit={async event => {
        const currentReader = reader.current
        if (sending.current || !currentReader) return
        const form = new FormData(event.currentTarget)
        sending.current = true; setSaving(true); currentReader.invalidate()
        try {
          const next = await usageRequest<UsageSettingsView>('/settings', { method: 'PUT', body: JSON.stringify({ version: view.settings.version, enabled: form.has('enabled'), retentionDays: Number(form.get('retentionDays')), excludedUserIds: form.getAll('excludedUserIds') }) })
          if (reader.current !== currentReader || context !== captureMutationContext()) return
          revision.minimum = next.settings.version
          setView(next); setError(''); notify('使用率设置已保存')
          try { await finishSaved(() => currentReader.read(), next.settings.version) }
          catch (error) {
            if (!(error instanceof SavedResultError)) throw error
            if (reader.current === currentReader && context === captureMutationContext()) { setSavedReadError(true); setError('使用率设置已保存，但统计刷新失败。请重新读取已保存结果，无需再次提交。') }
          }
        } finally { sending.current = false; setSaving(false) }
      }}>
        <fieldset disabled={saving}>
        <label className="checkbox-label"><input type="checkbox" name="enabled" defaultChecked={view.effectiveEnabled} />启用成员最小使用率统计</label>
        <Field label="统计数据保留期"><select name="retentionDays" defaultValue={view.settings.retentionDays}><option value={90}>90 天</option><option value={30}>30 天</option></select></Field>
        <fieldset><legend>排除测试账号</legend><DirectoryAccountPicker name="excludedUserIds" purpose="usage" multiple defaultSelectedIds={view.settings.excludedUserIds} scope={`${data.user.id}:${data.operationEpoch}:${data.accessScopeVersion}:usage:${view.settings.version}`} /></fieldset>
        <p className="form-hint">排除账号会移除其现存统计。关闭后停止新增采集，已有统计按保留期自动清理。</p>
        </fieldset>
      </Form>}
      {savedReadError && <button className="button secondary" onClick={() => void reader.current?.read().catch(() => {})}>重新读取已保存结果</button>}
    </> : <p role="status">正在读取使用率设置…</p>}
    <div className="notification-section-heading"><h3>最近使用情况</h3><label>统计区间 <select aria-label="使用率统计区间" value={days} disabled={saving} onChange={event => { setError(''); setDays(Number(event.target.value)) }}><option value={7}>最近 7 天</option><option value={28}>最近 28 天</option></select></label><button className="button secondary" disabled={saving} onClick={() => void reader.current?.read().catch(() => {})}>刷新统计</button></div>
    {summary && <>
      <p>{summary.from} 至 {summary.to} · {summary.version} · 活跃成员 {summary.activeMembers} / 当前可统计成员 {summary.eligibleMembers}</p>
      <p className="form-hint">使用率分母为本区间、本版本至少有一次页面访问或成功操作的可统计成员。页面按每天、成员、版本去重；成功动作按实际操作标识去重。下表不展示个人明细。</p>
      <p className="form-hint">本版本连续启用观察跨度 {summary.observationDays} 个日历日，其中 {summary.observedDays} 天有使用记录。系统离线、节假日和职责差异仍需结合业务评估。</p>
      {summary.insufficientData && <p className="note">观察跨度不足 28 天或活跃成员不足 5 人。低频可能受周期、职责与启用范围影响，不能据此判断功能应删除。</p>}
      <table><thead><tr><th>页面 / 成功动作</th><th>去重次数</th><th>使用成员</th><th>占活跃成员</th></tr></thead><tbody>{[...summary.pages, ...summary.actions].map(row => <tr key={row.name}><td>{({ ...usagePageLabels, ...usageActionLabels })[row.name]}</td><td>{row.count}</td><td>{row.members}</td><td>{Math.round(row.memberRate * 100)}%</td></tr>)}</tbody></table>
      <p className="form-hint">统计用于了解使用情况，不自动建议删除功能。仅覆盖已列出的页面和操作。</p>
    </>}
  </section>
}
