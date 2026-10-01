import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanVoiceName,
  clonedVoiceSamplePath,
  createClonedVoice,
  deleteClonedVoice,
  listClonedVoices,
  MAX_SAMPLE_BYTES,
  parseSampleWav
} from '../../server/lib/agent-voice/voice-store'
import { sampleWav } from './wav-fixture'

/**
 * The cloned-voice store takes files from the browser and writes them under
 * the data directory, so what it refuses matters as much as what it keeps.
 */

describe('parseSampleWav', () => {
  it('reads a mono PCM16 sample, past chunks it does not need', () => {
    expect(parseSampleWav(sampleWav(12))).toEqual({ sampleRate: 24000, seconds: 12 })
    expect(parseSampleWav(sampleWav(8, { rate: 16000, extraChunk: true }))).toEqual({ sampleRate: 16000, seconds: 8 })
  })

  it('refuses what Pocket would misread or what is not audio', () => {
    expect(() => parseSampleWav(Buffer.from('ID3\u0003 an mp3, not a wav, padded out past forty-four bytes'))).toThrow(/RIFF/)
    expect(() => parseSampleWav(sampleWav(10, { channels: 2 }))).toThrow(/mono/)
    expect(() => parseSampleWav(sampleWav(10, { bits: 8 }))).toThrow(/16-bit/)
    expect(() => parseSampleWav(sampleWav(10, { format: 3, bits: 16 }))).toThrow(/PCM/)
    expect(() => parseSampleWav(sampleWav(10, { rate: 96000 }))).toThrow(/larger|sample rate/)
  })

  it('refuses a sample too short to learn from, too long to be read, or too large', () => {
    expect(() => parseSampleWav(sampleWav(2))).toThrow(/at least 5 s/)
    expect(() => parseSampleWav(sampleWav(31))).toThrow(/30 s/)
    expect(() => parseSampleWav(Buffer.alloc(MAX_SAMPLE_BYTES + 1))).toThrow(/larger than/)
  })
})

describe('cleanVoiceName', () => {
  it('keeps one tidy line and refuses an empty or long one', () => {
    expect(cleanVoiceName('  My\n  voice\u0000 ')).toBe('My voice')
    expect(() => cleanVoiceName('   ')).toThrow(/name/)
    expect(() => cleanVoiceName(undefined)).toThrow(/name/)
    expect(() => cleanVoiceName('x'.repeat(41))).toThrow(/40/)
  })
})

describe('the voice store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'domo-voices-'))
    process.env.NUXT_DATA_DIR = dir
  })
  afterEach(() => {
    delete process.env.NUXT_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a sample under a random id, whatever the name says, and deletes it', async () => {
    const voice = await createClonedVoice('../../etc/passwd', sampleWav(10))
    expect(voice.id).toMatch(/^[a-z0-9]{12}$/)
    expect(voice.name).toBe('../../etc/passwd')
    expect(readdirSync(join(dir, 'voices')).sort()).toEqual([`${voice.id}.json`, `${voice.id}.wav`])
    expect(await listClonedVoices()).toEqual([voice])
    expect(await deleteClonedVoice(voice.id)).toBe(true)
    expect(await listClonedVoices()).toEqual([])
    expect(readdirSync(join(dir, 'voices'))).toEqual([])
  })

  it('writes nothing for a refused sample, and never resolves an id outside the directory', async () => {
    await expect(createClonedVoice('Short', sampleWav(1))).rejects.toThrow(/at least/)
    expect(existsSync(join(dir, 'voices')) ? readdirSync(join(dir, 'voices')) : []).toEqual([])
    expect(clonedVoiceSamplePath('../secret')).toBeNull()
    expect(await deleteClonedVoice('../../voices')).toBe(false)
  })
})
