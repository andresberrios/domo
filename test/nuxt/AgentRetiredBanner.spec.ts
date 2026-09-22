import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentRetiredBanner from '~/components/AgentRetiredBanner.vue'
import type { AgentSession, DevEnvironment } from '~~/shared/types'

/**
 * The whole of the read-only story on the agent page.
 *
 * The composer and the Start button are simply gone for a retired session, so
 * without this banner the page would be a transcript that silently could not be
 * added to. Two things are worth pinning: it says *why* the session ended, and
 * it offers the way back only when there is one — and when there is not, it
 * says so instead of leaving a button that would 409.
 */

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'ag_1',
    voiceSessionId: null,
    adapter: 'claude-code',
    acpSessionId: null,
    title: 'Auth refactor',
    cwd: '/workspaces/domo',
    devEnvironmentId: null,
    status: 'stopped',
    modeId: null,
    modes: null,
    model: null,
    config: null,
    configOptions: null,
    lastError: null,
    summary: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    archived: true,
    retiredAt: '2026-01-06T00:00:00.000Z',
    retiredReason: 'user',
    usage: null,
    ...overrides
  }
}

function environment(overrides: Partial<DevEnvironment> = {}): DevEnvironment {
  return {
    id: 'env_1',
    projectId: 'p1',
    name: 'feature-auth',
    containerName: 'domo-dev-env_1',
    containerId: 'abc',
    workspacePath: '/workspaces/domo',
    configSource: 'domo',
    configPath: '.domo.json',
    remoteUser: 'vscode',
    status: 'running',
    lastError: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    deletedAt: null,
    ...overrides
  }
}

const calls: string[] = []
registerEndpoint('/api/agents/ag_1/revive', {
  method: 'POST',
  handler: () => {
    calls.push('revive')
    return { ok: true }
  }
})

function harness(props: { session: AgentSession, environment: DevEnvironment | null }) {
  return defineComponent({
    setup: () => () => h(UApp, null, { default: () => h(AgentRetiredBanner, props) })
  })
}

function buttonWithText(text: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.includes(text))
}

beforeEach(() => {
  calls.length = 0
})

describe('AgentRetiredBanner', () => {
  it('says it is read-only and offers the way back', async () => {
    const wrapper = await mountSuspended(harness({ session: session(), environment: null }), {
      attachTo: document.body
    })

    expect(document.body.textContent).toContain('Retired')
    expect(document.body.textContent).toContain('read-only')
    expect(buttonWithText('Revive')).toBeTruthy()

    wrapper.unmount()
  })

  it('names the environment deletion as the reason, and refuses to offer a revival', async () => {
    const wrapper = await mountSuspended(harness({
      session: session({ devEnvironmentId: 'env_1', retiredReason: 'environment-deleted' }),
      environment: environment({ deletedAt: '2026-01-05T00:00:00.000Z' })
    }), { attachTo: document.body })

    const text = document.body.textContent ?? ''
    expect(text).toContain('feature-auth')
    expect(text).toContain('It cannot be brought back.')
    expect(buttonWithText('Revive')).toBeFalsy()

    wrapper.unmount()
  })

  it('confirms before reviving, and says what does not come back with it', async () => {
    const wrapper = await mountSuspended(harness({ session: session(), environment: null }), {
      attachTo: document.body
    })

    buttonWithText('Revive')!.click()

    // The caveat is the reason this is a confirmation at all: Domo's transcript
    // is safe, the coding agent's own memory of the session may not be.
    await vi.waitFor(() => expect(document.body.textContent).toContain('Revive Auth refactor?'))
    expect(document.body.textContent).toContain('coding agent')
    expect(calls).toEqual([])

    buttonWithText('Revive session')!.click()
    await vi.waitFor(() => expect(calls).toEqual(['revive']))

    wrapper.unmount()
  })
})
