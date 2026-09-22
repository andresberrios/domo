import { GoogleGenAI } from '@google/genai'

/** The Gemini key only ever comes from the environment, never the database. */
export function geminiApiKey(): string | null {
  return process.env.NUXT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null
}

/**
 * How big a Live model's context window is, because the session never says.
 *
 * `usageMetadata` reports how many tokens a conversation has used and nothing
 * at all about how many it may use, so a percentage needs the denominator from
 * somewhere else. The models API has it — every Live model carries an
 * `inputTokenLimit` — so the real answer is learned rather than guessed, and
 * the table below is only what to fall back on when that call cannot be made.
 *
 * The seeded values were read off the live models API rather than written from
 * memory, which is the only reason they are right: the whole Live family is on
 * 131,072 tokens, *not* the 1M the non-Live Gemini models get. Domo is
 * self-hosted and often offline, so an out-of-date table beats no table — but
 * an unknown model is `null` and not a guess, and the UI then draws a token
 * count with no bar. A made-up denominator would put a meaningless percentage
 * on screen, which is worse than no percentage at all.
 */
const SEEDED_CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-3.8-live': 131_072,
  'gemini-3.8-live-extended-thinking': 131_072,
  'gemini-3.1-flash-live-preview': 131_072,
  'gemini-3.5-transcribe-live': 131_072,
  'gemini-3.5-live-translate-preview': 16_384,
  'gemini-2.5-flash-native-audio-latest': 131_072,
  'gemini-2.5-flash-native-audio-preview-09-2025': 131_072,
  'gemini-2.5-flash-native-audio-preview-12-2025': 131_072
}

/** What the models API has said, which always wins over the seed. */
const learned = new Map<string, number>()

/** How long a models-API answer is reused. Windows change on a release, not on a turn. */
const LEARN_TTL_MS = 6 * 60 * 60_000
let learnedAt = 0
let learning: Promise<void> | null = null

function normalizeModelId(model: string): string {
  return model.replace(/^models\//, '').toLowerCase()
}

/** Record `inputTokenLimit`s from a models listing the app has already made. */
export function learnLiveContextWindows(
  models: Array<{ name?: string | null, inputTokenLimit?: number | null }>
): void {
  for (const model of models) {
    const name = model?.name ? normalizeModelId(model.name) : null
    const limit = model?.inputTokenLimit
    if (!name || typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) continue
    learned.set(name, limit)
  }
  if (learned.size) learnedAt = Date.now()
}

export function liveContextWindow(model: string | null | undefined): number | null {
  if (!model) return null
  const id = normalizeModelId(model)
  return learned.get(id) ?? SEEDED_CONTEXT_WINDOWS[id] ?? null
}

/**
 * Fill the table from the models API, at most once every few hours.
 *
 * Best-effort and never awaited by anything that matters: a conversation must
 * start whether or not this works, and the seed already covers every Live model
 * the picker offers today. De-duplicated, because several conversations may
 * connect at once.
 */
export async function ensureLiveContextWindows(): Promise<void> {
  if (Date.now() - learnedAt < LEARN_TTL_MS && learned.size) return
  if (learning) return learning
  const apiKey = geminiApiKey()
  if (!apiKey) return

  learning = (async () => {
    try {
      const pager = await new GoogleGenAI({ apiKey }).models.list()
      const models: Array<{ name?: string | null, inputTokenLimit?: number | null }> = []
      for await (const model of pager as any) models.push(model)
      learnLiveContextWindows(models)
    } catch (error) {
      // A model whose window is unknown renders as a token count, so this is
      // never worth more than a line in the log.
      console.warn(
        '[voice] could not read Live model context windows from the models API: '
        + (error instanceof Error ? error.message || error.name : String(error))
      )
    } finally {
      learning = null
    }
  })()
  return learning
}
