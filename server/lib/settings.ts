import { query } from './db'
import { defaultWorkDir, insideOwnInstall } from './paths'
import { DEFAULT_HOME_MOUNTS } from './dev-env/home-overlay'
import { AGENT_ADAPTERS, isAgentAdapter } from '../../shared/agent-adapters'
import { DEFAULT_AGENT_VOICE, isSpeaker, isToolSound, isTranscriber, isTurnDetector, normalizeVolumes } from '../../shared/agent-voice'
import { rememberSecretSettings } from './secret-settings'
import { SECRET_SETTING_KEYS, type AgentVoiceSettings, type AppSettings, type SecretSettingKey, type SetupProgress, type SetupTarget, type UpdateSettings } from '../../shared/types'

/**
 * Look every hour, and never switch by itself: an unasked restart is the one
 * thing an update must not do until the operator says so.
 */
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  checkIntervalMinutes: 60,
  autoApply: false,
  minHoursBetweenApplies: 1
}

export const DEFAULTS: AppSettings = {
  defaultCwd: defaultWorkDir(),
  defaultAssistantId: '',
  // Each adapter's own starting mode, so the default changes nothing until the
  // operator picks something: Claude Code's `default` ("Manual") and Codex's
  // `agent` ("Auto review"). The ids are not interchangeable — see
  // `AppSettings.defaultAgentModes`.
  defaultAgentModes: Object.fromEntries(AGENT_ADAPTERS.map(adapter => [adapter.id, adapter.defaultMode])) as AppSettings['defaultAgentModes'],
  // Empty, meaning "whatever the adapter starts on": there is no model id Domo
  // could name here that is right for every account, and the env pin beneath
  // this is what an install configured before the setting existed still uses.
  defaultAgentModels: Object.fromEntries(AGENT_ADAPTERS.map(adapter => [adapter.id, ''])) as AppSettings['defaultAgentModels'],
  // Empty, because an adapter's own defaults are the only sensible starting
  // point for settings Domo does not know the names of. See
  // `AppSettings.defaultAgentConfig`.
  defaultAgentConfig: Object.fromEntries(AGENT_ADAPTERS.map(adapter => [adapter.id, {}])) as AppSettings['defaultAgentConfig'],
  // Empty, with a server override read ahead of the row rather than seeded
  // into it: a default that copied the environment in would be written back to
  // the row by the first save (`secret-settings.ts`).
  openCodeApiKey: '',
  copilotGithubToken: '',
  geminiApiKey: '',
  openAiApiKey: '',
  anthropicApiKey: '',
  claudeCodeOauthToken: '',
  kyutaiApiKey: '',
  // Environments permissive, the host as OpenCode has it. See
  // `AppSettings.openCodePermission` for why the two differ.
  openCodePermission: { host: 'ask', environment: 'allow' },
  vscodeSshHost: '',
  homeMounts: [...DEFAULT_HOME_MOUNTS],
  // On, because the gap it closes is one nobody can close from in here: an
  // agent that cannot open a page can only say a change "should" render. The
  // cost is one several-hundred-megabyte volume per machine, built once.
  browserTools: true,
  agentVoice: { ...DEFAULT_AGENT_VOICE },
  agentVoiceNotice: '',
  updates: { ...DEFAULT_UPDATE_SETTINGS },
  // On, on whatever cheap model this machine can reach: a generated title
  // costs a fraction of a cent of a plan that is already paid for.
  sessionTitles: { enabled: true, adapter: '', model: '' },
  setup: { finishedAt: null, skipped: [], checks: {} }
}

export async function getSettings(): Promise<AppSettings> {
  const rows = await query<{ key: string, value: any }>('select key, value from settings')
  const stored: Record<string, any> = {}
  for (const row of rows) stored[row.key] = row.value?.v ?? row.value
  const settings = {
    ...DEFAULTS,
    ...stored,
    // Saved when the default was the release the server ran from, which an update deletes.
    defaultCwd: typeof stored.defaultCwd === 'string' && stored.defaultCwd.trim() && !insideOwnInstall(stored.defaultCwd)
      ? stored.defaultCwd
      : DEFAULTS.defaultCwd,
    defaultAgentModes: storedAgentModes(stored),
    defaultAgentModels: storedAgentModels(stored),
    defaultAgentConfig: storedAgentConfig(stored),
    openCodePermission: storedOpenCodePermission(stored),
    agentVoice: storedAgentVoice(stored),
    agentVoiceNotice: typeof stored.agentVoiceNotice === 'string' ? stored.agentVoiceNotice : '',
    updates: storedUpdates(stored),
    sessionTitles: storedSessionTitles(stored),
    setup: normalizeSetup(stored.setup)
  } as AppSettings
  // The synchronous key readers (`secret-settings.ts`) see what was just read.
  rememberSecretSettings(settings)
  return settings
}

