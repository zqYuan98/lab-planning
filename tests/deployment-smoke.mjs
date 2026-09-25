import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

// Never target the user's application on port 4310 or an arbitrary remote host.
const port = Number(process.argv[3] || 4321)
assert.ok([4321, 44321].includes(port), 'Use an isolated deployment-test port: 4321 or 44321')
const base = `http://127.0.0.1:${port}`
const mode = process.argv[2]
assert.ok(['setup', 'verify'].includes(mode), 'Use setup or verify')
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(`${base}/api/auth/status`, { signal: AbortSignal.timeout(1000) })
    if (response.ok) break
  } catch { /* The isolated process may still be starting. */ }
  if (attempt === 29) throw new Error('Deployment did not become ready')
  await delay(300)
}
let cookie = ''
async function request(path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
  const data = await response.json()
  assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`)
  return data
}
const credentials = { email: 'container-fixture@example.test', password: 'Disposable-container-fixture-2026!' }
const page = await fetch(base)
assert.equal(page.status, 200)
assert.ok(page.headers.get('content-security-policy')?.includes("default-src 'self'"))
const html = await page.text()
assert.match(html, /天枢实验室/)
const asset = html.match(/src="([^\"]+\.js)"/)?.[1]
assert.ok(asset, 'Built JavaScript must be referenced by the served page')
assert.equal((await fetch(new URL(asset, base))).status, 200)
if (mode === 'setup') {
  assert.deepEqual(await request('/auth/status'), { initialized: false })
  const manager = await request('/auth/setup', { ...credentials, name: '容器验收管理员' })
  await request('/projects', { name: '重启后应保留的验收项目', code: 'CONTAINER-PERSISTENCE', ownerId: manager.id })
  const report = await request('/reports', { type: 'monthly', period: '2026-09' })
  const word = await fetch(`${base}/api/reports/${report.id}/export?format=docx`, { headers: { cookie } })
  assert.equal(word.status, 200)
  assert.match(word.headers.get('content-type'), /wordprocessingml/)
  const bytes = new Uint8Array(await word.arrayBuffer())
  assert.deepEqual(Array.from(bytes.slice(0, 2)), [80, 75])
} else {
  await request('/auth/login', credentials)
  const projects = await request('/workspace/projects?q=CONTAINER-PERSISTENCE')
  const reports = await request('/workspace/reports')
  assert.equal(projects.items.filter(project => project.code === 'CONTAINER-PERSISTENCE').length, 1)
  assert.equal(reports.total, 1)
}
console.log(`Deployment ${mode}: static assets, authenticated API, SQLite ${mode === 'setup' ? 'writes and Word export' : 'persistence after restart'} passed.`)
