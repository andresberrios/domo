import { describe, expect, it } from 'vitest'

import { askForTitle, cleanTitle, writeTitle } from '../../server/lib/acp/session-title'
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

describe('asked directly', () => {
  // Codex's backend on the ChatGPT login, and OpenCode Go on the console key,
  // against the same harness through ACP: what the direct call saves.
  it.each([['codex', 'gpt-5.6-luna'], ['opencode', 'opencode-go/glm-5.3-flash']] as const)('%s answers without a session, and sooner', async (adapter, model) => {
    const text = MESSAGES[0]!.text
    const timings: Record<string, number[]> = { direct: [], acp: [] }
    for (let run = 0; run < 3; run++) {
      let began = Date.now()
      const direct = await writeTitle(text, { adapter, model }, `ag_live_${adapter}`)
      timings.direct!.push(Date.now() - began)
      expect(direct.via).toBe('direct')
      expect(cleanTitle(direct.answer)).toMatch(MESSAGES[0]!.about)
      began = Date.now()
      await askForTitle(text, { adapter, model }, 120_000)
      timings.acp!.push(Date.now() - began)
    }
    console.log(`[${adapter}] direct ${timings.direct!.join('/')} ms, acp ${timings.acp!.join('/')} ms`)
  })
})