const isSecretKey = (key: string): key is SecretSettingKey => (SECRET_SETTING_KEYS as readonly string[]).includes(key)

const isSetupTarget = (value: unknown): value is SetupTarget => value === 'voice' || isAgentAdapter(value)

/** The setup guide's progress, from the row or a request, keeping only what it can use. */
export function normalizeSetup(current: any): SetupProgress {
  const setup: SetupProgress = { finishedAt: null, skipped: [], checks: {} }
  if (!current || typeof current !== 'object') return setup
  if (typeof current.finishedAt === 'string' && current.finishedAt) setup.finishedAt = current.finishedAt
  if (Array.isArray(current.skipped)) setup.skipped = [...new Set(current.skipped.filter(isSetupTarget))] as SetupTarget[]
  if (current.checks && typeof current.checks === 'object') {
    for (const [target, check] of Object.entries(current.checks as Record<string, any>)) {
      if (!isSetupTarget(target) || !check || typeof check !== 'object') continue
      if (typeof check.ok !== 'boolean' || typeof check.at !== 'string' || typeof check.summary !== 'string') continue
      setup.checks[target] = { ok: check.ok, at: check.at, summary: check.summary }
    }
  }
  return setup
}

/** The title settings, with a harness Domo knows or none. */
function storedSessionTitles(stored: Record<string, any>): AppSettings['sessionTitles'] {
  const current = stored.sessionTitles
  const titles = { ...DEFAULTS.sessionTitles }
  if (!current || typeof current !== 'object') return titles
  if (typeof current.enabled === 'boolean') titles.enabled = current.enabled
  if (isAgentAdapter(current.adapter)) titles.adapter = current.adapter
  if (typeof current.model === 'string') titles.model = current.model.trim()
  return titles
}

/** The update settings, each field kept in a range the updater can act on. */
function storedUpdates(stored: Record<string, any>): UpdateSettings {
  const updates = { ...DEFAULT_UPDATE_SETTINGS }
  const current = stored.updates
  if (!current || typeof current !== 'object') return updates
  if (Number.isFinite(current.checkIntervalMinutes)) updates.checkIntervalMinutes = Math.max(5, Math.round(current.checkIntervalMinutes))
  if (typeof current.autoApply === 'boolean') updates.autoApply = current.autoApply
  if (Number.isFinite(current.minHoursBetweenApplies)) updates.minHoursBetweenApplies = Math.max(0, current.minHoursBetweenApplies)
  return updates
}

/**
 * The agent voice cascade, read the same defensive way as the records below:
 * the two engine ids are checked against the catalogue, because each is used
 * to pick an implementation, and every model id or voice keeps its default
 * when the stored one is not a non-empty string.
 */
function storedAgentVoice(stored: Record<string, any>): AgentVoiceSettings {
  return normalizeAgentVoice(stored.agentVoice)
}

/** Voice bar settings from anywhere (the row, or a form not yet saved), checked the same way. */
export function normalizeAgentVoice(current: any): AgentVoiceSettings {
  const voice = { ...DEFAULT_AGENT_VOICE }
  voice.volumes = normalizeVolumes(current?.volumes)
  if (!current || typeof current !== 'object') return voice
  if (isTranscriber(current.transcriber)) voice.transcriber = current.transcriber
  if (isSpeaker(current.speaker)) voice.speaker = current.speaker
  if (isTurnDetector(current.turnDetector)) voice.turnDetector = current.turnDetector
  if (typeof current.macVoice === 'string') voice.macVoice = current.macVoice.trim()
  if (isToolSound(current.toolSound)) voice.toolSound = current.toolSound
  // Empty is meaningful: Domo runs the server itself.
  if (typeof current.pocketUrl === 'string') voice.pocketUrl = current.pocketUrl.trim()
  if (typeof current.language === 'string' && /^(?:[a-z]{2,3})?$/.test(current.language)) voice.language = current.language
  const seconds = Number(current.silenceSeconds)
  if (Number.isFinite(seconds) && seconds >= 0.3 && seconds <= 30) voice.silenceSeconds = seconds
  type Named = Exclude<keyof AgentVoiceSettings, 'transcriber' | 'speaker' | 'turnDetector' | 'silenceSeconds' | 'language' | 'macVoice' | 'toolSound' | 'pocketUrl' | 'volumes'>
  for (const key of Object.keys(voice) as Array<keyof AgentVoiceSettings>) {
    if (key === 'transcriber' || key === 'speaker' || key === 'turnDetector' || key === 'silenceSeconds' || key === 'language' || key === 'macVoice' || key === 'toolSound' || key === 'pocketUrl' || key === 'volumes') continue
    if (typeof current[key] === 'string' && current[key].trim()) voice[key as Named] = current[key].trim()
  }
  return voice
}

