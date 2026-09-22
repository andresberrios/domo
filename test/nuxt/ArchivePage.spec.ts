import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { computed, defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ArchivePage from '~/pages/archive.vue'
import type { AgentSession, DevEnvironment, Project } from '~~/shared/types'

/**
 * The only place either kind of put-away session is findable again.
 *
 * The two lists are the point: **archived** is a shelf and comes back with one
 * click, **retired** is a tombstone that is read-only and may not come back at
 * all. Conflating them is the mistake this page exists to prevent, so what is
 * asserted here is that each session lands in the right list and that Revive is
 * offered exactly when `shared/retention.ts` says the server would allow it.
 */

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 'ag_base',
    voiceSessionId: null,
    adapter: 'claude-code',
    acpSessionId: null,
    title: 'Session',
    cwd: '/work/domo',
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
    archived: false,
    retiredAt: null,
    retiredReason: null,
    usage: null,
    ...overrides
  }
}

const project: Project = {
  id: 'p1',
  name: 'Domo',
  repoPath: '/work/domo',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null
}

function environment(overrides: Partial<DevEnvironment>): DevEnvironment {
  return {
    id: 'env_live',
    projectId: 'p1',
    name: 'feature-auth',
    containerName: 'domo-dev-env_live',
    containerId: 'abc123',
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

const environments = [
  environment({}),
  environment({ id: 'env_gone', name: 'spike', deletedAt: '2026-01-05T00:00:00.000Z' })
]

const shelved = session({ id: 'ag_shelved', title: 'Shelved work', archived: true })

/** Retired by hand while its environment is alive: it can come back. */
const revivable = session({
  id: 'ag_revivable',
  title: 'Finished work',
  archived: true,
  devEnvironmentId: 'env_live',
  retiredAt: '2026-01-06T00:00:00.000Z',
  retiredReason: 'user'
})

/** Retired *by* the environment deletion: the container and checkout are gone. */
const stranded = session({
  id: 'ag_stranded',
  title: 'Stranded work',
  archived: true,
  devEnvironmentId: 'env_gone',
  retiredAt: '2026-01-05T00:00:00.000Z',
  retiredReason: 'environment-deleted'
})

const all = ref<AgentSession[]>([shelved, revivable, stranded, session({ id: 'ag_live', title: 'Live work' })])

mockNuxtImport('useArchivedAgentSessions', () => () => ({
  archived: computed(() => all.value.filter(item => item.archived && !item.retiredAt)),
  retired: computed(() => all.value.filter(item => !!item.retiredAt)),
  isReady: ref(true)
}))
mockNuxtImport('useDevEnvironments', () => () => ({
  environments: computed(() => environments.filter(item => !item.deletedAt)),
  all: computed(() => environments),
  isReady: ref(true)
}))
mockNuxtImport('useProjects', () => () => ({
  projects: computed(() => [project]),
  all: computed(() => [project]),
  isReady: ref(true)
}))

const calls: Array<{ method: string, path: string, body?: unknown }> = []

function record(path: string, method: string) {
  return async (event: any) => {
    const body = method === 'DELETE' ? undefined : await readBody(event).catch(() => undefined)
    calls.push({ method, path, body })
    return { ok: true }
  }
}

registerEndpoint('/api/agents/ag_shelved', { method: 'PATCH', handler: record('/api/agents/ag_shelved', 'PATCH') })
registerEndpoint('/api/agents/ag_revivable/revive', {
  method: 'POST',
  handler: record('/api/agents/ag_revivable/revive', 'POST')
})

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(ArchivePage) })
})

function buttonWithText(text: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.includes(text))
}

beforeEach(() => {
  calls.length = 0
})

describe('the archive', () => {
  it('separates the shelf from the tombstones, and leaves live sessions out of both', async () => {
    const wrapper = await mountSuspended(Harness, { attachTo: document.body })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Shelved work')
    expect(text).toContain('Finished work')
    expect(text).toContain('Stranded work')
    expect(text).not.toContain('Live work')

    // Why each one ended, not just that it did.
    expect(text).toContain('environment deleted')
    // The environment it ran in is named, and marked as a tombstone itself.
    expect(text).toContain('spike (deleted)')

    wrapper.unmount()
  })

  it('unarchives through the same PATCH the rest of the app uses', async () => {
    const wrapper = await mountSuspended(Harness, { attachTo: document.body })

    buttonWithText('Unarchive')!.click()

    await vi.waitFor(() => expect(calls).toContainEqual({
      method: 'PATCH',
      path: '/api/agents/ag_shelved',
      body: { archived: false }
    }))

    wrapper.unmount()
  })

  it('offers Revive only where the server would allow it', async () => {
    const wrapper = await mountSuspended(Harness, { attachTo: document.body })

    const revive = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .filter(element => element.textContent?.includes('Revive'))

    // One per retired session, but the stranded one is disabled: its
    // environment was deleted, so `POST /revive` would refuse it. The UI must
    // never offer an action the server rejects.
    expect(revive).toHaveLength(2)
    expect(revive.filter(button => button.disabled)).toHaveLength(1)

    revive.find(button => !button.disabled)!.click()
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/agents/ag_revivable/revive' })
    ))

    wrapper.unmount()
  })
})
