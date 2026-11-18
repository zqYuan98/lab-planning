import { ChevronDown, Sparkles } from 'lucide-react'
import type { ImportBatch, ImportKind } from '../../shared/import-types'
import type { restoredImportOptions } from '../import-review'
import { Field } from '../ui'

export type ParseOptions = ReturnType<typeof restoredImportOptions>
interface Props {
  batch: ImportBatch
  options: ParseOptions
  onChange: (next: ParseOptions) => void
  batchBusy: boolean
  configured: boolean
  manager: boolean
  parseSource: (resumeFailed?: boolean) => Promise<void>
}

export default function ImportParseStep({ batch, options, onChange, batchBusy, configured, manager, parseSource }: Props) {
  return (
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
              <Field label="选择需要解析的工作表（可多选）">
                <select multiple value={options.sheetNames}
                  onChange={event => onChange({ ...options, sheetNames: Array.from(event.target.selectedOptions, option => option.value) })}>
                  {batch.sourceSheets.map(sheet => <option key={sheet.name} value={sheet.name}>{sheet.name} · {sheet.rowCount} 行</option>)}
                </select>
              </Field>
            )}
            <div className="import-form-grid">
              <Field label="主要内容类型">
                <select
                  value={options.kind}
                  onChange={(event) => {
                    onChange({ ...options, kind: event.target.value as ImportKind, period: '' })
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
                  type={options.kind === 'monthly' ? 'month' : 'date'}
                  value={options.period}
                  onChange={(event) => onChange({ ...options, period: event.target.value })}
                />
              </Field>
            </div>
            <Field label="补充解析说明（可选）">
              <textarea
                rows={2}
                value={options.instruction}
                onChange={(event) =>
                  onChange({ ...options, instruction: event.target.value })
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
                    !options.sheetNames.length)
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
  )
}
