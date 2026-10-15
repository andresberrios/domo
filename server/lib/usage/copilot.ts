import { copilotApiToken } from '../acp/copilot'
import { fetchCopilotAccount, normalizeCopilotUsage } from '../copilot-credentials'
import type { UsageLimitValue } from './normalize'

export interface CopilotUsageResult {
  outcome: 'ok' | 'unconfigured' | 'error'
  limits: UsageLimitValue[]
  message: string | null
}

/**
 * Poll Copilot's monthly quotas, with the token Domo reads Copilot with
 * (`copilotApiToken`). The endpoint answers a plan and its quotas; a plan
 * whose quotas are all unlimited answers no rows, which is not an error.
 */
export async function fetchCopilotUsage(
  token: () => Promise<string | null> = copilotApiToken,
  doFetch: typeof fetch = fetch
): Promise<CopilotUsageResult> {
  const value = await token().catch(() => null)
  if (!value) {
    return { outcome: 'unconfigured', limits: [], message: 'No GitHub token to read Copilot\'s limits with. Add one in Settings → Copilot.' }
  }
  try {
    const { status, body } = await fetchCopilotAccount(value, doFetch)
    if (status === 401 || status === 403 || status === 404) {
      return { outcome: 'unconfigured', limits: [], message: 'GitHub refused the token, or the account has no Copilot plan.' }
    }
    if (status < 200 || status >= 300) return { outcome: 'error', limits: [], message: `Copilot usage answered HTTP ${status}.` }
    return { outcome: 'ok', limits: normalizeCopilotUsage(body), message: null }
  } catch (error) {
    return { outcome: 'error', limits: [], message: error instanceof Error ? error.message : String(error) }
  }
}
