import type { AgentAdapter } from '../../../shared/types'

/**
 * Which model an adapter's sessions should run on, if the operator pinned one.
 *
 * Environment only, and deliberately so: it is an install-wide default, not a
 * per-session input, so it needs no column and no UI.
 */
export function pinnedModel(adapter: AgentAdapter): string | null {
  const raw = adapter === 'claude-code'
    ? process.env.NUXT_CLAUDE_MODEL
    : process.env.NUXT_CODEX_MODEL
  const trimmed = (raw ?? '').trim()
  return trimmed || null
}

export interface ModelChoice {
  configId: string
  value: string
  name: string
}

interface SelectOption { value?: string, name?: string }

/** A select's options are either a flat list or a list of named groups. */
function flattenOptions(options: any): SelectOption[] {
  if (!Array.isArray(options)) return []
  return options.flatMap((entry: any) =>
    Array.isArray(entry?.options) ? entry.options : [entry]
  ).filter((entry: any) => entry && typeof entry.value === 'string')
}

/**
 * The model selector out of a `session/new` / `session/load` response.
 *
 * Both installed adapters answer with ACP `configOptions` and take
 * `session/set_config_option`, so this is one code path rather than an
 * adapter-specific mechanism each. The `model` *category* is what the spec says
 * identifies it; the id is the fallback, because both adapters happen to use
 * `"model"` for it and an older one might only have that.
 */
export function modelConfigOption(response: any): any | null {
  const options = response?.configOptions
  if (!Array.isArray(options)) return null
  return options.find((option: any) => option?.category === 'model' && option?.type === 'select')
    ?? options.find((option: any) => option?.id === 'model' && option?.type === 'select')
    ?? null
}

/** What the session is on now, as reported by the adapter. */
export function currentModel(option: any): ModelChoice | null {
  if (!option || typeof option.currentValue !== 'string') return null
  const match = flattenOptions(option.options).find(entry => entry.value === option.currentValue)
  return { configId: String(option.id), value: option.currentValue, name: match?.name ?? option.currentValue }
}

/**
 * Resolve a pinned model id against what the adapter actually offers.
 *
 * Exact first, then case-insensitively, then a containment match in either
 * direction — the adapters list ids like `claude-haiku-4-5` and aliases like
 * `haiku`, and an operator may reasonably write either. Never a fuzzy score:
 * silently running on a model nobody asked for is worse than not pinning.
 */
export function resolveModel(option: any, preference: string): ModelChoice | null {
  const configId = String(option?.id ?? '')
  const entries = flattenOptions(option?.options)
  if (!configId || entries.length === 0) return null
  const wanted = preference.trim().toLowerCase()

  const pick = entries.find(entry => entry.value === preference.trim())
    ?? entries.find(entry => entry.value!.toLowerCase() === wanted)
    ?? entries.find(entry => (entry.name ?? '').toLowerCase() === wanted)
    ?? entries.find(entry => entry.value!.toLowerCase().includes(wanted))
    ?? entries.find(entry => wanted.includes(entry.value!.toLowerCase()))
  return pick ? { configId, value: pick.value!, name: pick.name ?? pick.value! } : null
}

/** The ids an adapter offered, for an error that tells the operator what to write. */
export function availableModelIds(option: any): string[] {
  return flattenOptions(option?.options).map(entry => entry.value!)
}
