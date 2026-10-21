import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { computed, defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ProjectTree from '~/components/ProjectTree.vue'
import type { AgentSession, DevEnvironment, Project } from '~~/shared/types'

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
  updatedAt: '2026-01-01T00:00:00.000Z',
  retiredAt: null,
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
  updatedAt: '2026-01-02T00:00:00.000Z',
  retiredAt: null,
  leftovers: [],
  adapterVersions: null,
  lastUpgrade: null,
  branch: null,
  cleanedAt: null,
}

/** Environments a test adds beside `environment`, to see them grouped. */
const grouped: DevEnvironment[] = []

const agent: AgentSession = {
  id: 'ag_1',
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
  steering: null,
  lastError: null,
  summary: null,
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  lastActivityAt: null,
  usage: null,
  archived: false,
  spawnedBy: null,
  assistantId: null,
}

mockNuxtImport('useProjects', () => () => ({ projects: computed(() => [project]), isReady: ref(true) }))
mockNuxtImport('useDevEnvironments', () => () => ({ environments: computed(() => [environment, ...grouped]), isReady: ref(true) }))
/** A session of an assistant in the same environment: its journal's, not the tree's. */
const assistantSession: AgentSession = { ...agent, id: 'ag_assistant', title: 'Inbox organizer', assistantId: 'as_1' }

/** A second session in `environment`, so it keeps its nested list; the merged row has tests of its own. */
const sibling: AgentSession = { ...agent, id: 'ag_2', title: 'Login page', status: 'idle' }
/** Sessions a test adds, to see an environment with one session as one row. */
const extraSessions: AgentSession[] = []

mockNuxtImport('useAgentSessions', () => () => ({
  sessions: computed(() => [agent, sibling, assistantSession, ...extraSessions]),
  isReady: ref(true)
}))
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
registerEndpoint('/api/agents/ag_solo', { method: 'PATCH', handler: record('/api/agents/ag_solo', 'PATCH') })
registerEndpoint('/api/dev-environments/env_solo', { method: 'PATCH', handler: record('/api/dev-environments/env_solo', 'PATCH') })
registerEndpoint('/api/dev-environments/env_solo/stop', { method: 'POST', handler: record('/api/dev-environments/env_solo/stop', 'POST') })

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(ProjectTree) })
})

/**
 * Real transitions, not Test Utils' stubs: the tree's lists are `MotionList`s,
 * and a stubbed `TransitionGroup` renders no list element at all.
 */
async function mountTree() {
  return await mountSuspended(Harness, { attachTo: document.body, global: { stubs: { transition: false, 'transition-group': false } } })
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
  grouped.length = 0
  extraSessions.length = 0
  localStorage.clear()
  document.body.innerHTML = ''
})

/*
 * Mounting the whole tree — every row, and the four modals each row owns — is
 * heavy in a real Nuxt runtime, and each test does it again. Under the full
 * suite's parallel load that overran Vitest's 5 s default and failed as a
 * timeout rather than an assertion.
 */
