import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDingTalkClient, DingTalkError, prepareDingTalkMessage, type DingTalkMessage } from '../server/dingtalk.ts'

const env = { DINGTALK_CORP_ID: 'ding-corp', DINGTALK_CLIENT_ID: 'client', DINGTALK_CLIENT_SECRET: 'never-expose-secret', DINGTALK_AGENT_ID: '1234', APP_ORIGIN: 'https://lab.example.test' }
const message = { title: '新的工作安排', body: '请查看并确认接收', url: 'https://lab.example.test/entry?notificationId=opaque-id' }
function fetchMock(handler: (url: URL, input: RequestInit) => unknown | Promise<unknown>): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const value = await handler(new URL(String(input)), init ?? {})
    return value instanceof Response ? value : Response.json(value)
  }) as typeof fetch
}
const tokenResponse = { errcode: 0, access_token: 'server-access-token', expires_in: 7200 }

test('DingTalk prepared structured card is the exact sent payload and auditable plain text', async () => {
  const structured: DingTalkMessage = { ...message, buttonText: '查看并确认原安排', card: {
    heading: '待确认安排｜接口联调报告', intro: '李四提醒你确认是否已知悉以上安排。',
    items: [{ title: '接口联调报告', lines: ['负责人：张三 · 2026-09-21 周安排', '工作要求：提交测试结果及异常清单。', '任务截止：2026-09-25'] }],
  } }
  const prepared = prepareDingTalkMessage(structured, env)
  assert.ok(prepared.body.startsWith(structured.card!.heading))
  assert.ok(prepared.body.includes('工作要求：提交测试结果及异常清单。'))
  assert.ok(prepared.body.includes('任务截止：2026-09-25'))
  assert.equal(prepared.body.includes('**'), false)
  assert.equal(prepared.buttonText, '查看并确认原安排')
  assert.equal(prepared.url, message.url)
  assert.equal(prepared.truncated, false)
  assert.equal(prepared.payloadHash, createHash('sha256').update(JSON.stringify(prepared.payload)).digest('hex'))
  assert.match(prepared.payload.action_card.markdown, /^### /)
  let sends = 0
  const client = createDingTalkClient({ env, fetch: fetchMock((url, init) => {
    if (url.pathname === '/gettoken') return tokenResponse
    assert.deepEqual(JSON.parse(String(init.body)).msg, prepared.payload)
    sends++
    return { errcode: 0, task_id: 123 }
  }) })
  await client.send('member-1', structured)
  assert.equal(sends, 1)
})

test('DingTalk structured card budgets Chinese and emoji requirements before dropping deadlines or items', () => {
  const card = { heading: '本月工作安排', items: Array.from({ length: 6 }, (_, index) => ({
    title: `联调报告 ${index + 1}`,
    lines: [`工作要求：${'完成中文测试😀，提交异常清单。'.repeat(300)}`, `任务截止：2026-09-${25 + index}`],
  })), totalCount: 8 }
  const prepared = prepareDingTalkMessage({ ...message, buttonText: '查看本月安排', card }, env)
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.payload), 'utf8') <= 2048)
  for (const number of [1, 2, 3]) {
    assert.ok(prepared.body.includes(`联调报告 ${number}`))
    assert.ok(prepared.body.includes(`任务截止：2026-09-${24 + number}`))
  }
  assert.ok(prepared.body.includes('另有 5 项，查看全部'))
  assert.equal(prepared.body.includes('联调报告 4'), false)
  assert.ok(prepared.body.includes('工作要求：'))
  assert.ok(prepared.body.includes('…'))
  assert.equal(prepared.body, Buffer.from(prepared.body, 'utf8').toString('utf8'))
  assert.equal(prepared.payload.action_card.markdown, Buffer.from(prepared.payload.action_card.markdown, 'utf8').toString('utf8'))
  assert.equal(prepared.truncated, true)
  assert.equal(prepared.url, message.url)
})

test('DingTalk remaining-item count follows the items actually fitting the final JSON budget', () => {
  const card = { heading: '月目标安排', items: Array.from({ length: 7 }, (_, index) => ({
    title: `事项 ${index + 1}`, lines: ['工作要求：提交报告', ...Array.from({ length: 12 }, (_, date) => `交付 ${date + 1} 截止：2026-09-25 17:00（北京时间）`)],
  })), totalCount: 7 }
  const prepared = prepareDingTalkMessage({ ...message, card }, env)
  const displayedCount = [...prepared.body.matchAll(/事项 \d/g)].length
  assert.ok(displayedCount >= 1 && displayedCount < 3)
  assert.ok(prepared.body.includes(`另有 ${7 - displayedCount} 项，查看全部`))
  assert.equal([...prepared.body.matchAll(/截止：2026-09-25 17:00（北京时间）/g)].length, displayedCount * 12)
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.payload), 'utf8') <= 2048)
})

