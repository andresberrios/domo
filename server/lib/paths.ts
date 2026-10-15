import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
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

/**
 * Where a session works when nothing names a directory: the checkout under
 * `pnpm dev`, the home directory in an installed Domo, whose working directory
 * is a release that the next update deletes.
 */
export function defaultWorkDir(): string {
  return process.env.NUXT_DEFAULT_CWD || (process.env.DOMO_HOME ? homedir() : process.cwd())
}

/** Resolve a user-supplied path (possibly `~`-relative) to an absolute one. */
export function normalizeCwd(input: string): string {
  const trimmed = (input || '').trim()
  if (!trimmed) return defaultWorkDir()
  const expanded = trimmed.startsWith('~')
    ? join(process.env.HOME || process.cwd(), trimmed.slice(1))
    : trimmed
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}
