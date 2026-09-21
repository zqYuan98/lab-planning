import { useRef, useState } from 'react'
import { api, json } from '../api'
import { Form, Modal } from '../ui'

export interface ImportDeleteTarget {
  kind: 'batch' | 'history'
  id: string
  version: number
  title: string
}

export default function ImportDeleteDialog({ target, onClose, onPendingChange, onDeleted }: {
  target: ImportDeleteTarget
  onClose: () => void
  onPendingChange: (pending: boolean) => void
  onDeleted: (target: ImportDeleteTarget, deletedHistoryCount: number) => void
}) {
  const pending = useRef(false)
  const [deleting, setDeleting] = useState(false)
  const batch = target.kind === 'batch'
  const close = () => { if (!pending.current) onClose() }

  return (
    <Modal title={batch ? '删除导入批次' : '删除历史资料'} onClose={close}>
      <Form onCancel={close} submitLabel="确认删除" onSubmit={async () => {
        if (pending.current) return
        pending.current = true
        setDeleting(true)
        onPendingChange(true)
        try {
          const result = await api<{ ok: true; deletedHistoryCount?: number }>(
            batch ? `/imports/${target.id}` : `/imports/history/${target.id}`,
            json({ version: target.version }, 'DELETE'),
          )
          onDeleted(target, result.deletedHistoryCount || 0)
        } finally {
          pending.current = false
          setDeleting(false)
          onPendingChange(false)
        }
      }}>
        <p>确定删除“{target.title}”？此操作无法撤销。</p>
        <p className="subtle-note">
          {batch
            ? '将删除该导入批次及其归档历史资料；原始文件在没有其他批次引用时一并清理。已生成的月度目标、个人任务、周记录和已保存报告会保留。'
            : '将删除这条归档历史资料，来源批次、原始文件及其他记录会保留。已生成的计划和已保存报告不会改变。'}
        </p>
        {deleting && <p role="status">正在删除，请稍候…</p>}
      </Form>
    </Modal>
  )
}
