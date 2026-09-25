import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import { request, createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { compressResponses, staticDelivery } from '../server/http-delivery.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { Store } from '../server/store.ts'

const javascript = 'console.log("内容哈希构建资源");\n'.repeat(400)
const html = '<!doctype html><html><title>工作空间</title><body>shell</body></html>'
const hashedFile = '/assets/application-aBcD123_.js'
type WireResponse = { status: number; headers: IncomingHttpHeaders; bytes: Buffer }
function wire(server: Server, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, headers, method }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject).end()
  })
}
async function listen(t: TestContext, server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return server
}
async function fixture(t: TestContext, withManifest = true) {
  const dist = mkdtempSync(join(tmpdir(), 'lab-http-delivery-'))
  t.after(() => rmSync(dist, { recursive: true, force: true }))
  mkdirSync(join(dist, 'assets')); mkdirSync(join(dist, '.vite'))
  writeFileSync(join(dist, 'index.html'), html)
  writeFileSync(join(dist, hashedFile), javascript)
  writeFileSync(join(dist, 'assets/plain.js'), javascript)
  writeFileSync(join(dist, 'assets/not-listed-aBcD123_.js'), javascript)
  writeFileSync(join(dist, 'logo.png'), Buffer.alloc(3000, 5))
  if (withManifest) writeFileSync(join(dist, '.vite/manifest.json'), JSON.stringify({ 'index.html': { file: hashedFile.slice(1), isEntry: true }, mutable: { file: 'assets/plain.js' } }))
  const app = express()
  app.use(compressResponses())
  app.get('/no-transform', (_req, res) => res.set('Cache-Control', 'no-transform').type('text').send(javascript))
  app.get('/already-encoded', (_req, res) => res.set('Content-Encoding', 'custom').type('text').send(javascript))
  app.get('/events', (_req, res) => res.type('text/event-stream').send(javascript))
  app.get('/vary', (_req, res) => res.vary('Origin').type('text').send(javascript))
  app.use(staticDelivery(dist))
  return listen(t, createServer(app))
}
const varyEncoding = (res: WireResponse) => assert.match(String(res.headers.vary), /(?:^|,\s*)Accept-Encoding(?:,|$)/i)

test('static delivery negotiates gzip, Brotli, deflate, quality values and identity with exact bytes', async t => {
  const server = await fixture(t)
  const cases = [
    ['gzip', 'gzip'], ['br', 'br'], ['deflate', 'deflate'],
    ['gzip;q=0, br;q=0.5, identity;q=0', 'br'],
    ['br;q=0.1,gzip;q=0.9,identity;q=0', 'gzip'],
    ['gzip;q=0,br;q=0,deflate;q=0', undefined], ['identity', undefined],
  ] as const
  for (const [accept, expected] of cases) {
    const res = await wire(server, hashedFile, { 'Accept-Encoding': accept })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], expected, accept)
    varyEncoding(res)
    const decoded = expected === 'gzip' ? gunzipSync(res.bytes) : expected === 'br' ? brotliDecompressSync(res.bytes) : expected === 'deflate' ? inflateSync(res.bytes) : res.bytes
    assert.equal(decoded.toString(), javascript)
    if (expected) { assert.ok(res.bytes.length < Buffer.byteLength(javascript)); assert.equal(res.headers['content-length'], undefined) }
  }
  assert.equal((await wire(server, hashedFile)).headers['content-encoding'], undefined)
  const vary = await wire(server, '/vary', { 'Accept-Encoding': 'gzip' })
  assert.match(String(vary.headers.vary), /Origin/); varyEncoding(vary)
})

test('only manifest-listed hash assets are immutable; shell and mutable files revalidate; missing files are 404', async t => {
  const server = await fixture(t)
  assert.equal((await wire(server, hashedFile)).headers['cache-control'], 'public, max-age=31536000, immutable')
  for (const path of ['/', '/index.html', '/work?view=weekly&id=task-1', '/assets/plain.js', '/assets/not-listed-aBcD123_.js']) {
    const res = await wire(server, path, { Accept: 'text/html' })
    assert.equal(res.status, 200, path)
    assert.equal(res.headers['cache-control'], 'no-cache', path)
  }
  for (const path of ['/assets/missing-aBcD123_.js', '/assets/missing', '/%61ssets/missing', '/assets', '/favicon.ico', '/.vite/manifest.json']) {
    const res = await wire(server, path, { Accept: 'text/html' })
    assert.equal(res.status, 404, path)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.doesNotMatch(res.bytes.toString(), /<html/)
  }
  assert.equal((await wire(server, '/work', { Accept: 'application/json' })).status, 404)
  const legacy = await fixture(t, false)
  assert.equal((await wire(legacy, hashedFile)).headers['cache-control'], 'no-cache')
})

