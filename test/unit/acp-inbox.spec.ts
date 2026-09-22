import { describe, expect, it } from 'vitest'

import { combineInboxContent, inboxDivider } from '../../server/lib/acp/inbox'
import type { AgentInboxMessage, MessageOrigin } from '~~/shared/types'
import { inboxMessage } from '../helpers/events'

/**
 * What the agent actually reads when the queue drains. The queue is coalesced
 * into one turn, so the only thing keeping two messages apart is this text —
 * and it is the model's only clue that they came from different places.
 */
function said(text: string, origin: MessageOrigin): AgentInboxMessage {
  return inboxMessage({ content: [{ type: 'text', text }], origin })
}

const textOf = (content: any[]) => content.map(block => block.text).join('')

describe('inboxDivider', () => {
  it.each([
    ['user' as const, '[From you]'],
    ['voice' as const, '[From Domo]'],
    // A subscription note is Domo talking too, not the agent it is about.
    ['system' as const, '[From Domo]'],
    ['agent:ag_7f3' as const, '[Message from agent ag_7f3]']
  ])('names %s as %s', (origin, expected) => {
    expect(inboxDivider(origin)).toBe(expected)
  })
})

describe('combineInboxContent', () => {
  /** One message is what it always was: the queue must not rewrite a prompt. */
  it('hands a single message over untouched', () => {
    const only = said('then push it', 'user')

    expect(combineInboxContent([only])).toEqual(only.content)
  })

  it('introduces each message of a batch by where it came from', () => {
    const content = combineInboxContent([
      said('the deploy finished', 'system'),
      said('take a look when you can', 'agent:ag_peer')
    ])

    expect(textOf(content)).toBe(
      '[From Domo]\nthe deploy finished\n[Message from agent ag_peer]\ntake a look when you can'
    )
  })

  it('keeps every block of every message, in order', () => {
    const first = inboxMessage({
      content: [{ type: 'text', text: 'look at this' }, { type: 'resource_link', uri: 'file:///tmp/log' }],
      origin: 'voice'
    })
    const second = said('and this', 'user')

    expect(combineInboxContent([first, second])).toEqual([
      { type: 'text', text: '[From Domo]\n' },
      ...first.content,
      { type: 'text', text: '\n[From you]\n' },
      ...second.content
    ])
  })
})
