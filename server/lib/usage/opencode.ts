import { opencodeAuthContent } from '../acp/adapter-process'
import type { UsageLimitValue } from './normalize'

const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'
const TIMEOUT_MS = 15_000

export interface OpenCodeUsageResult {
  outcome: 'ok' | 'unconfigured' | 'error'
  limits: UsageLimitValue[]
  message: string | null
}

type Fetcher = typeof fetch

/** Resolve the Go API key without ever returning it in an error or database row. */
export async function opencodeGoApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.NUXT_OPENCODE_GO_API_KEY || env.OPENCODE_GO_API_KEY
  if (configured) return configured
  const content = await opencodeAuthContent(env)
  if (!content) return null
  try {
    const auth = JSON.parse(content)
    const entry = auth?.['opencode-go'] ?? auth?.opencode
    return entry?.type === 'api' && typeof entry.key === 'string' ? entry.key : null
  } catch {
    return null
  }
}

const WINDOWS: Record<string, { label: string, minutes: number }> = {
  rolling: { label: '5-hour limit', minutes: 300 },
  weekly: { label: 'Weekly limit', minutes: 7 * 24 * 60 },
  monthly: { label: 'Monthly limit', minutes: 30 * 24 * 60 }
}

/** Convert OpenCode Go's account response into Domo's provider-neutral rows. */
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
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeUsageResult> {
  const key = await opencodeGoApiKey(env)
  if (!key) {
    return {
      outcome: 'unconfigured',
      limits: [],
      message: 'No OpenCode Go API key found. Run `opencode auth login` or set NUXT_OPENCODE_GO_API_KEY.'
    }
  }
  try {
    const response = await doFetch(env.NUXT_OPENCODE_GO_USAGE_URL || DEFAULT_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (response.status === 401 || response.status === 403) {
      return { outcome: 'unconfigured', limits: [], message: 'The OpenCode Go key was rejected or has no Go subscription.' }
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
