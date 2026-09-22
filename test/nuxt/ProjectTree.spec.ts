import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { computed, defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ProjectTree from '~/components/ProjectTree.vue'
import type { AgentSession, DevEnvironment, Project, VoiceSession } from '~~/shared/types'

/**
 * The sidebar is the management surface now, so this is where "does the menu
 * actually call the endpoint" is answered. Everything Electric-backed is
 * stubbed; every action goes to a registered endpoint and is asserted on.
 */

const project: Project = {
  id: 'p1',
  name: 'Domo',
  repoPath: '/work/domo',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

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
  updatedAt: '2026-01-02T00:00:00.000Z'
}

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
  lastError: null,
  summary: null,
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  lastActivityAt: null,
  archived: false
}

const conversation: VoiceSession = {
  id: 'vs_1',
  title: 'Morning standup',
  titleSource: 'auto',
  status: 'idle',
  model: 'models/gemini-live',
  voice: 'Puck',
  createdAt: '2026-01-04T00:00:00.000Z',
  updatedAt: '2026-01-04T00:00:00.000Z',
  lastActivityAt: null,
  archived: false
}

mockNuxtImport('useProjects', () => () => ({ projects: computed(() => [project]), isReady: ref(true) }))
mockNuxtImport('useDevEnvironments', () => () => ({ environments: computed(() => [environment]), isReady: ref(true) }))
mockNuxtImport('useAgentSessions', () => () => ({ sessions: computed(() => [agent]), isReady: ref(true) }))
mockNuxtImport('useVoiceSessions', () => () => ({ sessions: computed(() => [conversation]), isReady: ref(true) }))
mockNuxtImport('usePermissions', () => () => ({
  permissions: computed(() => []),
  pending: computed(() => []),
  isReady: ref(true)
}))

/** Every request the tree's actions make, in order. */
const calls: Array<{ method: string, path: string, body?: unknown }> = []

function record(path: string, method: string) {
  return async (event: any) => {
    const body = method === 'DELETE' ? undefined : await readBody(event).catch(() => undefined)
    calls.push({ method, path, body })
    return { ok: true }
  }
}

registerEndpoint('/api/settings', () => ({ defaultCwd: '/work', defaultAgentModes: { 'claude-code': 'plan' } }))
registerEndpoint('/api/adapters/models', () => ({
  models: [{ id: 'sonnet', name: 'Sonnet 5' }],
  current: 'sonnet',
  modes: [{ id: 'plan', name: 'Plan', description: null }],
  currentMode: 'plan'
}))

registerEndpoint('/api/projects/p1', { method: 'PATCH', handler: record('/api/projects/p1', 'PATCH') })
registerEndpoint('/api/projects/p1', { method: 'DELETE', handler: record('/api/projects/p1', 'DELETE') })
registerEndpoint('/api/dev-environments/env_1', { method: 'PATCH', handler: record('/api/dev-environments/env_1', 'PATCH') })
registerEndpoint('/api/dev-environments/env_1', { method: 'DELETE', handler: record('/api/dev-environments/env_1', 'DELETE') })
registerEndpoint('/api/dev-environments/env_1/stop', { method: 'POST', handler: record('/api/dev-environments/env_1/stop', 'POST') })
registerEndpoint('/api/dev-environments/env_1/start', { method: 'POST', handler: record('/api/dev-environments/env_1/start', 'POST') })
registerEndpoint('/api/agents/ag_1', { method: 'PATCH', handler: record('/api/agents/ag_1', 'PATCH') })
registerEndpoint('/api/agents/ag_1/cancel', { method: 'POST', handler: record('/api/agents/ag_1/cancel', 'POST') })
registerEndpoint('/api/voice-sessions/vs_1', { method: 'PATCH', handler: record('/api/voice-sessions/vs_1', 'PATCH') })

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(ProjectTree) })
})

async function mountTree() {
  return await mountSuspended(Harness, { attachTo: document.body })
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.getAttribute('aria-label') === label)
}

/** Reka's dropdown opens on `pointerdown`, not on a bare click. */
async function openMenu(label: string): Promise<HTMLElement> {
  const trigger = buttonLabelled(label)
  expect(trigger, `a trigger labelled "${label}"`).toBeTruthy()
  trigger!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  trigger!.click()
  return await vi.waitFor(() => {
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')
    expect(menu, 'the menu opens').toBeTruthy()
    return menu!
  })
}

async function choose(menuLabel: string, item: string) {
  const menu = await openMenu(menuLabel)
  const entry = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent?.includes(item))
  expect(entry, `a "${item}" item in the ${menuLabel} menu`).toBeTruthy()
  entry!.click()
}

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
  document.body.innerHTML = ''
})

/*
 * Mounting the whole tree — every row, and the four modals each row owns — is
 * heavy in a real Nuxt runtime, and each test does it again. Under the full
 * suite's parallel load that overran Vitest's 5 s default and failed as a
 * timeout rather than an assertion.
 */
