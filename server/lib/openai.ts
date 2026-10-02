/**
 * The OpenAI half of the voice stack: the key, and what a key can see.
 *
 * Like `gemini.ts` beside it, the key is read from the environment first and
 * then from Settings (`secret-settings.ts`), which is never streamed to the
 * browser.
 */
import { storedSecret } from './secret-settings'

/**
 * Where a Live socket connects. No query parameters: the model goes in
 * `session.start`.
 *
 * Overridable for the same reason `NUXT_ANTHROPIC_API_BASE` is — it is how the
 * voice path can be exercised end to end, browser audio included, against
 * something that speaks the protocol and costs nothing. Nothing in the app
 * sets it.
 */
export function openAiLiveUrl(): string {
  return process.env.NUXT_OPENAI_LIVE_URL || 'wss://api.openai.com/v1/live/sessions'
}

/**
 * The OpenAI key, in the order a self-hosted install is likely to have set one.
 *
 * `CODEX_API_KEY` is accepted last because it is the same platform credential
 * under another name — an install that configured Codex has one and should not
 * have to duplicate it — but an explicitly OpenAI-named variable wins, so an
 * operator who keeps the two apart gets the one they meant.
 */
export function openAiApiKey(): string | null {
  return process.env.NUXT_OPENAI_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.NUXT_CODEX_API_KEY
    || process.env.CODEX_API_KEY
    || storedSecret('openAiApiKey')
}

/**
 * Where the REST API lives, so a test can point it somewhere unreachable the
 * same way `NUXT_ANTHROPIC_API_BASE` already does for the usage poller.
 */
export function openAiApiBase(): string {
  return (process.env.NUXT_OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '')
}

export interface OpenAiModel {
  id: string
  /** A live voice model, i.e. one that can be the `session.start` model. */
  live: boolean
}

/**
 * What ids this key can see, split into the ones that can run a Live socket and
 * the ones that can be its Responses backend.
 *
 * Both pickers are fed from this rather than from a list in the code, for the
 * reason the Gemini picker is: a model id is the thing most likely to have
 * changed since anything here was written, and a typed id still works — the
 * fields are combo boxes.
 */
export async function listOpenAiModels(
  options: { signal?: AbortSignal } = {}
): Promise<OpenAiModel[]> {
  const apiKey = openAiApiKey()
  if (!apiKey) throw new Error('No OpenAI API key. Add one in Settings → General, or NUXT_OPENAI_API_KEY in .env.')

  const response = await fetch(`${openAiApiBase()}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: options.signal
  })
  if (!response.ok) {
    throw new Error(`The OpenAI models API answered ${response.status} ${response.statusText}`)
  }
  const body = await response.json() as { data?: Array<{ id?: string }> }
  const models: OpenAiModel[] = []
  for (const entry of body.data ?? []) {
    const id = entry?.id
    if (!id) continue
    models.push({ id, live: isLiveModelId(id) })
  }
  models.sort((a, b) => Number(b.live) - Number(a.live) || a.id.localeCompare(b.id))
  return models
}

/**
 * Whether an id names a voice model rather than a text one.
 *
 * Both families are matched because both have been the name for this: the
 * current one is `gpt-live-*`, and `gpt-realtime-*` is what the previous
 * generation of the same API is called. An install pinned to an older id must
 * still find it in the picker.
 */
export function isLiveModelId(id: string): boolean {
  return /(^|[-/])(live|realtime)([-.]|$)/i.test(id)
}
