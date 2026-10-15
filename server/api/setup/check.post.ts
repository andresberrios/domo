import { checkAgent, checkVoice, updateSetup } from '../../lib/setup'
import { isAgentAdapter } from '../../../shared/agent-adapters'

/**
 * A live check the person started: one tiny real request to a coding agent on
 * its cheap model, or voice speaking and hearing a sentence. The result is
 * kept, so the guide remembers what worked.
 */
export default defineEventHandler(async (event) => {
  const { target } = await readBody<{ target?: unknown }>(event) ?? {}
  if (target === 'voice') {
    const { audio, heard, ...check } = await checkVoice()
    const progress = await updateSetup({ check: { target, result: { ok: check.ok, at: check.at, summary: check.summary } } })
    return { ...check, audio, heard, progress }
  }
  if (!isAgentAdapter(target)) throw createError({ statusCode: 400, message: 'target names a coding agent or voice.' })
  const { reply, ...check } = await checkAgent(target)
  const progress = await updateSetup({ check: { target, result: { ok: check.ok, at: check.at, summary: check.summary } } })
  return { ...check, reply, progress }
})
