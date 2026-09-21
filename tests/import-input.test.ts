import test from 'node:test'
import assert from 'node:assert/strict'
import { filesFromTransfer, hasTransferredFiles, importFileError, importFileName } from '../src/import-input.ts'

test('clipboard screenshots without extensions receive a supported filename; unsupported formats stay rejected', () => {
  assert.equal(importFileName(new File(['image'], '', { type: 'image/png' })), '粘贴图片.png')
  assert.equal(importFileName(new File(['image'], '截图', { type: 'image/jpeg' })), '截图.jpg')
  assert.equal(importFileError(new File(['image'], '截图', { type: 'image/webp' })), '')
  assert.match(importFileError(new File(['image'], '动画.gif', { type: 'image/gif' })), /仅支持/)
  assert.match(importFileError(new File(['data'], '旧版.xls')), /另存为 XLSX/)
  assert.match(importFileError(new File([], '空白.txt')), /文件为空/)
  assert.match(importFileError({ name: 'large.xlsx', type: '', size: 10 * 1024 * 1024 + 1 }), /10 MB/)
  assert.equal(importFileError({ name: 'limit.PNG', type: 'image/png', size: 10 * 1024 * 1024 }), '')
})

test('transfers keep every file exactly once and leave ordinary text paste alone', () => {
  const files = [new File(['image'], '截图.png'), new File(['sheet'], '计划.csv')]
  const transfer = {
    types: ['Files', 'text/plain'], files,
    items: [
      { kind: 'string' },
      ...files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    ],
  } as unknown as DataTransfer
  assert.equal(hasTransferredFiles(transfer), true)
  assert.deepEqual(filesFromTransfer(transfer), { files, issues: [] })
  assert.equal(hasTransferredFiles({ types: ['text/plain'], items: [{ kind: 'string' }] } as unknown as DataTransfer), false)
  assert.deepEqual(filesFromTransfer({ files, items: [] } as unknown as DataTransfer), { files, issues: [] })
})

test('directories and unreadable items are explained while valid files remain available', () => {
  const file = new File(['text'], '计划.txt')
  const transfer = {
    files: [file],
    items: [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, name: '资料目录' }), getAsFile: () => null },
      { kind: 'file', getAsFile: () => file },
      { kind: 'file', getAsFile: () => null },
    ],
  } as unknown as DataTransfer
  const result = filesFromTransfer(transfer)
  assert.deepEqual(result.files, [file])
  assert.equal(result.issues.length, 2)
  assert.match(result.issues[0], /资料目录.*文件夹/)
  assert.match(result.issues[1], /无法读取/)
})
