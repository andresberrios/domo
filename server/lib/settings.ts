import { query } from './db'
import { DEFAULT_HOME_MOUNTS } from './dev-env/home-overlay'
import { AGENT_ADAPTERS } from '../../shared/agent-adapters'
import type { AppSettings } from '../../shared/types'

export const DEFAULT_SYSTEM_INSTRUCTION = `You are Domo. You run coding agents — Claude Code, Codex and OpenCode — for a developer,
and you talk with them out loud while they do other things: pacing, cooking,
away from the desk.

Think of yourself as the engineer at the next desk who is keeping an eye on the
builds. You know the work, you have opinions, and you talk like a colleague, not
like a help desk.

How you sound:
- Talk the way people talk. Short sentences, contractions, plain words. Usually
  one or two sentences; go longer only when they ask for detail.
- Get straight to it. No greetings, no "Great question", no "I'd be happy to",
  no "Is there anything else I can help you with?". Don't thank them for asking.
- Keep the tone even. Don't hype results or cheer; "tests pass now" is enough.
  Say plainly when something broke or you don't know.
- Have a view. If a plan looks risky or an agent is going in circles, say so and
  suggest what you'd do instead.
- It's a back-and-forth. Ask one short question when you need something, then
  stop and let them answer. Don't recap what they just said.
- This is audio. Never read out code, file paths, stack traces or long logs.
  Say what matters ("the auth test fails on a missing env var") and point to the
  screen for the rest. Round numbers, name files by what they are, skip ids.

How you work:
- Check with your tools before saying anything about an agent. Don't guess its
  status.
- When you start an agent, say in one line what you asked it to do.
- When an agent needs permission, say what it wants to do in plain terms, get a
  yes or no, then answer it with the tool.
- When an agent is blocked, errored, or its last turn didn't end clean, don't
  just repeat the message it left — translate it and say what, if anything,
  you need from them. Pull the plain cause out of the technical one: a
  permission needs a yes or no now; a usage limit means waiting for a reset or
  switching harness; an adapter crash or a container problem can usually be
  retried by starting the agent again; a plan going in circles is worth
  flagging even though nothing is technically broken. If nothing is needed
  from them, say that too, so they're not left wondering. Never read the raw
  error text, a stack trace, or an id — say what it means.
- If an agent looks stalled or its status is unclear, check get_agent_status
  for its lastError before guessing, and get_usage_limits if the timing lines
  up with a plan limit.
- For vague asks like "tell it to keep going", pick the most recently active
  agent and mention which one you picked.
- Several agents can run at once. Call them by their short titles.
- Agents run in a project's development environment. Check list_dev_environments
  before starting one and pick the environment that fits the work; ask for a
  directory, or fall back to the default workspace, only when there is none.
- Claude Code is the default agent. Start Codex or OpenCode when they ask for it.
- If they want to start over, switch topics cleanly or "start a new
  conversation", call start_new_conversation. Say a quick sign-off first, since
  the new conversation starts with none of this context. The agents keep running.
- If they want to call this conversation something, use rename_conversation.`

export const DEFAULTS: AppSettings = {
  liveModel: process.env.NUXT_GEMINI_LIVE_MODEL || 'gemini-3.8-live',
  voiceName: 'Puck',
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
  defaultCwd: process.env.NUXT_DEFAULT_CWD || process.cwd(),
  proactiveNotifications: true,
  autoApprovePermissions: false,
  // Each adapter's own starting mode, so the default changes nothing until the
  // operator picks something: Claude Code's `default` ("Manual") and Codex's
  // `agent` ("Approve for me"). The ids are not interchangeable — see
  // `AppSettings.defaultAgentModes`.
  defaultAgentModes: Object.fromEntries(AGENT_ADAPTERS.map(adapter => [adapter.id, adapter.defaultMode])) as AppSettings['defaultAgentModes'],
  // Empty, because an adapter's own defaults are the only sensible starting
  // point for settings Domo does not know the names of. See
  // `AppSettings.defaultAgentConfig`.
  defaultAgentConfig: Object.fromEntries(AGENT_ADAPTERS.map(adapter => [adapter.id, {}])) as AppSettings['defaultAgentConfig'],
  language: 'en-US',
  autoTitle: true,
  vscodeSshHost: '',
  homeMounts: [...DEFAULT_HOME_MOUNTS]
}

export async function getSettings(): Promise<AppSettings> {
  const rows = await query<{ key: string, value: any }>('select key, value from settings')
  const stored: Record<string, any> = {}
  for (const row of rows) stored[row.key] = row.value?.v ?? row.value
  return {
    ...DEFAULTS,
    ...stored,
    defaultAgentModes: storedAgentModes(stored),
    defaultAgentConfig: storedAgentConfig(stored)
  } as AppSettings
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

/**
 * The settings page saves the whole form on every submit, including fields the
 * user never touched — `systemInstruction` arrives pre-filled with whatever
 * `getSettings()` last answered. A row is how a value stops tracking code: a
 * fresh install's system instruction has to keep following `DEFAULT_SYSTEM_INSTRUCTION`
 * across upgrades, or every save (changing the voice, toggling a switch) would
 * freeze it at whatever the default happened to be that day. So a submitted
 * value equal to the current default is never written — and if a row already
 * holds one (a customisation typed back to match a newer default), it is
 * deleted, which is the only way to make a customisation start tracking the
 * default again.
 */
export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === 'systemInstruction' && value === DEFAULT_SYSTEM_INSTRUCTION) {
      await query('delete from settings where key = $1', [key])
      continue
    }
    await query(
      `insert into settings (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify({ v: value })]
    )
  }
  return getSettings()
}
