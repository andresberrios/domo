import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The Node half of the Mac's speech: the resident helpers' line protocol,
 * with a script standing in for each compiled Swift program (this runs on
 * Linux too; the Swift is checked on a Mac).
 */

const dir = mkdtempSync(join(tmpdir(), 'mac-speech-'))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

/** Put a fake at the path the helper would compile to, so it is used as is. */
function fake(name: string, source: string, script: string) {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
  mkdirSync(join(dir, 'mac-speech'), { recursive: true })
  const path = join(dir, 'mac-speech', `${name}-${hash}`)
  writeFileSync(path, `#!/usr/bin/env node\n${script}`)
  chmodSync(path, 0o755)
}

let mac: typeof import('../../server/lib/agent-voice/mac-speech')

beforeAll(async () => {
  vi.stubEnv('NUXT_DATA_DIR', dir)
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const source = readFileSync(new URL('../../server/lib/agent-voice/mac-speech.ts', import.meta.url), 'utf8')
  const embedded = (name: string) => source.split(`const ${name} = String.raw\``)[1]!.split('\n`\n')[0]! + '\n'
  // Speech: two chunks then done, per request; a voice list on request.
  fake('say', embedded('SAY_SOURCE'), `
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line)
  const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
  if (r.list) return out({ id: r.id, voices: [{ id: 'com.apple.voice.premium.en-US.Ava', name: 'Ava', language: 'en-US', quality: 3 }] })
  const pcm = Buffer.from(new Int16Array([1, 2, 3]).buffer).toString('base64')
  out({ id: r.id, rate: 22050, pcm })
  setTimeout(() => { out({ id: r.id, rate: 22050, pcm }); out({ id: r.id, done: true }) }, 20)
})`)
  // Hearing: echoes what it was asked, so the test can see the request.
  fake('hear', embedded('HEAR_SOURCE'), `
const fs = require('fs')
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line)
  const size = fs.statSync(r.wav).size
  process.stdout.write(JSON.stringify({ id: r.id, text: ' heard ' + size + ' bytes in ' + r.locale + ' with ' + r.context.join('+') + ' ' }) + '\\n')
})`)
  mac = await import('../../server/lib/agent-voice/mac-speech')
})

afterAll(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
})

describe('the Mac speech helpers', () => {
  it('stream a reply chunk by chunk, and keep requests apart on one process', async () => {
    const chunks: Array<{ id: string, rate: number }> = []
    await Promise.all(['one', 'two'].map(id => mac.synthesizeMac(id, '', 'en', chunk => chunks.push({ id, rate: chunk.sampleRate }))))
    expect(chunks.filter(c => c.id === 'one')).toHaveLength(2)
    expect(chunks.filter(c => c.id === 'two')).toHaveLength(2)
    expect(chunks.every(c => c.rate === 22050)).toBe(true)
  })

  it('hear a turn as a WAV, with the locale and the vocabulary', async () => {
    const text = await mac.transcribeMac(new Int16Array(16000), 16000, 'en', { conversation: '', vocabulary: ['Domo', 'Vitest'] })
    expect(text).toBe(`heard ${44 + 32000} bytes in en-US with Domo+Vitest`)
  })

  it('list the voices installed', async () => {
    expect(await mac.macVoices()).toEqual([{ id: 'com.apple.voice.premium.en-US.Ava', name: 'Ava', language: 'en-US', quality: 3 }])
  })
})
