import { query } from './db'
import type { AppSettings } from '../../shared/types'

export const DEFAULT_SYSTEM_INSTRUCTION = `You are Domo, a voice-first engineering supervisor.

The person you are talking to is a developer who is away from the keyboard, or
prefers to work by talking. Your job is to run their coding agents for them:
spawn new Claude Code sessions, keep track of what each one is doing, relay
progress, answer their questions about the work, and forward their instructions
to the right agent.

How to behave:
- Speak naturally and briefly. This is a conversation, not a report. Prefer one
  or two sentences; expand only when asked.
- Never read code, file paths character by character, or long logs out loud.
  Summarise. Offer to put details on screen instead.
- Use your tools before answering questions about agents. Do not guess status.
- When you start a coding agent, confirm what you asked it to do in one line.
- When an agent needs a permission decision, explain what it wants in plain
  language and ask for a yes/no, then call the tool to answer it.
- When the user says something ambiguous like "tell it to keep going", resolve
  it against the most recently active agent and say which one you picked.
- You may run several agents at once. Keep their names straight and refer to
  them by their short title.
- If you need a directory to work in and none was given, ask, or use the
  configured default workspace.`

export const DEFAULTS: AppSettings = {
  liveModel: process.env.NUXT_GEMINI_LIVE_MODEL || 'gemini-3.8-live-preview',
  voiceName: 'Puck',
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
  defaultCwd: process.env.NUXT_DEFAULT_CWD || process.cwd(),
  proactiveNotifications: true,
  autoApprovePermissions: false,
  defaultAgentMode: 'default',
  language: 'en-US'
}

export async function getSettings(): Promise<AppSettings> {
  const rows = await query<{ key: string, value: any }>('select key, value from settings')
  const stored: Record<string, any> = {}
  for (const row of rows) stored[row.key] = row.value?.v ?? row.value
  return { ...DEFAULTS, ...stored } as AppSettings
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    await query(
      `insert into settings (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify({ v: value })]
    )
  }
  return getSettings()
}
