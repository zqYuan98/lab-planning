import compression from 'compression'
import express, { type RequestHandler } from 'express'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Negotiate the representation without changing the API's no-store policy. */
export function compressResponses(): RequestHandler {
  const compress = compression({
    threshold: 1024,
    filter: (req, res) => res.statusCode !== 206 && !res.hasHeader('Content-Range')
      && !String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')
      && compression.filter(req, res),
  })
  return (req, res, next) => {
    // Retain the selection key even when Express strips Content-Type for a 304.
    res.vary('Accept-Encoding')
    compress(req, res, next)
  }
}

const revalidate = 'no-cache'
const immutable = 'public, max-age=31536000, immutable'

function buildAssets(dist: string): Set<string> {
  try {
    const manifest = JSON.parse(readFileSync(resolve(dist, '.vite/manifest.json'), 'utf8')) as Record<string, { file?: string; css?: string[]; assets?: string[] }>
    return new Set(Object.values(manifest).flatMap(entry => [entry.file, ...(entry.css || []), ...(entry.assets || [])])
      .filter((path): path is string => typeof path === 'string' && /^assets\/[^/]+-[\w-]{8,}\.[\w.]+$/.test(path)))
  } catch {
    // A missing/old build manifest must never accidentally make mutable files immutable.
    return new Set()
  }
}

export function staticDelivery(dist: string): RequestHandler {
  const router = express.Router()
  const index = resolve(dist, 'index.html')
  if (!existsSync(index)) return router
  const assets = buildAssets(dist)
  router.use(express.static(dist, {
    index: false,
    redirect: false,
    setHeaders: (res, file) => {
      const isBuildAsset = assets.has(file.slice(resolve(dist).length + 1).replaceAll('\\', '/'))
      res.setHeader('Cache-Control', isBuildAsset ? immutable : revalidate)
    },
  }))
  router.use((req, res, next) => {
    let path: string
    try { path = decodeURIComponent(req.path) }
    catch { res.set('Cache-Control', 'no-store').status(400).type('text').send('资源路径无效'); return }
    // The SPA shell is only a navigation fallback. Missing chunks and other files are real 404s.
    if (path === '/assets' || path.startsWith('/assets/') || /\/[^/]+\.[^/]+$/.test(path)) {
      res.set('Cache-Control', 'no-store').status(404).type('text').send('资源不存在')
      return
    }
    if (!['GET', 'HEAD'].includes(req.method) || !req.accepts('html')) return next()
    res.set('Cache-Control', revalidate).sendFile(index)
  })
  return router
}
