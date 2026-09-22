import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ImportBranchModal from '~/components/ImportBranchModal.vue'
import type { BranchImport, DevEnvironment } from '~~/shared/types'

/**
 * The other direction's face. Two things here are not cosmetic: the branch it
 * starts on is the one an import can actually write (not the one an agent is
 * sitting on), and the refusal is shown *before* the round trip, because
 * learning it from a failed request is how somebody concludes the feature is
 * broken.
 */

// `UTooltip` reads the provider context `UApp` installs, so mount inside one.
const Harness = defineComponent({
  props: { environment: { type: Object as () => DevEnvironment, required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(ImportBranchModal, { environment: props.environment })
  })
})

function environment(overrides: Partial<DevEnvironment> = {}): DevEnvironment {
  return {
    id: 'env_1',
    projectId: 'proj_1',
    name: 'feature-auth',
    containerName: 'domo-dev-env_1',
    containerId: 'container-sha',
    workspacePath: '/workspaces/feature-auth',
    configSource: 'default',
    configPath: null,
    remoteUser: 'vscode',
    status: 'running',
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as DevEnvironment
}

// `feat/x` is what the agent has checked out, so `main` is the one to offer.
registerEndpoint('/api/dev-environments/env_1/branches', () => ({
  current: 'feat/x',
  branches: [
    { name: 'feat/x', sha: 'b'.repeat(40), subject: 'feat: x' },
    { name: 'main', sha: 'a'.repeat(40), subject: 'docs: y' }
  ]
}))

const posted: any[] = []
let answer: BranchImport = {
  branch: 'main',
  from: 'main',
  sha: 'a'.repeat(40),
  commits: [{ sha: 'a'.repeat(40), subject: 'docs: y' }],
  result: 'fast-forwarded'
}
registerEndpoint('/api/dev-environments/env_1/import', {
  method: 'POST',
  handler: async (event) => {
    posted.push(await readBody(event))
    return answer
  }
})

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.trim() === label)
}

function inputs(): HTMLInputElement[] {
  return [...document.body.querySelectorAll<HTMLInputElement>('[role="dialog"] input')]
}

async function openModal(overrides: Partial<DevEnvironment> = {}) {
  const wrapper = await mountSuspended(Harness, {
    props: { environment: environment(overrides) },
    attachTo: document.body
  })
  button('Import branch')!.click()
  await vi.waitFor(() => {
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy()
  })
  // Both fields are filled from the branch listing, so wait for that.
  await vi.waitFor(() => expect(inputs()[0]?.value).toBe('main'))
  return wrapper
}

beforeEach(() => {
  posted.length = 0
  document.body.innerHTML = ''
})

describe('ImportBranchModal', () => {
  it('is disabled until the environment runs — the import writes to its container', async () => {
    const wrapper = await mountSuspended(Harness, {
      props: { environment: environment({ status: 'stopped' }) },
      attachTo: document.body
    })
    expect(button('Import branch')?.disabled).toBe(true)
    wrapper.unmount()
  })

  // The reported incident: work lands on the host, the environment's main is
  // stale, and the agent is on another branch. That is the case to land on.
  it('starts on a branch that is not the one the environment has checked out', async () => {
    const wrapper = await openModal()

    const [from, branch] = inputs()
    expect(from!.value).toBe('main')
    expect(branch!.value).toBe('main')
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('feat/x (checked out)')
    wrapper.unmount()
  })

  it('sends both branches, defaulting the host one to the same name', async () => {
    const wrapper = await openModal()

    button('Import')!.click()

    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({ branch: 'main', from: 'main' })
    wrapper.unmount()
  })

  it('takes a differently named branch on this machine', async () => {
    const wrapper = await openModal()

    const from = inputs()[0]!
    from.value = 'release'
    from.dispatchEvent(new Event('input', { bubbles: true }))
    button('Import')!.click()

    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({ branch: 'main', from: 'release' })
    wrapper.unmount()
  })

  /**
   * Nothing is sent at all: the server refuses this too, but an agent's
   * uncommitted work is what is at stake, so the UI says so up front rather
   * than spending a round trip to be told.
   */
  it('refuses the environment\'s checked-out branch before anything is sent', async () => {
    const wrapper = await openModal()

    const branch = inputs()[1]!
    branch.value = 'feat/x'
    branch.dispatchEvent(new Event('input', { bubbles: true }))

    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="dialog"]')?.textContent)
        .toContain('has “feat/x” checked out')
    })
    expect(button('Import')?.disabled).toBe(true)
    expect(posted).toHaveLength(0)
    wrapper.unmount()
  })

  it('shows what crossed, and why nothing did when nothing did', async () => {
    answer = {
      branch: 'main',
      from: 'main',
      sha: 'c'.repeat(40),
      commits: [],
      result: 'not-merged',
      reason: 'feature-auth\'s "main" has commits that "main" does not, so it cannot be fast-forwarded.'
    }
    const wrapper = await openModal()

    button('Import')!.click()

    await vi.waitFor(() => {
      const text = document.body.querySelector('[role="dialog"]')?.textContent ?? ''
      expect(text).toContain('Nothing was sent')
      expect(text).toContain('cannot be fast-forwarded')
      expect(text).toContain('No commits crossed.')
    })
    wrapper.unmount()
  })
})
