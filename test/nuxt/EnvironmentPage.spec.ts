import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { computed, defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import EnvironmentPage from '~/pages/environments/[id].vue'
import type { AgentSession, DevEnvironment, Project } from '~~/shared/types'

/**
 * The page the sidebar's environment rows link to. There was no page for one
 * environment before — the projects page rendered cards — so this covers both
 * the facts it states and the actions it offers.
 */

const project: Project = {
  id: 'p1',
  name: 'Domo',
  repoPath: '/work/domo',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
}

const environment = ref<DevEnvironment>({
  id: 'env_1',
  projectId: 'p1',
  name: 'feature-auth',
  containerName: 'domo-dev-env_1',
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
})

const agent: AgentSession = {
  id: 'ag_1',
  voiceSessionId: null,
  adapter: 'claude-code',
  acpSessionId: 'acp_1',
  title: 'Auth refactor',
  cwd: '/workspaces/domo',
  devEnvironmentId: 'env_1',
  status: 'thinking',
  modeId: null,
  modes: null,
  model: null,
  config: null,
  configOptions: null,
  lastError: null,
  summary: null,
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  lastActivityAt: null,
  usage: null,
  archived: false,
  retiredAt: null,
  retiredReason: null,
}

mockNuxtImport('useRoute', () => () => ({ params: { id: 'env_1' } }))
// `all` carries the tombstones. This page reads it rather than the live list:
// a deleted environment is what a retired session's badge links to, and the
// page has to render it instead of claiming the environment never existed.
mockNuxtImport('useProjects', () => () => ({
  projects: computed(() => [project]),
  all: computed(() => [project]),
  isReady: ref(true)
}))
mockNuxtImport('useDevEnvironments', () => () => ({
  environments: computed(() => [environment.value].filter(item => !item.deletedAt)),
  all: computed(() => [environment.value]),
  isReady: ref(true)
}))
mockNuxtImport('useAgentSessions', () => () => ({
  sessions: computed(() => [agent].filter(item => !item.archived)),
  all: computed(() => [agent]),
  isReady: ref(true)
}))
mockNuxtImport('usePermissions', () => () => ({
  permissions: computed(() => []),
  pending: computed(() => []),
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

registerEndpoint('/api/settings', () => ({ defaultCwd: '/work', defaultAgentModes: { 'claude-code': 'plan' } }))
registerEndpoint('/api/adapters/models', () => ({ models: [], current: null, modes: [], currentMode: null }))
registerEndpoint('/api/dev-environments/env_1/ports', () => [])
registerEndpoint('/api/dev-environments/env_1/stop', { method: 'POST', handler: record('/api/dev-environments/env_1/stop', 'POST') })
registerEndpoint('/api/dev-environments/env_1/start', { method: 'POST', handler: record('/api/dev-environments/env_1/start', 'POST') })
registerEndpoint('/api/dev-environments/env_1', { method: 'PATCH', handler: record('/api/dev-environments/env_1', 'PATCH') })
registerEndpoint('/api/dev-environments/env_1', { method: 'DELETE', handler: record('/api/dev-environments/env_1', 'DELETE') })

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(EnvironmentPage) })
})

async function mountPage() {
  return await mountSuspended(Harness, { attachTo: document.body })
}

function buttonWithText(text: string, root: ParentNode = document.body) {
  return [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.includes(text))
}

beforeEach(() => {
  calls.length = 0
  document.body.innerHTML = ''
  environment.value = { ...environment.value, status: 'running' }
})

