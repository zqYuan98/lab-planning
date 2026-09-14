import type { Task, WeeklyRecord } from '../../shared/types'
import { Badge, nameOf, type PageProps } from '../ui'

export function workSource(row: Task | WeeklyRecord) {
  return row.importSource ? 'imported' : row.workOrigin?.kind ?? 'unknown'
}
export default function WorkOriginLabel({ row, data }: { row: Task | WeeklyRecord; data: PageProps['data'] }) {
  if (row.importSource) return null
  const origin = row.workOrigin
  if (!origin) return <Badge>来源未记录</Badge>
  return <span className="work-origin"><Badge tone={origin.kind === 'self' ? 'neutral' : 'blue'}>{{ self: '自行安排', assigned: '管理员下发', proxy: '管理员代录' }[origin.kind]}</Badge><span>{nameOf(data, origin.actorId)}</span>{origin.reason && <span> · 代录原因：{origin.reason}</span>}</span>
}
