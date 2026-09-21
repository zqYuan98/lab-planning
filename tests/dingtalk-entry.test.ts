import test from 'node:test'
import assert from 'node:assert/strict'
import { dingTalkEntryLink } from '../shared/dingtalk-entry.ts'
import { prepareDingTalkMessage } from '../server/dingtalk.ts'
import { identityThenWorkspace } from '../src/dingtalk-access.ts'

const config = { origin: 'https://lab.example.test', agentId: '123', corpId: 'ding-corp', enabled: true }
const entry = `${config.origin}/entry?notificationId=opaque-id`
test('AppLink encodes one complete controlled entry and keeps desktop popup and rollback', () => {
  const result = new URL(dingTalkEntryLink(entry, config))
  assert.equal(result.origin, 'https://applink.dingtalk.com')
  assert.equal(result.searchParams.get('path'), '/entry?notificationId=opaque-id')
  assert.equal(result.searchParams.get('targetDesktop'), 'popupWindow')
  assert.equal(result.searchParams.get('appId'), '123')
  assert.equal(dingTalkEntryLink(entry, { ...config, enabled: false }), entry)
  for (const bad of ['https://evil.test/entry?notificationId=x', `${entry}&returnUrl=https://evil.test`, `${entry}&notificationId=other`, `${entry}#secret`, `${config.origin}/entry?notificationId=../secret`, `${config.origin}/entry?notificationId=${'x'.repeat(500)}`]) assert.throws(() => dingTalkEntryLink(bad, config))
  const prepared = prepareDingTalkMessage({ title: '安排', body: '查看安排', url: entry }, { APP_ORIGIN: config.origin, DINGTALK_AGENT_ID: '123', DINGTALK_CORP_ID: 'ding-corp', DINGTALK_APPLINK_ENABLED: 'true' })
  assert.equal(prepared.url, result.href)
  assert.equal(prepared.payload.action_card.single_url, result.href)
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.payload)) <= 2048)
})
test('DingTalk startup validates current identity even with a cookie and never loads business data on conflict or unbound identity', async () => {
  let loads = 0, ordinary = 0
  const options = { dingTalk: true, normalSession: async () => { ordinary++ }, load: async () => { loads++; return 'business' } }
  const pending = await identityThenWorkspace({ ...options, verify: async () => ({ authenticated: false, bindingRequired: true }) })
  assert.deepEqual(pending, { bindingRequired: true })
  await assert.rejects(identityThenWorkspace({ ...options, verify: async () => { throw new Error('conflict') } }))
  assert.equal(loads, 0); assert.equal(ordinary, 0)
  assert.deepEqual(await identityThenWorkspace({ ...options, verify: async () => ({ authenticated: true }) }), { data: 'business' })
  assert.equal(loads, 1)
  await identityThenWorkspace({ ...options, dingTalk: false, verify: async () => { throw new Error('must not verify ordinary login') } })
  assert.equal(ordinary, 1)
})
