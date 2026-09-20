import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The secret is generated once per process and never persisted, on purpose: a
 * token only has to outlive the adapter it was handed to, and no adapter
 * outlives the server. Nitro's `close` hook kills every one of them, and each
 * spawn gets fresh `mcpServers` (both `session/new` and `session/load`), so a
 * restart hands out new tokens before anything could present an old one.
 */
const secret = randomBytes(32)

function sign(agentSessionId: string): string {
  return createHmac('sha256', secret).update(agentSessionId).digest('hex')
}

/** The bearer token a coding agent presents to `/api/internal/mcp`. */
export function mintMeshToken(agentSessionId: string): string {
  return `${agentSessionId}.${sign(agentSessionId)}`
}

/** The agent session a token proves, or `null` if it proves nothing. */
export function verifyMeshToken(token: string | undefined | null): string | null {
  if (!token) return null
  const split = token.lastIndexOf('.')
  if (split <= 0) return null
  const agentSessionId = token.slice(0, split)
  const presented = Buffer.from(token.slice(split + 1))
  const expected = Buffer.from(sign(agentSessionId))
  // `timingSafeEqual` throws on a length mismatch, so the cheap check comes first.
  if (presented.length !== expected.length) return null
  return timingSafeEqual(presented, expected) ? agentSessionId : null
}
