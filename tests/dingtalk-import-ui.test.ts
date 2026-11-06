import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

test('source and DingTalk review workspaces have distinct stable keys for the same batch', () => {
  const source = ts.createSourceFile('Imports.tsx', readFileSync(new URL('../src/pages/Imports.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const keys = new Map<string, ts.Expression>()
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && ['DingTalkImportReview', 'ImportSourceReview'].includes(node.tagName.getText(source))) {
      const key = node.attributes.properties.find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'key')
      assert.ok(key?.initializer && ts.isJsxExpression(key.initializer) && key.initializer.expression, 'each review must keep a stable explicit key across updates')
      keys.set(node.tagName.getText(source), key.initializer.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(keys.size, 2)
  function value(expression: ts.Expression, batchId: string): string {
    if (ts.isStringLiteralLike(expression)) return expression.text
    if (ts.isPropertyAccessExpression(expression) && expression.getText(source) === 'batch.id') return batchId
    if (ts.isTemplateExpression(expression)) return expression.head.text + expression.templateSpans.map(span => value(span.expression, batchId) + span.literal.text).join('')
    throw new Error(`Unsupported review key expression: ${expression.getText(source)}`)
  }
  for (const batchId of ['batch-a', 'batch-b', 'dingtalk:source:batch']) {
    const dingtalkKey = value(keys.get('DingTalkImportReview')!, batchId)
    const sourceKey = value(keys.get('ImportSourceReview')!, batchId)
    assert.notEqual(dingtalkKey, sourceKey, 'duplicate sibling keys remount review effects and can repeat requests indefinitely')
    assert.ok(dingtalkKey.includes(batchId) && sourceKey.includes(batchId), 'both workspaces must reset when the active batch changes')
  }
})
