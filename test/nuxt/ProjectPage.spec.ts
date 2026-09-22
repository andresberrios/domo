import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { computed, defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ProjectPage from '~/pages/projects/[id].vue'
import type { AgentSession, DevEnvironment, Project } from '~~/shared/types'

/**
 * The page that replaced `app/pages/projects.vue`: one project rather than all
 * of them, reached from the sidebar row's name.
 */

const project = ref<Project>({
  id: 'p1',
  name: 'Domo',
  repoPath: '/work/domo',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  retiredAt: null,
})

const environment: DevEnvironment = {
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
  retiredAt: null,
}

/** One agent inside the environment, one directly in the host checkout. */
const agents: AgentSession[] = [
  {
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
  },
  {
    id: 'ag_local',
    voiceSessionId: null,
    adapter: 'codex',
    acpSessionId: null,
    title: 'Docs sweep',
    cwd: '/work/domo/docs',
    devEnvironmentId: null,
    status: 'idle',
    modeId: null,
    modes: null,
    model: null,
    config: null,
    configOptions: null,
    lastError: null,
    summary: null,
    createdAt: '2026-01-04T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
    lastActivityAt: null,
    usage: null,
    archived: false,
  }
]

mockNuxtImport('useRoute', () => () => ({ params: { id: 'p1' } }))
mockNuxtImport('useProjects', () => () => ({ projects: computed(() => [project.value]), isReady: ref(true) }))
mockNuxtImport('useDevEnvironments', () => () => ({ environments: computed(() => [environment]), isReady: ref(true) }))
mockNuxtImport('useAgentSessions', () => () => ({ sessions: computed(() => agents), isReady: ref(true) }))
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
registerEndpoint('/api/projects/p1', { method: 'PATCH', handler: record('/api/projects/p1', 'PATCH') })
registerEndpoint('/api/projects/p1', { method: 'DELETE', handler: record('/api/projects/p1', 'DELETE') })
registerEndpoint('/api/dev-environments', { method: 'POST', handler: record('/api/dev-environments', 'POST') })

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(ProjectPage) })
})

async function mountPage() {
  return await mountSuspended(Harness, { attachTo: document.body })
}

function buttonWithText(text: string, root: ParentNode = document.body) {
  return [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.includes(text))
}

async function openActions() {
  const menu = document.body.querySelector<HTMLButtonElement>('button[aria-label="Project actions"]')!
  menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  menu.click()
  return await vi.waitFor(() => {
    const found = document.body.querySelector<HTMLElement>('[role="menu"]')
    expect(found).toBeTruthy()
    return found!
  })
}

beforeEach(() => {
  calls.length = 0
  document.body.innerHTML = ''
  project.value = { ...project.value, name: 'Domo' }
})

describe('project details page', { timeout: 30_000 }, () => {
  it('states the project’s name, repository and config source', async () => {
    const wrapper = await mountPage()

    const text = document.body.textContent ?? ''
    expect(text).toContain('Domo')
    expect(text).toContain('/work/domo')
    expect(text).toContain('The project’s own .domo.json')

    wrapper.unmount()
  })

  it('lists its environments, each linking to its own page', async () => {
    const wrapper = await mountPage()

    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/environments/env_1"]')
    expect(link?.textContent).toContain('feature-auth')
    // The count beside it is the agents inside that environment, not all of them.
    expect(link?.textContent).toContain('1 agent')

    wrapper.unmount()
  })

  it('separates agents running in the local checkout from those in an environment', async () => {
    const wrapper = await mountPage()

    // `ag_local`'s cwd sits under the repo path, so it is attributed here.
    expect(document.body.querySelector('a[href="/agents/ag_local"]')?.textContent).toContain('Docs sweep')
    // The environment's own agent belongs on the environment page, not this list.
    expect(document.body.querySelector('a[href="/agents/ag_1"]')).toBeNull()

    wrapper.unmount()
  })

  it('creates an environment for this project from the page', async () => {
    const wrapper = await mountPage()

    buttonWithText('New environment')!.click()
    const input = await vi.waitFor(() => {
      const found = document.body.querySelector<HTMLInputElement>('input[placeholder="feature-auth"]')
      expect(found).toBeTruthy()
      return found!
    })

    input.value = 'feature-billing'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // The submit is disabled until the typed name has re-rendered into it.
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const create = await vi.waitFor(() => {
      const button = buttonWithText('Create environment', dialog)
      expect(button?.disabled).toBe(false)
      return button!
    })
    create.click()

    // `discard` unless the switch was turned on: the host's uncommitted work must
    // not ride along invisibly inside whatever branch comes back out.
    await vi.waitFor(() => expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/dev-environments',
      body: { projectId: 'p1', name: 'feature-billing', workingTree: 'discard' }
    }))

    wrapper.unmount()
  })

  it('renames the project through PATCH', async () => {
    const wrapper = await mountPage()

    const menu = await openActions()
    const entry = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(element => element.textContent?.includes('Rename'))!
    entry.click()

    const input = await vi.waitFor(() => {
      const found = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')
      expect(found).toBeTruthy()
      return found!
    })
    input.value = 'Domo UI'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    buttonWithText('Rename', dialog)!.click()

    await vi.waitFor(() => expect(calls).toContainEqual({
      method: 'PATCH',
      path: '/api/projects/p1',
      body: { name: 'Domo UI' }
    }))

    wrapper.unmount()
  })

  it('spells out the cascade before it retires anything', async () => {
    const wrapper = await mountPage()

    const menu = await openActions()
    const entry = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(element => element.textContent?.includes('Retire'))!
    entry.click()

    await vi.waitFor(() => expect(document.body.textContent).toContain('Retire Domo?'))
    const text = document.body.textContent ?? ''
    expect(text).toContain('1 development environment')
    expect(text).toContain('1 coding agent session')
    expect(text).toContain('/work/domo')
    // What goes and what stays, both named: the containers are destroyed and
    // the transcripts are not.
    expect(text).toContain('records are kept')
    expect(calls).toHaveLength(0)

    buttonWithText('Retire project')!.click()
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/api/projects/p1' })
    ))

    wrapper.unmount()
  })
})
