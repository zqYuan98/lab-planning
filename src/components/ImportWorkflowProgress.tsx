import { ArrowRight, Check } from 'lucide-react'
import type { ImportBatch } from '../../shared/import-types'
import { importedDraftMonths, type ImportCommitBlocker, type ImportReviewSection } from '../import-review'
import type { Navigate } from '../navigation'

export default function ImportWorkflowProgress({ batch, manager, sourceReady, blockers, disabled, onGo, navigate }: {
  batch: ImportBatch
  manager: boolean
  sourceReady: boolean
  blockers: ImportCommitBlocker[]
  disabled: boolean
  onGo: (section: ImportReviewSection) => void
  navigate?: Navigate
}) {
  if (batch.status === 'committed') {
    const months = importedDraftMonths(batch)
    return months.length ? <section className="import-next-step" aria-label="导入后的下一步">
      <div><h3>草稿已生成，下一步审核发布</h3>
        <p>{manager ? '新生成的月度目标仍是草稿。请前往月度目标页核对并发布，发布后才能正式安排执行。' : '新生成的月度目标仍是草稿。请前往月度目标页提交审核，由管理员发布后再正式安排执行。'}</p></div>
      {navigate && <div className="import-next-step-actions">{months.map(month => <button type="button" className="button primary" disabled={disabled} key={month} onClick={() => navigate('monthly', { month })}>前往 {month} 月度目标<ArrowRight size={16} /></button>)}</div>}
    </section> : null
  }
  const next = blockers[0]
  const managerReview = !manager && batch.mode === 'existing'
  const contentReady = !blockers.some(item => ['rows', 'completeness', 'mode'].includes(item.section))
  const steps: { label: string; section: ImportReviewSection; done: boolean }[] = [
    { label: batch.dingtalk ? '处理来源差异' : '选择保存方式', section: batch.dingtalk ? 'source' : 'mode', done: sourceReady },
    { label: '核对内容与完整性', section: 'rows', done: sourceReady && contentReady && !managerReview },
    { label: batch.mode === 'draft' ? '导入草稿' : batch.mode === 'history' ? '保存历史资料' : manager ? '确认导入生效' : '交管理员核对', section: 'commit', done: false },
  ]
  const currentStep = !sourceReady ? 0 : !contentReady ? 1 : 2
  return <section className="import-workflow" aria-label="本批次导入步骤">
    <ol>{steps.map((step, index) => <li key={step.section} className={step.done ? 'is-complete' : index === currentStep ? 'is-current' : ''}>
      <button type="button" disabled={disabled} aria-current={index === currentStep ? 'step' : undefined} onClick={() => onGo(step.section)}>
        <span className="import-step-number">{step.done ? <Check size={16} /> : index + 1}</span>
        <span>{step.label}<small>{step.done ? '已完成' : index === 1 && managerReview ? '由管理员核对' : index === currentStep ? '当前步骤' : '待完成'}</small></span>
      </button>
    </li>)}</ol>
    <div className="import-workflow-next">
      <div><strong>{next ? '接下来需要完成' : batch.mode === 'existing' && !manager ? '可以提交给管理员核对' : '校对已完成，可以确认导入'}</strong>
        <p>{next?.message || (batch.mode === 'draft' ? `本次选中 ${batch.rows.filter(row => row.selected).length} 条记录。导入后仍需审核发布，不会自动成为正式月度目标。` : '请核对下方的导入方式、记录数量和生效范围后确认。')}</p></div>
      <button type="button" className="button secondary" disabled={disabled} onClick={() => onGo(next?.section || 'commit')}>{next?.action || '查看最终确认'}<ArrowRight size={16} /></button>
    </div>
  </section>
}
