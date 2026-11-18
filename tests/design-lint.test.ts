import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error plain .mjs script without declarations
import { inspect, compare } from '../scripts/design-lint.mjs'

test('source styles stay on the token scale and under the recorded baseline', () => {
  const { errors, counts } = inspect()
  assert.deepEqual(errors, [])
  assert.deepEqual(compare(counts, JSON.parse(readFileSync(new URL('../design-system/baseline.json', import.meta.url), 'utf8'))), [])
})

test('literal color checks distinguish paint values from tokens, URLs and selectors', () => {
  const base = mkdtempSync(join(tmpdir(), 'design-colors-'))
  mkdirSync(join(base, 'src'))
  writeFileSync(join(base, 'src/tokens.css'), ':root { --palette-ink: #181818; }')
  writeFileSync(join(base, 'src/page.css'), `
    .white { white-space: normal; color: white; background: rgba(10, 20, 30, .2); }
    .black { color: var(--palette-ink); box-shadow: 0 0 1px rgba(var(--ink-rgb), .15); }
    .image { background: url("black.svg#abc"); border-color: hsl(210 30% 50%); }
  `)
  assert.equal(inspect(base).counts.colorLiterals, 3)
})

test('the checker rejects off-scale values, decoration and slogan copy, and reports growth', () => {
  const base = mkdtempSync(join(tmpdir(), 'design-lint-'))
  mkdirSync(join(base, 'src'))
  writeFileSync(join(base, 'src/tokens.css'), ':root { --font-body: 14px; }')
  writeFileSync(join(base, 'src/page.css'), '.a { font-size: 15px; font-weight: 650; border-radius: 7px; backdrop-filter: blur(2px); color: #123456; }\n.b { font-size: var(--font-body); border-radius: 50%; }')
  writeFileSync(join(base, 'src/page.tsx'), 'export const text = "连接协作，赋能创新"')
  const { errors, counts } = inspect(base)
  for (const expected of ['font-size: 15px', 'font-weight: 650', 'border-radius: 7px', 'backdrop-filter', '赋能']) assert.ok(errors.some((line: string) => line.includes(expected)), expected)
  assert.equal(errors.filter((line: string) => line.includes('page.css')).length, 4)
  assert.equal(counts.distinctColors, 1)
  assert.deepEqual(compare(counts, { distinctColors: 1 }), [])
  assert.equal(compare(counts, { distinctColors: 0 }).length, 1)
})