describe('ProjectTree', () => {
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

  it('groups environments by the slashes in their names, as folders that collapse', async () => {
    grouped.push(
      { ...environment, id: 'env_s', name: 'handoff/speech-system' },
      { ...environment, id: 'env_v', name: 'handoff/voice/x' }
    )
    try {
      const wrapper = await mountTree()
      const link = (id: string) => document.body.querySelector<HTMLAnchorElement>(`a[href="/environments/${id}"]`)

      // Inside its folder, a row reads as its last segment; the full name is its tooltip.
      // (The status icon says "Running" to a screen reader first.)
      expect(link('env_s')?.textContent?.trim()).toBe('Runningspeech-system')
      expect(link('env_s')?.getAttribute('title')).toBe('handoff/speech-system')
      expect(link('env_v')?.textContent?.trim()).toBe('Runningx')
      expect(buttonLabelled('Collapse handoff/voice')).toBeTruthy()

      buttonLabelled('Collapse handoff')!.click()
      await vi.waitFor(() => expect(link('env_s')).toBeNull())
      expect(link('env_v')).toBeNull()
      // What is outside the folder stays.
      expect(link('env_1')?.textContent?.trim()).toBe('Runningfeature-auth')
      expect(JSON.parse(localStorage.getItem('domo.sidebar.collapsed')!)).toContain('folder:p1:handoff')

      buttonLabelled('Expand handoff')!.click()
      await vi.waitFor(() => expect(link('env_s')).toBeTruthy())
      wrapper.unmount()
    } finally {
      grouped.length = 0
    }
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
    await vi.waitFor(() => expect(document.body.textContent).toContain('A git checkout on this machine, or a folder Domo makes into one'))

    wrapper.unmount()
  })

  it('opens the new-environment modal from the project row, for that project', async () => {
    const wrapper = await mountTree()

    buttonLabelled('New environment in Domo')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('A container of its own for Domo'))

    wrapper.unmount()
  })

  it('opens the new-session page on the environment when the agent is started from its row', async () => {
    const push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
    const wrapper = await mountTree()

    buttonLabelled('New session in feature-auth')!.click()

    // The environment decides the project above it, so naming it is enough.
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/agents/new?environment=env_1'))

    push.mockRestore()
    wrapper.unmount()
  })

  it('opens the new-session page on the project\'s own checkout from the project\'s menu', async () => {
    const push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
    const wrapper = await mountTree()

    // Nothing runs in the checkout yet, so it has no row; the menu is the way in.
    expect(document.body.textContent).not.toContain('Local checkout')
    await choose('Actions for Domo', 'New session in the local checkout')

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/agents/new?project=p1'))

    push.mockRestore()
    wrapper.unmount()
  })

  it('says nothing of empty places: no placeholder rows, no empty sections', async () => {
    const wrapper = await mountTree()

    expect(document.body.textContent).not.toContain('No agents yet')
    // Every agent here is in a project, so there is no section for the rest.
    expect(document.body.textContent).not.toContain('Other directories')
    // An environment with no agents has nothing to open.
    grouped.push({ ...environment, id: 'env_empty', name: 'empty-one' })
    try {
      const again = await mountTree()
      expect(buttonLabelled('Collapse empty-one')).toBeUndefined()
      expect(buttonLabelled('Collapse feature-auth')).toBeTruthy()
      again.unmount()
    } finally {
      grouped.length = 0
    }

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

  it('retires an environment only after the confirmation names the cascade', async () => {
    const wrapper = await mountTree()

    await choose('Actions for feature-auth', 'Retire')
    await vi.waitFor(() => expect(document.body.textContent).toContain('Retire feature-auth?'))
    // Nothing has gone out yet: the menu item opens a dialog, it does not act.
    expect(calls).toHaveLength(0)
    expect(document.body.textContent).toContain('everything it made in Docker')

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent?.includes('Retire environment'))
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

    await choose('Actions for Auth refactor', 'Stop the turn')
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

  it('retires a project only after a confirmation that counts what goes with it', async () => {
    const wrapper = await mountTree()

    await choose('Actions for Domo', 'Retire')
    await vi.waitFor(() => expect(document.body.textContent).toContain('Retire Domo?'))
    expect(document.body.textContent).toContain('1 development environment')
    expect(document.body.textContent).toContain('and 2 coding agents inside them')

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(element => element.textContent?.includes('Retire project'))
    confirm!.click()

    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/api/projects/p1' })
    ))

    wrapper.unmount()
  })
})

