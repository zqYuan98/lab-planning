import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, Suspense } from 'react'
import { renderToPipeableStream } from 'react-dom/server'
import { PassThrough } from 'node:stream'
import { createLazyResource, PageModuleLoadError } from '../src/lazy-resource.ts'

test('failed lazy modules retry with a fresh React component and recover without changing page props', async () => {
  let attempts = 0
  const resource = createLazyResource(async () => {
    attempts++
    if (attempts === 1) throw new Error('https://private.example/chunk.js?secret=omitted')
    return { default: ({ taskId }: { taskId: string }) => createElement('p', null, taskId) }
  })
  const initial = resource.component
  await assert.rejects(resource.load(), error => error instanceof PageModuleLoadError && !error.message.includes('private'))
  await assert.rejects(resource.load(), PageModuleLoadError)
  assert.equal(attempts, 1, 'a failed resource remains stable until an explicit retry')
  resource.retry()
  assert.notEqual(resource.component, initial)
  const markup = await new Promise<string>((resolve, reject) => {
    const output = new PassThrough()
    let html = ''
    output.on('data', chunk => { html += chunk.toString() }); output.on('end', () => resolve(html))
    const stream = renderToPipeableStream(createElement(Suspense, { fallback: '正在加载' }, createElement(resource.component, { taskId: 'deep-link-task' })), {
      onAllReady() { stream.pipe(output) }, onError: reject,
    })
  })
  assert.match(markup, /deep-link-task/)
  assert.equal(attempts, 2)
  const loaded = resource.component
  resource.retry()
  assert.equal(resource.component, loaded, 'successful components keep their identity and local draft state')
})

test('concurrent lazy reads share the request and pending retries do not duplicate a request', async () => {
  let resolveModule!: (value: { default: () => null }) => void
  let calls = 0
  const resource = createLazyResource(() => { calls++; return new Promise<{ default: () => null }>(resolve => { resolveModule = resolve }) })
  const component = resource.component
  const first = resource.load(), second = resource.load()
  resource.retry()
  assert.equal(first, second); assert.equal(resource.component, component)
  await Promise.resolve()
  assert.equal(calls, 1)
  resolveModule({ default: () => null })
  await first
  assert.equal(await resource.load(), await second)
})

test('failed Vite stylesheet preload requires a protected document reload instead of rendering without CSS', async () => {
  let attempts = 0
  const resource = createLazyResource<Record<string, never>>(async () => {
    attempts++
    throw new Error('Unable to preload CSS for /assets/private-page.css')
  })
  const component = resource.component
  await assert.rejects(resource.load(), error => error instanceof PageModuleLoadError && error.reloadRequired && !error.message.includes('private-page'))
  resource.retry()
  assert.equal(component, resource.component)
  await assert.rejects(resource.load(), PageModuleLoadError)
  assert.equal(attempts, 1)
})

test('browser-cached dynamic import fetch failures require the protected reload action', async () => {
  // Chromium/Edge, Firefox and WebKit use different rejection messages.
  for (const message of [
    'Failed to fetch dynamically imported module: http://localhost/assets/FeedbackComposer-old.js',
    'error loading dynamically imported module: http://localhost/assets/FeedbackComposer-old.js',
    'Importing a module script failed.',
  ]) {
    let attempts = 0
    const resource = createLazyResource<Record<string, never>>(async () => { attempts++; throw new TypeError(message) })
    const component = resource.component
    await assert.rejects(resource.load(), error => error instanceof PageModuleLoadError && error.reloadRequired && error.message === '页面资源加载失败')
    resource.retry()
    assert.equal(resource.component, component, 'local retry must not pretend it can bypass the browser module cache')
    await assert.rejects(resource.load(), PageModuleLoadError)
    assert.equal(attempts, 1)
  }
})
