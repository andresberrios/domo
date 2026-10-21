import { setBoardFold } from '../../../lib/repo'
import { boardOwnerParam } from '../../../lib/board/route'

/** Fold or unfold a group; null goes back to the default. */
export default defineEventHandler(async (event) => {
  const owner = await boardOwnerParam(event)
  const body = await readBody<{ group?: unknown, folded?: unknown }>(event)
  if (typeof body?.group !== 'string' || !body.group) throw createError({ statusCode: 400, statusMessage: 'Name the group' })
  const folded = typeof body.folded === 'boolean' ? body.folded : null
  await setBoardFold(owner, body.group, folded)
  return { ok: true }
})