/**
 * The per-surface OpenCode permission, read the same defensive way as the
 * records above: a stored object missing a surface keeps that surface's
 * default rather than becoming undefined, and anything that is not one of the
 * two actions is dropped rather than reaching OpenCode's config validator.
 */
function storedOpenCodePermission(stored: Record<string, any>): AppSettings['openCodePermission'] {
  const permission = { ...DEFAULTS.openCodePermission }
  const current = stored.openCodePermission
  if (current && typeof current === 'object') {
    for (const surface of Object.keys(permission) as Array<keyof typeof permission>) {
      if (current[surface] === 'ask' || current[surface] === 'allow') permission[surface] = current[surface]
    }
  }
  return permission
}

/**
 * The per-adapter default model, reading the install's own row.
 *
 * Read the same defensive way as the modes and the config beside it — an
 * adapter missing from a stored object keeps the empty default rather than
 * becoming undefined, and a non-string is dropped rather than reaching a
 * `session/set_config_option`. There is no older single-value form to migrate:
 * the pre-setting way of saying this was an environment variable, and that
 * still works underneath (see `defaultModel`).
 */
function storedAgentModels(stored: Record<string, any>): AppSettings['defaultAgentModels'] {
  const models = { ...DEFAULTS.defaultAgentModels }
  const current = stored.defaultAgentModels
  if (current && typeof current === 'object') {
    for (const adapter of Object.keys(models) as Array<keyof typeof models>) {
      if (typeof current[adapter] === 'string') models[adapter] = current[adapter].trim()
    }
  }
  return models
}

/**
 * The per-adapter defaults for the adapter's own settings.
 *
 * Read defensively rather than trusted: the keys are config option ids Domo
 * never declares (`effort`, `reasoning_effort`, whatever an adapter ships
 * next), so the shape is "an object of strings per adapter" and anything that
 * is not a string is dropped instead of reaching a `session/set_config_option`
 * call. An empty object means "leave the adapter on its own defaults", which
 * is what a fresh install wants.
 */
function storedAgentConfig(stored: Record<string, any>): AppSettings['defaultAgentConfig'] {
  const config = Object.fromEntries(AGENT_ADAPTERS.map(adapter => [adapter.id, {}])) as AppSettings['defaultAgentConfig']
  const current = stored.defaultAgentConfig
  if (!current || typeof current !== 'object') return config
  for (const adapter of Object.keys(config) as Array<keyof typeof config>) {
    const entries = current[adapter]
    if (!entries || typeof entries !== 'object') continue
    for (const [id, value] of Object.entries(entries)) {
      if (typeof value === 'string' && value) config[adapter][id] = value
    }
  }
  return config
}

/**
 * The per-adapter default modes, reading the install's own row.
 *
 * `defaultAgentMode` — one string for both adapters — is what installs before
 * this stored, and it could only ever have been a Claude Code id, so that is
 * what it becomes. It is not migrated away: the settings page writes the whole
 * form, so the new key appears on the next save and the old one is simply
 * ignored from then on. An adapter missing from a stored object keeps its own
 * default rather than becoming undefined.
 */
function storedAgentModes(stored: Record<string, any>): AppSettings['defaultAgentModes'] {
  const modes = { ...DEFAULTS.defaultAgentModes }
  if (typeof stored.defaultAgentMode === 'string' && stored.defaultAgentMode) {
    modes['claude-code'] = stored.defaultAgentMode
  }
  const current = stored.defaultAgentModes
  if (current && typeof current === 'object') {
    for (const adapter of Object.keys(modes) as Array<keyof typeof modes>) {
      if (typeof current[adapter] === 'string' && current[adapter]) modes[adapter] = current[adapter]
    }
  }
  return modes
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    // An empty credential is a removal, not a stored empty string, so the row
    // goes rather than shadowing whatever the environment says. A page never
    // sends these fields on an ordinary save — it cannot, since a key is never
    // sent *to* it — so an empty value here is always deliberate.
    if (isSecretKey(key) && typeof value === 'string' && !value.trim()) {
      await query('delete from settings where key = $1', [key])
      continue
    }
    await query(
      `insert into settings (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify({ v: isSecretKey(key) && typeof value === 'string' ? value.trim() : value })]
    )
  }
  return getSettings()
}
