import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  CalendarDays,
  ClipboardList,
  FolderKanban,
  Search,
  Users,
  X,
} from 'lucide-react'
import Input, { type RefInputType } from '@arco-design/web-react/es/Input'
import type { Bootstrap } from '../../shared/types'
import { canUseAccount } from '../../shared/auth-policy'
import { accountDisplayName } from '../account-options'
import type { Navigate, NavigationIntent, PageId } from '../navigation'
import { shanghaiToday, weekMonday } from '../overview-data'

type SearchCategory = '月度目标' | '个人任务' | '项目' | '团队成员'
interface SearchResult {
  key: string
  category: SearchCategory
  title: string
  description: string
  keywords: string
  page: PageId
  intent: NavigationIntent
  taskKeywords?: string
  taskWeeks?: { weekStart: string; commitment: string }[]
}
const icons = {
  月度目标: CalendarDays,
  个人任务: ClipboardList,
  项目: FolderKanban,
  团队成员: Users,
}
const categories: SearchCategory[] = [
  '月度目标',
  '个人任务',
  '项目',
  '团队成员',
]

export function buildWorkspaceSearchIndex(data: Bootstrap, currentWeek = weekMonday(shanghaiToday())): SearchResult[] {
    const people = new Map(data.users.map((user) => [user.id, accountDisplayName(user)]))
    const projects = new Map(
      data.projects.map((project) => [project.id, project.name]),
    )
    const entries: SearchResult[] = data.plans.map((plan) => ({
      key: `plan-${plan.id}`,
      category: '月度目标',
      title: plan.title,
      description: `${plan.month} · ${people.get(plan.ownerId) || '未指定负责人'} · ${plan.projectId ? projects.get(plan.projectId) || '项目计划' : plan.category}`,
      keywords: [
        plan.title,
        plan.expectedOutcome,
        plan.category,
        people.get(plan.ownerId),
        plan.projectId ? projects.get(plan.projectId) : '',
      ].join(' '),
      page: 'monthly',
      intent: { id: plan.id, month: plan.month, query: plan.title },
    }))
    for (const task of data.tasks) {
      const records = data.weeklyRecords.filter(
        (record) => record.taskId === task.id,
      ).sort((a, b) => Number(b.weekStart === currentWeek) - Number(a.weekStart === currentWeek) || b.weekStart.localeCompare(a.weekStart))
      const record = records[0]
      const taskKeywords = [task.title, task.description, people.get(task.ownerId)].join(' ')
      entries.push({
        key: `task-${task.id}`,
        category: '个人任务',
        title: task.title,
        description: `${people.get(task.ownerId) || '未指定负责人'} · ${record ? `所属周 ${record.weekStart}` : '尚未安排周记录'}${task.isTemporary ? ' · 临时工作' : ''}`,
        keywords: [
          taskKeywords,
          ...records.map((item) => item.commitment),
        ].join(' '),
        taskKeywords,
        taskWeeks: records.map(item => ({ weekStart: item.weekStart, commitment: item.commitment })),
        page: 'weekly',
        intent: {
          id: task.id,
          weekStart: record?.weekStart || currentWeek,
          query: task.title,
        },
      })
    }
    for (const project of data.projects)
      entries.push({
        key: `project-${project.id}`,
        category: '项目',
        title: project.name,
        description: `${project.code} · ${people.get(project.ownerId) || '未指定负责人'}${project.status === 'archived' ? ' · 已归档' : ''}`,
        keywords: [
          project.name,
          project.code,
          project.description,
          people.get(project.ownerId),
        ].join(' '),
        page: 'projects',
        intent: { id: project.id, query: project.name },
      })
    if (data.user.role === 'manager')
      for (const user of data.users.filter(canUseAccount))
        entries.push({
          key: `user-${user.id}`,
          category: '团队成员',
          title: user.name,
          description: `${user.position || (user.role === 'manager' ? '管理员' : '成员')} · ${user.email}${user.active ? '' : ' · 已停用'}`,
          keywords: [user.name, user.position, user.email].join(' '),
          page: 'team',
          intent: { id: user.id, query: user.name },
        })
    return entries
}