describe('ProjectTree: an environment with one session', () => {
  const solo: DevEnvironment = { ...environment, id: 'env_solo', name: 'solo-env' }
  const soloAgent: AgentSession = { ...agent, id: 'ag_solo', title: 'Fix badges', devEnvironmentId: 'env_solo' }

  function showSolo() {
    grouped.push(solo)
    extraSessions.push(soloAgent)
  }

  it('is one row: the environment\'s icon links to it, the rest to the session', async () => {
    showSolo()
    const wrapper = await mountTree()

    const environmentLink = document.body.querySelector<HTMLAnchorElement>('a[href="/environments/env_solo"]')!
    const agentLink = document.body.querySelector<HTMLAnchorElement>('a[href="/agents/ag_solo"]')!
    expect(environmentLink, 'the environment keeps a link').toBeTruthy()
    // Its name is there for a screen reader and slides out on hover; the full name is the tooltip.
    expect(environmentLink.textContent).toContain('solo-env')
    expect(environmentLink.getAttribute('title')).toBe('solo-env')
    expect(agentLink.textContent).toContain('Fix badges')

    // Both links on the one row, environment first, and no nested list under it.
    const row = environmentLink.parentElement!
    expect(agentLink.parentElement).toBe(row)
    expect(environmentLink.compareDocumentPosition(agentLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.closest('li')!.querySelector('ul')).toBeNull()
    expect(buttonLabelled('Collapse solo-env')).toBeUndefined()

    wrapper.unmount()
  })

  it('keeps the nested list for two sessions or none', async () => {
    showSolo()
    grouped.push({ ...environment, id: 'env_empty', name: 'empty-one' })
    const wrapper = await mountTree()

    // Two sessions: an environment row with its own chevron and list.
    expect(buttonLabelled('Collapse feature-auth')).toBeTruthy()
    expect(buttonLabelled('Actions for feature-auth')).toBeTruthy()
    // None: the environment's own row, with nothing to open.
    expect(buttonLabelled('Actions for empty-one')).toBeTruthy()
    // One: only the merged row's menu.
    expect(buttonLabelled('Actions for solo-env')).toBeUndefined()
    expect(buttonLabelled('Actions for Fix badges')).toBeUndefined()
    expect(buttonLabelled('Actions for Fix badges in solo-env')).toBeTruthy()

    wrapper.unmount()
  })

  it('has one menu that acts on the session and on the environment', async () => {
    showSolo()
    const wrapper = await mountTree()

    await choose('Actions for Fix badges in solo-env', 'Stop environment')
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/dev-environments/env_solo/stop' })
    ))

    await choose('Actions for Fix badges in solo-env', 'Archive')
    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'PATCH', path: '/api/agents/ag_solo', body: { archived: true } })
    ))

    const menu = await openMenu('Actions for Fix badges in solo-env')
    const labels = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent?.trim())
    expect(labels).toEqual(expect.arrayContaining([
      'Rename session', 'Stop the turn', 'Archive',
      'New session here', 'Stop environment', 'Open in VS Code', 'Rename environment', 'Retire environment'
    ]))

    wrapper.unmount()
  })

  it('renames the environment, not the session, from "Rename environment"', async () => {
    showSolo()
    const wrapper = await mountTree()

    await choose('Actions for Fix badges in solo-env', 'Rename environment')
    const input = await vi.waitFor(() => {
      const found = document.body.querySelector<HTMLInputElement>('input[value="solo-env"]')
      expect(found).toBeTruthy()
      return found!
    })
    input.value = 'solo-renamed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === 'Rename')!.click()

    await vi.waitFor(() => expect(calls).toContainEqual(
      expect.objectContaining({ method: 'PATCH', path: '/api/dev-environments/env_solo', body: { name: 'solo-renamed' } })
    ))
    expect(calls.some(call => call.path === '/api/agents/ag_solo')).toBe(false)

    wrapper.unmount()
  })
})

describe('ProjectTree and assistants', () => {
  it('leaves an assistant\'s sessions out of the tree', async () => {
    const wrapper = await mountTree()
    expect(wrapper.text()).toContain('Auth refactor')
    expect(wrapper.text()).not.toContain('Inbox organizer')
    wrapper.unmount()
  })
})
