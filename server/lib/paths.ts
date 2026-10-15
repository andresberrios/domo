import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

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

/**
 * Whether `path` is inside an installed Domo's own app: its releases, the
 * links to them, or the git checkout installs before releases built from.
 * Updates replace and delete all of these, so no session works there. The
 * default directory once was the release itself, so a saved setting, an
 * assistant or a session can still name one.
 */
export function insideOwnInstall(path: string, home = process.env.DOMO_HOME): boolean {
  if (!home || !path) return false
  const target = resolve(path)
  return ['app', 'releases', 'current', 'previous'].some((name) => {
    const root = join(resolve(home), name)
    return target === root || target.startsWith(root + sep)
  })
}

/** Resolve a user-supplied path (possibly `~`-relative) to an absolute one; empty is the default directory. */
export function expandPath(input: string): string {
  const trimmed = (input || '').trim()
  if (!trimmed) return defaultWorkDir()
  const expanded = trimmed.startsWith('~')
    ? join(process.env.HOME || process.cwd(), trimmed.slice(1))
    : trimmed
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

/** Where a session works for a user-supplied path: one inside Domo's own install is taken as no path at all. */
export function normalizeCwd(input: string): string {
  const absolute = expandPath(input)
  return insideOwnInstall(absolute) ? defaultWorkDir() : absolute
}
