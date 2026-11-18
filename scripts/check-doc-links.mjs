#!/usr/bin/env node
// 检查 Markdown 里的相对链接都指向存在的文件。文档搬动或删除后运行，CI 也会跑。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skip = new Set(['node_modules', '.git', 'dist', 'data', 'output', '.tools', '.playwright-cli', 'test-results'])
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.md')) out.push(path)
  }
  return out
}
const broken = []
for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
  for (const match of text.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
    const target = match[1]
    if (/^[a-z]+:/i.test(target) || target.startsWith('/')) continue
    const path = decodeURIComponent(target.replace(/:\d+(?::\d+)?$/, ''))
    const absolute = resolve(dirname(file), path)
    // Local verification artifacts are unavailable to readers of a fresh checkout.
    const localArtifact = relative(root, absolute).split(/[\\/]/)[0] === 'output'
    if (localArtifact || !existsSync(absolute)) broken.push(`${relative(root, file)} → ${target}`)
  }
}
for (const line of broken) console.error(line)
console.log(broken.length ? `有 ${broken.length} 个失效链接。` : '文档链接检查通过。')
process.exit(broken.length ? 1 : 0)
