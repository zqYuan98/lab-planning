#!/usr/bin/env node
// 设计一致性检查。零依赖，CI 与 `npm run lint:design` 共用。
// 两类规则：
//   硬规则 —— 出现即失败（字号、字重、圆角必须取自 src/tokens.css 的刻度；禁用的装饰和口号）。
//   棘轮   —— 历史存量只许减少不许增加（颜色字面量、渐变、阴影、!important、页面说明文字等），
//             基线记录在 design-system/baseline.json，降低后用 --update 收紧。
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = 'src/tokens.css'
const BASELINE = 'design-system/baseline.json'

/** 允许直接写出的值；其余必须走 var(--font-*) / var(--weight-*) / var(--radius-*)。 */
const ALLOWED = {
  'font-size': /^(var\(--font-[a-z0-9-]+\)|inherit|0|1em|100%)$/,
  'font-weight': /^(var\(--weight-[a-z]+\)|inherit|normal)$/,
  'border-radius': /^(var\(--radius-[a-z0-9-]+\)|inherit|0|50%|100%)$/,
}
/** 只在生成 Word/打印稿的样式里保留物理单位，其余文件不得豁免。 */
const PRINT_UNITS = /^\d+(\.\d+)?pt$/
/** 登录页和业务页都不再使用的装饰。 */
const BANNED_CSS = [
  [/backdrop-filter\s*:/, '毛玻璃 backdrop-filter'],
  [/text-shadow\s*:/, '文字发光 text-shadow'],
  [/letter-spacing\s*:\s*[2-9]px/, '大字距 letter-spacing ≥ 2px'],
]
/** 营销口号式文案。业务界面只写“这是什么、下一步做什么”。 */
const BANNED_COPY = ['赋能', '智汇', '让创新', '有迹可循', '锚定', '探索 · 未来', '连接协作', '聚焦关键', '让每一份', '一站式', '全方位', '智能化赋']

function walk(dir, test, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, test, out)
    else if (test(name)) out.push(path)
  }
  return out
}
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
const lineOf = (text, index) => text.slice(0, index).split('\n').length

export function inspect(base = root) {
  const cssFiles = walk(join(base, 'src'), name => name.endsWith('.css'))
  const tsxFiles = walk(join(base, 'src'), name => /\.tsx?$/.test(name))
  const errors = []
  const colors = new Set()
  const counts = { colorLiterals: 0, gradients: 0, boxShadows: 0, important: 0, customPropertyFamilies: 0, inlineStyles: 0, cssFiles: cssFiles.length, pageNarration: 0 }
  const families = new Set()

  for (const file of cssFiles) {
    const name = relative(base, file).replaceAll('\\', '/')
    const text = stripComments(readFileSync(file, 'utf8'))
    const isTokens = name === TOKENS
    for (const match of text.matchAll(/(^|[;{\s])(font-size|font-weight|border-radius)\s*:\s*([^;}]+)/g)) {
      if (isTokens) continue
      const property = match[2], value = match[3].replace(/\s*!important/, '').trim()
      if (ALLOWED[property].test(value)) continue
      if (property === 'font-size' && PRINT_UNITS.test(value)) continue
      if (property === 'border-radius' && value.split(/\s+/).every(part => ALLOWED[property].test(part))) continue
      errors.push(`${name}:${lineOf(text, match.index)} ${property}: ${value} —— 请改用 ${TOKENS} 中的刻度`)
    }
    for (const [pattern, label] of BANNED_CSS) {
      const hit = pattern.exec(text)
      if (hit) errors.push(`${name}:${lineOf(text, hit.index)} 不再使用${label}`)
    }
    if (!isTokens) {
      for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) { colors.add(match[0].toLowerCase()); counts.colorLiterals++ }
      for (const match of text.matchAll(/^\s*--([a-z0-9]+)-[a-z0-9-]+\s*:/gm)) families.add(match[1])
    }
    counts.gradients += (text.match(/gradient\(/g) || []).length
    counts.boxShadows += (text.match(/box-shadow\s*:(?!\s*none)/g) || []).length
    counts.important += (text.match(/!important/g) || []).length
  }
  counts.distinctColors = colors.size
  counts.customPropertyFamilies = families.size

  for (const file of tsxFiles) {
    const name = relative(base, file).replaceAll('\\', '/')
    const text = readFileSync(file, 'utf8')
    counts.inlineStyles += (text.match(/style=\{\{/g) || []).length
    // 直接铺在页面上的说明段落（不含折叠在 <details> 里的）是“系统在解释自己”的主要来源。
    counts.pageNarration += (text.match(/className="[^"]*(?:-intro|-explainer|-rule-note|scope-note|page-note)[^"]*"/g) || []).length
    for (const phrase of BANNED_COPY) {
      const index = text.indexOf(phrase)
      if (index >= 0) errors.push(`${name}:${lineOf(text, index)} 文案含口号式用语“${phrase}”`)
    }
  }
  return { errors, counts }
}

export function compare(counts, baseline) {
  const regressions = []
  for (const [key, limit] of Object.entries(baseline)) {
    if (typeof limit === 'number' && counts[key] > limit) regressions.push(`${key}: ${counts[key]} 超过基线 ${limit}（存量只许减少）`)
  }
  return regressions
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { errors, counts } = inspect()
  const baselinePath = join(root, BASELINE)
  if (process.argv.includes('--update')) {
    const previous = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
    const raised = Object.keys(counts).filter(key => typeof previous[key] === 'number' && counts[key] > previous[key])
    if (raised.length && !process.argv.includes('--allow-increase')) {
      console.error(`基线只能收紧。以下指标变大：${raised.join('、')}。确需放宽请在评审中说明并加 --allow-increase。`)
      process.exit(1)
    }
    writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`)
    console.log(`已更新 ${BASELINE}`, counts)
    process.exit(0)
  }
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
  const regressions = compare(counts, baseline)
  for (const line of [...errors.slice(0, 60), ...regressions]) console.error(line)
  if (errors.length > 60) console.error(`…… 另有 ${errors.length - 60} 处`)
  console.log(JSON.stringify(counts))
  if (errors.length || regressions.length) { console.error(`设计检查未通过：${errors.length} 处硬规则，${regressions.length} 项存量回升。`); process.exit(1) }
  console.log('设计检查通过。')
}
