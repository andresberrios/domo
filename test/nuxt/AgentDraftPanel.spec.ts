import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { computed, defineComponent, h, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import AgentDraftPanel from '~/components/AgentDraftPanel.vue'
import type { AgentDraft, DevEnvironment, Project } from '~~/shared/types'

/**
 * Two projects with an environment each, so "the environment list is scoped to
 * the chosen project" is a claim a test can fail: with one project it would
 * pass whether the filter is there or not.
 */
const projects = [
  { id: 'p1', name: 'Domo', repoPath: '/work/domo' },
  { id: 'p2', name: 'Other', repoPath: '/work/other' }
] as Project[]

const environments = [
  { id: 'env_1', projectId: 'p1', name: 'feature-auth', status: 'running' },
  { id: 'env_2', projectId: 'p2', name: 'other-work', status: 'stopped' }
] as DevEnvironment[]

mockNuxtImport('useProjects', () => () => ({ projects: computed(() => projects), all: computed(() => projects), isReady: ref(true) }))
mockNuxtImport('useDevEnvironments', () => () => ({ environments: computed(() => environments), all: computed(() => environments), isReady: ref(true) }))
registerEndpoint('/api/settings', () => ({ defaultCwd: '/work' }))

function mountPanel(initial: Partial<AgentDraft>) {
  const draft = ref<AgentDraft>({
    adapter: 'claude-code',
    model: '',
    modeId: '',
    config: {},
    projectId: 'p1',
    devEnvironmentId: 'env_1',
    cwd: '/work/domo',
    title: '',
    ...initial
  })
  const Panel = defineComponent({
    setup: () => () => h(UApp, null, {
      default: () => h(AgentDraftPanel, {
        'modelValue': draft.value,
        'onUpdate:modelValue': (value: AgentDraft) => { draft.value = value }
      })
    })
  })
  return mountSuspended(Panel, { attachTo: document.body }).then(component => ({ component, draft }))
}

/** The select whose current label matches, as the user would find it. */
function selectTrigger(label: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]')]
    .find(element => element.textContent?.includes(label))
}

function listboxContaining(label: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"]')]
    .find(element => element.textContent?.includes(label))
}

describe('AgentDraftPanel', () => {
  /**
   * Reka's select items throw on an empty-string value, so neither "no
   * project" nor "local" can be `''`. The error only appears when the menu is
   * opened and its items render.
   */
  it('lists only the chosen project\'s environments, and opens without throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { component } = await mountPanel({})

    expect(selectTrigger('Domo'), 'the project select is above the environment one').toBeTruthy()
    selectTrigger('feature-auth')!.click()
    const listbox = await vi.waitFor(() => {
      const found = listboxContaining('feature-auth')
      expect(found?.textContent).toContain('Local checkout')
      return found!
    })
    expect(listbox.textContent, 'another project\'s environment is not offered').not.toContain('other-work')
    // An environment's workspace is its own: no directory to choose.
    expect(document.body.querySelector('input[placeholder="/path/to/repository"]')).toBeNull()

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    component.unmount()
  })

  it('asks for a path, and offers no environment, with no project', async () => {
    const { component } = await mountPanel({ projectId: null, devEnvironmentId: null, cwd: '/work' })

    expect(selectTrigger('No project')).toBeTruthy()
    expect(selectTrigger('feature-auth'), 'there is no environment select').toBeFalsy()
    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="/path/to/repository"]')?.value).toBe('/work')

    component.unmount()
  })

  it('re-points the environment and the directory when the project changes', async () => {
    const { component, draft } = await mountPanel({})

    selectTrigger('Domo')!.click()
    const option = await vi.waitFor(() => {
      const found = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(element => element.textContent?.includes('Other'))
      expect(found).toBeTruthy()
      return found!
    })
    option.click()

    await vi.waitFor(() => expect(draft.value).toMatchObject({ projectId: 'p2', devEnvironmentId: null, cwd: '/work/other' }))
    component.unmount()
  })
})
