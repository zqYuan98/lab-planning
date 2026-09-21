import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import type { Project, User } from '../shared/types.ts'
import type { FeedbackActionInput, FeedbackCreateInput } from '../shared/feedback.ts'
import { FeedbackService } from '../server/feedback-service.ts'
import { exportBusinessData } from '../server/data-transfer.ts'
import { Store } from '../server/store.ts'

test('online SQLite backup preserves protected feedback images, history and retry receipts independently of the live database', async () => {
  const tempRoot = resolve(tmpdir()), directory = mkdtempSync(join(tempRoot, 'lab-feedback-backup-'))
  const sourcePath = join(directory, 'source.sqlite'), backupPath = join(directory, 'backup.sqlite')
  const source = new Store(sourcePath)
  let restored: Store | undefined
  try {
    const account = (id: string, role: User['role']) => source.insert<User>('users', { id, name: id, email: `${id}@feedback-backup.test`, position: '', active: true, role })
    const manager = account('manager', 'manager'), member = account('member', 'member'), other = account('other', 'member')
    const project = source.insert<Project>('projects', { name: '可迁移业务项目', code: 'BACKUP', description: '独立业务记录', ownerId: manager.id, status: 'active' })
    const service = new FeedbackService(source)
    const image = { name: '备份截图.png', mimeType: 'image/png' as const,
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY/jPwPCfARkAAB7zAf+x9MCaAAAAAElFTkSuQmCC' }
    const create: FeedbackCreateInput = { requestId: 'backup-create', description: '需要保留原始截图和后续处理历史', attachments: [image] }
    let detail = service.create(member, create)
    detail = service.action(manager, detail.feedback.id, { requestId: 'backup-start', version: detail.feedback.version, action: 'start' })
    detail = service.action(member, detail.feedback.id, { requestId: 'backup-comment', version: detail.feedback.version, action: 'comment', text: '追加复现记录', attachments: [image] })
    const ready: FeedbackActionInput = { requestId: 'backup-ready', version: detail.feedback.version, action: 'ready', resolution: '修复已上线', releaseVersion: 'backup-v1', released: true }
    detail = service.action(manager, detail.feedback.id, ready)
    const expected = service.detail(member, detail.feedback.id)
    const collections = ['feedback', 'feedbackEvents', 'feedbackAttachments', 'feedbackCommands', 'notifications'] as const
    const snapshot = new Map(collections.map(collection => [collection, source.list(collection)]))

    // Same underlying online backup API as scripts/backup.ts. Keep the live WAL-backed
    // Store open: success must include committed records, not just the main file bytes.
    const connection = new DatabaseSync(sourcePath, { readOnly: true })
    try { await backup(connection, backupPath) } finally { connection.close() }
    const verification = new DatabaseSync(backupPath, { readOnly: true })
    try { assert.equal(verification.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok') } finally { verification.close() }

    service.action(member, detail.feedback.id, { requestId: 'live-only-confirm', version: detail.feedback.version, action: 'confirm' })
    assert.equal(service.detail(member, detail.feedback.id).feedback.status, 'closed')
    restored = new Store(backupPath)
    const recovered = new FeedbackService(restored)
    assert.deepEqual(recovered.detail(member, detail.feedback.id), expected)
    assert.equal(recovered.detail(member, detail.feedback.id).feedback.status, 'verification', 'the backup is independent of changes made after its snapshot')
    for (const collection of collections) assert.deepEqual(restored.list(collection), snapshot.get(collection), collection)
    for (const attachment of expected.attachments) {
      assert.deepEqual(Buffer.from(recovered.attachment(member, detail.feedback.id, attachment.id).dataBase64, 'base64'), Buffer.from(image.dataBase64, 'base64'))
      assert.equal(recovered.attachment(manager, detail.feedback.id, attachment.id).mimeType, 'image/png')
      assert.throws(() => recovered.attachment(other, detail.feedback.id, attachment.id), { status: 404 })
    }

    // Both creation and a now-stale action retry must use the restored command receipts.
    assert.deepEqual(recovered.create(member, create), expected)
    assert.deepEqual(recovered.action(manager, detail.feedback.id, ready), recovered.detail(manager, detail.feedback.id))
    assert.throws(() => recovered.action(manager, detail.feedback.id, { ...ready, resolution: 'different payload' }), { status: 409 })
    for (const collection of collections) assert.deepEqual(restored.list(collection), snapshot.get(collection), `retry changed ${collection}`)

    for (const store of [source, restored]) {
      const packet = exportBusinessData(store, manager), serialized = JSON.stringify(packet)
      assert.ok(packet.collections.projects.some(row => row.id === project.id), 'ordinary business data must still be exportable')
      for (const secret of [detail.feedback.id, image.dataBase64, ...expected.attachments.map(row => row.id)]) assert.equal(serialized.includes(secret), false)
      for (const collection of ['feedback', 'feedbackEvents', 'feedbackAttachments', 'feedbackCommands']) assert.equal(Object.hasOwn(packet.collections, collection), false)
    }
  } finally {
    restored?.close(); source.close()
    const relativeDirectory = relative(tempRoot, resolve(directory))
    assert.ok(!isAbsolute(relativeDirectory) && !relativeDirectory.startsWith('..') && relativeDirectory.startsWith('lab-feedback-backup-'), 'only the verified test-created temporary directory may be removed')
    rmSync(directory, { recursive: true, force: true })
  }
})
