import { boardDraft } from '../../../../../shared/types/board'
import { setBoardDraft } from '../../../../lib/repo'
import { boardOwnerParam } from '../../../../lib/board/route'

/** Save what the human has changed on one element, or on a group (see `groupDraftKey`); an empty draft removes it. */
export default defineEventHandler(async (event) => {
  const owner = await boardOwnerParam(event)
  const element = getRouterParam(event, 'element', { decode: true })!
  const body = await readBody<{ draft?: unknown }>(event)
  const parsed = boardDraft.nullable().safeParse(body?.draft ?? null)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid draft', data: parsed.error.issues })
  await setBoardDraft(owner, element, parsed.data)
  return { ok: true }
})
