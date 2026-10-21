import { createError, getRouterParam, type H3Event } from 'h3'
import { boardOwnerFor } from './index'

/**
 * The board an address names, which must be the board's own owner: an
 * assistant's, or a session that is not an assistant's. A session of an
 * assistant is refused rather than redirected, so the UI never writes a draft
 * under an id nobody reads.
 */
export async function boardOwnerParam(event: H3Event): Promise<string> {
  const owner = getRouterParam(event, 'owner') ?? ''
  const resolved = await boardOwnerFor(owner)
  if (!resolved) throw createError({ statusCode: 404, statusMessage: `No session or assistant ${owner}` })
  if (resolved !== owner) throw createError({ statusCode: 400, statusMessage: `That session's board is its assistant's, ${resolved}` })
  return owner
}
