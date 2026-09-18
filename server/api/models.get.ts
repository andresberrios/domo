import { GoogleGenAI } from '@google/genai'

import { geminiApiKey } from '../lib/gemini'

/**
 * Ask the Gemini API what models this key can see, so the model picker shows
 * real ids rather than a hard-coded guess.
 */
export default defineEventHandler(async () => {
  const apiKey = geminiApiKey()
  if (!apiKey) return { models: [], error: 'No Gemini API key configured' }

  try {
    const ai = new GoogleGenAI({ apiKey })
    const pager = await ai.models.list()
    const models: Array<{ name: string, displayName?: string, description?: string, live: boolean }> = []
    for await (const model of pager as any) {
      const name = (model.name ?? '').replace(/^models\//, '')
      if (!name) continue
      const actions: string[] = model.supportedActions ?? model.supportedGenerationMethods ?? []
      const live = /live/i.test(name) || actions.some((action: string) => /bidi|live/i.test(action))
      models.push({ name, displayName: model.displayName, description: model.description, live })
    }
    models.sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name))
    return { models }
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) }
  }
})
