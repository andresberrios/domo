import { updateAssistantFields } from '../../../lib/assistants'

/**
 * Change an assistant: name, picture and persona, what its next session runs
 * on, its handoff threshold, or `archived`. Pass only the fields to change.
 */
export default defineEventHandler(async (event) => {
  return updateAssistantFields(getRouterParam(event, 'id')!, (await readBody(event)) ?? {})
})
