import { describe, expect, it } from 'vitest'

import { SPOKEN_NOTE_PREFIX, isSpokenNote } from '../../shared/agent-voice'
import {
  SPOKEN_CHANNEL_INSTRUCTIONS,
  needsFullInstructions,
  spokenContent,
  spokenNoteKind
} from '../../server/lib/agent-voice/prompt'
import { logMelFeatures, windowOf } from '../../server/lib/agent-voice/turn'
import {
  joinUtterance,
  parseSpokenTurn,
  plainForSpeech,
  takeClause,
  takeSentences
} from '../../server/lib/agent-voice/utterance'
import {
  concatPcm16,
  isSilent,
  sampleRateOf,
  transcriptFrom,
  wavFromPcm16
} from '../../server/lib/agent-voice/speech'

/**
 * The pure half of talking to a coding agent. What is pinned here is the
 * conversation's grammar — which words end a turn, which are commands, how
 * streamed Markdown becomes sentences a speech model is handed — because a
 * mistake there is a turn that never sends or an agent told to stop when the
 * developer said "let's start over".
 */

describe('parseSpokenTurn', () => {
  it('sends on the radio sign-off, and strips it', () => {
    expect(parseSpokenTurn('fix the auth test, over')).toEqual({ kind: 'send', text: 'fix the auth test' })
    expect(parseSpokenTurn('Fix the auth test. Over.')).toEqual({ kind: 'send', text: 'Fix the auth test.' })
    expect(parseSpokenTurn('fix the auth test message over')).toEqual({ kind: 'send', text: 'fix the auth test' })
    expect(parseSpokenTurn('fix it, over and out!')).toEqual({ kind: 'send', text: 'fix it' })
  })

  it('sends on a sign-off heard on its own', () => {
    expect(parseSpokenTurn('Over.')).toEqual({ kind: 'send', text: '' })
    expect(parseSpokenTurn('message over')).toEqual({ kind: 'send', text: '' })
    expect(parseSpokenTurn("That's it.")).toEqual({ kind: 'send', text: '' })
    expect(parseSpokenTurn('go ahead')).toEqual({ kind: 'send', text: '' })
  })

  it('takes the plain sign-offs at the end of a sentence too', () => {
    expect(parseSpokenTurn("rename the file and that's it")).toEqual({ kind: 'send', text: 'rename the file and' })
    expect(parseSpokenTurn("Run the tests. That's all.")).toEqual({ kind: 'send', text: 'Run the tests.' })
    expect(parseSpokenTurn('is that all there is')).toMatchObject({ kind: 'partial' })
  })

  it('takes a bare trailing "over" only when asked to be lenient', () => {
    expect(parseSpokenTurn('how many lines the readme has over')).toMatchObject({ kind: 'partial' })
    expect(parseSpokenTurn('how many lines the readme has over', { lenient: true })).toEqual({ kind: 'send', text: 'how many lines the readme has' })
  })

  it('does not mistake a sentence ending in "over" for a sign-off', () => {
    expect(parseSpokenTurn("let's start over")).toEqual({ kind: 'partial', text: "let's start over" })
    expect(parseSpokenTurn('do it over')).toEqual({ kind: 'partial', text: 'do it over' })
  })

  it('recognises the two commands, and only on their own', () => {
    expect(parseSpokenTurn('Stop.')).toEqual({ kind: 'hush' })
    expect(parseSpokenTurn('okay, stop talking')).toEqual({ kind: 'hush' })
    expect(parseSpokenTurn('Cancel that')).toEqual({ kind: 'cancel' })
    expect(parseSpokenTurn('never mind')).toEqual({ kind: 'cancel' })
    expect(parseSpokenTurn('stop the server and rerun the tests')).toMatchObject({ kind: 'partial' })
    expect(parseSpokenTurn('cancel the subscription in the code, over')).toMatchObject({ kind: 'send' })
  })

  it('holds ordinary words, and calls nothing empty', () => {
    expect(parseSpokenTurn('  so what I want   is ')).toEqual({ kind: 'partial', text: 'so what I want is' })
    expect(parseSpokenTurn('   ')).toEqual({ kind: 'empty' })
  })

  it('joins the pieces of an utterance across a pause', () => {
    expect(joinUtterance('', 'first')).toBe('first')
    expect(joinUtterance('first ', ' second')).toBe('first second')
  })
})

