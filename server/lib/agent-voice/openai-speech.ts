import { openAiApiBase, openAiApiKey } from '../openai'
import { instructionPrompt, precedingTextPrompt, type SpeechContext } from './context'
import { wavFromPcm16, type SpeechChunk } from './speech'

/**
 * OpenAI's two speech endpoints, the REST ones: a transcription is one
 * multipart request with a WAV, and speech is one streamed response of raw
 * 24 kHz PCM16, handed on chunk by chunk as it arrives.
 */

function headers(): Record<string, string> {
  const key = openAiApiKey()
  if (!key) throw new Error('No OpenAI API key: set NUXT_OPENAI_API_KEY')
  return { Authorization: `Bearer ${key}` }
}

export async function transcribeOpenAi(
  samples: Int16Array,
  sampleRate: number,
  model: string,
  language: string,
  context: SpeechContext,
  signal?: AbortSignal
): Promise<string> {
  const form = new FormData()
  form.append('model', model)
  form.append('response_format', 'json')
  if (language) form.append('language', language)
  // whisper-1 continues its prompt as if it were the preceding transcript;
  // the transcribe models read it as context.
  const prompt = model.startsWith('whisper') ? precedingTextPrompt(context) : instructionPrompt(context)
  if (prompt) form.append('prompt', prompt)
  form.append('file', new Blob([new Uint8Array(wavFromPcm16(samples, sampleRate))], { type: 'audio/wav' }), 'turn.wav')
  const response = await fetch(`${openAiApiBase()}/audio/transcriptions`, {
    method: 'POST',
    headers: headers(),
    body: form,
    signal
  })
  if (!response.ok) throw new Error(`transcription failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
  const json = (await response.json()) as { text?: string }
  return String(json.text ?? '').replace(/\s+/g, ' ').trim()
}

export async function synthesizeOpenAi(
  text: string,
  model: string,
  voice: string,
  onChunk: (chunk: SpeechChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${openAiApiBase()}/audio/speech`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, input: text, response_format: 'pcm' }),
    signal
  })
  if (!response.ok || !response.body) {
    throw new Error(`speech failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  const reader = response.body.getReader()
  // Chunks may split a sample in two; the odd byte waits for the next chunk.
  let carry: Uint8Array | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (signal?.aborted) {
      await reader.cancel().catch(() => {})
      return
    }
    let bytes = value
    if (carry) {
      const joined = new Uint8Array(carry.length + bytes.length)
      joined.set(carry)
      joined.set(bytes, carry.length)
      bytes = joined
      carry = null
    }
    if (bytes.length % 2) {
      carry = bytes.subarray(bytes.length - 1)
      bytes = bytes.subarray(0, bytes.length - 1)
    }
    if (bytes.length) onChunk({ data: Buffer.from(bytes).toString('base64'), sampleRate: 24000 })
  }
}