test('DingTalk compresses both sides of long changes and requirements mentioning dates', () => {
  const prepared = prepareDingTalkMessage({ ...message, card: { heading: '工作要求有变化', items: [{ title: '接口联调', lines: [
    `工作要求：请在截止 2026-09-25 前${'完成联调并核验交付成果。'.repeat(600)}`,
    `交付要求：原成果${'测试结果'.repeat(500)} → 新成果${'异常复现步骤'.repeat(500)}`,
    '任务截止：2026-09-25',
  ] }] } }, env)
  assert.ok(prepared.body.includes('工作要求：'))
  assert.match(prepared.body, /交付要求：原成果[^\n]*… → 新成果[^\n]*…/)
  assert.ok(prepared.body.includes('任务截止：2026-09-25'))
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.payload), 'utf8') <= 2048)
  assert.equal(prepared.truncated, true)
})

test('DingTalk structured business fragments cannot inject Markdown, HTML, mentions or evidence links', () => {
  const attack = '[链接](https://evil.test/private?token=secret) ![图片](https://evil.test/image) <b>内容</b> @all **伪造**'
  const prepared = prepareDingTalkMessage({ ...message, title: attack, card: { heading: attack, intro: attack, items: [{ title: attack, lines: [attack, '任务截止：2026-09-25'] }], footer: attack } }, env)
  const serialized = JSON.stringify(prepared.payload)
  assert.equal(serialized.includes('evil.test'), false)
  assert.equal(serialized.includes('token=secret'), false)
  assert.equal(serialized.includes('<b>'), false)
  assert.equal(serialized.includes('@all'), false)
  assert.ok(prepared.payload.action_card.markdown.includes(String.raw`\*\*伪造\*\*`))
  assert.ok(prepared.body.includes('任务截止：2026-09-25'))
  assert.equal(prepared.url, message.url)
})

test('DingTalk only accepts approved action labels and preserves complete validated entry URLs', async () => {
  for (const buttonText of ['查看工作安排', '查看并确认安排', '查看并确认原安排', '查看变更并确认', '查看变更', '查看本月安排', '查看目标变更', '查看并审核', '查看审核结果', '核对并正式提交', '查看摘要', '查看事项', '查看原安排']) {
    assert.equal(prepareDingTalkMessage({ ...message, buttonText }, env).buttonText, buttonText)
  }
  assert.equal(prepareDingTalkMessage(message, env).buttonText, '查看工作安排')
  const url = `https://lab.example.test/entry?notificationId=${'x'.repeat(450)}`
  const prepared = prepareDingTalkMessage({ ...message, url, body: '中文😀'.repeat(1000) }, env)
  assert.equal(prepared.payload.action_card.single_url, url)
  assert.equal(prepared.url, url)
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.payload), 'utf8') <= 2048)
  let fetches = 0
  const client = createDingTalkClient({ env, fetch: fetchMock(() => { fetches++; throw new Error('must not fetch') }) })
  for (const buttonText of ['', '确认并完成', '查看事项\n@all', 'https://evil.test']) {
    await assert.rejects(client.send('member-1', { ...message, buttonText }), error => error instanceof DingTalkError && error.outcome === 'definitive' && !error.retryable)
  }
  for (const invalidUrl of ['https://evil.test/entry?notificationId=1', 'https://lab.example.test/entry?notificationId=1&notificationId=2', 'https://lab.example.test/entry?notificationId=1#detail', `${url}xxxxxxxxxx`]) {
    assert.throws(() => prepareDingTalkMessage({ ...message, url: invalidUrl }, env), DingTalkError)
  }
  assert.equal(fetches, 0)
})

test('DingTalk impossible structured minimum fails definitively before any external request', async () => {
  const invalid: DingTalkMessage = { ...message, card: { heading: '待确认安排', items: [{ title: '接口联调报告', lines: ['任务截止：' + '2026-09-25 '.repeat(500)] }] } }
  assert.throws(() => prepareDingTalkMessage(invalid, env), error => error instanceof DingTalkError && error.outcome === 'definitive' && !error.retryable)
  const client = createDingTalkClient({ env, fetch: fetchMock(() => { throw new Error('must not fetch') }) })
  await assert.rejects(client.send('member-1', invalid), error => error instanceof DingTalkError && error.outcome === 'definitive' && !error.retryable)
})

test('DingTalk adapter remains inert when unconfigured and never exposes credentials in errors', async () => {
  const client = createDingTalkClient({ env: {}, fetch: fetchMock(() => { throw new Error('must not fetch') }) })
  assert.equal(client.configured, false)
  await assert.rejects(client.getIdentity('a-code'), error => error instanceof DingTalkError && error.outcome === 'definitive')
  const failed = createDingTalkClient({ env, fetch: fetchMock(() => { throw new Error(env.DINGTALK_CLIENT_SECRET) }) })
  await assert.rejects(failed.getIdentity('private-code'), error => error instanceof DingTalkError && !error.message.includes(env.DINGTALK_CLIENT_SECRET) && !error.message.includes('private-code'))
})

