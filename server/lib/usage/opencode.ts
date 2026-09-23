import { resolveOpenCodeApiKey, settingsOpenCodeApiKey, type OpenCodeKeyLookup } from '../opencode-credentials'
import type { UsageLimitValue } from './normalize'

/**
 * Undocumented, and the credential it wants is specific.
 *
 * Measured against a real account: a service-account key answers 200 with the
 * window block below, and the device-flow access token out of the host's own
 * login answers **401** on the same URL. So the poll needs the configured key
 * and there is no falling back to the host login — doing so would report a
 * logged-in developer as "rejected". `/zen/v1/usage` (without `go`) is a 404,
 * so this path is real rather than left over.
 */
const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'
const TIMEOUT_MS = 15_000

export interface OpenCodeUsageResult {
  outcome: 'ok' | 'unconfigured' | 'error'
  limits: UsageLimitValue[]
  message: string | null
}

type Fetcher = typeof fetch

const WINDOWS: Record<string, { label: string, minutes: number }> = {
  rolling: { label: '5-hour limit', minutes: 300 },
  weekly: { label: 'Weekly limit', minutes: 7 * 24 * 60 },
  monthly: { label: 'Monthly limit', minutes: 30 * 24 * 60 }
}

/**
 * Convert OpenCode Go's account response into Domo's provider-neutral rows.
 *
 * `percent` is read as 0-100, and that is **measured but unconfirmed**: the one
 * real response captured came from an account with no usage, so every window
 * answered `0` — which reads the same on either scale. Every other source Domo
 * polls disagrees about this (Claude's endpoint answers percent, its headers
 * answer fractions), and a 0.41 read as a percentage renders as a reassuring
 * "0%". If OpenCode turns out to answer fractions, the symptom is a card that
 * sits near zero while the plan is really being spent; divide here, not at the
 * call site.
 */
export function normalizeOpenCodeUsage(response: any): UsageLimitValue[] {
  const usage = response?.usage
  if (!usage || typeof usage !== 'object') return []
  const limits: UsageLimitValue[] = []
  for (const [id, description] of Object.entries(WINDOWS)) {
    const window = usage[id]
    if (!window || typeof window.percent !== 'number') continue
    limits.push({
      limitId: id,
      label: description.label,
      usedPercent: Math.max(0, Math.min(100, window.percent)),
      resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
      windowMinutes: description.minutes,
      status: window.status === 'ok' ? 'allowed' : window.status ? 'rejected' : null,
      amountUsed: null,
      amountLimit: null,
      currency: null,
      source: 'endpoint'
    })
  }
  return limits
}

/** Poll the OpenCode Go account endpoint for the account-wide usage display. */
export async function fetchOpenCodeUsage(
  doFetch: Fetcher = fetch,
  env: NodeJS.ProcessEnv = process.env,
  /** Injected for the unit layer, which has no database behind Settings. */
  stored: OpenCodeKeyLookup = settingsOpenCodeApiKey
): Promise<OpenCodeUsageResult> {
  const key = await resolveOpenCodeApiKey(env, stored)
  if (!key) {
    return {
      outcome: 'unconfigured',
      limits: [],
      message: 'No OpenCode console key. Add a service-account key in Settings, or set NUXT_OPENCODE_API_KEY. '
        + 'A host `opencode auth login` is not enough: the console rejects that credential here.'
    }
  }
  try {
    const response = await doFetch(env.NUXT_OPENCODE_GO_USAGE_URL || DEFAULT_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (response.status === 401 || response.status === 403) {
      return { outcome: 'unconfigured', limits: [], message: 'The OpenCode console key was rejected or has no Go subscription.' }
    }
    if (!response.ok) {
      return { outcome: 'error', limits: [], message: `OpenCode Go usage answered HTTP ${response.status}.` }
    }
    const limits = normalizeOpenCodeUsage(await response.json())
    return limits.length
      ? { outcome: 'ok', limits, message: null }
      : { outcome: 'error', limits: [], message: 'OpenCode Go usage returned no recognizable limit windows.' }
  } catch (error) {
    return {
      outcome: 'error',
      limits: [],
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
