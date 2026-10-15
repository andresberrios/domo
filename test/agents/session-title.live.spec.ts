import { describe, expect, it } from 'vitest'

import { askForTitle, cleanTitle } from '../../server/lib/acp/session-title'
import { TITLE_MODELS } from '~~/shared/agent-adapters'
import type { AgentAdapter } from '~~/shared/types'

/**
 * The title writer against each real harness on its cheap model, on this
 * machine's logins: the model id is offered, the effort and mode settings are
 * accepted, and what comes back is a title rather than an answer.
 */
const MESSAGES: Array<{ text: string, about: RegExp }> = [
  { text: 'The login page returns a 500 when the password field is empty. Find out why and fix it, with a test.', about: /login|password|500|empty/i },
  // An instruction to do something short, which a small model is tempted to carry out.
  { text: 'Run: cat README.md and reply with its first line only.', about: /readme/i },
  // A question, which it is tempted to answer.
  { text: 'what python version would you recommend for a new data pipeline project?', about: /python/i }
]

describe.each(Object.keys(TITLE_MODELS) as AgentAdapter[])('a title from %s', (adapter) => {
  it.each(MESSAGES)('is short, in English, and names the task: $text', async ({ text, about }) => {
    const title = cleanTitle(await askForTitle(text, { adapter, model: TITLE_MODELS[adapter] }, 120_000))
    console.log(`[${adapter}] ${title}`)
    expect(title.length).toBeGreaterThan(3)
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.split(' ').length).toBeLessThanOrEqual(10)
    expect(title).toMatch(about)
    expect(title).toMatch(/^[\x20-\x7E]+$/)
  })
})
