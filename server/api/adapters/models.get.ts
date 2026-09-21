import { listAdapterModels } from '../../lib/acp/models'

/**
 * The models an adapter offers, for the picker in the new-agent modal.
 *
 * Under `/api/adapters`, not `/api/agents`: a literal segment beside
 * `/api/agents/[id]` collapses the typed route for every agent call to the
 * methods this one supports, and `$fetch('/api/agents/' + id, { method: 'PATCH' })`
 * stops type-checking.
 *
 * A 502 rather than an empty list when the probe fails: "this adapter is not
 * logged in" and "this adapter offers no choice of model" are different answers,
 * and the modal says so.
 */
export default defineEventHandler(async (event) => {
  const adapter = getQuery(event).adapter === 'codex' ? 'codex' : 'claude-code'
  try {
    return await listAdapterModels(adapter)
  } catch (error) {
    throw createError({
      statusCode: 502,
      statusMessage: error instanceof Error ? error.message : String(error)
    })
  }
})
