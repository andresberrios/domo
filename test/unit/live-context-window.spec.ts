import { describe, expect, it } from 'vitest'

import { learnLiveContextWindows, liveContextWindow } from '../../server/lib/gemini'

/**
 * The denominator for a conversation's context bar.
 *
 * The Live API reports what a session has spent and never how much it may
 * spend, so the window has to come from the models API. The seeded values were
 * read off that API rather than written from memory, which is the only reason
 * they are right: the whole Live family is on 131,072 tokens, *not* the 1M the
 * non-Live Gemini models get — an easy and invisible thing to get wrong, since
 * a too-large denominator just makes every conversation look roomy.
 */

describe('the seeded table', () => {
  it('knows the models Settings offers today', () => {
    expect(liveContextWindow('gemini-3.8-live')).toBe(131_072)
    expect(liveContextWindow('gemini-2.5-flash-native-audio-latest')).toBe(131_072)
    // Not every Live model has the same window.
    expect(liveContextWindow('gemini-3.5-live-translate-preview')).toBe(16_384)
  })

  it('accepts the `models/` prefix the API answers with', () => {
    expect(liveContextWindow('models/gemini-3.8-live')).toBe(131_072)
  })

  it('is null for a model it has never heard of, rather than a guess', () => {
    // The UI then draws a token count and no bar. A made-up denominator would
    // put a meaningless percentage on screen instead.
    expect(liveContextWindow('gemini-99-live')).toBeNull()
    expect(liveContextWindow(null)).toBeNull()
    expect(liveContextWindow('')).toBeNull()
  })
})

describe('learning from the models API', () => {
  it('takes inputTokenLimit, which is what the window actually is', () => {
    learnLiveContextWindows([{ name: 'models/gemini-99-live', inputTokenLimit: 262_144 }])

    expect(liveContextWindow('gemini-99-live')).toBe(262_144)
  })

  it('overrides the seed, so a released change does not need a Domo release', () => {
    learnLiveContextWindows([{ name: 'models/gemini-3.8-live', inputTokenLimit: 200_000 }])

    expect(liveContextWindow('gemini-3.8-live')).toBe(200_000)
  })

  it('ignores a listing entry with no usable limit', () => {
    learnLiveContextWindows([
      { name: 'models/gemini-broken-live', inputTokenLimit: 0 },
      { name: 'models/gemini-broken2-live', inputTokenLimit: null },
      { name: null, inputTokenLimit: 1000 }
    ])

    expect(liveContextWindow('gemini-broken-live')).toBeNull()
    expect(liveContextWindow('gemini-broken2-live')).toBeNull()
  })
})
