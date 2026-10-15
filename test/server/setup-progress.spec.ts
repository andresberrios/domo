import { describe, expect, it } from 'vitest'

import { updateSetup } from '../../server/lib/setup'

describe('the setup guide\'s kept check results', () => {
  // Two clicks on a cold first start: the first check is still waiting when
  // the second answers, and finishes after it. The first is not news.
  it('keep the later-started check when an earlier one finishes after it', async () => {
    const answered = { ok: true, at: '2026-10-15T10:00:30.000Z', summary: 'gpt-5-mini answered in 3.0 s.' }
    const timedOut = { ok: false, at: '2026-10-15T10:00:00.000Z', summary: 'Copilot did not answer within 90 seconds.' }

    await updateSetup({ check: { target: 'copilot', result: answered } })
    const progress = await updateSetup({ check: { target: 'copilot', result: timedOut } })

    expect(progress.checks.copilot).toEqual(answered)
  })

  it('take a newer check over an older one', async () => {
    const before = { ok: false, at: '2026-10-15T10:00:00.000Z', summary: 'Codex could not sign in: 401.' }
    const after = { ok: true, at: '2026-10-15T10:05:00.000Z', summary: 'gpt-5.6-luna answered in 2.1 s.' }

    await updateSetup({ check: { target: 'codex', result: before } })
    const progress = await updateSetup({ check: { target: 'codex', result: after } })

    expect(progress.checks.codex).toEqual(after)
  })
})