export function filterWorkspaceSearch(index: SearchResult[], query: string): SearchResult[] {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    const matchesWords = (text: string) => words.every(word => text.toLocaleLowerCase().includes(word))
    const matches = index.filter(item => matchesWords(item.keywords)).flatMap(item => {
      if (!item.taskWeeks || matchesWords(item.taskKeywords || '')) return [item]
      // A historical commitment must lead to the week that actually matched.
      // Do not combine unrelated words from different weeks into a false match.
      const matchedWeek = item.taskWeeks.find(week => matchesWords(`${item.taskKeywords} ${week.commitment}`))
      return matchedWeek ? [{ ...item,
        description: `${item.description.replace(/所属周 \d{4}-\d{2}-\d{2}/, `所属周 ${matchedWeek.weekStart}`)} · ${matchedWeek.commitment}`,
        intent: { ...item.intent, weekStart: matchedWeek.weekStart },
      }] : []
    })
    return categories.flatMap((category) =>
      matches.filter((item) => item.category === category).slice(0, 5),
    )
}

export default function WorkspaceSearch({ data, navigate }: { data: Bootstrap; navigate: Navigate }) {
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null), input = useRef<RefInputType>(null)
  const id = useId()
  const index = useMemo(() => buildWorkspaceSearchIndex(data), [data])
  const results = useMemo(() => filterWorkspaceSearch(index, query), [index, query])
  useEffect(() => {
    setActive(0)
  }, [query])
  useEffect(() => {
    setActive(value => Math.min(value, Math.max(0, results.length - 1)))
  }, [results.length])
  useEffect(() => {
    function outside(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function shortcut(event: KeyboardEvent) {
      if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey)
        return
      const target = event.target as HTMLElement
      if (
        target.closest(
          'input,textarea,select,[contenteditable="true"],[role="dialog"]',
        )
      )
        return
      event.preventDefault()
      input.current?.focus()
      setOpen(true)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', shortcut)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', shortcut)
    }
  }, [])
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-option-${active}`)
        ?.scrollIntoView({ block: 'nearest' })
  }, [active, open, id])
  function choose(result: SearchResult) {
    setOpen(false)
    setQuery('')
    input.current?.blur()
    navigate(result.page, result.intent)
  }
  const visible = open && !!query.trim()
  return (
    <div
      className="workspace-search"
      ref={root}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <Input
        className="workspace-search-input"
        prefix={<Search size={17} aria-hidden="true" />}
        ref={input}
        type="search"
        role="combobox"
        aria-label="搜索工作空间"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? `${id}-results` : undefined}
        aria-activedescendant={
          visible && results[active] ? `${id}-option-${active}` : undefined
        }
        placeholder="搜索计划、任务、项目…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(value) => {
          setQuery(value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setActive((value) =>
              results.length ? (value + 1) % results.length : 0,
            )
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            setActive((value) =>
              results.length
                ? (value - 1 + results.length) % results.length
                : 0,
            )
          } else if (event.key === 'Enter' && visible && results[active]) {
            event.preventDefault()
            choose(results[active])
          }
        }}
      />
      {query ? (
        <button
          className="search-clear"
          type="button"
          aria-label="清空搜索"
          onClick={() => {
            setQuery('')
            input.current?.focus()
          }}
        >
          <X size={14} />
        </button>
      ) : (
        <kbd aria-hidden="true">/</kbd>
      )}
      {visible && (
        <div className="search-popover">
          <div className="search-popover-heading">
            <span>搜索可访问的工作记录</span>
            <small>{results.length} 条匹配</small>
          </div>
          <div
            id={`${id}-results`}
            role="listbox"
            aria-label="搜索结果"
            className="search-results"
          >
            {results.length ? (
              categories.map((category) => {
                const rows = results.filter(
                  (result) => result.category === category,
                )
                if (!rows.length) return null
                const Icon = icons[category]
                return (
                  <div
                    className="search-group"
                    key={category}
                    role="group"
                    aria-label={category}
                  >
                    <h3>{category}</h3>
                    {rows.map((result) => {
                      const position = results.indexOf(result)
                      return (
                        <button
                          type="button"
                          role="option"
                          id={`${id}-option-${position}`}
                          key={result.key}
                          aria-selected={active === position}
                          tabIndex={-1}
                          className={`search-result ${active === position ? 'selected' : ''}`}
                          onMouseEnter={() => setActive(position)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => choose(result)}
                        >
                          <span className="search-result-icon">
                            <Icon size={17} />
                          </span>
                          <span>
                            <strong>{result.title}</strong>
                            <small>{result.description}</small>
                          </span>
                          <ArrowUpRight size={14} />
                        </button>
                      )
                    })}
                  </div>
                )
              })
            ) : (
              <div className="search-empty">
                <Search size={24} />
                <strong>没有找到相关记录</strong>
                <p>试试项目名称、计划关键词或负责人的姓名。</p>
              </div>
            )}
          </div>
          <div className="search-help">
            <span>↑ ↓ 选择</span>
            <span>Enter 打开</span>
            <span>Esc 收起</span>
          </div>
        </div>
      )}
    </div>
  )
}
