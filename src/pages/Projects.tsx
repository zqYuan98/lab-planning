import { useState } from 'react'
import { canUseAccount } from '../../shared/auth-policy'
import { accountDisplayName, assignmentAccounts } from '../account-options'
import { Archive, FolderKanban, Plus, Search } from 'lucide-react'
import type { Project } from '../../shared/types'
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
export default function Projects({ data, refresh, notify, intent }: PageProps) {
  const [editing, setEditing] = useState<Project | 'new' | null>(
      intent?.action === 'create' && data.user.role === 'manager'
        ? 'new'
        : null,
    ),
    [archive, setArchive] = useState<Project | null>(null),
    [search, setSearch] = useState(intent?.query || ''),
    [showArchived, setShowArchived] = useState(
      data.projects.some(
        (project) => project.id === intent?.id && project.status === 'archived',
      ),
    )
  const manager = data.user.role === 'manager',
    project = editing && editing !== 'new' ? editing : null
  const projects = data.projects.filter(
    (item) =>
      (showArchived || item.status === 'active') &&
      `${item.name}${item.code}`.includes(search),
  )
  return (
    <>
      <PageHeader
        eyebrow="PORTFOLIO / PROJECTS"
        title="项目档案"
        description="项目聚合相关成果；归档后仍保留计划、任务与汇报历史。"
        actions={
          manager && (
            <button
              className="button primary"
              onClick={() => setEditing('new')}
            >
              <Plus size={17} />
              新建项目
            </button>
          )
        }
      />
      <div className="toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="搜索项目"
            placeholder="搜索项目名称或编号"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          显示已归档项目
        </label>
      </div>
      {projects.length ? (
        <div className="panel">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>项目名称 / 编号</th>
                  <th>负责人</th>
                  <th>已发布月度成果</th>
                  <th>状态</th>
                  {manager && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {projects.map((item) => (
                  <tr
                    key={item.id}
                    className={
                      item.id === intent?.id
                        ? 'navigation-highlight'
                        : undefined
                    }
                  >
                    <td>
                      <div className="project-title">
                        <div className="project-icon">
                          <FolderKanban size={21} />
                        </div>
                        <div>
                          <strong>{item.name}</strong>
                          <small className="cell-date">
                            {item.code || '未设置编号'}
                          </small>
                        </div>
                      </div>
                      {item.description && (
                        <p className="cell-description">{item.description}</p>
                      )}
                    </td>
                    <td>{nameOf(data, item.ownerId)}</td>
                    <td>
                      {
                        data.plans.filter(
                          (plan) =>
                            plan.projectId === item.id &&
                            plan.status === 'published',
                        ).length
                      }{' '}
                      项
                    </td>
                    <td>
                      <Badge
                        tone={item.status === 'active' ? 'green' : 'neutral'}
                      >
                        {item.status === 'active' ? '进行中' : '已归档'}
                      </Badge>
                    </td>
                    {manager && (
                      <td>
                        <div className="row-actions">
                          <button onClick={() => setEditing(item)}>编辑</button>
                          <button onClick={() => setArchive(item)}>
                            {item.status === 'active' ? '归档' : '恢复'}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="panel">
          <Empty
            title="暂无项目"
            description="新建项目后，可将月度成果归入项目；部门工作也可以独立提报。"
            action={
              manager && (
                <button
                  className="button secondary"
                  onClick={() => setEditing('new')}
                >
                  新建项目
                </button>
              )
            }
          />
        </div>
      )}
      {editing && (
        <Modal
          title={project ? '编辑项目' : '新建项目'}
          onClose={() => setEditing(null)}
        >
          <Form
            onCancel={() => setEditing(null)}
            onSubmit={async (event) => {
              const values = Object.fromEntries(new FormData(event.currentTarget))
              await api(
                project ? `/projects/${project.id}` : '/projects',
                json(
                  {
                    ...values,
                    ownerId: values.ownerId || project?.ownerId,
                    ...(project ? { version: project.version } : {}),
                  },
                  project ? 'PATCH' : 'POST',
                ),
              )
              await refresh()
              notify('项目资料已保存')
              setEditing(null)
            }}
          >
            <Field label="项目名称">
              <input
                name="name"
                required
                maxLength={200}
                defaultValue={project?.name}
              />
            </Field>
            <Field label="项目编号">
              <input
                name="code"
                required
                maxLength={50}
                defaultValue={project?.code}
                placeholder="例如 LAB-2026-01"
              />
            </Field>
            <Field label="项目负责人">
              <select
                name="ownerId"
                defaultValue={project?.ownerId || data.user.id}
              >
                {assignmentAccounts(data.users, project ? [project.ownerId] : [])
                  .map((user) => (
                    <option key={user.id} value={user.id} disabled={!canUseAccount(user)}>
                      {accountDisplayName(user)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="项目说明">
              <textarea
                name="description"
                rows={4}
                defaultValue={project?.description}
              />
            </Field>
          </Form>
        </Modal>
      )}
      {archive && (
        <Modal
          title={archive.status === 'active' ? '归档项目' : '恢复项目'}
          onClose={() => setArchive(null)}
        >
          <div className="context-box">
            <Archive size={24} />
            <h3>{archive.name}</h3>
            <p>
              {archive.status === 'active'
                ? '归档后停止新建正常计划，现有计划、执行记录和报告仍然保留。'
                : '恢复后可以继续为该项目新增月度计划。'}
            </p>
          </div>
          <Form
            onCancel={() => setArchive(null)}
            submitLabel={archive.status === 'active' ? '确认归档' : '确认恢复'}
            onSubmit={async () => {
              await api(
                `/projects/${archive.id}`,
                json(
                  {
                    version: archive.version,
                    status: archive.status === 'active' ? 'archived' : 'active',
                  },
                  'PATCH',
                ),
              )
              await refresh()
              notify('项目状态已更新')
              setArchive(null)
            }}
          >
            {null}
          </Form>
        </Modal>
      )}
    </>
  )
}
