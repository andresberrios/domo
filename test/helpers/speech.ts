import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A spoken question, as a WAV file Chromium can be pointed at.
 *
 * Chromium's fake capture device generates a *tone*, which is exactly right
 * for proving the worklet produces frames and exactly useless for a test whose
 * subject is a model listening to speech — the transcript would be empty and
 * the assertion would be about nothing. `--use-file-for-fake-audio-capture`
 * takes a WAV and loops it, so the microphone can say a real sentence.
 *
 * The audio is synthesised once per phrase and cached on disk under the test
 * build directory: a live layer already costs money and seconds, and there is
 * no reason to pay for the same sentence on every run. It is generated rather
 * than committed because a checked-in binary is a thing nobody can review, and
 * it is generated with the same key the layer already requires.
 */

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CACHE_DIR = resolve(rootDir, '.nuxt/test/voice')

/** Small and fast; this is a microphone, not a broadcast. */
const TTS_MODEL = process.env.NUXT_OPENAI_TTS_MODEL || 'gpt-4o-mini-tts'

export async function spokenWav(text: string): Promise<string> {
  const key = process.env.NUXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY
  if (!key) throw new Error('No OpenAI API key, so the spoken fixture cannot be synthesised')

  const name = createHash('sha256').update(`${TTS_MODEL}:${text}`).digest('hex').slice(0, 16)
  const path = resolve(CACHE_DIR, `${name}.wav`)
  if (existsSync(path)) return path

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: 'alloy', input: text, response_format: 'wav' })
  })
  if (!response.ok) {
    throw new Error(`Could not synthesise the spoken fixture: ${response.status} ${await response.text()}`)
  }

  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(path, Buffer.from(await response.arrayBuffer()))
  return path
}