describe('takeSentences', () => {
  it('cuts complete sentences and leaves the tail', () => {
    expect(takeSentences('I will look. It seems the test fails. Let me chec')).toEqual({
      sentences: ['I will look.', 'It seems the test fails.'],
      rest: 'Let me chec'
    })
  })

  it('waits for whitespace after the punctuation', () => {
    expect(takeSentences('The answer is 3.')).toEqual({ sentences: [], rest: 'The answer is 3.' })
    expect(takeSentences('The answer is 3.5 and 4. Right')).toEqual({ sentences: ['The answer is 3.5 and 4.'], rest: 'Right' })
  })

  it('treats a line break as a boundary', () => {
    expect(takeSentences('First line\nSecond line')).toEqual({ sentences: ['First line'], rest: 'Second line' })
  })

  it('keeps a closing quote with its sentence', () => {
    expect(takeSentences('He said "done." Then left')).toEqual({ sentences: ['He said "done."'], rest: 'Then left' })
  })

  it('holds an open code fence and drops a closed one', () => {
    expect(takeSentences('Here it is. ```ts\nconst a = 1.\n')).toEqual({
      sentences: ['Here it is.'],
      rest: '```ts\nconst a = 1.\n'
    })
    expect(takeSentences('Here it is. ```ts\nconst a = 1.\n``` That is all. ')).toEqual({
      sentences: ['Here it is.', 'That is all.'],
      rest: ''
    })
  })
})

describe('plainForSpeech', () => {
  it('drops the Markdown and keeps the words', () => {
    expect(plainForSpeech('## Result\n\n- **Two** tests fail\n- see `auth.spec.ts`\n\n> note')).toBe(
      'Result Two tests fail see auth.spec.ts note'
    )
    expect(plainForSpeech('Read [the docs](https://example.com) first.')).toBe('Read the docs first.')
    expect(plainForSpeech('```js\nx()\n```\nDone.')).toBe('Done.')
  })
})

describe('spokenContent', () => {
  it('sends the words and a note, and the note is the one the transcript hides', () => {
    const blocks = spokenContent('run the tests', { full: false })
    expect(blocks[0]).toEqual({ type: 'text', text: 'run the tests' })
    expect(isSpokenNote(blocks[1]!.text)).toBe(true)
    expect(isSpokenNote(blocks[0]!.text)).toBe(false)
    expect(spokenNoteKind(blocks[1]!.text)).toBe('short')
  })

  it('carries the whole instruction only when asked to', () => {
    expect(spokenContent('hi', { full: false })[1]!.text).not.toContain(SPOKEN_CHANNEL_INSTRUCTIONS)
    const full = spokenContent('hi', { full: true })[1]!.text
    expect(full).toContain(SPOKEN_CHANNEL_INSTRUCTIONS)
    expect(full.startsWith(SPOKEN_NOTE_PREFIX)).toBe(true)
    expect(spokenNoteKind(full)).toBe('full')
    expect(spokenNoteKind('typed words')).toBe(null)
  })
})

