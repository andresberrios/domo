import { bus } from '../lib/bus'
import { normalizeHomeMount, validateHomeMounts } from '../lib/dev-env/home-overlay'
import { patchSettings } from '../lib/settings'
import { clearAdapterModelCache } from '../lib/acp/models'
import { isAgentAdapter } from '../../shared/agent-adapters'
import { SECRET_SETTING_KEYS, type AppSettings } from '../../shared/types'

export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<AppSettings>>(event)
  const patch = { ...(body ?? {}) }
  // The setup guide's progress is merged by `/api/setup`, never replaced whole.
  delete patch.setup

  for (const key of SECRET_SETTING_KEYS) {
    if (patch[key] !== undefined && typeof patch[key] !== 'string') {
      throw createError({ statusCode: 400, message: `${key} must be a string; empty removes it.` })
    }
  }

  // Only cleared from here, once read; Domo writes it.
  if (patch.agentVoiceNotice !== undefined && patch.agentVoiceNotice !== '') {
    throw createError({ statusCode: 400, message: 'agentVoiceNotice can only be cleared.' })
  }

  if (patch.defaultAssistantId !== undefined && typeof patch.defaultAssistantId !== 'string') {
    throw createError({ statusCode: 400, message: 'defaultAssistantId must be an assistant id; empty means the most recent.' })
  }

  if (patch.sessionTitles !== undefined) {
    const titles = patch.sessionTitles as any
    if (!titles || typeof titles !== 'object' || typeof titles.enabled !== 'boolean'
      || (titles.adapter !== '' && !isAgentAdapter(titles.adapter)) || typeof titles.model !== 'string') {
      throw createError({ statusCode: 400, message: 'sessionTitles needs enabled, an adapter (empty for the default) and a model.' })
    }
    patch.sessionTitles = { enabled: titles.enabled, adapter: titles.adapter, model: titles.model.trim() }
  }

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
  // What an adapter offers depends on what it signs in with.
  if (SECRET_SETTING_KEYS.some(key => patch[key] !== undefined)) clearAdapterModelCache()
  bus.publish({ type: 'settings-changed' })
  return settings
})