describe('environment details page', { timeout: 30_000 }, () => {
  it('states the environment’s facts', async () => {
    const wrapper = await mountPage()

    const text = document.body.textContent ?? ''
    expect(text).toContain('feature-auth')
    expect(text).toContain('/workspaces/domo')
    expect(text).toContain('domo-dev-env_1')
    expect(text).toContain('.domo.json')
    expect(text).toContain('Running')
    // The project it belongs to, as a link back to its own page.
    expect(document.body.querySelector('a[href="/projects/p1"]')?.textContent).toContain('Domo')

    wrapper.unmount()
  })

  it('lists the agents running inside it, each linking to its transcript', async () => {
    const wrapper = await mountPage()

    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/agents/ag_1"]')
    expect(link?.textContent).toContain('Auth refactor')

    wrapper.unmount()
  })

  it('stops a running environment and starts a stopped one, through their own endpoints', async () => {
    const running = await mountPage()
    buttonWithText('Stop')!.click()
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/dev-environments/env_1/stop' })
    ))
    running.unmount()

    document.body.innerHTML = ''
    environment.value = { ...environment.value, status: 'stopped' }

    const stopped = await mountPage()
    buttonWithText('Start')!.click()
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/dev-environments/env_1/start' })
    ))
    stopped.unmount()
  })

  it('offers VS Code only while the container is running, and as a vscode:// link', async () => {
    const running = await mountPage()
    const link = [...document.body.querySelectorAll<HTMLAnchorElement>('a')]
      .find(element => element.textContent?.includes('Open in VS Code'))
    expect(link?.getAttribute('href')).toMatch(/^vscode:\/\/vscode-remote\/attached-container\+/)
    running.unmount()

    document.body.innerHTML = ''
    environment.value = { ...environment.value, status: 'stopped' }

    const stopped = await mountPage()
    // Stopped: the control is still there, but it is no longer a link.
    expect([...document.body.querySelectorAll<HTMLAnchorElement>('a')]
      .find(element => element.textContent?.includes('Open in VS Code'))).toBeUndefined()
    expect(document.body.textContent).toContain('Open in VS Code')
    stopped.unmount()
  })

  it('deletes only after a confirmation that names what goes with it', async () => {
    const wrapper = await mountPage()

    const menu = document.body.querySelector<HTMLButtonElement>('button[aria-label="Environment actions"]')!
    menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    menu.click()

    const entry = await vi.waitFor(() => {
      const found = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find(element => element.textContent?.includes('Delete'))
      expect(found).toBeTruthy()
      return found!
    })
    entry.click()

    await vi.waitFor(() => expect(document.body.textContent).toContain('Delete feature-auth?'))
    // The cascade is named, and named honestly: the container goes, the
    // session does not — it is retired, and its transcript stays readable.
    expect(document.body.textContent).toContain('The 1 coding agent session')
    expect(document.body.textContent).toContain('retired')
    expect(calls).toHaveLength(0)

    buttonWithText('Delete environment')!.click()
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/api/dev-environments/env_1' })
    ))

    wrapper.unmount()
  })

  it('renders a deleted environment as a tombstone rather than as missing', async () => {
    // The row outlives the container so a retired session can still say where
    // it ran, and this page is where its badge links. It must not offer to
    // start, stop or open anything that no longer exists.
    environment.value = { ...environment.value, deletedAt: '2026-01-09T00:00:00.000Z' }
    const wrapper = await mountSuspended(defineComponent({
      setup: () => () => h(UApp, null, { default: () => h(EnvironmentPage) })
    }), { attachTo: document.body })

    await vi.waitFor(() => expect(document.body.textContent).toContain('Deleted'))
    expect(document.body.textContent).toContain('the sessions that ran here are retired')
    expect(document.body.textContent).not.toContain('This environment no longer exists.')
    expect(buttonWithText('Stop')).toBeFalsy()
    expect(buttonWithText('New agent')).toBeFalsy()

    environment.value = { ...environment.value, deletedAt: null }
    wrapper.unmount()
  })

  it('says so rather than rendering a blank page when the environment is gone', async () => {
    const wrapper = await mountSuspended(defineComponent({
      setup: () => () => h(UApp, null, { default: () => h(EnvironmentPage) })
    }), { attachTo: document.body })

    environment.value = { ...environment.value, id: 'env_other' }
    await vi.waitFor(() => expect(document.body.textContent).toContain('This environment no longer exists.'))

    environment.value = { ...environment.value, id: 'env_1' }
    wrapper.unmount()
  })
})
