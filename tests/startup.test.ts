import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

test('an occupied port exits unsuccessfully without announcing readiness', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-startup-'))
  const occupied = createServer().listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  const port = (occupied.address() as AddressInfo).port
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: resolve('.'),
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      APP_ORIGIN: `http://127.0.0.1:${port}`, COOKIE_SECURE: 'false', TRUST_PROXY: 'false',
      DATABASE_PATH: join(directory, 'startup.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', data => { output += String(data) })
  child.stderr.on('data', data => { output += String(data) })
  const timeout = setTimeout(() => child.kill(), 10000)
  try {
    const [code] = await once(child, 'close')
    assert.equal(code, 1, output)
    assert.match(output, /服务启动失败/)
    assert.match(output, /EADDRINUSE/)
    assert.doesNotMatch(output, /系统已启动/)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await new Promise<void>(done => occupied.close(() => done()))
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('lab-startup-'))
    rmSync(directory, { recursive: true, force: true })
  }
})
