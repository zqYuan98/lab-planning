import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Bind measurements to the actual built frontend, including container builds. */
export function readBuildVersion(directory: string, production = process.env.NODE_ENV === 'production'): string {
  try {
    const value: unknown = JSON.parse(readFileSync(resolve(directory, 'build-info.json'), 'utf8'))
    const version = value && typeof value === 'object' && 'version' in value ? value.version : undefined
    if (typeof version !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(version)) throw new Error('Invalid build version')
    return version
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !production) return 'development'
    throw new Error('构建版本信息缺失或无效，请先重新执行 npm run build')
  }
}
