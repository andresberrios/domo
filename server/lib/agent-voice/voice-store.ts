import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClonedVoice } from '../../../shared/types'
import { VOICE_SAMPLE_MAX_SECONDS, VOICE_SAMPLE_MIN_SECONDS } from '../../../shared/agent-voice'
import { dataDir } from '../paths'

/**
 * The voices cloned for Pocket TTS: a WAV sample and a small JSON file each,
 * under `<data>/voices`, named by a random id so nothing the user typed ever
 * becomes a path. They are kept out of the database because every synced
 * table streams to the browser, and a recording of someone's voice is not
 * something to send to every open tab.
 *
 * The browser converts whatever was recorded or uploaded to mono PCM16, so
 * the one format accepted here is the one Pocket reads without guessing.
 */

/** 30 s of mono PCM16 at 48 kHz, and room for a header. */
export const MAX_SAMPLE_BYTES = VOICE_SAMPLE_MAX_SECONDS * 48000 * 2 + 4096
const ID = /^[a-z0-9]{12}$/

export function voicesDir(): string {
  const dir = join(dataDir(), 'voices')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function isClonedVoiceId(id: string): boolean {
  return ID.test(id)
}

/** The sample's path, or null for an id that is not one of ours. */
export function clonedVoiceSamplePath(id: string): string | null {
  return isClonedVoiceId(id) ? join(voicesDir(), `${id}.wav`) : null
}

/** A name to show: one line, no control characters, at most 40 characters. */
export function cleanVoiceName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('The voice needs a name.')
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('The voice needs a name.')
  if (clean.length > 40) throw new Error('The name is longer than 40 characters.')
  return clean
}

/**
 * Check that `bytes` is a mono PCM16 WAV of a usable length, and return its
 * length in seconds. Chunks other than `fmt ` and `data` (LIST, fact) are
 * skipped, as a file from an editor may have them.
 */
export function parseSampleWav(bytes: Buffer): { sampleRate: number, seconds: number } {
  const fail = (why: string): never => { throw new Error(`The sample is not a usable WAV: ${why}.`) }
  if (bytes.length > MAX_SAMPLE_BYTES) fail(`larger than ${Math.round(MAX_SAMPLE_BYTES / 1e6)} MB`)
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') fail('no RIFF/WAVE header')
  let sampleRate = 0
  let dataBytes = -1
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) fail('a short format chunk')
      if (bytes.readUInt16LE(body) !== 1) fail('not PCM')
      if (bytes.readUInt16LE(body + 2) !== 1) fail('not mono')
      if (bytes.readUInt16LE(body + 14) !== 16) fail('not 16-bit')
      sampleRate = bytes.readUInt32LE(body + 4)
    } else if (id === 'data') {
      // A streamed WAV may leave the size unset; the rest of the file is the data.
      dataBytes = Math.min(size, bytes.length - body)
      break
    }
    offset = body + size + (size % 2)
  }
  if (!sampleRate) fail('no format chunk')
  if (sampleRate < 8000 || sampleRate > 48000) fail(`a sample rate of ${sampleRate} Hz`)
  if (dataBytes < 0) fail('no audio data')
  const seconds = dataBytes / 2 / sampleRate
  if (seconds < VOICE_SAMPLE_MIN_SECONDS) throw new Error(`The sample is ${seconds.toFixed(1)} s long; it needs at least ${VOICE_SAMPLE_MIN_SECONDS} s of speech.`)
  if (seconds > VOICE_SAMPLE_MAX_SECONDS + 0.5) throw new Error(`The sample is ${Math.round(seconds)} s long; ${VOICE_SAMPLE_MAX_SECONDS} s is the most Pocket TTS reads.`)
  return { sampleRate, seconds: Math.round(seconds * 10) / 10 }
}

export async function listClonedVoices(): Promise<ClonedVoice[]> {
  const dir = voicesDir()
  const voices: ClonedVoice[] = []
  for (const file of await readdir(dir)) {
    const id = file.replace(/\.json$/, '')
    if (!file.endsWith('.json') || !isClonedVoiceId(id)) continue
    try {
      const meta = JSON.parse(await readFile(join(dir, file), 'utf8'))
      voices.push({ id, name: String(meta.name), seconds: Number(meta.seconds), createdAt: String(meta.createdAt) })
    } catch {
      // A half-written or hand-edited file is skipped rather than failing the list.
    }
  }
  return voices.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function getClonedVoice(id: string): Promise<ClonedVoice | null> {
  if (!isClonedVoiceId(id)) return null
  return (await listClonedVoices()).find(voice => voice.id === id) ?? null
}

/** Validate and keep a sample. Throws a message fit to show the user. */
export async function createClonedVoice(name: unknown, sample: Buffer): Promise<ClonedVoice> {
  const clean = cleanVoiceName(name)
  const { seconds } = parseSampleWav(sample)
  const voice: ClonedVoice = { id: randomBytes(6).toString('hex'), name: clean, seconds, createdAt: new Date().toISOString() }
  const dir = voicesDir()
  // The sample first: a JSON file is what makes a voice appear, so a
  // failure between the two writes never lists a voice with no audio.
  await writeFile(join(dir, `${voice.id}.wav`), sample)
  await writeFile(join(dir, `${voice.id}.json`), JSON.stringify({ name: voice.name, seconds: voice.seconds, createdAt: voice.createdAt }))
  return voice
}

export async function deleteClonedVoice(id: string): Promise<boolean> {
  if (!isClonedVoiceId(id)) return false
  const dir = voicesDir()
  const existed = (await readdir(dir)).includes(`${id}.json`)
  await rm(join(dir, `${id}.json`), { force: true })
  await rm(join(dir, `${id}.wav`), { force: true })
  return existed
}
