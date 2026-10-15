import type { SetupAgentStatus, SetupCheckResult, SetupVoiceStatus } from '~~/shared/types'

export type SetupTone = 'success' | 'warning' | 'error' | 'neutral'

/** One coding agent's state in a word and a colour, for the guide and its summary. */
export function agentBadge(status: SetupAgentStatus, check?: SetupCheckResult): { label: string, color: SetupTone } {
  if (!status.installed) return { label: 'Not installed', color: 'error' }
  if (status.login === 'none') return { label: 'Not signed in', color: 'error' }
  if (check && !check.ok) return { label: 'Test failed', color: 'error' }
  if (status.login === 'api-key') return { label: check?.ok ? 'Working, on an API key' : 'API key', color: 'warning' }
  if (status.login === 'free') return { label: check?.ok ? 'Working, free models' : 'Free models only', color: 'neutral' }
  return { label: check?.ok ? 'Working' : 'Signed in', color: 'success' }
}

/** Voice the same way. */
export function voiceBadge(status: SetupVoiceStatus, check?: SetupCheckResult): { label: string, color: SetupTone } {
  if (status.problem) return { label: 'Needs a key', color: 'error' }
  if (check && !check.ok) return { label: 'Test failed', color: 'error' }
  return { label: check?.ok ? 'Working' : 'Ready to test', color: check?.ok ? 'success' : 'neutral' }
}
