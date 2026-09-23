import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, readBody } from 'h3'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import NewAgentModal from '~/components/NewAgentModal.vue'
import type { DevEnvironment, Project } from '~~/shared/types'

/**
 * Two projects with an environment each, so "the environment list is scoped to
 * the chosen project" is a claim a test can fail: with one project it would
 * pass whether the filter is there or not.
 */
const projects: Project[] = [
  { id: 'p1', name: 'Domo', repoPath: '/work/domo', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', retiredAt: null },
  { id: 'p2', name: 'Other', repoPath: '/work/other', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', retiredAt: null }
]

function environment(id: string, projectId: string, name: string, status: DevEnvironment['status']): DevEnvironment {
  return {
    id,
    projectId,
    name,
    containerName: `domo-dev-${id}`,
    containerId: 'abc123',
    workspacePath: '/workspaces/repo',
    configSource: 'domo',
    configPath: '.domo.json',
    remoteUser: 'vscode',
    status,
    lastError: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    retiredAt: null,
    leftovers: []
  }
}

const environments = [
  environment('env_1', 'p1', 'feature-auth', 'running'),
  environment('env_2', 'p2', 'other-work', 'stopped')
]

mockNuxtImport('useProjects', () => () => ({ projects: computed(() => projects), all: computed(() => projects), isReady: ref(true) }))
mockNuxtImport('useDevEnvironments', () => () => ({ environments: computed(() => environments), all: computed(() => environments), isReady: ref(true) }))

/**
 * Reka's select items throw on an empty-string value, so neither "no
 * environment" nor "adapter default" can be `''`. The error only appears when
 * the menu is opened and its items render, which is why nothing but a mounted,
 * opened dialog can catch it.
 */
registerEndpoint('/api/settings', () => ({
  defaultCwd: '/work',
  defaultAgentModes: { 'claude-code': 'plan', codex: 'read-only' }
}))

const posted: any[] = []
registerEndpoint('/api/agents', {
  method: 'POST',
  handler: async (event) => {
    posted.push(await readBody(event))
    return { id: 'ag_new' }
  }
})

let modelsFail = false
registerEndpoint('/api/adapters/models', () => {
  if (modelsFail) throw createError({ statusCode: 502, statusMessage: 'Not logged in' })
  return {
    models: [{ id: 'sonnet', name: 'Sonnet 5' }, { id: 'haiku', name: 'Haiku 4.5' }],
    current: 'sonnet',
    // One probe answers both lists, and the mode ids are the adapter's own.
    modes: [
      { id: 'default', name: 'Manual', description: 'Always ask' },
      { id: 'plan', name: 'Plan', description: 'Plan first' }
    ],
    currentMode: 'default'
  }
})

async function open(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(NewAgentModal, {
    props: { open: true, ...props },
    attachTo: document.body
  })
  return wrapper
}

/** Every option in the open listbox that carries the given label. */
function listboxContaining(label: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"]')]
    .find(element => element.textContent?.includes(label))
}

/** The select whose current label matches, as the user would find it. */
function selectTrigger(label: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]')]
    .find(element => element.textContent?.includes(label))
}

describe('NewAgentModal', () => {
  it('opens the development environment menu without throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await open()

    const trigger = selectTrigger('feature-auth')
    expect(trigger, 'the environment select renders with its default selected').toBeTruthy()

    trigger!.click()
    await vi.waitFor(() => {
      expect(listboxContaining('feature-auth')?.textContent).toContain('Local checkout')
    })

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    wrapper.unmount()
  })

  it('lists only the chosen project\'s environments', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await open()

    // The running environment decides the project the form opens on.
    expect(selectTrigger('Domo'), 'the project select is above the environment one').toBeTruthy()

    selectTrigger('feature-auth')!.click()
    const listbox = await vi.waitFor(() => {
      const found = listboxContaining('feature-auth')
      expect(found).toBeTruthy()
      return found!
    })
    expect(listbox.textContent, 'another project\'s environment is not offered').not.toContain('other-work')

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    wrapper.unmount()
  })

  it('asks for a path, and offers no environment, when the caller says "no project"', async () => {
    // `null` is the sidebar's no-project section opening straight onto a
    // directory; `undefined` would let the modal pick a project instead.
    const wrapper = await open({ projectId: null })

    await vi.waitFor(() => {
      expect(selectTrigger('No project')).toBeTruthy()
      expect(selectTrigger('feature-auth'), 'there is no environment select').toBeFalsy()
      expect(
        document.body.querySelector<HTMLInputElement>('input[placeholder="/path/to/repository"]')?.value,
        'the directory falls back to the install default'
      ).toBe('/work')
    })

    wrapper.unmount()
  })

  it('starts in a project\'s own checkout when the caller names the project', async () => {
    const wrapper = await open({ projectId: 'p2' })

    await vi.waitFor(() => {
      expect(selectTrigger('Other'), 'the named project is selected').toBeTruthy()
      expect(selectTrigger('Local checkout'), 'and not one of its containers').toBeTruthy()
      expect(
        document.body.querySelector<HTMLInputElement>('input[placeholder="/path/to/repository"]')?.value
      ).toBe('/work/other')
    })

    wrapper.unmount()
  })

  it('offers the adapter\'s own models, behind an "adapter default" that is not an empty value', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await open()

    const trigger = await vi.waitFor(() => {
      const found = selectTrigger('Adapter default')
      expect(found).toBeTruthy()
      return found!
    })

    trigger.click()
    await vi.waitFor(() => {
      const listbox = [...document.body.querySelectorAll('[role="listbox"]')]
        .find(element => element.textContent?.includes('Adapter default'))
      // The list the server probed the adapter for, not a hard-coded one.
      expect(listbox?.textContent).toContain('Haiku 4.5')
    })

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    wrapper.unmount()
  })

  it('offers the adapter\'s own permission modes, preselected to the setting', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await open()

    // "Plan" is what `/api/settings` says this install defaults Claude Code to —
    // there is no hard-coded list here and no hard-coded default either.
    const trigger = await vi.waitFor(() => {
      const found = selectTrigger('Plan')
      expect(found).toBeTruthy()
      return found!
    })

    trigger.click()
    await vi.waitFor(() => {
      const listbox = [...document.body.querySelectorAll('[role="listbox"]')]
        .find(element => element.textContent?.includes('Plan'))
      expect(listbox?.textContent).toContain('Manual')
    })

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    wrapper.unmount()
  })

  it('submits no model while the default is selected', async () => {
    posted.length = 0
    const wrapper = await open()

    // Queried off `document.body`, not the wrapper: `UModal` teleports its
    // content, so `wrapper.find` sees none of the form. The event has to bubble
    // or Nuxt UI's input never re-emits and the submit button stays disabled.
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="auth refactor"]')!
    input.value = 'auth refactor'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const start = await vi.waitFor(() => {
      const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find(element => element.textContent?.includes('Start agent'))
      expect(button?.disabled).toBe(false)
      return button!
    })
    start.click()

    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].model).toBeUndefined()
    // The mode *is* sent: it is a per-session choice, preselected from Settings.
    expect(posted[0]).toMatchObject({ title: 'auth refactor', adapter: 'claude-code', modeId: 'plan' })
    // The running environment is where it lands, and its own workspace is the
    // directory, so no path goes with it.
    expect(posted[0]).toMatchObject({ devEnvironmentId: 'env_1' })
    expect(posted[0].cwd).toBeUndefined()
    wrapper.unmount()
  })

  it('says so inline when the adapter cannot be asked, and still lets the default through', async () => {
    modelsFail = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await open()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Could not ask Claude Code which models it offers')
    })
    // A failed probe must not take the whole form down with it.
    expect(selectTrigger('Adapter default')).toBeTruthy()

    errors.mockRestore()
    modelsFail = false
    wrapper.unmount()
  })
})
