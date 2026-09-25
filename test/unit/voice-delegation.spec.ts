import { describe, expect, it } from 'vitest'

import { buildDelegationRequest } from '../../server/lib/voice/delegation'

/**
 * What a coding agent is actually asked when the live model delegates.
 *
 * The protocol's own rule is that `session.delegation.created` carries no task
 * text — an id, a target and a position on the timeline, and nothing about
 * what the user wanted. So this request *is* the delegation as far as the
 * agent is concerned, and it has to carry the conversation with it. Pure, so
 * that can be read rather than inferred from a socket.
 */

const CONTEXT = [
  'This conversation is already under way. Carry on from where it left off.',
  '',
  'The most recent messages, oldest first:',
  'user: how is the invoice branch going'
].join('\n')

describe('the request a delegation becomes', () => {
  it('carries the backend prompt, then the conversation', () => {
    const request = buildDelegationRequest({ conversationContext: CONTEXT, delegationId: 'item_1' })

    expect(request).toContain('You are the reasoning backend for a live voice conversation')
    expect(request).toContain('how is the invoice branch going')
    // The prompt comes first: what the agent is *for* has to be read before
    // the transcript it is reading, or a transcript line reads as the task.
    expect(request.indexOf('reasoning backend')).toBeLessThan(request.indexOf('invoice branch'))
  })

  it('says the answer is going to be spoken, in the terms that matter out loud', () => {
    const request = buildDelegationRequest({ conversationContext: CONTEXT, delegationId: 'item_1' })

    expect(request).toContain('read out loud')
    expect(request).toContain('no code')
    expect(request).toContain('transcripts')
  })

  it('points at the end of the transcript when the live model delegated', () => {
    const request = buildDelegationRequest({ conversationContext: CONTEXT, delegationId: 'item_1' })

    expect(request).toContain('latest request, at the end of the')
  })

  it('quotes typed input verbatim instead, because that is the exact text', () => {
    const request = buildDelegationRequest({
      conversationContext: CONTEXT,
      delegationId: null,
      typed: 'the branch is fix/invoices-2'
    })

    // A spoken transcript can mishear an identifier; something typed cannot,
    // so it is handed over as-is rather than left to be found in the tail.
    expect(request).toContain('typed this, verbatim: the branch is fix/invoices-2')
    expect(request).not.toContain('latest request, at the end of the')
  })

  it('says so plainly when there is no transcript yet', () => {
    const request = buildDelegationRequest({ conversationContext: '', delegationId: 'item_1' })

    expect(request).toContain('only just started and there is no transcript yet')
  })
})
