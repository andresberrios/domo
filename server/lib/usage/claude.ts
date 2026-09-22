import { claudeOauthToken } from '../claude-credentials'
import { claudeEndpointLimits, claudeHeaderLimits, type UsageLimitValue } from './normalize'

/**
 * Reading Claude plan limits without touching the developer's own login.
 *
 * Both paths below authenticate with the `claude setup-token` token and nothing
 * else. Domo never reads the macOS Keychain item or `~/.claude/.credentials.json`
 * for this: Anthropic rotates that refresh token on every use, so a second
 * reader would eventually log the developer's own Mac out of Claude Code, and
 * on macOS the read itself raises a GUI prompt.
 */

const API_BASE = process.env.NUXT_ANTHROPIC_API_BASE || 'https://api.anthropic.com'

/**
 * The beta header an OAuth token has to be presented with, and the endpoint
 * path — both read out of the shipped Claude Code binary (2.1.270), where the
 * constant pool holds `/api/oauth/usage`, `oauth-2025-04-20` and
 * `BASE_API_URL: "https://api.anthropic.com"` together.
 *
 * Unofficial and undocumented: this is the request Claude Code's own `/usage`
 * makes, not a published API, and it can change without notice. Everything
 * downstream of it treats an unexpected body as "no data" rather than failing.
 */
const OAUTH_BETA = 'oauth-2025-04-20'
const USAGE_PATH = '/api/oauth/usage'

const REQUEST_TIMEOUT_MS = 10_000

/** What a poll learned, including how long to wait before asking again. */
export interface ClaudeUsageResult {
  outcome: 'ok' | 'unconfigured' | 'auth' | 'rate-limited' | 'error'
  limits: UsageLimitValue[]
  /** A sentence for the UI. Never contains a token or a header. */
  message: string | null
  /** Honour this before the next attempt, from the response's `Retry-After`. */
  retryAfterMs?: number
}

