import type { SessionModeInfo } from '../../../shared/types'
import { flattenOptions } from './config-options'

/**
 * The modes out of a `session/new` / `session/load` response.
 *
 * Most adapters use ACP's `modes` object (`availableModes` + `currentModeId`).
 * OpenCode instead publishes its visible-agent choice as the `mode`
 * `configOptions` select and changes it through `session/set_config_option`.
 * Keep both wire representations behind one Domo concept so the row and UI do
 * not need an adapter-specific branch.
 *
 * Like the model list, this is only ever in a `session/new` answer: there is no
 * "list the modes" request, and the list differs by adapter (Claude Code offers
 * `default` / `acceptEdits` / `plan` / `auto` / `bypassPermissions`, Codex
 * `read-only` / `agent` / `agent-full-access`). Hard-coding one adapter's ids
 * is exactly what the Settings page used to do, and it was wrong for the other.
 */
export function availableModes(response: any): SessionModeInfo[] {
  const modes = response?.modes?.availableModes
  if (Array.isArray(modes)) return modes
    // An empty id is not a mode, and Reka's select throws on an empty value —
    // one bad entry would take the whole picker down with it.
    .filter((mode: any) => mode && typeof mode.id === 'string' && mode.id)
    .map((mode: any) => ({
      id: mode.id,
      name: typeof mode.name === 'string' ? mode.name : mode.id,
      description: typeof mode.description === 'string' ? mode.description : null
    }))

  const option = modeConfigOption(response)
  return flattenOptions(option?.options).map(entry => ({
    id: entry.value!,
    name: entry.name ?? entry.value!,
    description: entry.description ?? null
  }))
}

/** What mode the session is in now, as the adapter reports it. */
export function currentModeId(response: any): string | null {
  const current = response?.modes?.currentModeId
  if (typeof current === 'string' && current) return current
  const configured = modeConfigOption(response)?.currentValue
  return typeof configured === 'string' && configured ? configured : null
}

/** The alternate config-option representation used by OpenCode. */
export function modeConfigOption(response: any): any | null {
  const options = response?.configOptions
  if (!Array.isArray(options)) return null
  return options.find((option: any) =>
    option?.type === 'select'
    && (option.category === 'mode' || option.id === 'mode')
  ) ?? null
}
