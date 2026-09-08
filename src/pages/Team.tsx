import { useState } from 'react'
import { Plus, Users, Search } from 'lucide-react'
import type { User } from '../../shared/types'
import { api, json } from '../api'
import {
  Badge,
  Empty,
  Field,
  Form,
  Modal,
  PageHeader,
  type PageProps,
} from '../ui'
export default function Team({ data, refresh, notify, intent }: PageProps) {
  const [search, setSearch] = useState(intent?.query || '')
  const members = data.users.filter((item) =>
    `${item.name} ${item.email} ${item.position}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  )
  const [editing, setEditing] = useState<User | 'new' | null>(null),
    user = editing && editing !== 'new' ? editing : null
  return (
    <>
      <PageHeader
        eyebrow="PEOPLE / TEAM"
        title="团队成员"
        description="按岗位明确责任，每位成员使用自己的账号提报计划和进展。"
        actions={
          <button className="button primary" onClick={() => setEditing('new')}>
            <Plus size={17} />
            添加成员
          </button>
        }
      />
      <div className="toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="搜索成员"
            placeholder="搜索姓名、岗位或邮箱"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="team-intro">
        <Users size={22} />
        <span>
          <strong>{data.users.filter((item) => item.active).length}</strong>{' '}
          位活跃成员
        </span>
        <p>管理员审核发布与验收；成员维护本人计划、任务及进展。</p>
      </div>
      {members.length ? (
        <div className="panel">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>成员</th>
                  <th>岗位</th>
                  <th>邮箱 / 登录账号</th>
                  <th>权限</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {members.map((item) => (
                  <tr
                    key={item.id}
                    className={
                      item.id === intent?.id
                        ? 'navigation-highlight'
                        : undefined
                    }
                  >
                    <td>
                      <div className="person-cell">
                        <span className="avatar light">
                          {item.name.slice(-2)}
                        </span>
                        <strong>{item.name}</strong>
                        {item.id === data.user.id && <Badge>我</Badge>}
                      </div>
                    </td>
                    <td>{item.position || '待设置'}</td>
                    <td>{item.email}</td>
                    <td>{item.role === 'manager' ? '管理员' : '成员'}</td>
                    <td>
                      <Badge tone={item.active ? 'green' : 'neutral'}>
                        {item.active ? '启用' : '停用'}
                      </Badge>
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setEditing(item)}
                      >
                        管理账号
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Empty
          title={search ? '没有匹配的成员' : '暂无成员'}
          description={search ? '尝试其他姓名、岗位或邮箱关键词。' : undefined}
        />
      )}
      {editing && (
        <Modal
          title={user ? '管理成员账号' : '添加团队成员'}
          onClose={() => setEditing(null)}
        >
          <Form
            onCancel={() => setEditing(null)}
            submitLabel={user ? '保存账号设置' : '创建成员账号'}
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget),
                values = Object.fromEntries(form)
              const body: Record<string, unknown> = {
                ...values,
                ...(user
                  ? { version: user.version, active: form.has('active') }
                  : {}),
              }
              if (user && !values.password) delete body.password
              await api(
                user ? `/users/${user.id}` : '/users',
                json(body, user ? 'PATCH' : 'POST'),
              )
              await refresh()
              notify(
                user
                  ? '账号设置已保存'
                  : '成员账号已创建，可使用邮箱和初始密码登录',
              )
              setEditing(null)
            }}
          >
            <Field label="姓名">
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={user?.name}
              />
            </Field>
            <Field label="岗位">
              <input
                name="position"
                maxLength={100}
                defaultValue={user?.position}
                placeholder="如 算法工程师、产品经理、测试工程师"
              />
            </Field>
            {!user && (
              <Field label="登录邮箱">
                <input name="email" type="email" required autoComplete="off" />
              </Field>
            )}
            <Field label="角色">
              <select name="role" defaultValue={user?.role || 'member'}>
                <option value="member">成员 · 本人提报与执行</option>
                <option value="manager">管理员 · 审核发布、验收与管理</option>
              </select>
            </Field>
            <Field
              label={user ? '重设密码（留空则保留）' : '初始密码'}
              hint="至少 10 位。通过部门认可的方式将初始密码交给本人。"
            >
              <input
                name="password"
                type="password"
                minLength={10}
                required={!user}
                autoComplete="new-password"
              />
            </Field>
            {user && (
              <label className="checkbox-label">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={user.active}
                />
                启用账号
              </label>
            )}
          </Form>
        </Modal>
      )}
    </>
  )
}
