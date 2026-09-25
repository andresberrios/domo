import { listOpenAiModels } from '../lib/openai'

/**
 * Ask the OpenAI API what models this key can see, so the Live and Responses
 * pickers show real ids rather than a hard-coded guess.
 *
 * A literal segment beside a dynamic route collapses the typed route for every
 * call on it (see the `/api/adapters/models` note in AGENTS.md), so this is a
 * top-level file rather than `/api/openai/models` — there is no `/api/openai`
 * tree and no reason to open one for a single endpoint.
 */
export default defineEventHandler(async () => {
  try {
    return { models: await listOpenAiModels() }
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) }
  }
})
