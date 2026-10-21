import { getAgentSession } from '../../lib/repo'
import { verifyMeshToken } from '../../lib/mesh/token'
import { hostGrokAccessToken, providerAnswer } from '../../lib/acp/grok-token'

/**
 * A short-lived Grok access token for a Grok session in a development
 * environment: what its `GROK_AUTH_PROVIDER_COMMAND` prints. Only that
 * session's own mesh token gets one, and never a refresh token; see
 * `server/lib/acp/grok-token.ts`.
 */
export default defineEventHandler(async (event) => {
  const header = getRequestHeader(event, 'authorization') ?? ''
  const agentSessionId = verifyMeshToken(header.replace(/^Bearer\s+/i, ''))
  const session = agentSessionId ? await getAgentSession(agentSessionId) : null
  if (!session || session.adapter !== 'grok' || !session.devEnvironmentId) {
    throw createError({ statusCode: 403, statusMessage: 'Only a Grok session in a development environment gets a Grok token' })
  }
  const token = await hostGrokAccessToken()
  if (!token) {
    throw createError({ statusCode: 503, statusMessage: 'The computer Domo runs on has no Grok login. Run grok login there, or save an xAI API key.' })
  }
  return providerAnswer(token.token, token.expiresAt)
})
