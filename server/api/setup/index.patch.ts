import { updateSetup } from '../../lib/setup'
import { isAgentAdapter } from '../../../shared/agent-adapters'
import type { SetupTarget } from '../../../shared/types'

const isTarget = (value: unknown): value is SetupTarget => value === 'voice' || isAgentAdapter(value)

/** Skip a step, take a skip back, or finish (or reopen) the guide. */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ finished?: unknown, skip?: unknown, unskip?: unknown }>(event) ?? {}
  if (body.finished !== undefined && typeof body.finished !== 'boolean') {
    throw createError({ statusCode: 400, message: 'finished is true or false.' })
  }
  for (const field of ['skip', 'unskip'] as const) {
    if (body[field] !== undefined && !isTarget(body[field])) {
      throw createError({ statusCode: 400, message: `${field} names a coding agent or voice.` })
    }
  }
  return updateSetup({
    finished: body.finished as boolean | undefined,
    skip: body.skip as SetupTarget | undefined,
    unskip: body.unskip as SetupTarget | undefined
  })
})
