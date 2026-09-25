import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright-core'

import { launchBrowser, openPage } from '../helpers/browser'
import { spokenWav } from '../helpers/speech'
import { VOICE_SERVER_ORIGIN } from './origin'
import type { VoiceMessage, VoiceSession } from '~~/shared/types'

/**
 * The voice agent, end to end, with nothing faked: a real Chromium whose
 * microphone is a WAV file, the real Nuxt app, a real Nitro server, real
 * Postgres, a real ElectricSQL, and a real GPT-Live session on a real OpenAI
 * account.
 *
 * Every other layer stops short of one of those, and the gaps are not
 * academic. `test/unit` drives the runtime with `ws` replaced by a recorder,
 * which pins what Domo *sends* and can say nothing about whether OpenAI agrees
 * — the delegated tool call that was silently dropped passed that layer for
 * exactly this reason. `test/nuxt` mounts components in happy-dom, which has
 * no `AudioContext` and no `AudioWorklet`, so the microphone path has never
 * been executed anywhere else at all.
 *
 * **This costs money and needs a key**, so it can never join `pnpm test` —
 * same rule and same shape as `agents-live`. Opt in with `pnpm test:voice`.
 *
 * Everything is driven through the real HTTP API rather than by importing
 * `repo.ts`: the server owns the database connection here, and going through
 * the API is both closer to what a user does and immune to which database
 * this process happens to have configured.
 *
 * Assertions are on **shape, never on wording**. A live model may answer
 * "nothing is running" or "you have no agents right now", and a test that
 * pinned either would fail for being right.
 */

/** A live turn is hear → think → delegate → speak. None of it is fast. */
const TURN_MS = 90_000

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, VOICE_SERVER_ORIGIN), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  })
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}

const browsers: Browser[] = []

beforeAll(async () => {
  // The provider is an install-wide setting the server reads at every connect,
  // so this is all it takes to put the whole app on GPT-Live.
  await api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      voiceProvider: 'openai',
      openaiDelegation: {
        target: 'responses',
        responsesModel: process.env.NUXT_OPENAI_TEST_BACKEND || 'gpt-6-sol',
        // Lowest that still reasons: this layer pays per token, and what is
        // under test is the wiring, not the depth of the thinking.
        reasoningEffort: 'low',
        agentSessionId: '',
        agentAdapter: 'claude-code',
        agentDevEnvironmentId: ''
      }
    })
  })
}, 60_000)

afterAll(async () => {
  await Promise.all(browsers.map(browser => browser.close().catch(() => {})))
})

/**
 * A fresh conversation, open in a browser whose microphone is already saying
 * `question`. One browser per question — see `launchBrowser` for why.
 */
async function ask(question: string): Promise<{ page: Page, sessionId: string }> {
  const browser = await launchBrowser(await spokenWav(question))
  browsers.push(browser)
  const session = await api<VoiceSession>('/api/voice-sessions', { method: 'POST', body: '{}' })
  const page = await openPage(browser, `${VOICE_SERVER_ORIGIN}/voice/${session.id}`)
  return { page, sessionId: session.id }
}

/** Turn the microphone on, the way a user does. */
async function startTalking(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start talking' }).first().click({ timeout: 30_000 })
}

/**
 * Say the question once, then stop talking — and the second half is not
 * politeness, it is the only way this test can pass.
 *
 * Chromium loops the audio file for as long as the microphone is open, so a
 * test that just starts the mic is a user who never draws breath. GPT-Live
 * marks no end of turn (see `TRANSCRIPT_IDLE_MS`), Domo's idle timer is reset
 * by every arriving delta, and nothing is ever committed: the live transcript
 * fills the screen while `voice_messages` stays empty and the model never gets
 * a gap to answer into. So: wait until the words have actually been heard,
 * then close the microphone and let the silence do its job.
 */
async function sayItOnce(page: Page, heard: RegExp): Promise<void> {
  await startTalking(page)
  await expect
    .poll(() => page.locator('body').innerText(), { timeout: TURN_MS })
    .toMatch(heard)
  await page.getByRole('button', { name: 'Stop the microphone' }).first().click({ timeout: 30_000 })
}

const messages = (id: string) => api<VoiceMessage[]>(`/api/voice-sessions/${id}/messages`)

describe('a real conversation in a real browser', () => {
  it('hears the microphone, answers out loud, and stores both sides', async () => {
    const { page, sessionId } = await ask('Hello there. Can you hear me?')

    // The user's own words, captured by an AudioWorklet, resampled on the
    // server, transcribed by the model and streamed back into the live
    // transcript. Nothing below a browser can produce this.
    await sayItOnce(page, /hear me/i)

    // And it answered out loud: the assistant transcript only exists because
    // decoded PCM and its transcript arrived back down the same socket.
    await expect
      .poll(async () => (await messages(sessionId)).some(m => m.role === 'assistant'), { timeout: TURN_MS })
      .toBe(true)
  }, TURN_MS * 2)

  it('delegates to the backend model, runs a real Domo tool, and carries on', async () => {
    // A question the live model cannot answer from its prompt: it holds no
    // tools, so the only route is a delegation to the Responses backend, which
    // calls one of Domo's own tools and hands the result back.
    const { page, sessionId } = await ask('How many coding agents are running right now?')

    await sayItOnce(page, /coding agents/i)

    // The tool really ran, server-side, against the real database: the runtime
    // writes one `tool` row per call, named.
    await expect
      .poll(
        async () => (await messages(sessionId)).filter(m => m.role === 'tool').map(m => m.toolName),
        { timeout: TURN_MS }
      )
      .toContain('list_agent_sessions')

    // …and the conversation continued afterwards, which is the half that was
    // broken: the calls were collected and dropped, so the backend waited
    // forever on results that never came and the user heard nothing.
    await expect
      .poll(async () => (await messages(sessionId)).some(m => m.role === 'assistant'), { timeout: TURN_MS })
      .toBe(true)
  }, TURN_MS * 2)

  it('records the occupancy ratio GPT-Live reports, and no token count', async () => {
    const { page, sessionId } = await ask('Just say OK.')

    await sayItOnce(page, /OK/i)

    // This provider reports a ratio and its billing in audio seconds, and
    // never a token count — `used` staying zero is the contract, not a gap.
    await expect
      .poll(
        async () => (await api<VoiceSession>(`/api/voice-sessions/${sessionId}`)).usage,
        { timeout: TURN_MS }
      )
      .toMatchObject({ context: { used: 0, size: null } })
  }, TURN_MS * 2)
})
