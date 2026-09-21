import { describe, expect, it } from 'vitest'

import {
  COMPACT_AFTER_CHARS,
  KEEP_VERBATIM_CHARS,
  buildConversationContext,
  renderMessage,
  renderTranscript,
  selectCompactionSlice
} from '../../server/lib/voice/context'
import type { VoiceMessage } from '../../shared/types'

/**
 * What a continuing conversation is told, and what gets folded away.
 *
 * This is the half of compaction that has no I/O in it: given the log and the
 * summary that already covers part of it, which messages does the model see
 * verbatim, and which are ready to become summary. The invariant the rest of
 * the system leans on is that the two halves partition the log exactly — no
 * message is both summarised and replayed, and none is neither.
 */

let seq = 0

function message(role: VoiceMessage['role'], text: string, toolName?: string): VoiceMessage {
  seq += 1
  return {
    id: `vm_${seq}`,
    sessionId: 'vs_1',
    seq,
    role,
    text,
    toolName: toolName ?? null,
    meta: null,
    createdAt: '2026-09-21T10:00:00.000Z'
  }
}

/** A conversation long enough to be worth folding. */
function longConversation(turns: number): VoiceMessage[] {
  const messages: VoiceMessage[] = []
  for (let i = 0; i < turns; i++) {
    messages.push(message('user', `Question ${i}. `.repeat(20)))
    messages.push(message('assistant', `Answer ${i}. `.repeat(20)))
  }
  return messages
}

describe('rendering a message for context', () => {
  it('collapses whitespace and labels the role', () => {
    expect(renderMessage(message('user', 'what\n  is\tup'))).toBe('user: what is up')
  })

  it('names the tool and clips its output hard', () => {
    const line = renderMessage(message('tool', JSON.stringify({ blob: 'x'.repeat(5000) }), 'list_agent_sessions'))

    expect(line.startsWith('tool list_agent_sessions → ')).toBe(true)
    expect(line.length).toBeLessThan(400)
    expect(line).toContain('more characters')
  })

  it('marks a system note as a note, not as something the user said', () => {
    expect(renderMessage(message('system', 'Agent finished'))).toBe('note: Agent finished')
  })
})

describe('the context a connect is given', () => {
  it('is empty for a conversation that has not started', () => {
    expect(buildConversationContext({ messages: [] })).toEqual({
      text: '',
      verbatim: [],
      dropped: 0,
      summarised: false
    })
  })

  it('tells the model to carry on rather than start over', () => {
    const context = buildConversationContext({ messages: [message('user', 'hello')] })

    expect(context.text).toContain('already under way')
    expect(context.text).toContain('user: hello')
  })

  it('replays only what the summary does not already cover', () => {
    const messages = [message('user', 'old one'), message('assistant', 'old two'), message('user', 'new one')]

    const context = buildConversationContext({
      summary: 'They asked two things and got answers.',
      summaryThroughSeq: messages[1]!.seq,
      messages
    })

    expect(context.summarised).toBe(true)
    expect(context.text).toContain('They asked two things and got answers.')
    expect(context.verbatim.map(m => m.text)).toEqual(['new one'])
    expect(context.text).not.toContain('old one')
    expect(context.dropped).toBe(0)
  })

  it('keeps the line breaks of the summary, which is a document, not a line', () => {
    const context = buildConversationContext({
      summary: 'Chasing a flaky test.\n- Agent ag_1 is on the importer.\n- PR when it is green.',
      messages: [message('user', 'where were we')]
    })

    expect(context.text).toContain('\n- Agent ag_1 is on the importer.\n')
  })

  it('keeps the newest messages when the tail will not fit, and says how many it lost', () => {
    const messages = longConversation(40)

    const context = buildConversationContext({ messages, tailBudget: 2000 })

    expect(context.text.length).toBeLessThan(4000)
    expect(context.verbatim.at(-1)).toBe(messages.at(-1))
    expect(context.dropped).toBe(messages.length - context.verbatim.length)
    expect(context.dropped).toBeGreaterThan(0)
    expect(context.text).toContain(`(${context.dropped} messages before the lines below could not be kept`)
  })

  it('says nothing about dropped messages while compaction is keeping up', () => {
    const context = buildConversationContext({ messages: longConversation(2) })

    expect(context.dropped).toBe(0)
    expect(context.text).not.toContain('could not be kept')
  })

  it('counts a backlog the window cannot even show', () => {
    const messages = longConversation(3)

    const context = buildConversationContext({ messages, uncoveredTotal: 500 })

    expect(context.dropped).toBe(500 - context.verbatim.length)
    expect(context.text).toContain('could not be kept')
  })

  it('still shows the last message when that one message is over budget', () => {
    const messages = [message('user', 'x'.repeat(50_000))]

    const context = buildConversationContext({ messages, tailBudget: 100 })

    expect(context.verbatim).toHaveLength(1)
    expect(context.text).toContain('more characters')
  })
})

describe('choosing what to fold into the summary', () => {
  it('leaves a short conversation alone', () => {
    expect(selectCompactionSlice({ messages: longConversation(2) })).toBeNull()
    expect(selectCompactionSlice({ messages: [] })).toBeNull()
    expect(selectCompactionSlice({ messages: [message('user', 'x'.repeat(COMPACT_AFTER_CHARS * 2))] })).toBeNull()
  })

  it('folds the old part and keeps the recent part verbatim', () => {
    const messages = longConversation(40)

    const slice = selectCompactionSlice({ messages })!

    expect(slice).not.toBeNull()
    const kept = messages.slice(slice.messages.length)
    expect(renderTranscript(kept).length).toBeGreaterThanOrEqual(KEEP_VERBATIM_CHARS)
    expect(kept.length).toBeGreaterThan(0)
    expect(slice.throughSeq).toBe(slice.messages.at(-1)!.seq)
  })

  it('partitions the log exactly: nothing summarised twice, nothing skipped', () => {
    const messages = longConversation(40)

    const slice = selectCompactionSlice({ messages })!
    const context = buildConversationContext({
      summary: 'a summary',
      summaryThroughSeq: slice.throughSeq,
      messages
    })

    const seen = [...slice.messages, ...context.verbatim].map(m => m.seq)
    expect(seen).toEqual(messages.map(m => m.seq))
    expect(context.dropped).toBe(0)
  })

  it('ignores what an earlier fold already covered', () => {
    const messages = longConversation(40)
    const first = selectCompactionSlice({ messages })!

    const second = selectCompactionSlice({ messages, summaryThroughSeq: first.throughSeq })

    expect(second).toBeNull()
  })

  it('moves forward when the conversation does', () => {
    const messages = longConversation(40)
    const first = selectCompactionSlice({ messages })!
    const grown = [...messages, ...longConversation(20)]

    const second = selectCompactionSlice({ messages: grown, summaryThroughSeq: first.throughSeq })!

    expect(second.throughSeq).toBeGreaterThan(first.throughSeq)
    expect(second.messages[0]!.seq).toBeGreaterThan(first.throughSeq)
  })

  it('starts the kept tail at something the user said', () => {
    const messages = longConversation(40)

    const slice = selectCompactionSlice({ messages })!

    expect(messages[slice.messages.length]!.role).toBe('user')
  })
})
