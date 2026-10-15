import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp, UPopover } from '#components'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AgentSessionChips from '~/components/AgentSessionChips.vue'
import type { AgentDraft, AgentSession, Assistant, DevEnvironment, PendingPermission, Project } from '~~/shared/types'

/**
 * The row under an agent page's title: each chip goes where it names, and only
 * what exists is shown.
 */

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 'ag_1', adapter: 'claude-code', acpSessionId: null, title: 'One', cwd: '/work/domo/app', devEnvironmentId: null,
    status: 'idle', modeId: null, modes: null, model: null, config: null, configOptions: null, steering: null,
    lastError: null, summary: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null, archived: false, usage: null, spawnedBy: null, assistantId: null,
    ...overrides
  }
}

const project: Project = { id: 'p1', name: 'Domo', repoPath: '/work/domo', createdAt: '', updatedAt: '', retiredAt: null }
const environment = {
  id: 'env_1', projectId: 'p1', name: 'small-fixes', status: 'running', branch: 'fix/header', retiredAt: null
} as DevEnvironment

const sessions = ref<AgentSession[]>([])
const follows = ref<Array<{ subscriberId: string, targetId: string }>>([])
const pending = ref<PendingPermission[]>([])
const assistants = ref<Assistant[]>([])

mockNuxtImport('useAgentSessions', () => () => ({ sessions: computed(() => sessions.value), all: computed(() => sessions.value), isReady: ref(true) }))
mockNuxtImport('useDevEnvironments', () => () => ({ environments: computed(() => [environment]), all: computed(() => [environment]), isReady: ref(true) }))
mockNuxtImport('useProjects', () => () => ({ projects: computed(() => [project]), all: computed(() => [project]), isReady: ref(true) }))
mockNuxtImport('useAgentFollows', () => () => ({ follows: computed(() => follows.value) }))
mockNuxtImport('usePermissions', () => () => ({ permissions: computed(() => pending.value), pending: computed(() => pending.value), isReady: ref(true) }))
mockNuxtImport('useAssistant', () => (id: () => string | null | undefined) => ({
  assistant: computed(() => assistants.value.find(item => item.id === id()) ?? null),
  isReady: ref(true)
}))
mockNuxtImport('useCronJobs', () => () => ({ jobs: computed(() => []), isReady: ref(true) }))

const mounted: { unmount: () => void }[] = []
async function mount(props: { session: AgentSession | null, draft?: AgentDraft | null, closed?: boolean }) {
  const component = await mountSuspended(defineComponent(() => () => h(UApp, null, {
    default: () => h(AgentSessionChips, { draft: null, closed: false, ...props })
  })))
  mounted.push(component)
  return component
}

const chip = (component: Awaited<ReturnType<typeof mount>>, id: string) => component.find(`[data-testid="${id}"]`)

beforeEach(() => {
  sessions.value = []
  follows.value = []
  pending.value = []
  assistants.value = []
})

afterEach(() => {
  for (const component of mounted.splice(0)) component.unmount()
})

