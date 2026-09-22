import type { SessionConfigOptionInfo } from '../../../shared/types'

/**
 * The adapter's *own* settings, whatever they happen to be.
 *
 * ACP lets an agent publish a list of `configOptions`, and the two installed
 * adapters use it for genuinely different things. Reasoning effort is the one
 * they both have and they do not even agree on its id: Claude Code publishes
 * `effort` ("Effort"), codex-acp `reasoning_effort` ("Reasoning effort"), and
 * both tag it `category: "thought_level"`. Codex alone adds a
 * `collaboration_mode`, and both add a fast-mode toggle on the models that
 * support one.
 *
 * So nothing here knows any option by name. Domo renders what the adapter
 * reports and sends back what the user picked, which is the only way a client
 * can serve two adapters that disagree — and the only way the next option
 * either of them ships works without a change here.
 *
 * Two of them *are* known and are filtered out: `mode` and `model` have their
 * own columns, their own endpoints and their own pickers, and an adapter
 * publishes both here as well.
 */

/** A select's options are either a flat list or a list of named groups. */
export function flattenOptions(options: any): Array<{ value?: string, name?: string, description?: string | null }> {
  if (!Array.isArray(options)) return []
  return options
    .flatMap((entry: any) => (Array.isArray(entry?.options) ? entry.options : [entry]))
    .filter((entry: any) => entry && typeof entry.value === 'string')
}

/** Mode and model are Domo's own; everything else is the adapter's business. */
function isOwn(option: any): boolean {
  const category = typeof option?.category === 'string' ? option.category : ''
  const id = typeof option?.id === 'string' ? option.id : ''
  return category === 'mode' || category === 'model' || id === 'mode' || id === 'model'
}

/**
 * Every adapter-specific select out of a `session/new`, `session/load` or
 * `session/set_config_option` response.
 *
 * Selects only. An option is a `boolean` instead when the client advertises
 * the capability for it, and Domo does not: both adapters then fall back to a
 * two-value select ("On" / "Off"), which needs no separate renderer. An
 * option with no choices in it is dropped rather than drawn as an empty menu.
 */
export function adapterConfigOptions(response: any): SessionConfigOptionInfo[] {
  const options = response?.configOptions
  if (!Array.isArray(options)) return []

  return options
    .filter((option: any) => option && option.type === 'select' && typeof option.id === 'string' && !isOwn(option))
    .map((option: any): SessionConfigOptionInfo => ({
      id: String(option.id),
      name: typeof option.name === 'string' && option.name ? option.name : String(option.id),
      description: typeof option.description === 'string' ? option.description : null,
      category: typeof option.category === 'string' ? option.category : null,
      currentValue: typeof option.currentValue === 'string' ? option.currentValue : null,
      options: flattenOptions(option.options).map(entry => ({
        value: entry.value!,
        name: entry.name ?? entry.value!,
        description: entry.description ?? null
      }))
    }))
    .filter(option => option.options.length > 0)
}

/**
 * Find the option a caller means, by id first and then by the words a person
 * would use.
 *
 * The id is the contract, but "reasoning effort" has to reach `effort` on one
 * adapter and `reasoning_effort` on the other, or a voice command that works
 * on a Claude session fails on a Codex one for no reason a user can see. The
 * category is the last resort because it is ACP's own grouping and both
 * adapters file effort under `thought_level`.
 */
export function findConfigOption(
  options: SessionConfigOptionInfo[] | null | undefined,
  key: string
): SessionConfigOptionInfo | null {
  const list = options ?? []
  const wanted = key.trim().toLowerCase()
  if (!wanted) return null
  const loose = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '')
  const exact = list.find(option => option.id === key.trim())
    ?? list.find(option => option.id.toLowerCase() === wanted)
    ?? list.find(option => option.name.toLowerCase() === wanted)
    ?? list.find(option => loose(option.id) === loose(wanted))
    ?? list.find(option => loose(option.name) === loose(wanted))
    ?? list.find(option => (option.category ?? '').toLowerCase() === wanted)
  if (exact) return exact

  // "reasoning effort" has to reach Claude Code's `effort` and Codex's
  // `reasoning_effort`, and neither is an exact match for it either way round,
  // so the last rung is containment in both directions — the same ladder
  // `resolveModel` climbs, and for the same reason.
  //
  // Only when it picks out exactly one option, though. Two matches means the
  // caller said something that could be either, and acting on a setting nobody
  // asked for is worse than saying the name was not clear.
  const contained = list.filter(option =>
    loose(wanted).includes(loose(option.id))
    || loose(option.id).includes(loose(wanted))
    || loose(wanted).includes(loose(option.name))
    || loose(option.name).includes(loose(wanted))
  )
  return contained.length === 1 ? contained[0]! : null
}

/**
 * Resolve a requested value against what the option actually offers.
 *
 * The same ladder as `resolveModel`, and for the same reason: the values are
 * ids like `high` but a person or a voice agent may say "High". Never a fuzzy
 * score — silently running on a setting nobody asked for is worse than saying
 * the value was not offered.
 */
export function resolveConfigValue(option: SessionConfigOptionInfo, preference: string): string | null {
  const wanted = preference.trim().toLowerCase()
  if (!wanted) return null
  return option.options.find(entry => entry.value === preference.trim())?.value
    ?? option.options.find(entry => entry.value.toLowerCase() === wanted)?.value
    ?? option.options.find(entry => entry.name.toLowerCase() === wanted)?.value
    ?? null
}

/** The values an option offers, for an error that says what to write instead. */
export function configValueIds(option: SessionConfigOptionInfo): string[] {
  return option.options.map(entry => entry.value)
}

/**
 * Whether two reported lists say the same thing, so an unchanged one writes
 * nothing.
 *
 * "Nothing reported" and "nothing offered" are the same state here, which
 * matters more than it looks: `agent_sessions` is synced with
 * `REPLICA IDENTITY FULL`, so writing `[]` over a `null` on every attach would
 * re-stream the whole session row to every browser to say what it already
 * said. An adapter that *had* options and now has none still differs, which is
 * the case that has to keep writing — a model change can drop the effort
 * option entirely.
 */
export function sameConfigOptions(
  a: SessionConfigOptionInfo[] | null,
  b: SessionConfigOptionInfo[] | null
): boolean {
  const normalise = (value: SessionConfigOptionInfo[] | null) =>
    value && value.length ? JSON.stringify(value) : ''
  return normalise(a) === normalise(b)
}