describe('needsFullInstructions', () => {
  const now = Date.parse('2026-09-27T12:00:00Z')
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const spoken = (full: boolean, minutesAgo: number) => ({ content: spokenContent('x', { full }), createdAt: at(minutesAgo) })
  const typed = (minutesAgo: number) => ({ content: [{ type: 'text', text: 'typed' }], createdAt: at(minutesAgo) })

  it('starts an episode with the full text', () => {
    expect(needsFullInstructions([], now)).toBe(true)
    expect(needsFullInstructions([typed(1)], now)).toBe(true)
  })

  it('reminds briefly while the episode goes on', () => {
    expect(needsFullInstructions([spoken(true, 1)], now)).toBe(false)
    expect(needsFullInstructions([spoken(false, 1), spoken(false, 2), spoken(true, 3)], now)).toBe(false)
  })

  it('repeats the full text after a typed message, a long gap, or a dozen messages', () => {
    expect(needsFullInstructions([typed(1), spoken(true, 2)], now)).toBe(true)
    expect(needsFullInstructions([spoken(true, 31)], now)).toBe(true)
    const many = Array.from({ length: 12 }, (_, i) => spoken(false, i + 1))
    expect(needsFullInstructions([...many, spoken(true, 13)], now)).toBe(true)
    expect(needsFullInstructions([...many.slice(0, 11), spoken(true, 12)], now)).toBe(false)
  })
})

describe('turn model features', () => {
  it('front-pads to eight seconds and keeps the end', () => {
    const wave = windowOf(Int16Array.from([16384, -16384]))
    expect(wave.length).toBe(128000)
    expect(wave[127998]).toBeCloseTo(0.5)
    expect(wave[127999]).toBeCloseTo(-0.5)
    expect(wave[0]).toBe(0)
    const long = new Int16Array(200000)
    long[199999] = 32767
    expect(windowOf(long)[127999]).toBeCloseTo(1, 3)
  })

  it('produces Whisper-shaped log-mel features in the expected range', () => {
    const wave = new Float32Array(128000)
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / 16000)
    const features = logMelFeatures(wave)
    expect(features.length).toBe(80 * 800)
    let max = -Infinity
    let min = Infinity
    for (const value of features) {
      expect(Number.isFinite(value)).toBe(true)
      if (value > max) max = value
      if (value < min) min = value
    }
    // (log10 + 4) / 4 with an 8 dB floor under the peak: the range is exactly 2 wide.
    expect(max - min).toBeCloseTo(2, 5)
  })
})

describe('speech helpers', () => {
  it('writes a WAV header the transcriber can read', () => {
    const wav = wavFromPcm16(Int16Array.from([1, -1, 300]), 16000)
    expect(wav.length).toBe(44 + 6)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(40)).toBe(6)
    expect(wav.readInt16LE(44 + 4)).toBe(300)
  })

  it('joins chunks in order', () => {
    expect([...concatPcm16([Int16Array.from([1, 2]), Int16Array.from([3])])]).toEqual([1, 2, 3])
  })

  it('calls a click on the microphone silent and a voice not', () => {
    expect(isSilent(new Int16Array(4000))).toBe(true)
    expect(isSilent(new Int16Array(0))).toBe(true)
    const loud = new Int16Array(4000)
    for (let i = 0; i < loud.length; i++) loud[i] = i % 2 ? 4000 : -4000
    expect(isSilent(loud)).toBe(false)
  })

  it('reads the transcript out of either part shape', () => {
    expect(transcriptFrom({ candidates: [{ content: { parts: [{ audioTranscription: { text: ' hello  there ' } }] } }] })).toBe('hello there')
    expect(transcriptFrom({ candidates: [{ content: { parts: [{ text: 'typed' }] } }] })).toBe('typed')
    expect(transcriptFrom({})).toBe('')
  })

  it('reads the sample rate off the chunk, defaulting to 24 kHz', () => {
    expect(sampleRateOf('audio/l16; rate=24000; channels=1')).toBe(24000)
    expect(sampleRateOf('audio/l16;rate=16000')).toBe(16000)
    expect(sampleRateOf(undefined)).toBe(24000)
  })
})

describe('takeClause', () => {
  it('takes the first clause long enough to say alone', () => {
    expect(takeClause('It records your voice, sends it up')).toEqual({ clause: 'It records your voice,', rest: 'sends it up' })
    expect(takeClause('Yes, it does, and then')).toBe(null)
    expect(takeClause('Look at this: ```code, more')).toBe(null)
  })
})