describe('ProjectTree', { timeout: 30_000 }, () => {
  it('links a row to its page and leaves the chevron to toggle', async () => {
    const wrapper = await mountTree()

    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/environments/env_1"]')
    expect(link, 'the environment name is a link to its page').toBeTruthy()
    expect(link!.textContent).toContain('feature-auth')

    expect(document.body.querySelector('a[href="/projects/p1"]')?.textContent).toContain('Domo')

    wrapper.unmount()
  })

  it('never puts a button inside a link', async () => {
    const wrapper = await mountTree()

    // A button inside an anchor is invalid HTML and swallows the navigation.
    expect(document.body.querySelectorAll('a button')).toHaveLength(0)

    wrapper.unmount()
  })

  it('collapses the agents under an environment without navigating', async () => {
    const wrapper = await mountTree()

    const chevron = buttonLabelled('Collapse feature-auth')
    expect(chevron?.getAttribute('aria-expanded')).toBe('true')

    const list = document.body.querySelector<HTMLAnchorElement>('a[href="/agents/ag_1"]')!.closest('ul')!
    expect(list.style.display).not.toBe('none')

    chevron!.click()
    await vi.waitFor(() => expect(list.style.display).toBe('none'))

    expect(buttonLabelled('Expand feature-auth')?.getAttribute('aria-expanded')).toBe('false')
    // The toggle is not a link, so nothing was navigated.
    expect(chevron!.closest('a')).toBeNull()

    wrapper.unmount()
  })

  it('remembers what was collapsed across a reload', async () => {
    const first = await mountTree()
    buttonLabelled('Collapse Domo')!.click()
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('domo.sidebar.collapsed')!)).toContain('p1'))
    first.unmount()
    document.body.innerHTML = ''

    const second = await mountTree()
    await vi.waitFor(() => expect(buttonLabelled('Expand Domo')).toBeTruthy())

    second.unmount()
  })

  it('opens the new-project modal from the heading', async () => {
    const wrapper = await mountTree()

    buttonLabelled('New project')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Points Domo at an existing local Git checkout'))

    wrapper.unmount()
  })

  it('opens the new-environment modal from the project row, for that project', async () => {
    const wrapper = await mountTree()

    buttonLabelled('New environment in Domo')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('A container of its own for Domo'))

    wrapper.unmount()
  })

  it('preselects the environment when the agent is started from its row', async () => {
    const wrapper = await mountTree()

    buttonLabelled('New agent in feature-auth')!.click()

    await vi.waitFor(() => {
      const trigger = [...document.body.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]')]
        .find(element => element.textContent?.includes('Domo / feature-auth'))
      expect(trigger, 'the environment select is preselected to the row that opened it').toBeTruthy()
    })

    wrapper.unmount()
  })

  it('stops an environment through its own endpoint', async () => {
    const wrapper = await mountTree()

    await choose('Actions for feature-auth', 'Stop')
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/dev-environments/env_1/stop' })
    ))

    wrapper.unmount()
  })

  it('deletes an environment only after the confirmation names the cascade', async () => {
    const wrapper = await mountTree()

    await choose('Actions for feature-auth', 'Delete')
    await vi.waitFor(() => expect(document.body.textContent).toContain('Delete feature-auth?'))
    // Nothing has gone out yet: the menu item opens a dialog, it does not delete.
    expect(calls).toHaveLength(0)
    expect(document.body.textContent).toContain('Docker-in-Docker volume')

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent?.includes('Delete environment'))
    confirm!.click()

    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/api/dev-environments/env_1' })
    ))

    wrapper.unmount()
  })

  it('archives an agent through PATCH, and stops one through cancel', async () => {
    const wrapper = await mountTree()

    await choose('Actions for Auth refactor', 'Archive')
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'PATCH', path: '/api/agents/ag_1', body: { archived: true } })
    ))

    await choose('Actions for Auth refactor', 'Stop')
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/agents/ag_1/cancel' })
    ))

    wrapper.unmount()
  })

  it('renames an agent with the name the dialog collected', async () => {
    const wrapper = await mountTree()

    await choose('Actions for Auth refactor', 'Rename')
    const input = await vi.waitFor(() => {
      const found = document.body.querySelector<HTMLInputElement>('input[value="Auth refactor"]')
      expect(found).toBeTruthy()
      return found!
    })

    input.value = 'Auth rewrite'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    // Scoped to the dialog: the menu that opened it also has a "Rename" item.
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const submit = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent?.trim() === 'Rename')
    submit!.click()

    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'PATCH', path: '/api/agents/ag_1', body: { title: 'Auth rewrite' } })
    ))

    wrapper.unmount()
  })

  it('archives a conversation from its row', async () => {
    const wrapper = await mountTree()

    await choose('Actions for Morning standup', 'Archive')
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'PATCH', path: '/api/voice-sessions/vs_1', body: { archived: true } })
    ))

    wrapper.unmount()
  })

  it('deletes a project only after a confirmation that counts what goes with it', async () => {
    const wrapper = await mountTree()

    await choose('Actions for Domo', 'Delete')
    await vi.waitFor(() => expect(document.body.textContent).toContain('Delete Domo?'))
    expect(document.body.textContent).toContain('1 development environment')
    expect(document.body.textContent).toContain('1 coding agent session')

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent?.includes('Delete project'))
    confirm!.click()

    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/api/projects/p1' })
    ))

    wrapper.unmount()
  })
})