test('DingTalk coalesces token refreshes, caches per expiry and exchanges H5 codes in the app enterprise', async () => {
  let now = 0, tokenCalls = 0, identities = 0
  const client = createDingTalkClient({ env, now: () => now, fetch: fetchMock(async (url, input) => {
    if (url.pathname === '/gettoken') {
      tokenCalls++
      assert.equal(url.searchParams.get('appkey'), env.DINGTALK_CLIENT_ID)
      assert.equal(input.redirect, 'error')
      await new Promise(resolve => setImmediate(resolve))
      return tokenResponse
    }
    assert.equal(url.pathname, '/topapi/v2/user/getuserinfo')
    assert.equal(url.searchParams.get('access_token'), tokenResponse.access_token)
    identities++
    return { errcode: 0, result: { userid: 'member-1', sys: true, sys_level: 1 } }
  }) })
  assert.deepEqual(await Promise.all([client.getIdentity('code1'), client.getIdentity('code2')]), [{ corpId: 'ding-corp', userid: 'member-1' }, { corpId: 'ding-corp', userid: 'member-1' }])
  assert.equal(tokenCalls, 1)
  now = 7_100_000
  await client.getIdentity('code3')
  assert.equal(tokenCalls, 1)
  now = 7_150_000
  await client.getIdentity('code4')
  assert.equal(tokenCalls, 2)
  assert.equal(identities, 4)
})

test('DingTalk sends one personal action card with no broadcast or arbitrary redirect and preserves long task IDs', async () => {
  let sent = 0
  const client = createDingTalkClient({ env, fetch: fetchMock((url, init) => {
    if (url.pathname === '/gettoken') return tokenResponse
    assert.equal(url.pathname, '/topapi/message/corpconversation/asyncsend_v2')
    const body = JSON.parse(String(init.body))
    assert.equal(body.userid_list, 'member-1')
    assert.equal(body.to_all_user, false)
    assert.equal(body.agent_id, 1234)
    assert.deepEqual(body.msg, { msgtype: 'action_card', action_card: {
      title: message.title, markdown: message.body, single_title: '查看工作安排', single_url: message.url,
    } })
    sent++
    return new Response('{"errcode":0,"task_id":9223372036854775806}')
  }) })
  assert.deepEqual(await client.send('member-1', message), { taskId: '9223372036854775806' })
  for (const url of ['https://evil.example/entry?notificationId=x', 'https://lab.example.test/auth/login', 'https://lab.example.test/entry?notificationId=x&returnUrl=evil', `https://lab.example.test/entry?notificationId=${'x'.repeat(500)}`]) await assert.rejects(client.send('member-1', { ...message, url }), DingTalkError)
  await assert.rejects(client.send('member-1,member-2', message), DingTalkError)
  assert.equal(sent, 1)
})

test('DingTalk action card treats user Markdown, HTML and URLs as plain text', async () => {
  const samples = [
    ['[外链](https://evil.test)', String.raw`\[外链\]\(https\:\/\/evil\.test\)`],
    ['![图片](https://evil.test/x)', String.raw`\!\[图片\]\(https\:\/\/evil\.test\/x\)`],
    ['<a href="https://evil.test">点击</a>', String.raw`\<a href\=\"https\:\/\/evil\.test\"\>点击\<\/a\>`],
    ['https://evil.test @all &amp; `代码`', String.raw`https\:\/\/evil\.test \@all \&amp\; \`代码\``],
    ['[引用]: https://evil.test\n# 标题\\', String.raw`\[引用\]\: https\:\/\/evil\.test` + '\n' + String.raw`\# 标题\\`],
  ]
  for (const [body, expected] of samples) {
    const client = createDingTalkClient({ env, fetch: fetchMock((url, init) => {
      if (url.pathname === '/gettoken') return tokenResponse
      const msg = JSON.parse(String(init.body)).msg
      assert.equal(msg.msgtype, 'action_card')
      assert.equal(msg.action_card.markdown, expected)
      assert.equal(msg.action_card.single_url, message.url)
      return { errcode: 0, task_id: 123 }
    }) })
    await client.send('member-1', { ...message, body })
  }
})

