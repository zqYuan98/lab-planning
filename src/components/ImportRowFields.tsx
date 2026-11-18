import { useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { LIMITS } from '../../shared/entity-rules'
import { canUseAccount } from '../../shared/auth-policy'
import type { ImportBatch, ImportKind, ImportRow } from '../../shared/import-types'
import type { ImportCandidateKind, ImportReferences } from '../../shared/import-workspace'
import { importedMonthlyResult, importedWeeklyStatus } from '../../shared/import-status'
import { accountDisplayName } from '../account-options'
import { importWorkFields, selectImportTask, type ImportWorkFields } from '../import-review'
import { Field } from '../ui'
import AnnualGoalPicker from './AnnualGoalPicker'

export const monthlyResultLabels = {
  pending: '尚无成果记录',
  submitted: '成果已记录，验收待确认',
  accepted: '已验收（管理员确认）',
  not_completed: '未完成',
}
export const weeklyResultLabels = {
  planned: '未开始 / 原状态未明确',
  doing: '进行中',
  blocked: '受阻',
  done: '已完成',
  not_done: '未完成',
}

const steps = {
  source: '事项与原文', plan: '计划与周期', people: '负责人与项目', assignment: '交办与投入',
  links: '周工作关联', status: '状态与截止日期', outcome: '成果与下一步',
}
type Step = keyof typeof steps
interface Props {
  batch: ImportBatch | null
  editing: ImportRow
  setEditing: (row: ImportRow) => void
  data: ImportReferences & { user: ImportReferences['users'][number] }
  scope: string
  activeUsers: ImportReferences['users']
  availablePlans: ImportReferences['plans']
  manager: boolean
  editingNew: boolean
  editingHistory: boolean
  readOnlyEditor: boolean
  editingTask: ImportReferences['tasks'][number] | undefined
  editingTaskLocked: boolean
  candidateLookups: (kinds: ImportCandidateKind[]) => ReactNode
}

export default function ImportRowFields({ batch, editing, setEditing, data, scope, activeUsers, availablePlans, manager, editingNew, editingHistory, readOnlyEditor, editingTask, editingTaskLocked, candidateLookups }: Props) {
  const [step, setStep] = useState<Step>('source')
  const editingTemporary = editingTask?.isTemporary ?? !!editing.isTemporary
  const dingtalkSource = !!batch?.dingtalk
  const detachedWorkSource = useRef<{ rowId: string; fields: ImportWorkFields } | null>(null)
  return <>
    <div className="tabs" role="group" aria-label="校对内容">
      {(Object.keys(steps) as Step[]).filter(id => id !== 'links' || editing.kind === 'weekly').map(id =>
        <button type="button" key={id} aria-pressed={step === id} className={step === id ? 'selected' : ''} onClick={() => setStep(id)}>{steps[id]}</button>)}
    </div>
    <fieldset className="import-editor-fields" disabled={readOnlyEditor} onInvalidCapture={event => {
      // Reveal the first invalid field before the browser focuses it on submission.
      const field = event.target as HTMLElement
      const invalid = event.currentTarget.form?.querySelector('input:invalid, select:invalid, textarea:invalid')
      const panel = field.closest<HTMLElement>('[data-step]')?.dataset.step as Step | undefined
      if (invalid === field && panel && panel !== step) flushSync(() => setStep(panel))
    }}>
      {!readOnlyEditor && candidateLookups(['users', 'projects', 'plans', 'tasks'])}
      <div data-step="source" hidden={step !== 'source'}>
          <Field label="工作事项">
            <input
              value={editing.title}
              maxLength={LIMITS.title}
              onChange={(event) =>
                setEditing({ ...editing, title: event.target.value })
              }
            />
          </Field>
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
      </div>
      <div data-step="plan" hidden={step !== 'plan'}>
        <div className="import-editor-destination">
          <div className="import-form-grid">
          <Field label="纳入计划" hint={editingTaskLocked ? '已关联个人任务，保持纳入每周计划。' : undefined}>
            <select
              value={editing.kind}
              disabled={editingTaskLocked || (dingtalkSource && !editingHistory)}
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
              disabled={dingtalkSource && !editingHistory}
              onChange={(event) => setEditing({ ...editing, [editing.kind === 'monthly' ? 'month' : 'weekStart']: event.target.value })}
            />
          </Field>
          </div>
          {editingTemporary && (
            <Field label={batch?.mode === 'history' || editingHistory || editingTaskLocked || editing.ownerId === data.user.id ? '交办说明（选填）' : '交办说明（代录必填）'} hint="可填写原文中的交办来源或要求。代他人新建临时事项时，请在纳入计划前补齐。">
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
          <Field label="工作类别">
            <input
              value={editing.category}
              onChange={(event) =>
                setEditing({ ...editing, category: event.target.value })
              }
            />
          </Field>
        {editing.kind === 'monthly' && <Field label="关联年度目标" hint="仅关联同年度目标；留空表示未关联。">
          {/^(20\d\d)-\d\d$/.test(editing.month) ? <AnnualGoalPicker key={`${scope}:${editing.id}:${editing.month.slice(0, 4)}`} year={Number(editing.month.slice(0, 4))} value={editing.annualGoalId || ''} scope={scope} onChange={value => setEditing({ ...editing, annualGoalId: value || null })} /> : <p>先填写所属月份后选择年度目标。</p>}
        </Field>}
      </div>
      <div data-step="people" hidden={step !== 'people'}>
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
          <Field label="原文协作人" hint={editing.kind === 'monthly' ? '用顿号或逗号分隔；在下方明确匹配系统成员。' : '周任务由个人负责；原文有多人协作时请分别拆项或改为月目标，名单不要直接作为个人责任。'}>
            <input value={(editing.collaboratorNames || []).join('、')} onChange={event => setEditing({ ...editing, collaboratorNames: event.target.value.split(/[、,，;；\n]/) })} />
          </Field>
        {(editing.kind === 'monthly' || !!editing.collaboratorIds?.length) && <div className="import-editor-collaborators">
          <h3>明确匹配协作成员</h3>
          <p>协作参与与负责人分别记录；请核对同名和无法匹配的原文姓名。</p>
          <details><summary>选择协作成员</summary><div className="import-collaborator-options">{data.users.filter(user => canUseAccount(user) || editing.collaboratorIds?.includes(user.id)).map(user => <label key={user.id}>
            <input type="checkbox" checked={editing.collaboratorIds?.includes(user.id) || false} disabled={!canUseAccount(user) && !editing.collaboratorIds?.includes(user.id)}
              onChange={event => setEditing({ ...editing, collaboratorIds: event.target.checked ? [...(editing.collaboratorIds || []), user.id] : (editing.collaboratorIds || []).filter(id => id !== user.id) })} />
            {accountDisplayName(user)}
          </label>)}</div></details>
        </div>}
      </div>
      <div data-step="assignment" hidden={step !== 'assignment'}>
          <Field label="工作来源" hint="临时工作不自动等于领导交办；按原文或明确安排选择。">
            <select value={editingTask ? editingTask.workSource || '' : editing.workSource || ''} disabled={editingTaskLocked} onChange={event => setEditing({ ...editing, workSource: event.target.value as ImportRow['workSource'] })}>
              <option value="">来源待核对</option><option value="leader">领导交办</option><option value="self">自主安排</option><option value="coordination">协同事项</option>
            </select>
          </Field>
          <Field label="交办人" hint={editingTaskLocked ? '沿用已有任务；需更正时请到原任务处理。' : undefined}><input maxLength={LIMITS.assignedBy} disabled={editingTaskLocked} value={editingTask ? editingTask.assignedBy || '' : editing.assignedBy || ''} onChange={event => setEditing({ ...editing, assignedBy: event.target.value })} /></Field>
          <Field label="交办日期"><input type="date" disabled={editingTaskLocked} value={editingTask ? editingTask.assignedOn || '' : editing.assignedOn || ''} onChange={event => setEditing({ ...editing, assignedOn: event.target.value })} /></Field>
        {editing.kind === 'weekly' && <div className="form-grid">
          {([['plannedEffortDays', '本周预计投入'], ['actualEffortDays', '本周实际投入'], ['remainingEffortDays', '任务剩余工作量']] as const).map(([field, label]) => <Field key={field} label={`${label}（人日）`} hint={field === 'remainingEffortDays' && editingTaskLocked ? '沿用现有任务；更正请到原任务处理。' : '按 0.5 人日填写；空白表示未知，0 表示零投入。'}>
            <input type="number" min="0" step="0.5" disabled={field === 'remainingEffortDays' && editingTaskLocked} value={field === 'remainingEffortDays' && editingTask ? editingTask.remainingEffortDays ?? '' : editing[field] ?? ''} onChange={event => setEditing({ ...editing, [field]: event.target.value === '' ? null : Number(event.target.value) })} />
          </Field>)}
        </div>}
      </div>
      <div data-step="links" hidden={step !== 'links'}>
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
      </div>
      <div data-step="status" hidden={step !== 'status'}>
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
        {editing.kind === 'weekly' && !editingHistory && batch?.mode === 'existing' && <div className="import-overall-completion">
          <h3>整件任务是否完成</h3>
          <p>本周阶段完成不会自动结束整件任务。只有全部工作已完成且无需继续推进，才确认整体完成。</p>
          {editingTaskLocked ? <p>已关联现有个人任务，整体完成状态请到原任务核对与修改。</p> : <>
            <label><input type="checkbox" checked={editing.taskCompleted === true} onChange={event => setEditing({ ...editing, taskCompleted: event.target.checked, completionNote: event.target.checked ? editing.completionNote || '' : '' })} />确认整件任务已完成</label>
            {editing.taskCompleted && <Field label="整体完成依据"><textarea required maxLength={2000} rows={2} value={editing.completionNote || ''} onChange={event => setEditing({ ...editing, completionNote: event.target.value })} placeholder="说明整个事项已完成的依据，而非仅本周的阶段成果" /></Field>}
          </>}
        </div>}
      </div>
      <div data-step="outcome" hidden={step !== 'outcome'}>
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
      </div>
    </fieldset>
  </>
}
