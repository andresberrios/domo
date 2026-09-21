import { afterEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import {
  appendVoiceMessage,
  createVoiceSession,
  getVoiceSession,
  listVoiceMessages,
  saveConversationSummary
} from '../../server/lib/repo'
import { compactConversation, ensureCompacted } from '../../server/lib/voice/compaction'
import { buildConversationContext, selectCompactionSlice } from '../../server/lib/voice/context'

/**
 * Folding a conversation's own history into the summary on its row.
 *
 * Everything below is real — the schema, the repo, Postgres — except the
 * summariser, which is a stub: what Gemini writes is Google's business, while
 * *which messages are handed to it*, *what gets stored*, and *what happens when
 * it fails or two folds race* are Domo's, and those are what used to be wrong
 * (there was no fold at all: a reconnect replayed the last twelve messages and
 * silently forgot everything before them).
 */

/** Numbered, so a fold can be told from the one it replaced. */
const summariser = vi.fn(async ({ previous, transcript }: { previous: string | null, transcript: string }) => {
  const generation = Number(previous?.match(/^memory#(\d+)/)?.[1] ?? 0) + 1
  return `memory#${generation} covering ${transcript.split('\n').length} lines`
})

afterEach(async () => {
  summariser.mockClear()
  await query('delete from voice_sessions')
})

/** A conversation long enough that the tail no longer fits a connect. */
async function longConversation(turns = 40) {
  const session = await createVoiceSession({ title: 'Flaky invoice tests' })
  for (let i = 0; i < turns; i++) {
    await appendVoiceMessage({ sessionId: session.id, role: 'user', text: `Question ${i}. `.repeat(20) })
    await appendVoiceMessage({ sessionId: session.id, role: 'assistant', text: `Answer ${i}. `.repeat(20) })
  }
  return session
}

describe('compacting a conversation', () => {
  it('leaves a short one alone, and never calls the summariser for it', async () => {
    const session = await createVoiceSession()
    await appendVoiceMessage({ sessionId: session.id, role: 'user', text: 'morning' })
    await appendVoiceMessage({ sessionId: session.id, role: 'assistant', text: 'morning' })

    await expect(compactConversation(session.id, { summarise: summariser }))
      .resolves.toEqual({ compacted: false, reason: 'not-needed' })
    expect(summariser).not.toHaveBeenCalled()
    expect((await getVoiceSession(session.id))?.summary).toBeNull()
  })

  it('folds the oldest messages into the row once there are enough of them', async () => {
    const session = await longConversation()

    const result = await compactConversation(session.id, { summarise: summariser })

    expect(result.compacted).toBe(true)
    const row = (await getVoiceSession(session.id))!
    expect(row.summary).toContain('memory#1')
    expect(row.summaryThroughSeq).toBe(result.compacted && result.throughSeq)
    expect(row.summaryUpdatedAt).toBeTruthy()
  })

  it('hands the summariser only the messages no summary covers yet', async () => {
    const session = await longConversation()
    await compactConversation(session.id, { summarise: summariser })
    const firstFold = (await getVoiceSession(session.id))!.summaryThroughSeq!
    for (let i = 0; i < 20; i++) {
      await appendVoiceMessage({ sessionId: session.id, role: 'user', text: `Later ${i}. `.repeat(20) })
      await appendVoiceMessage({ sessionId: session.id, role: 'assistant', text: `Reply ${i}. `.repeat(20) })
    }

    await compactConversation(session.id, { summarise: summariser })

    const second = summariser.mock.calls[1]![0]
    expect(second.previous).toContain('memory#1')
    expect(second.transcript).toContain('Later 0.')
    expect(second.transcript).not.toContain('Question 0.')
    expect((await getVoiceSession(session.id))!.summaryThroughSeq).toBeGreaterThan(firstFold)
  })

  it('folds from the boundary, not from the newest messages, so a backlog leaves no hole', async () => {
    // A summariser that was down for a long time: far more unfolded messages
    // than one fold's window can hold.
    const session = await longConversation(160)
    const oldest = (await listVoiceMessages(session.id))[0]!

    await compactConversation(session.id, { summarise: summariser })

    expect(summariser.mock.calls[0]![0].transcript).toContain('Question 0.')
    const row = (await getVoiceSession(session.id))!
    expect(row.summaryThroughSeq).toBeGreaterThanOrEqual(oldest.seq)
    // Folding the window it could see, not the whole backlog, and the next one
    // carries on where this stopped.
    expect(row.summaryThroughSeq).toBeLessThan((await listVoiceMessages(session.id)).at(-1)!.seq)
    await compactConversation(session.id, { summarise: summariser })
    const second = summariser.mock.calls[1]![0]
    expect(second.transcript.split('\n')[0]).toContain('Question')
    expect((await getVoiceSession(session.id))!.summaryThroughSeq).toBeGreaterThan(row.summaryThroughSeq!)
  })

  it('leaves the summary and the transcript untouched when the summariser fails', async () => {
    const session = await longConversation()

    const result = await compactConversation(session.id, {
      summarise: async () => {
        throw new Error('quota exhausted')
      }
    })

    expect(result).toMatchObject({ compacted: false, reason: 'failed', error: 'quota exhausted' })
    const row = (await getVoiceSession(session.id))!
    expect(row.summary).toBeNull()
    expect(row.summaryThroughSeq).toBeNull()
    expect(await listVoiceMessages(session.id)).toHaveLength(80)
  })

  it('pays for one model call when a turn and a connect ask at the same time', async () => {
    const session = await longConversation()

    const [a, b] = await Promise.all([
      compactConversation(session.id, { summarise: summariser }),
      compactConversation(session.id, { summarise: summariser })
    ])

    expect(summariser).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('answers no-session for a conversation that has been deleted', async () => {
    await expect(compactConversation('vs_gone', { summarise: summariser }))
      .resolves.toEqual({ compacted: false, reason: 'no-session' })
  })

  it('never rewinds: a fold that covers less than the row already does is dropped', async () => {
    const session = await longConversation()
    await compactConversation(session.id, { summarise: summariser })
    const through = (await getVoiceSession(session.id))!.summaryThroughSeq!

    const stale = await saveConversationSummary(session.id, { summary: 'older, shorter memory', throughSeq: through - 1 })

    expect(stale).toBeNull()
    expect((await getVoiceSession(session.id))!.summary).toContain('memory#1')
  })

  it('goes with the conversation when it is deleted', async () => {
    const session = await longConversation(4)
    await saveConversationSummary(session.id, { summary: 'something', throughSeq: 2 })

    await query('delete from voice_sessions where id = $1', [session.id])

    expect(await getVoiceSession(session.id)).toBeNull()
  })
})

describe('compacting before a connect', () => {
  it('gives up on a summariser that hangs, rather than holding the socket', async () => {
    const session = await longConversation()

    const result = await ensureCompacted(session.id, {
      timeoutMs: 20,
      summarise: () => new Promise<string>(() => {})
    })

    expect(result).toMatchObject({ compacted: false, reason: 'failed', error: 'timed out' })
  })

  it('is what keeps a reconnect from losing the middle of a long conversation', async () => {
    const session = await longConversation(60)

    const before = buildConversationContext({ messages: await listVoiceMessages(session.id) })
    await ensureCompacted(session.id, { summarise: summariser })
    const row = (await getVoiceSession(session.id))!
    const after = buildConversationContext({
      summary: row.summary,
      summaryThroughSeq: row.summaryThroughSeq,
      messages: await listVoiceMessages(session.id)
    })

    // Without a fold the budget simply throws the oldest messages away; with
    // one, everything it dropped is accounted for by the summary instead.
    expect(before.dropped).toBeGreaterThan(0)
    expect(after.dropped).toBe(0)
    expect(after.summarised).toBe(true)
    expect(selectCompactionSlice({ messages: await listVoiceMessages(session.id), summaryThroughSeq: row.summaryThroughSeq })).toBeNull()
  })
})
