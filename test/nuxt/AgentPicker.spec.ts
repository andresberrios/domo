import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { computed, defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentPicker from '~/components/AgentPicker.vue'
import type { AgentSession, DevEnvironment, Project } from '~~/shared/types'

/**
 * The one picker for a session: grouped as the sidebar groups them, offering
 * only what can still take a message, and still naming a choice that has since
 * stopped being offered.
 */

const project = { id: 'p1', name: 'domo', repoPath: '/work/domo', retiredAt: null } as Project
const environment = (id: string, name: string, retiredAt: string | null = null) =>
  ({ id, projectId: 'p1', name, retiredAt, status: 'running' }) as DevEnvironment
const session = (id: string, title: string, extra: Partial<AgentSession> = {}) =>
  ({ id, title, cwd: '/workspace/repo', devEnvironmentId: null, status: 'idle', archived: false, assistantId: null, ...extra }) as AgentSession

const environments = [
  environment('env_solo', 'sidebar-polish'),
  environment('env_pair', 'voice-bar'),
  environment('env_old', 'old-experiment', '2026-10-01T00:00:00.000Z')
]
const sessions = [
  session('ag_solo', 'Fix badges', { devEnvironmentId: 'env_solo' }),
  session('ag_a', 'Turn detection', { devEnvironmentId: 'env_pair' }),
  session('ag_b', 'Layout', { devEnvironmentId: 'env_pair' }),
  session('ag_host', 'Chores', { cwd: '/work/domo' }),
  session('ag_archived', 'Archived refactor', { devEnvironmentId: 'env_pair', archived: true }),
  session('ag_retired', 'Ran in a retired one', { devEnvironmentId: 'env_old' }),
  session('ag_assistant', 'Inbox session', { cwd: '/work/domo', assistantId: 'as_1' })
]

mockNuxtImport('useAgentSessions', () => () => ({
  sessions: computed(() => sessions.filter(item => !item.archived)),
  all: computed(() => sessions),
  isReady: ref(true)
}))
mockNuxtImport('useDevEnvironments', () => () => ({
  environments: computed(() => environments.filter(item => !item.retiredAt)),
  all: computed(() => environments),
  isReady: ref(true)
}))
mockNuxtImport('useProjects', () => () => ({ projects: computed(() => [project]), all: computed(() => [project]), isReady: ref(true) }))

/** An entry's label, with the environment's name and the session's as two words. */
function labelText(label: HTMLElement): string {
  const parts = label.querySelectorAll(':scope > span > span')
  return (parts.length ? [...parts].map(part => part.textContent!.trim()).join(' ') : label.textContent!).trim()
}

async function openPicker(value: string) {
  const model = ref(value)
  const Harness = defineComponent(() => () => h(UApp, null, {
    default: () => h(AgentPicker, {
      'modelValue': model.value,
      'onUpdate:modelValue': (next: string) => { model.value = next },
      'leading': { label: 'Assistants', items: [{ label: 'Inbox organizer', value: 'as_1', icon: 'i-lucide-sparkles' }] }
    })
  }))
  const wrapper = await mountSuspended(Harness, { attachTo: document.body })
  const trigger = wrapper.find('button')
  const shown = trigger.text()
  await trigger.trigger('click')
  const listbox = await vi.waitFor(() => {
    const found = document.body.querySelector<HTMLElement>('[role="listbox"]')
    expect(found).toBeTruthy()
    return found!
  })
  /** Headings and entries in order: "# heading", "  entry". */
  const rows = [...listbox.querySelectorAll<HTMLElement>('[data-slot="label"], [role="option"]')]
    .map(element => element.getAttribute('role') === 'option'
      ? `  ${labelText(element.querySelector<HTMLElement>('[data-slot="itemLabel"]')!)}`
      : `# ${element.textContent!.trim()}`)
  return { wrapper, shown, rows }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('AgentPicker', () => {
  it('groups like the sidebar and offers only what can still take a message', async () => {
    const { wrapper, rows } = await openPicker('as_1')
    expect(rows).toEqual([
      '# Assistants',
      '  Inbox organizer',
      '# domo',
      '  Chores',
      // One session in it: the environment's name, then the session's, as one entry.
      '  sidebar-polish Fix badges',
      '# domo › voice-bar',
      '  Turn detection',
      '  Layout'
    ])
    wrapper.unmount()
  })

  it('still shows a chosen session that has since been archived', async () => {
    const { wrapper, shown, rows } = await openPicker('ag_archived')
    expect(shown).toContain('Archived refactor')
    expect(rows.slice(-2)).toEqual(['# No longer offered', '  Archived refactor'])
    // And only that one: the other unofferable sessions stay out.
    expect(rows.join('\n')).not.toContain('Ran in a retired one')
    expect(rows.join('\n')).not.toContain('Inbox session')
    wrapper.unmount()
  })
})
