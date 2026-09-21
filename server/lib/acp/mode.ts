import type { SessionModeInfo } from '../../../shared/types'

/**
 * The permission modes out of a `session/new` / `session/load` response.
 *
 * Modes are ACP's own `modes` object (`availableModes` + `currentModeId`), not
 * a `configOptions` select — an adapter publishes them both ways and the
 * `modes` object is the one `session/set_mode` acts on, so it is the one read.
 *
 * Like the model list, this is only ever in a `session/new` answer: there is no
 * "list the modes" request, and the list differs by adapter (Claude Code offers
 * `default` / `acceptEdits` / `plan` / `auto` / `bypassPermissions`, Codex
 * `read-only` / `agent` / `agent-full-access`). Hard-coding one adapter's ids
 * is exactly what the Settings page used to do, and it was wrong for the other.
 */
export function availableModes(response: any): SessionModeInfo[] {
  const modes = response?.modes?.availableModes
  if (!Array.isArray(modes)) return []
  return modes
    // An empty id is not a mode, and Reka's select throws on an empty value —
    // one bad entry would take the whole picker down with it.
    .filter((mode: any) => mode && typeof mode.id === 'string' && mode.id)
    .map((mode: any) => ({
      id: mode.id,
      name: typeof mode.name === 'string' ? mode.name : mode.id,
      description: typeof mode.description === 'string' ? mode.description : null
    }))
}

/** What mode the session is in now, as the adapter reports it. */
export function currentModeId(response: any): string | null {
  const current = response?.modes?.currentModeId
  return typeof current === 'string' && current ? current : null
}
