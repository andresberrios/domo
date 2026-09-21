import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Root for everything Domo persists on disk: uploaded attachments. */
export function dataDir(): string {
  const configured = process.env.NUXT_DATA_DIR || process.env.DOMO_DATA_DIR
  const dir = configured
    ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured))
    : resolve(process.cwd(), '.data')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function uploadsDir(): string {
  const dir = join(dataDir(), 'uploads')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Resolve a user-supplied path (possibly `~`-relative) to an absolute one. */
export function normalizeCwd(input: string): string {
  const trimmed = (input || '').trim()
  if (!trimmed) return process.cwd()
  const expanded = trimmed.startsWith('~')
    ? join(process.env.HOME || process.cwd(), trimmed.slice(1))
    : trimmed
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}
