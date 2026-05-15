import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Resolve Domo's data dir.
 *
 *   DOMO_HOME=<absolute path>   ← explicit override
 *   $XDG_DATA_HOME/domo         ← XDG fallback (only if XDG_DATA_HOME is set)
 *   ~/.domo                     ← default
 *
 * Creates the dir if it doesn't exist. Safe to call on every request.
 */
export function domoHome(): string {
  const explicit = process.env.DOMO_HOME?.trim()
  if (explicit) {
    mkdirSync(explicit, { recursive: true })
    return explicit
  }

  const xdg = process.env.XDG_DATA_HOME?.trim()
  const path = xdg ? join(xdg, 'domo') : join(homedir(), '.domo')
  mkdirSync(path, { recursive: true })
  return path
}

export function domoDbPath(): string {
  return join(domoHome(), 'state.db')
}
