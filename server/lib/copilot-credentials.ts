import { secret } from './secret-settings'
import type { UsageLimitValue } from './usage/normalize'

/**
 * What GitHub Copilot signs in with, and what Domo reads with the same token.
 *
 * A **host** session needs nothing from Domo: the CLI reads its own
 * `copilot login` out of the system credential store (or `~/.copilot`). That
 * login is never copied anywhere. A **container** session gets a token in its
 * environment instead, and Copilot takes `COPILOT_GITHUB_TOKEN`, then
 * `GH_TOKEN`, ahead of any stored login. Two kinds are safe there because
 * neither rotates: a fine-grained personal access token with the "Copilot
 * Requests" permission, saved in Settings, and the `gh` OAuth token every
 * environment already carries as `GH_TOKEN` for git. Classic `ghp_` tokens are
 * refused by Copilot.
 *
 * Copilot bills one GitHub account per token, and its model ids carry no
 * provider prefix, so there is no second account a model id could land on.
 * The `COPILOT_PROVIDER_*` variables would move it onto a BYOK endpoint; they
 * never reach the adapter (`adapterEnv` passes an allow-list).
 */

/** The token saved in Settings (or set by the server's configuration), or null. */
export function copilotGithubToken(): string | null {
  return secret('copilotGithubToken')
}

const GITHUB_API = 'https://api.github.com'
/** Where the models list lives when the account does not name its own endpoint. */
const COPILOT_API = 'https://api.githubcopilot.com'
const TIMEOUT_MS = 15_000

/** One address for both, which the default test layers point nowhere. */
function apiOverride(): string | null {
  return process.env.NUXT_COPILOT_API_BASE || null
}

type Fetcher = typeof fetch

/**
 * The account's Copilot plan and quotas: the endpoint Copilot's own clients
 * read for their usage display. Undocumented. Measured with a `gh` OAuth token
 * on a Copilot Free account: it answers the plan (`access_type_sku`), the API
 * endpoint for the account, and `quota_snapshots` with an entitlement and
 * what remains of it per quota.
 */
export async function fetchCopilotAccount(token: string, doFetch: Fetcher = fetch): Promise<{ status: number, body: any }> {
  const response = await doFetch(`${apiOverride() || GITHUB_API}/copilot_internal/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

export interface CopilotModel {
  id: string
  name: string
}

/** Copilot's own model router, offered on every plan; on Copilot Free it is the only choice. */
export const COPILOT_AUTO_MODEL: CopilotModel = { id: 'auto', name: 'Auto' }

/**
 * The models a Copilot session can be put on.
 *
 * Copilot's ACP server offers no model option at all (copilot-cli#4880, still
 * so on 1.0.98), so the list is read where its own picker reads it. Only
 * models the picker shows and the account's policy has not disabled: on
 * Copilot Free the picker shows none, and the CLI refuses every named model
 * there ("only Auto mode is available on your plan"), so the answer is Auto
 * alone. Any failure is Auto alone as well: it is always valid.
 */
export async function fetchCopilotModels(
  token: string | null,
  apiBase: string | null,
  doFetch: Fetcher = fetch
): Promise<CopilotModel[]> {
  if (!token) return [COPILOT_AUTO_MODEL]
  try {
    const response = await doFetch(`${apiOverride() || apiBase || COPILOT_API}/models`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Copilot-Integration-Id': 'copilot-developer-cli' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) return [COPILOT_AUTO_MODEL]
    return [COPILOT_AUTO_MODEL, ...pickerModels(await response.json())]
  } catch {
    return [COPILOT_AUTO_MODEL]
  }
}

/** The chat models the account's picker offers, as the `/models` response lists them. */
export function pickerModels(body: any): CopilotModel[] {
  const seen = new Set<string>()
  const out: CopilotModel[] = []
  for (const model of Array.isArray(body?.data) ? body.data : []) {
    if (typeof model?.id !== 'string' || seen.has(model.id)) continue
    if (model.model_picker_enabled !== true) continue
    if (model.capabilities?.type && model.capabilities.type !== 'chat') continue
    if (model.policy?.state === 'disabled') continue
    seen.add(model.id)
    out.push({ id: model.id, name: typeof model.name === 'string' ? model.name : model.id })
  }
  return out
}

const QUOTAS: Record<string, string> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat'
}

/**
 * Copilot's monthly quotas as Domo's provider-neutral rows.
 *
 * Code completions are left out: they are the editor's, not an agent's. An
 * unlimited quota, or one the plan does not include (an entitlement of 0, as
 * premium requests are on Copilot Free), says nothing worth a bar.
 */
export function normalizeCopilotUsage(body: any): UsageLimitValue[] {
  const snapshots = body?.quota_snapshots
  if (!snapshots || typeof snapshots !== 'object') return []
  const resetsAt = typeof body.quota_reset_date_utc === 'string'
    ? body.quota_reset_date_utc
    : typeof body.quota_reset_date === 'string' ? `${body.quota_reset_date}T00:00:00.000Z` : null
  const limits: UsageLimitValue[] = []
  for (const [id, label] of Object.entries(QUOTAS)) {
    const quota = snapshots[id]
    if (!quota || quota.unlimited || !(Number(quota.entitlement) > 0)) continue
    const remaining = typeof quota.percent_remaining === 'number' ? quota.percent_remaining : null
    if (remaining === null) continue
    const usedPercent = Math.round(Math.max(0, Math.min(100, 100 - remaining)) * 10) / 10
    const entitlement = Number(quota.entitlement)
    const left = typeof quota.quota_remaining === 'number' ? quota.quota_remaining : Number(quota.remaining)
    limits.push({
      limitId: id,
      label: `${label} (monthly)`,
      usedPercent,
      resetsAt,
      windowMinutes: 30 * 24 * 60,
      status: usedPercent >= 100 && !quota.overage_permitted ? 'rejected' : 'allowed',
      amountUsed: Number.isFinite(left) ? Math.max(0, Math.round((entitlement - left) * 10) / 10) : null,
      amountLimit: entitlement,
      currency: null,
      source: 'endpoint'
    })
  }
  return limits
}