test('HEAD and conditional GET remain bodyless with validators and Vary; range, binary, streams and no-transform are preserved', async t => {
  const server = await fixture(t)
  for (const path of [hashedFile, '/work?view=reports']) {
    const original = await wire(server, path, { 'Accept-Encoding': 'gzip' })
    const head = await wire(server, path, { 'Accept-Encoding': 'gzip' }, 'HEAD')
    assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); varyEncoding(head)
    assert.equal(head.headers.etag, original.headers.etag)
    const fresh = await wire(server, path, { 'Accept-Encoding': 'gzip', 'If-None-Match': String(original.headers.etag) })
    assert.equal(fresh.status, 304); assert.equal(fresh.bytes.length, 0); varyEncoding(fresh)
    assert.equal(fresh.headers['content-encoding'], undefined)
    assert.equal(fresh.headers['cache-control'], original.headers['cache-control'])
  }
  for (const path of ['/logo.png', '/no-transform', '/events', '/']) assert.equal((await wire(server, path, { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], undefined, path)
  const encoded = await wire(server, '/already-encoded', { 'Accept-Encoding': 'gzip' })
  assert.equal(encoded.headers['content-encoding'], 'custom'); assert.equal(encoded.bytes.toString(), javascript)
  const range = await wire(server, hashedFile, { 'Accept-Encoding': 'identity', Range: 'bytes=0-9' })
  assert.equal(range.status, 206); assert.equal(range.bytes.length, 10)
  const largeRange = await wire(server, hashedFile, { 'Accept-Encoding': 'gzip', Range: 'bytes=0-1999' })
  assert.equal(largeRange.status, 206); assert.equal(largeRange.bytes.length, 2000)
  assert.equal(largeRange.headers['content-encoding'], undefined)
})

test('proxy forwarding preserves representation, Vary and cache policy without a second compression', async t => {
  const upstream = await fixture(t)
  const proxy = await listen(t, createServer((req, res) => {
    const forwarded = request({ host: '127.0.0.1', port: (upstream.address() as AddressInfo).port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res)
    })
    forwarded.on('error', () => res.writeHead(502).end()); req.pipe(forwarded)
  }))
  const result = await wire(proxy, hashedFile, { 'Accept-Encoding': 'gzip' })
  assert.equal(result.headers['content-encoding'], 'gzip'); varyEncoding(result)
  assert.equal(result.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(gunzipSync(result.bytes).toString(), javascript)
  assert.equal((await wire(proxy, hashedFile, { 'Accept-Encoding': 'gzip', 'If-None-Match': String(result.headers.etag) })).status, 304)
  assert.equal((await wire(proxy, hashedFile, { 'Accept-Encoding': 'gzip' }, 'HEAD')).bytes.length, 0)
  const nginx = readFileSync(resolve('deploy/nginx.conf.example'), 'utf8')
  assert.match(nginx, /gzip off;/); assert.match(nginx, /proxy_cache off;/)
  assert.equal((nginx.match(/proxy_pass /g) || []).length, (nginx.match(/proxy_set_header Accept-Encoding \$http_accept_encoding;/g) || []).length)
})

test('authenticated JSON remains no-store and isolated across accounts, errors keep security headers', async t => {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const actors = ['member-a', 'member-b'].map(id => store.insert<StoredUser>('users', { id, name: id.repeat(300), email: `${id}@example.test`, role: 'member', position: '', active: true, credentialVersion: 1, passwordHash: 'unused' }))
  const server = await listen(t, createServer(createApp({ store, enableScheduler: false })))
  for (const actor of actors) {
    const res = await wire(server, '/api/auth/me', { 'Accept-Encoding': 'gzip', Cookie: `lab_session=${createSession(store, actor)}` })
    assert.equal(res.status, 200); assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['content-encoding'], 'gzip'); varyEncoding(res)
    assert.equal(JSON.parse(gunzipSync(res.bytes).toString()).id, actor.id)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['x-frame-options'], 'DENY')
    assert.ok(res.headers['x-request-id'])
  }
  const unauthorized = await wire(server, '/api/auth/me', { 'Accept-Encoding': 'gzip' })
  assert.equal(unauthorized.status, 401); assert.equal(unauthorized.headers['cache-control'], 'no-store')
  assert.equal(unauthorized.headers['x-content-type-options'], 'nosniff')
})

test('favicon reuses the existing vector brand below 10KB while original brand assets remain', () => {
  const source = readFileSync(resolve('index.html'), 'utf8')
  assert.match(source, /rel="icon" type="image\/svg\+xml" href="\/src\/assets\/lab-favicon\.svg"/)
  assert.ok(readFileSync(resolve('src/assets/lab-favicon.svg')).length < 10 * 1024)
  assert.equal(readFileSync(resolve('src/assets/lab-icon.png')).length, 1_361_688)
})
