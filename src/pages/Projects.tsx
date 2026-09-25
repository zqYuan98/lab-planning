import { useState } from 'react'
import type { ProjectsPage } from '../../shared/directory-workspace'
import DirectoryAccountPicker, { directoryAccountName } from '../components/DirectoryAccountPicker'
import DirectoryPagination, { firstDirectoryPage } from '../components/DirectoryPagination'
import { useWorkspaceQuery } from '../workspace-query'
import { useDebouncedSearch } from '../use-debounced-search'
import { Archive, FolderKanban, Plus, Search } from 'lucide-react'
import type { Project } from '../../shared/types'
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
export default function Projects({ data, notify, intent }: PageProps) {
  const [editing, setEditing] = useState<Project | 'new' | null>(
      intent?.action === 'create' && data.user.role === 'manager'
        ? 'new'
        : null,
    ),
    [archive, setArchive] = useState<Project | null>(null),
    [search, setSearch] = useState(intent?.query || ''),
    [showArchived, setShowArchived] = useState(!!intent?.id),
    [paging, setPaging] = useState(firstDirectoryPage)
  const manager = data.user.role === 'manager',
    project = editing && editing !== 'new' ? editing : null
  const scope = `${data.user.id}:${data.user.role}:${data.operationEpoch}:${data.accessScopeVersion}`
  const querySearch = useDebouncedSearch(search)
  const params = new URLSearchParams({ status: showArchived ? 'all' : 'active', q: querySearch, limit: '30' })
  if (intent?.id) params.set('focusId', intent.id)
  if (paging.cursor) params.set('cursor', paging.cursor)
  const query = useWorkspaceQuery<ProjectsPage>(`/workspace/projects?${params}`, scope, undefined, { onCursorStale: () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging(firstDirectoryPage()); return `/workspace/projects?${first}` } })
  const reloadFirst = async () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging(firstDirectoryPage()); await query.reload(`/workspace/projects?${first}`) }
  const projects = query.value?.items ?? []
  const focus = query.value?.focus
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
            onChange={(event) => { setSearch(event.target.value); setPaging(firstDirectoryPage()) }}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => { setShowArchived(event.target.checked); setPaging(firstDirectoryPage()) }}
          />
          显示已归档项目
        </label>
      </div>
      {query.error && <p className="error" role="alert">{query.error}<button className="text-button" onClick={() => { setPaging(firstDirectoryPage()); void reloadFirst().catch(() => {}) }}>重新读取</button></p>}
      {query.loading && !query.value && <p role="status">正在读取项目…</p>}
      {focus && !projects.some(row => row.id === focus.id) && <div className="panel navigation-highlight"><strong>{focus.name}</strong><p>{directoryAccountName(focus.owner)} · {focus.status === 'active' ? '进行中' : '已归档'}</p>{manager && <button className="button secondary" onClick={() => setEditing(focus)}>编辑定位项目</button>}</div>}
      {query.value && <DirectoryPagination total={query.value.total} nextCursor={query.value.nextCursor} paging={paging} setPaging={setPaging} loading={query.loading} />}
      {projects.length ? (
        <div className="panel">
          <div className="table-scroll" role="region" aria-label="项目档案表，可横向滚动" tabIndex={0}>
            <table className="projects-table">
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
                    <td>{directoryAccountName(item.owner)}</td>
                    <td>
                      {item.publishedPlanCount}{' '}
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
            title={search ? '未找到匹配项目' : '暂无项目'}
            description={search ? '试试其他名称或编号，也可以勾选显示已归档项目。' : '新建项目后，可将月度成果归入项目；部门工作也可以独立提报。'}
            action={
              manager && !search && (
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
              const saved = await api<Project>(
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
              notify('项目资料已保存')
              await finishSaved(async () => { await reloadFirst(); setEditing(null) }, saved.version)
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
            <div className="field"><span>项目负责人</span>
              <DirectoryAccountPicker name="ownerId" defaultSelectedIds={[project?.ownerId || data.user.id]} scope={`${scope}:${project?.id ?? 'new'}`} />
            </div>
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
              const saved = await api<Project>(
                `/projects/${archive.id}`,
                json(
                  {
                    version: archive.version,
                    status: archive.status === 'active' ? 'archived' : 'active',
                  },
                  'PATCH',
                ),
              )
              notify('项目状态已更新')
              await finishSaved(async () => { await reloadFirst(); setArchive(null) }, saved.version)
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
