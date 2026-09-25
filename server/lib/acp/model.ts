import { flattenOptions } from './config-options'
import type { AgentAdapter, AppSettings } from '../../../shared/types'

/**
 * What a session of this adapter runs on when its own row names no model.
 *
 * The setting, and nothing else. This used to fall through to a
 * `NUXT_*_MODEL` environment variable per adapter, which was a second,
 * invisible way of saying the same thing: nothing in the UI could show it and
 * nobody could change it without editing a file and restarting the server. A
 * default model for new sessions is a preference, and a preference belongs
 * where the user can see it.
 *
 * Not consulted at all for a session that asked for a model itself: that is
 * `applyRequestedModel`'s first choice, and two agents on different models at
 * once is the case the column exists for.
 */
export function defaultModel(adapter: AgentAdapter, settings: AppSettings): string | null {
  return (settings.defaultAgentModels?.[adapter] ?? '').trim() || null
}

export interface ModelChoice {
  configId: string
  value: string
  name: string
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
 *
 * **An inexact match that fits more than one model resolves to nothing**, for
 * the same reason `findConfigOption` refuses an ambiguous option: OpenCode
 * offers `opencode/glm-5.3` and `opencode-go/glm-5.3`, one metered per token
 * and one on the flat subscription, and `.find()` would have quietly taken
 * whichever the adapter happened to list first. Refusing turns a silent
 * billing surprise into a readable error naming both — see
 * `ambiguousModelMatches`, which is what phrases it.
 */
export function resolveModel(option: any, preference: string): ModelChoice | null {
  const configId = String(option?.id ?? '')
  const entries = flattenOptions(option?.options)
  if (!configId || entries.length === 0) return null

  const exact = entries.find(entry => entry.value === preference.trim())
  if (exact) return { configId, value: exact.value!, name: exact.name ?? exact.value! }

  const matches = inexactMatches(entries, preference)
  if (matches.length !== 1) return null
  const pick = matches[0]!
  return { configId, value: pick.value!, name: pick.name ?? pick.value! }
}

/**
 * Every model an inexact preference could have meant, at its most exact tier.
 *
 * Empty when the preference matches nothing at all; one entry when it resolved;
 * more than one when it was refused as ambiguous. The caller uses the
 * difference to say *why* the pin did not take.
 */
export function ambiguousModelMatches(option: any, preference: string): string[] {
  const entries = flattenOptions(option?.options)
  if (entries.some(entry => entry.value === preference.trim())) return []
  return inexactMatches(entries, preference).map(entry => entry.value!)
}

/** The tiers below an exact id, stopping at the first that matches anything. */
function inexactMatches(
  entries: Array<{ value?: string, name?: string }>,
  preference: string
): Array<{ value?: string, name?: string }> {
  const wanted = preference.trim().toLowerCase()
  if (!wanted) return []
  const tiers = [
    (entry: { value?: string, name?: string }) => entry.value!.toLowerCase() === wanted,
    (entry: { value?: string, name?: string }) => (entry.name ?? '').toLowerCase() === wanted,
    (entry: { value?: string, name?: string }) => entry.value!.toLowerCase().includes(wanted),
    (entry: { value?: string, name?: string }) => wanted.includes(entry.value!.toLowerCase())
  ]
  for (const tier of tiers) {
    const found = entries.filter(tier)
    if (found.length) return found
  }
  return []
}

/** The ids an adapter offered, for an error that tells the operator what to write. */
export function availableModelIds(option: any): string[] {
  return flattenOptions(option?.options).map(entry => entry.value!)
}

/** The same list, with the labels a picker needs. */
export function availableModelOptions(option: any): Array<{ id: string, name: string }> {
  return flattenOptions(option?.options).map(entry => ({ id: entry.value!, name: entry.name ?? entry.value! }))
}
