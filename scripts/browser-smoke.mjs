// Browser smoke check through the Chrome DevTools protocol (Node 24 has a global WebSocket).
// Run only against a FRESH, disposable instance: it creates the first manager account.
//   DATABASE_PATH=output/smoke/db.sqlite PORT=4399 npm start   (after npm run build)
//   CHROME_PATH=/path/to/chrome node scripts/browser-smoke.mjs http://127.0.0.1:4399
// Checks the shell and main pages render without errors, entering the weekly page issues one
// read, the entry page code downloads alongside the workspace read, and search waits for a pause.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2] ?? 'http://127.0.0.1:4399'
const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const port = 9333
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lab-smoke-'))}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let target
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page') } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(resolve => ws.addEventListener('open', resolve))
let id = 0; const pending = new Map(), requests = [], errors = []
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url.replace(origin, ''))
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(a => a.value ?? a.description).join(' '))
})
const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
const text = () => evaluate('document.body.innerText')
const waitFor = async (predicate, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return; await sleep(150) } throw new Error(`timeout: ${label}\n${(await text())?.slice(0, 400)}`) }
await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

try {
  await send('Page.navigate', { url: `${origin}/` }); await sleep(1500)
  const setup = await evaluate(`fetch('/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'冒烟管理者',email:'smoke@example.test',password:'Smoke-check-password-2026'})}).then(r=>r.status)`)
  check('first manager account created', setup === 201, setup === 409 ? 'instance already initialized; use a fresh database' : `status ${setup}`)
  if (setup !== 201) throw new Error('a fresh instance is required')
  await send('Page.navigate', { url: `${origin}/` })
  await waitFor(async () => (await evaluate('!!document.querySelector(".arco-layout, .arco-menu, nav")')) === true, 'workspace shell')
  check('workspace shell renders with Arco layout', true)
  await sleep(3500)
  const notPreloaded = ['Monthly', 'Reports', 'Team', 'Feedback'].filter(name => !requests.some(u => new RegExp(`/assets/${name}-.*\\.js`).test(u)))
  check('idle time preloads the other pages', notPreloaded.length === 0, notPreloaded.length ? `missing ${notPreloaded.join(', ')}` : '')
  const switched = await evaluate(`(async () => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('月度目标'))
    if (!item) return 'no menu item'
    item.click(); await new Promise(r => requestAnimationFrame(() => r()))
    return document.querySelector('.page-resource-loading') ? 'loading fallback shown' : 'rendered directly'
  })()`)
  check('in-app navigation after preload skips the loading fallback', switched === 'rendered directly', switched)

  requests.length = 0
  await send('Page.navigate', { url: `${origin}/work?view=weekly` })
  await waitFor(async () => requests.some(u => u.startsWith('/api/workspace/weekly?')) && !(await text()).includes('正在读取周工作'), 'weekly page')
  await sleep(1200)
  const weeklyReads = requests.filter(u => u.startsWith('/api/workspace/weekly?'))
  check('entering the weekly page issues a single weekly read', weeklyReads.length === 1, weeklyReads.join(' | '))
  const pageChunk = requests.findIndex(u => /\/assets\/Weekly-.*\.js/.test(u)), workspaceRead = requests.findIndex(u => u === '/api/workspace')
  check('weekly page code starts downloading before the workspace read', pageChunk !== -1 && workspaceRead !== -1 && pageChunk < workspaceRead, `chunk #${pageChunk}, workspace #${workspaceRead}`)

  requests.length = 0
  const typed = await evaluate(`(async () => {
    const input = [...document.querySelectorAll('input')].find(el => el.closest('.search-input'))
    if (!input) return 'no search input'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    for (const value of ['项', '项目', '项目进', '项目进展']) { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 60)) }
    return 'typed'
  })()`)
  await sleep(1200)
  const searchReads = requests.filter(u => u.startsWith('/api/workspace/weekly?'))
  check('typing four characters issues one search read after the pause', typed === 'typed' && searchReads.length === 1 && decodeURIComponent(searchReads[0]).includes('q=项目进展'), `${typed}; ${searchReads.map(decodeURIComponent).join(' | ')}`)

  for (const page of ['monthly', 'collaboration', 'work-register', 'reports', 'period-reviews', 'feedback']) {
    requests.length = 0
    await send('Page.navigate', { url: `${origin}/work?view=${page}` })
    await waitFor(async () => { const body = await text(); return !!body && !/正在加载页面资源|正在读取/.test(body) }, page)
    check(`${page} page renders`, !(await text()).includes('页面资源加载失败'))
  }
  check('no uncaught errors or console errors', errors.length === 0, errors.slice(0, 3).join(' || '))
} catch (error) {
  check('smoke run completed', false, error.message)
} finally {
  ws.close(); browser.kill()
  process.exitCode = results.every(r => r.ok) ? 0 : 1
}
