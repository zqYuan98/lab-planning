import { useState } from 'react'
import { Plus, Target } from 'lucide-react'
import type { AnnualGoal } from '../../shared/types'
import { api, json } from '../api'
import {
  Badge,
  Empty,
  Field,
  Form,
  Modal,
  PageHeader,
  nameOf,
  type PageProps,
} from '../ui'
export default function Goals({ data, refresh, notify }: PageProps) {
  const [year, setYear] = useState(new Date().getFullYear()),
    [editing, setEditing] = useState<AnnualGoal | 'new' | null>(null)
  const goal = editing && editing !== 'new' ? editing : null,
    manager = data.user.role === 'manager'
  const goals = data.annualGoals.filter((item) => item.year === year)
  return (
    <>
      <PageHeader
        eyebrow="DIRECTION / ANNUAL GOALS"
        title="年度目标"
        description="独立记录部门方向和确认进展，供管理汇报引用。"
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
      <div className="toolbar">
        <label className="inline-field">
          目标年份
          <input
            type="number"
            min="2020"
            max="2100"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          />
        </label>
        <p className="subtle-note">
          年度进展由负责人确认，不按月计划条数推算。
        </p>
      </div>
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
                  <small>负责人 · {nameOf(data, item.ownerId)}</small>
                </div>
                <div className="goal-progress">
                  <strong>
                    {item.progress}
                    <small>%</small>
                  </strong>
                  <span>负责人确认进展</span>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label={`${item.title}进展`}
                    aria-valuenow={item.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div style={{ width: `${item.progress}%` }} />
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
              await api(
                goal ? `/annual-goals/${goal.id}` : '/annual-goals',
                json(
                  {
                    ...values,
                    year: Number(values.year),
                    progress: Number(values.progress),
                    ...(goal ? { version: goal.version } : {}),
                  },
                  goal ? 'PATCH' : 'POST',
                ),
              )
              await refresh()
              notify('年度目标已保存')
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
              <Field label="负责人">
                <select
                  name="ownerId"
                  defaultValue={goal?.ownerId || data.user.id}
                >
                  {data.users
                    .filter((user) => user.active || user.id === goal?.ownerId)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                </select>
              </Field>
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
              <Field label="确认进展（%）">
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
