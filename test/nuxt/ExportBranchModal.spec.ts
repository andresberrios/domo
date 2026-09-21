import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ExportBranchModal from '~/components/ExportBranchModal.vue'
import type { BranchExport, DevEnvironment } from '~~/shared/types'

/**
 * The export modal is the only place the branch export has a face: the
 * container's branches with the checked-out one preselected, a local branch
 * that follows it, and the result — what moved, or why nothing did.
 */

// `UTooltip` reads the provider context `UApp` installs, so mount inside one.
const Harness = defineComponent({
  props: { environment: { type: Object as () => DevEnvironment, required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(ExportBranchModal, { environment: props.environment })
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
    hostWorkspacePath: null,
    configSource: 'generated',
    configPath: null,
    remoteUser: 'vscode',
    status: 'running',
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as DevEnvironment
}

registerEndpoint('/api/dev-environments/env_1/branches', () => ({
  current: 'main',
  branches: [
    { name: 'feat/x', sha: 'b'.repeat(40), subject: 'feat: x' },
    { name: 'main', sha: 'a'.repeat(40), subject: 'docs: y' }
  ]
}))

const posted: any[] = []
let answer: BranchExport = {
  ref: 'refs/remotes/domo-env/feature-auth/main',
  sha: 'a'.repeat(40),
  commits: [{ sha: 'a'.repeat(40), subject: 'docs: y' }],
  into: 'main',
  result: 'fast-forwarded'
}
registerEndpoint('/api/dev-environments/env_1/export', {
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

async function openModal(overrides: Partial<DevEnvironment> = {}) {
  const wrapper = await mountSuspended(Harness, {
    props: { environment: environment(overrides) },
    attachTo: document.body
  })
  button('Export branch')!.click()
  await vi.waitFor(() => {
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy()
  })
  return wrapper
}

beforeEach(() => {
  posted.length = 0
  document.body.innerHTML = ''
})

describe('ExportBranchModal', () => {
  it('is disabled until the environment runs — the export reads its container', async () => {
    const wrapper = await mountSuspended(Harness, {
      props: { environment: environment({ status: 'stopped' }) },
      attachTo: document.body
    })
    expect(button('Export branch')?.disabled).toBe(true)
    wrapper.unmount()
  })

  it('preselects the checked-out branch and makes the local branch follow it', async () => {
    const wrapper = await openModal()

    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('main (checked out)')
    })
    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!
    expect(input.value).toBe('main')
    wrapper.unmount()
  })

  it('sends a blank local branch as null — fetch, but touch no branch', async () => {
    const wrapper = await openModal()
    await vi.waitFor(() => {
      expect(document.body.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('main')
    })

    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    button('Export')!.click()

    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({ branch: 'main', into: null })
    wrapper.unmount()
  })

  it('shows what came over, and why a branch was left alone', async () => {
    answer = {
      ref: 'refs/remotes/domo-env/feature-auth/main',
      sha: 'c'.repeat(40),
      commits: [{ sha: 'c'.repeat(40), subject: 'feat: something new' }],
      into: 'main',
      result: 'not-merged',
      reason: 'main has diverged from the environment; merge or rebase it yourself.'
    }
    const wrapper = await openModal()
    await vi.waitFor(() => {
      expect(document.body.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('main')
    })

    button('Export')!.click()

    await vi.waitFor(() => {
      const text = document.body.querySelector('[role="dialog"]')?.textContent ?? ''
      expect(text).toContain('Fetched, but no branch was moved')
      expect(text).toContain('main has diverged')
      expect(text).toContain('feat: something new')
      expect(text).toContain('refs/remotes/domo-env/feature-auth/main')
    })
    expect(posted[0]).toEqual({ branch: 'main', into: 'main' })
    wrapper.unmount()
  })
})
