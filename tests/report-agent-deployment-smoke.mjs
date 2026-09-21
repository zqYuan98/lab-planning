import assert from 'node:assert/strict'

// Public post-deployment probe. Every request is GET, without cookies, tokens or
// login. It never uploads files, creates reports, changes settings or runs jobs.
// Usage: node tests/report-agent-deployment-smoke.mjs https://lab.notvitamin.com
assert.equal(process.argv.length, 3, 'Supply exactly one public HTTPS origin')
const base = new URL(process.argv[2])
assert.equal(base.protocol, 'https:', 'Only public HTTPS origins are accepted')
assert.ok(!base.username && !base.password && !base.search && !base.hash, 'Do not put credentials, query parameters or fragments in the origin')
assert.equal(base.pathname, '/', 'Supply an origin without an application path')
assert.ok(!['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(base.hostname), 'This probe is for a public deployment, not a local fixture')

const checks = []
async function publicJson(path) {
  const response = await fetch(new URL(path, base), {
    method: 'GET', redirect: 'error', credentials: 'omit',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  })
  assert.match(response.headers.get('content-type') || '', /^application\/json\b/i, `${path}: expected JSON, not a login page or proxy error`)
  assert.match(response.headers.get('cache-control') || '', /\bno-store\b/i, `${path}: API responses must not be cached`)
  assert.equal(response.headers.get('set-cookie'), null, `${path}: anonymous checks must not create a session`)
  assert.equal(response.headers.get('content-disposition'), null, `${path}: an anonymous request must not return a document`)
  const requestId = response.headers.get('x-request-id') || ''
  assert.match(requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, `${path}: expected the application request ID`)
  let data
  try { data = await response.json() } catch { throw new Error(`${path}: invalid JSON response`) }
  return { response, requestId, data }
}

const status = await publicJson('/api/auth/status')
assert.equal(status.response.status, 200, 'The application must be healthy and reachable through HTTPS')
assert.deepEqual(status.data, { initialized: true }, 'Production must still use its existing initialized database')
checks.push({ path: '/api/auth/status', status: status.response.status, requestId: status.requestId })

const probeId = '__anonymous_report_agent_deployment_probe__'
const paths = [
  '/api/report-agent',
  '/api/report-agent/schedule',
  `/api/report-agent/jobs/${probeId}`,
  `/api/report-agent/reports/${probeId}`,
  `/api/report-agent/reports/${probeId}/docx?expectedVersion=1`,
  `/api/report-agent/assets/${probeId}/download`,
  '/api/v1/report-agent',
  `/api/reports/${probeId}/export?format=docx`,
]
for (const path of paths) {
  const { response, requestId, data } = await publicJson(path)
  assert.equal(response.status, 401, `${path}: authentication must run before data lookup or document generation`)
  assert.ok(data && typeof data.error === 'string' && data.error.length > 0, `${path}: expected an authentication error`)
  assert.equal(data.requestId, requestId, `${path}: error and response request IDs must agree`)
  assert.deepEqual(Object.keys(data).sort(), ['error', 'requestId'], `${path}: an anonymous error must not expose report data`)
  checks.push({ path, status: response.status, requestId })
}

console.log(JSON.stringify({
  origin: base.origin, checkedAt: new Date().toISOString(), readOnly: true, authenticated: false,
  passed: checks.length, checks,
  limitation: 'Anonymous guards alone do not prove the deployed commit, manager/member authorization, worker operation or restore integrity; verify those separately against the sealed release and isolated fixtures.',
}, null, 2))
