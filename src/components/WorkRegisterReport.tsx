import { createPortal } from 'react-dom'
import { Download, Printer } from 'lucide-react'
import { createWorkRegisterSnapshot } from '../../shared/work-register'
import { workRegisterReportCsv } from '../work-register-export'
import { Modal } from '../ui'

type Snapshot = ReturnType<typeof createWorkRegisterSnapshot>

function download(snapshot: Snapshot) {
  const file = new Blob([workRegisterReportCsv(snapshot)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = `我的工作清单-${snapshot.today}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function WorkRegisterReport({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const generatedAt = new Date(snapshot.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  return createPortal(<div className="wr-report-portal"><Modal wide title="工作清单 · 汇报预览" onClose={onClose}>
    <div className="wr-report-controls"><p>已固定本次预览内容，导出和打印均以此为准。</p><div><button className="button secondary" onClick={() => window.print()}><Printer size={16} />打印 / 存为 PDF</button><button className="button primary" onClick={() => download(snapshot)}><Download size={16} />导出 CSV</button></div></div>
    <section className="wr-report" aria-label="本人工作清单汇报">
      <header className="wr-report-heading"><span>在手工作 · 汇报清单</span><h2>{snapshot.owner.name}的工作清单</h2><p>{snapshot.rangeLabel}</p><small>生成于 {generatedAt}（北京时间）</small></header>
      <div className="wr-report-summary"><span>事项 <strong>{snapshot.totalCount}</strong> 件</span><span>截止待确认 <strong>{snapshot.unknownDueDateCount}</strong> 件</span><span>需协调 <strong>{snapshot.coordinationCount}</strong> 件</span></div>
      {snapshot.rows.length ? <div className="wr-report-items">{snapshot.rows.map((row, index) => <article key={`${row.itemType}:${row.id}`} className="wr-report-item">
        <div className="wr-report-title"><span>{String(index + 1).padStart(2, '0')}</span><h3>{row.title}</h3><b>{row.status}</b></div>
        <p className="wr-report-item-type">{row.itemType}</p>
        <dl className="wr-report-facts"><div><dt>来源 / 交办人</dt><dd>{row.source} · {row.assignedBy}</dd></div><div><dt>交办日期</dt><dd>{row.assignedOn}</dd></div><div><dt>截止日期</dt><dd>{row.dueDate}</dd></div><div><dt>优先级</dt><dd>{row.priority}</dd></div><div><dt>预计剩余投入</dt><dd>{row.estimatedEffort}</dd></div><div><dt>排期 / 反馈</dt><dd>{row.schedule} · {row.waitingForFeedback}</dd></div></dl>
        <dl className="wr-report-detail"><div><dt>预期交付</dt><dd>{row.requestedOutcome}</dd></div><div><dt>当前进展</dt><dd>{row.progress}</dd></div><div><dt>下一步</dt><dd>{row.nextAction}</dd></div><div className="wr-report-decision"><dt>需领导决策 / 协调</dt><dd>{row.decisionNeeded}</dd></div></dl>
      </article>)}</div> : <p className="wr-report-empty">当前筛选范围内暂无事项。</p>}
      <footer className="wr-report-footnote">说明：预计剩余投入由本人填写；任务总体状态与周计划执行状态分别记录。</footer>
    </section>
  </Modal></div>, document.body)
}
