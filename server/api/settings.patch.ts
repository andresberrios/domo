import { bus } from '../lib/bus'
import { normalizeHomeMount, validateHomeMounts } from '../lib/dev-env/home-overlay'
import { patchSettings } from '../lib/settings'
import type { AppSettings } from '../../shared/types'

export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<AppSettings>>(event)
  const patch = { ...(body ?? {}) }

  if (patch.homeMounts !== undefined) {
    if (!Array.isArray(patch.homeMounts) || patch.homeMounts.some(entry => typeof entry !== 'string')) {
      throw createError({ statusCode: 400, message: 'Home mounts must be a list of paths, one per line.' })
    }
    // Blank lines are how a textarea breathes; an entry of only whitespace is
    // not a path anyone meant, so it is dropped rather than refused.
    const entries = patch.homeMounts.map(normalizeHomeMount).filter(Boolean)
    const problems = validateHomeMounts(entries)
    if (problems.length) throw createError({ statusCode: 400, message: problems.join(' ') })
    patch.homeMounts = entries
  }

  const settings = await patchSettings(patch)
  bus.publish({ type: 'settings-changed' })
  return settings
})
