import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

test('server role checks go through server/authorization.ts', () => {
  const offenders = readdirSync(new URL('../server/', import.meta.url)).filter(name => name.endsWith('.ts') && name !== 'authorization.ts').flatMap(name =>
    readFileSync(new URL(`../server/${name}`, import.meta.url), 'utf8').split(/\r?\n/).flatMap((line, index) =>
      /\.role\s*(===|!==|==|!=)\s*['"]|['"](manager|member|observer)['"]\s*(===|!==)\s*[\w.?]*\.role\b/.test(line) ? [`${name}:${index + 1}: ${line.trim().slice(0, 120)}`] : []))
  assert.deepEqual(offenders, [], 'use isManager/isMember/isObserver or the actor gates from server/authorization.ts')
})
