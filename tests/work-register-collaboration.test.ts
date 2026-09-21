import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import type { User } from '../shared/types.ts'
import type { ProgressEvent, TaskTracking } from '../shared/collaboration.ts'

test('register progress updates the existing followup baseline; identical saves do not manufacture progress', () => {
  const store = new Store(':memory:')
  try {
    const manager = store.insert<User>('users', { id: 'register-manager', name: '负责人', email: 'manager@register.test', role: 'manager', position: '', active: true })
    const member = store.insert<User>('users', { id: 'register-member', name: '成员', email: 'member@register.test', role: 'member', position: '', active: true })
    const collaboration = new CollaborationService(store)
    collaboration.updateSettings(manager, { requestId: 'register-enable-collab-2026', version: 0, enabled: true, pilotUserIds: [member.id], defaultManagerIds: [manager.id] })
    const work = new WorkService(store)
    let task = work.createTask(manager, { ownerId: member.id, title: '规划方案', isTemporary: true, temporaryReason: '临时交办', dueDate: '2099-09-30' })
    assert.ok(store.get<TaskTracking>('taskTrackings', task.id))
    task = work.updateTask(member, task.id, { version: task.version, workSource: 'leader', currentProgress: '已完成规划提纲，正在补充预算' })
    const progress = store.list<ProgressEvent>('progressEvents')
    assert.equal(progress.length, 1)
    assert.equal(progress[0].meaningfulOwnerProgress, true)
    assert.ok(progress[0].changes.some(change => change.field === 'task.currentProgress'))
    const baseline = store.get<TaskTracking>('taskTrackings', task.id)!.lastMeaningfulOwnerProgressAt
    assert.ok(baseline)
    work.updateTask(member, task.id, { version: task.version, currentProgress: '已完成规划提纲，正在补充预算' })
    assert.equal(store.list('progressEvents').length, 1)
    assert.equal(store.get<TaskTracking>('taskTrackings', task.id)!.lastMeaningfulOwnerProgressAt, baseline)
  } finally { store.close() }
})