describe('AgentSessionChips', () => {
  it('names a host session\'s folder by its project, and leaves out every relation it does not have', async () => {
    const own = session({})
    sessions.value = [own]
    const component = await mount({ session: own })

    expect(chip(component, 'folder-chip').text()).toBe('Domo')
    expect(chip(component, 'folder-chip').attributes('title')).toBe('/work/domo/app · in Domo')
    expect(chip(component, 'environment-chip').exists()).toBe(false)
    expect(chip(component, 'spawner-chip').exists()).toBe(false)
    expect(chip(component, 'started-chip').exists()).toBe(false)
    expect(chip(component, 'following-chip').exists()).toBe(false)
  })

  it('links an environment session to its environment, and says the branch when the name does not', async () => {
    const own = session({ cwd: '/workspaces/domo', devEnvironmentId: 'env_1' })
    sessions.value = [own]
    const component = await mount({ session: own })

    expect(chip(component, 'environment-chip').attributes('href')).toBe('/environments/env_1')
    expect(chip(component, 'environment-chip').text()).toContain('small-fixes')
    expect(component.text()).toContain('fix/header')
  })

  it('puts the model and effort on the coding agent\'s chip', async () => {
    const own = session({
      model: 'opus',
      config: { effort: 'high' },
      configOptions: [{ id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'high', name: 'High' }] }]
    })
    sessions.value = [own]
    const component = await mount({ session: own })

    expect(chip(component, 'agent-chip').text()).toBe('Claude Code · opus · High')
  })

  it('links to the session that started this one, and the one it started', async () => {
    const parent = session({ id: 'ag_parent', title: 'Planner' })
    const child = session({ id: 'ag_child', title: 'Fix the header', spawnedBy: 'ag_parent', status: 'thinking' })
    sessions.value = [parent, child]

    const fromChild = await mount({ session: child })
    expect(chip(fromChild, 'spawner-chip').attributes('href')).toBe('/agents/ag_parent')
    expect(chip(fromChild, 'spawner-chip').text()).toContain('Started by Planner')

    const fromParent = await mount({ session: parent })
    expect(chip(fromParent, 'started-chip').attributes('href')).toBe('/agents/ag_child')
    expect(chip(fromParent, 'started-chip').text()).toContain('Started Fix the header')
  })

  it('counts several started sessions, says how many wait for an answer, and lists them all', async () => {
    const parent = session({ id: 'ag_parent', title: 'Planner' })
    const children = ['a', 'b', 'c'].map(id => session({ id: `ag_${id}`, title: `Child ${id}`, spawnedBy: 'ag_parent', status: id === 'b' ? 'awaiting-permission' : 'idle' }))
    sessions.value = [parent, ...children]
    pending.value = [{ id: 'perm_1', agentSessionId: 'ag_b' } as PendingPermission]

    const component = await mount({ session: parent })
    const started = chip(component, 'started-chip')
    expect(started.text()).toContain('Started 3')
    expect(started.attributes('title')).toBe('Started 3 · 1 waiting for you')

    const popover = component.findAllComponents(UPopover).find(item => item.text().includes('Started 3'))!
    popover.vm.$emit('update:open', true)
    await nextTick()
    await nextTick()
    const list = document.querySelector('[data-testid="session-links"]')!
    expect([...list.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(['/agents/ag_a', '/agents/ag_b', '/agents/ag_c'])
    expect(list.textContent).toContain('1 waiting for you')
  })

  it('lists who it follows apart from what it started', async () => {
    const own = session({ id: 'ag_own' })
    const child = session({ id: 'ag_child', title: 'Child', spawnedBy: 'ag_own' })
    const peer = session({ id: 'ag_peer', title: 'Reviewer' })
    sessions.value = [own, child, peer]
    follows.value = [{ subscriberId: 'ag_own', targetId: 'ag_child' }, { subscriberId: 'ag_own', targetId: 'ag_peer' }]

    const component = await mount({ session: own })
    expect(chip(component, 'following-chip').attributes('href')).toBe('/agents/ag_peer')
    expect(chip(component, 'following-chip').text()).toContain('Following Reviewer')
    expect(chip(component, 'started-chip').text()).toContain('Started Child')
  })

  it('links to the assistant a session belongs to', async () => {
    const own = session({ id: 'ag_own', assistantId: 'as_1' })
    sessions.value = [own]
    assistants.value = [{ id: 'as_1', name: 'Dia', currentSessionId: 'ag_newer' } as Assistant]

    const component = await mount({ session: own })
    expect(chip(component, 'assistant-chip').attributes('href')).toBe('/assistants/as_1')
    expect(chip(component, 'assistant-chip').text()).toContain('Dia, earlier')
  })

  it('shows a draft where it is about to work, and nothing it is tied to', async () => {
    sessions.value = [session({ id: 'ag_other', spawnedBy: null })]
    const draft = { cwd: '/work/domo', devEnvironmentId: 'env_1', adapter: 'codex' } as AgentDraft
    const component = await mount({ session: null, draft })

    expect(chip(component, 'folder-chip').exists()).toBe(false)
    expect(chip(component, 'environment-chip').text()).toContain('small-fixes')
    expect(component.text()).toContain('Codex')
  })
})
