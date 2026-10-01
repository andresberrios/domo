import { createAssistant } from '../../lib/assistants'

/**
 * Make an assistant and start its first session. The fields are checked in
 * `normalizeAssistantFields`; a bad one answers 400 with what to fix.
 */
export default defineEventHandler(async (event) => {
  return createAssistant((await readBody(event)) ?? {})
})
