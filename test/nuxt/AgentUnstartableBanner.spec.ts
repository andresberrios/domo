import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'

import AgentUnstartableBanner from '~/components/AgentUnstartableBanner.vue'
import { sessionStartability } from '~~/shared/retention'
import type { AgentSession, DevEnvironment } from '~~/shared/types'

/**
 * The one thing on the agent page that explains a session which cannot run.
 *
 * Retiring an environment does not archive the sessions inside it — they stay
 * on the list and their transcripts stay readable — so the page still renders,
 * and without this it would be a transcript above a composer that only ever
 * errored. The reason shown is the same string the server refuses with, which
 * is what this pins: the pure rule feeds both, so the two cannot drift.
 */

const session = {
  id: 'ag_1',
  title: 'Auth refactor',
  cwd: '/workspaces/domo',
  devEnvironmentId: 'env_1'
} as AgentSession

const retired = {
  name: 'feature-auth',
  retiredAt: '2026-01-05T00:00:00.000Z'
} as DevEnvironment

function harness(reason: string) {
  return defineComponent({
    setup: () => () => h(UApp, null, {
      default: () => h(AgentUnstartableBanner, { session, reason })
    })
  })
}

describe('AgentUnstartableBanner', () => {
  it('shows the reason the server would give, verbatim', async () => {
    const state = sessionStartability(session, retired)
    expect(state.startable).toBe(false)

    const wrapper = await mountSuspended(harness(state.startable ? '' : state.reason), {
      attachTo: document.body
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('This session can no longer run')
    expect(text).toContain('feature-auth')
    // What survives is said out loud: the alternative is a user assuming the
    // transcript went with the container.
    expect(text).toContain('kept and stays readable')

    wrapper.unmount()
  })
})
