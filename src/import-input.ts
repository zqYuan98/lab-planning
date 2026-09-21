const imageExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function importFileName(file: Pick<File, 'name' | 'type'>) {
  const extension = imageExtensions[file.type.toLowerCase()]
  // Clipboard screenshots may arrive without a filename or extension.
  return extension && !/\.[^.]+$/.test(file.name)
    ? `${file.name || '粘贴图片'}.${extension}`
    : file.name || '未命名文件'
}

export function importFileError(file: Pick<File, 'name' | 'type' | 'size'>) {
  if (file.size > 10 * 1024 * 1024)
    return '文件大小不能超过 10 MB，请分批导入。'
  if (!/\.(xlsx|csv|tsv|txt|png|jpe?g|webp)$/i.test(importFileName(file)))
    return '仅支持 XLSX、CSV、TSV、TXT、PNG、JPG、WebP；旧版 XLS 请先另存为 XLSX。'
  if (!file.size) return '文件为空，请选择包含内容的文件。'
  return ''
}

export function hasTransferredFiles(transfer: DataTransfer) {
  return (
    Array.from(transfer.types).includes('Files') ||
    Array.from(transfer.items || []).some((item) => item.kind === 'file')
  )
}

export function filesFromTransfer(transfer: DataTransfer) {
  const items = Array.from(transfer.items || []).filter(
    (item) => item.kind === 'file',
  )
  const files: File[] = []
  const issues: string[] = []
  // Read one representation only: clipboard images often appear in both lists.
  if (!items.length) return { files: Array.from(transfer.files), issues }
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.()
    if (entry?.isDirectory) {
      issues.push(`“${entry.name}”是文件夹，请选择其中的文件。`)
      continue
    }
    const file = item.getAsFile()
    if (file) files.push(file)
    else issues.push('有一个文件无法读取，请通过“上传文件”重新选择。')
  }
  return { files, issues }
}