/** `Retry-After` is seconds or an HTTP date; both turn up in the wild. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/**
 * A message that is safe to store and show.
 *
 * `usage_limits` and `usage_providers` are streamed to the browser, so nothing
 * derived from a request may carry the `Authorization` header — and a refused
 * connection arrives as an `AggregateError` whose `message` is the empty
 * string, so the name has to be the fallback or the UI shows a blank reason.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const causes = error instanceof AggregateError
      ? error.errors.map(inner => (inner instanceof Error ? inner.message : String(inner))).filter(Boolean)
      : []
    return error.message || causes[0] || error.name || 'request failed'
  }
  return String(error ?? 'request failed')
}

export type ClaudeUsageFetch = typeof fetch

/** A hung request must not hold a poll open until the next one is due. */
async function withTimeout(doFetch: ClaudeUsageFetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await doFetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `GET /api/oauth/usage` — the request Claude Code's own `/usage` screen makes.
 *
 * **Measured to be unusable with the token Domo is given**, which is the single
 * most important finding in this feature. A real `claude setup-token` token
 * answers:
 *
 *     403 {"type":"error","error":{"type":"permission_error",
 *       "message":"OAuth token does not meet scope requirement user:profile",
 *       "details":{"required_scopes":["user:profile"],
 *                  "error_code":"oauth_scope_insufficient"}}}
 *
 * A setup token carries `user:inference` only; the usage endpoint wants
 * `user:profile`, which is a scope Claude Code's own interactive login has and
 * a headless token does not. So this is kept — an operator who supplies a
 * differently-scoped token gets the richer answer, including the per-model
 * weekly buckets and the credits row that nothing else reports — but the poller
 * expects it to fail and falls through to `probeClaudeHeaders`.
 *
 * The endpoint is also hard rate-limited even when it *is* reachable: a second
 * call inside the window answers **429 with `retry-after: 3591`**, roughly one
 * call an hour. Hence the hourly interval, the honoured `Retry-After`, and a
 * 429 that is not an error state — the last good readings stay on screen with
 * their own timestamp rather than being replaced by nothing.
 */
export async function fetchClaudeUsage(
  token: string | null = claudeOauthToken(),
  doFetch: ClaudeUsageFetch = fetch
): Promise<ClaudeUsageResult> {
  if (!token) {
    return {
      outcome: 'unconfigured',
      limits: [],
      message: 'Set NUXT_CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) to see plan limits.'
    }
  }

  let response: Response
  try {
    response = await withTimeout(doFetch, `${API_BASE}${USAGE_PATH}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'Content-Type': 'application/json'
      }
    })
  } catch (error) {
    return { outcome: 'error', limits: [], message: describeError(error) }
  }

  if (response.status === 429) {
    return {
      outcome: 'rate-limited',
      limits: [],
      message: 'Anthropic is rate-limiting the usage endpoint; showing the last reading.',
      retryAfterMs: retryAfterMs(response.headers.get('retry-after'))
    }
  }
  if (response.status === 401 || response.status === 403) {
    // The expected answer for a `claude setup-token` token, so it is not an
    // alarming message: the poller reads the limits off response headers
    // instead, which needs only the inference scope that token does have.
    return {
      outcome: 'auth',
      limits: [],
      message: `The usage endpoint refused the Claude token (HTTP ${response.status}); `
        + 'reading plan limits from rate-limit headers instead.'
    }
  }
  if (!response.ok) {
    return { outcome: 'error', limits: [], message: `Usage endpoint answered HTTP ${response.status}.` }
  }

  let body: any
  try {
    body = await response.json()
  } catch (error) {
    return { outcome: 'error', limits: [], message: describeError(error) }
  }

  // An in-band error: the endpoint answers 200 with `{ error: … }` when it is
  // shedding load, which Claude Code's own client also special-cases.
  if (body?.error) {
    return {
      outcome: 'rate-limited',
      limits: [],
      message: 'Anthropic answered the usage endpoint with an error; showing the last reading.'
    }
  }

  const limits = claudeEndpointLimits(body)
  if (!limits.length) {
    return {
      outcome: 'ok',
      limits,
      message: 'No plan limits apply to this account (API-key billing has none).'
    }
  }
  return { outcome: 'ok', limits, message: null }
}

/**
 * One minimal Messages request, read for its rate-limit headers.
 *
 * In practice this is **the** source of Claude plan limits, because the usage
 * endpoint above needs a scope a headless token does not carry. Every
 * OAuth-authenticated response carries the `anthropic-ratelimit-unified-*`
 * family, and reading them needs only `user:inference` — verified against a
 * real token, which answered 200 with `5h-utilization`, `7d-utilization` and
 * both resets present.
 *
 * It does spend quota, which is why it is polled in minutes rather than
 * seconds: the request is the smallest one the API will accept (one token in,
 * one token out) and its body is dropped unread. The headers are on a 429 too,
 * which is the reading that matters most.
 */
export async function probeClaudeHeaders(
  token: string | null = claudeOauthToken(),
  doFetch: ClaudeUsageFetch = fetch
): Promise<ClaudeUsageResult> {
  if (!token) {
    return {
      outcome: 'unconfigured',
      limits: [],
      message: 'Set NUXT_CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) to see plan limits.'
    }
  }

  let response: Response
  try {
    response = await withTimeout(doFetch, `${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }]
      })
    })
  } catch (error) {
    return { outcome: 'error', limits: [], message: describeError(error) }
  }

  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value })
  // The body is never read: it is a token of an answer and costs nothing to drop.
  await response.body?.cancel().catch(() => {})

  const limits = claudeHeaderLimits(headers)
  if (response.status === 401 || response.status === 403) {
    return {
      outcome: 'auth',
      limits,
      message: `Anthropic rejected the Claude token (HTTP ${response.status}).`
    }
  }
  if (!limits.length) {
    return {
      outcome: 'error',
      limits,
      message: 'The rate-limit probe answered without any plan-limit headers.'
    }
  }
  return { outcome: 'ok', limits, message: null }
}