test('DingTalk uncertain sends are never automatically retried; clear provider rejection is classified separately', async () => {
  for (const outcome of ['transport', 'http', 'malformed', 'missing-task', 'system-busy'] as const) {
    let sends = 0
    const client = createDingTalkClient({ env, fetch: fetchMock(url => {
      if (url.pathname === '/gettoken') return tokenResponse
      sends++
      if (outcome === 'transport') throw new Error('timeout with token server-access-token')
      if (outcome === 'http') return new Response('failure', { status: 502 })
      if (outcome === 'malformed') return new Response('broken JSON')
      if (outcome === 'system-busy') return { errcode: -1, errmsg: 'unknown acceptance' }
      return { errcode: 0 }
    }) })
    await assert.rejects(client.send('member-1', message), error => error instanceof DingTalkError && error.outcome === 'unknown' && error.retryable === false && !error.message.includes('server-access-token'))
    assert.equal(sends, 1)
  }
  const rejected = createDingTalkClient({ env, fetch: fetchMock(url => url.pathname === '/gettoken' ? tokenResponse : { errcode: 88, errmsg: 'private provider details' }) })
  await assert.rejects(rejected.send('member-1', message), error => error instanceof DingTalkError && error.outcome === 'definitive' && error.retryable && !error.message.includes('private provider'))
})

test('DingTalk long Chinese/emoji content is truncated to 2048 serialized UTF-8 bytes without losing the link', async () => {
  let sent = 0
  const client = createDingTalkClient({ env, fetch: fetchMock((url, init) => {
    if (url.pathname === '/gettoken') return tokenResponse
    const msg = JSON.parse(String(init.body)).msg
    assert.ok(Buffer.byteLength(JSON.stringify(msg), 'utf8') <= 2048)
    assert.equal(msg.action_card.single_url, message.url)
    assert.match(msg.action_card.title, /…$/)
    assert.match(msg.action_card.markdown, /…$/)
    assert.ok(msg.action_card.markdown.includes('中文'))
    assert.equal(msg.action_card.markdown.includes('\uFFFD'), false)
    assert.equal(msg.action_card.title.includes('\uFFFD'), false)
    sent++
    return { errcode: 0, task_id: 123 }
  }) })
  await client.send('member-1', { ...message, title: '中文标题😀'.repeat(200), body: '中文正文😀"\\\n'.repeat(500) })
  assert.equal(sent, 1)
})

test('DingTalk token failure is definitive before send, expired token is invalidated without replaying sends', async () => {
  let tokenCalls = 0, sends = 0
  const client = createDingTalkClient({ env, fetch: fetchMock(url => {
    if (url.pathname === '/gettoken') { tokenCalls++; return tokenResponse }
    sends++
    return sends === 1 ? { errcode: 42001 } : { errcode: 0, task_id: 123 }
  }) })
  await assert.rejects(client.send('member-1', message), error => error instanceof DingTalkError && error.outcome === 'definitive' && error.retryable)
  assert.equal(sends, 1)
  await client.send('member-1', message)
  assert.equal(tokenCalls, 2)
  const brokenToken = createDingTalkClient({ env, fetch: fetchMock(() => { throw new Error('offline') }) })
  await assert.rejects(brokenToken.send('member-1', message), error => error instanceof DingTalkError && error.outcome === 'definitive' && error.retryable)
})

test('DingTalk result only reports explicit recipient success; empty, unrelated and failure evidence stay distinct', async () => {
  let result: unknown = {}
  const client = createDingTalkClient({ env, fetch: fetchMock((url, init) => {
    if (url.pathname === '/gettoken') return tokenResponse
    assert.equal(url.pathname, '/topapi/message/corpconversation/getsendresult')
    assert.deepEqual(JSON.parse(String(init.body)), { agent_id: 1234, task_id: '123' })
    return { errcode: 0, send_result: result }
  }) })
  assert.equal(await client.result('123', 'member-1'), 'pending')
  result = { unread_user_id_list: ['other'] }
  assert.equal(await client.result('123', 'member-1'), 'pending')
  result = { unread_user_id_list: ['member-1'] }
  assert.equal(await client.result('123', 'member-1'), 'delivered')
  result = { read_user_id_list: ['member-1'] }
  assert.equal(await client.result('123', 'member-1'), 'delivered')
  for (const key of ['invalid_user_id_list', 'failed_user_id_list', 'forbidden_user_id_list']) {
    result = { [key]: ['member-1'], read_user_id_list: ['member-1'] }
    assert.equal(await client.result('123', 'member-1'), 'failed')
  }
  result = { forbidden_list: [{ userid: 'member-1', code: 'deduplicated' }] }
  assert.equal(await client.result('123', 'member-1'), 'failed')
})

test('DingTalk rejects identity payloads with another enterprise, unsafe recipient or missing user', async () => {
  for (const result of [{ userid: 'member-1', corp_id: 'other-corp' }, { userid: 'one,two' }, {}]) {
    const client = createDingTalkClient({ env, fetch: fetchMock(url => url.pathname === '/gettoken' ? tokenResponse : { errcode: 0, result }) })
    await assert.rejects(client.getIdentity('code'), DingTalkError)
  }
})
