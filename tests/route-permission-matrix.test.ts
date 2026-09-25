import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'

/**
 * Pins who can reach every browser API route. Each route is called with a missing object id and
 * an empty body as an anonymous visitor, an observer, a member and a manager. The fixture keeps
 * each exact status: a change to any authentication or role gate, or to its order relative to
 * validation, shows up as a reviewed diff. Regenerate after an intended change with
 * UPDATE_ROUTE_MATRIX=1 and review the resulting file diff.
 */
const fixturePath = new URL('./fixtures/route-permission-matrix.json', import.meta.url)
const roles = ['anonymous', 'observer', 'member', 'manager'] as const
type Role = typeof roles[number]
type Matrix = Record<string, Record<Role, number>>
const password = 'Matrix-only-password-2026!'

interface Layer { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] }; matchers?: ((path: string) => unknown)[] }
function browserRoutes(app: { router: { stack: Layer[] } }): string[] {
  const routes = new Set<string>()
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) routes.add(`${method.toUpperCase()} ${prefix}${layer.route.path}`)
      else if (layer.handle?.stack) {
        // Routers are mounted at /api, except the separately authenticated integration API.
        const mount = layer.matchers?.[0]?.('/api/matrix') ? '/api' : layer.matchers?.[0]?.('/api/v1/matrix') ? '/api/v1' : ''
        walk(layer.handle.stack, `${prefix}${mount}`)
      }
    }
  }
  walk(app.router.stack, '')
  // Session lifecycle and the separately keyed integration API have their own tests.
  return [...routes].filter(route => route.split(' ')[1].startsWith('/api/') && !route.split(' ')[1].startsWith('/api/v1/') && !route.split(' ')[1].startsWith('/api/auth/')).sort()
}
const concrete = (path: string) => path.replace(/:(\w+)/g, 'matrix-missing').replace(/\*(\w+)/g, 'matrix-missing')

test('every browser API route keeps its pinned status for anonymous, observer, member and manager callers', async t => {
  const previous = { NODE_ENV: process.env.NODE_ENV, APP_ORIGIN: process.env.APP_ORIGIN }
  process.env.NODE_ENV = 'test'; delete process.env.APP_ORIGIN
  const store = new Store(':memory:'), app = createApp({ store }), server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); store.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = (method: string, path: string, cookie?: string, body?: unknown) => fetch(`${origin}${path}`, {
    method, headers: { origin, ...(cookie ? { cookie } : {}), ...(method === 'GET' || method === 'HEAD' ? {} : { 'content-type': 'application/json' }) },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  const setup = await call('POST', '/api/auth/setup', undefined, { name: '矩阵管理者', email: 'manager@matrix.example', password })
  assert.equal(setup.status, 201)
  const cookies: Partial<Record<Role, string>> = { manager: setup.headers.get('set-cookie')!.split(';')[0] }
  const login = async (role: Exclude<Role, 'anonymous'>) => {
    const response = await call('POST', '/api/auth/login', undefined, { email: `${role}@matrix.example`, password })
    assert.equal(response.status, 200, `${role} can sign in again`)
    cookies[role] = response.headers.get('set-cookie')!.split(';')[0]
  }
  for (const role of ['member', 'observer'] as const) {
    assert.equal((await call('POST', '/api/users', cookies.manager, { name: `矩阵${role}`, email: `${role}@matrix.example`, password, role, position: '' })).status, 201)
    await login(role)
  }
  // Some routes intentionally end the caller's session (for example unbinding DingTalk).
  // Restore every session before the next route so later statuses reflect roles, not sign-out.
  const ensureSessions = async () => {
    for (const role of ['observer', 'member', 'manager'] as const) {
      const me = await call('GET', '/api/auth/me', cookies[role]); await me.arrayBuffer()
      if (me.status === 401) await login(role)
      else assert.equal(me.status, 200)
    }
  }

  const routes = browserRoutes(app as never), actual: Matrix = {}
  assert.ok(routes.length > 150, `expected the full browser API, found ${routes.length} routes`)
  for (const route of routes) {
    const [method, path] = route.split(' ')
    actual[route] = {} as Record<Role, number>
    await ensureSessions()
    for (const role of roles) {
      const response = await call(method, concrete(path), cookies[role as Exclude<Role, 'anonymous'>])
      await response.arrayBuffer()
      actual[route][role] = response.status
    }
  }
  // Anonymous callers never reach a handler.
  for (const [route, statuses] of Object.entries(actual)) assert.ok([401, 403, 404].includes(statuses.anonymous), `${route} answered anonymous with ${statuses.anonymous}`)

  if (process.env.UPDATE_ROUTE_MATRIX === '1') { writeFileSync(fixturePath, `${JSON.stringify(actual, null, 1)}\n`); return }
  const expected = JSON.parse(readFileSync(fixturePath, 'utf8')) as Matrix
  const changes = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().flatMap(route => {
    if (!expected[route]) return [`+ ${route} ${JSON.stringify(actual[route])}`]
    if (!actual[route]) return [`- ${route}`]
    return roles.filter(role => expected[route][role] !== actual[route][role]).map(role => `~ ${route} ${role}: ${expected[route][role]} -> ${actual[route][role]}`)
  })
  assert.deepEqual(changes, [], `Route permissions changed. Review, then rerun with UPDATE_ROUTE_MATRIX=1 if intended:\n${changes.join('\n')}`)
})
