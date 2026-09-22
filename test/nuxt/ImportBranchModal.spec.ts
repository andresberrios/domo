import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ImportBranchModal from '~/components/ImportBranchModal.vue'
import type { DevEnvironment, EnvironmentBranchImport, ImportPlan } from '~~/shared/types'

/**
 * The other direction's face. The branch it starts on is the environment's own
 * checked-out one, because that is what an import almost always means —
 * importing into a branch the agent is *not* on is inert, since nothing in the
 * container ever tells it that branch moved. What the server decided, including
 * a diversion and who was told, has to come back out on screen.
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

registerEndpoint('/api/dev-environments/env_1/branches', () => ({
  current: 'main',
  branches: [
    { name: 'feat/x', sha: 'b'.repeat(40), subject: 'feat: x' },
    { name: 'main', sha: 'a'.repeat(40), subject: 'docs: y' }
  ]
}))

let planned: ImportPlan = {
  requested: 'main',
  from: 'main',
  branch: 'domo-import/main',
  toSideBranch: false,
  sideBranchReason: null,
  checkedOut: 'main',
  commitFirst: null,
  merge: true,
  notify: [{ agentSessionId: 'ag_1', title: 'the agent', busy: false }],
  resolver: { agentSessionId: 'ag_1', title: 'the agent', busy: false }
}
registerEndpoint('/api/dev-environments/env_1/import-plan', {
  method: 'POST',
  handler: () => planned
})

const posted: any[] = []
const landed: EnvironmentBranchImport = {
  branch: 'main',
  requested: 'main',
  from: 'main',
  sha: 'a'.repeat(40),
  commits: [{ sha: 'a'.repeat(40), subject: 'docs: y' }],
  result: 'merged',
  wip: null,
  notified: [{ agentSessionId: 'ag_1', title: 'the agent', via: 'inbox' }]
}
let answer: EnvironmentBranchImport = landed
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
  answer = landed
  planned = {
    requested: 'main',
    from: 'main',
    branch: 'domo-import/main',
    toSideBranch: false,
    sideBranchReason: null,
    checkedOut: 'main',
    commitFirst: null,
    merge: true,
    notify: [{ agentSessionId: 'ag_1', title: 'the agent', busy: false }],
    resolver: { agentSessionId: 'ag_1', title: 'the agent', busy: false }
  }
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

  // The reported incident: work lands on the host and the environment's own
  // branch is stale. That branch is the default, not a thing to avoid.
  it('starts on the branch the environment has checked out', async () => {
    const wrapper = await openModal()

    const [from, branch] = inputs()
    expect(from!.value).toBe('main')
    expect(branch!.value).toBe('main')
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('main (checked out)')
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

  // It used to be disabled here, on a premise that was wrong: this is the case
  // the whole feature exists for, so it has to be submittable.
  it('lets the environment\'s own branch be imported into', async () => {
    const wrapper = await openModal()

    expect(button('Import')?.disabled).toBe(false)

    button('Import')!.click()
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    wrapper.unmount()
  })

  /**
   * The outcome depends on live state — is a turn running, is the tree dirty —
   * so the button has to say what it will do before it is pressed. Rendered
   * from the server's own plan, never guessed at here.
   */
  it('says what it will do before it is pressed', async () => {
    planned = {
      ...planned,
      commitFirst: { paths: ['app/main.css', 'app/app.vue'], total: 2 }
    }
    const wrapper = await openModal()

    await vi.waitFor(() => {
      const text = document.body.querySelector('[role="dialog"]')?.textContent ?? ''
      expect(text).toContain('Will merge into “main”')
      expect(text).toContain('Commit 2 uncommitted files')
      expect(text).toContain('app/main.css')
      expect(text).toContain('merge it into "main"')
      expect(text).toContain('If the merge conflicts')
      expect(text).toContain('Tell the agent')
      expect(text).toContain('Ask the agent')
    })
    wrapper.unmount()
  })

  it('says the working tree will be left alone while an agent is mid-turn', async () => {
    planned = {
      ...planned,
      toSideBranch: true,
      sideBranchReason: 'agent-mid-turn',
      merge: false,
      commitFirst: null,
      notify: [{ agentSessionId: 'ag_1', title: 'the agent', busy: true }],
      resolver: { agentSessionId: 'ag_1', title: 'the agent', busy: true }
    }
    const wrapper = await openModal()

    await vi.waitFor(() => {
      const text = document.body.querySelector('[role="dialog"]')?.textContent ?? ''
      expect(text).toContain('Will land on “domo-import/main”')
      expect(text).toContain('working tree is left alone entirely')
      expect(text).not.toContain('Commit ')
    })
    wrapper.unmount()
  })

  it('says when there is nobody in the environment to tell', async () => {
    planned = { ...planned, notify: [], resolver: null }
    const wrapper = await openModal()

    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="dialog"]')?.textContent)
        .toContain('nobody to tell')
    })
    wrapper.unmount()
  })

  it('says who was told, and where a diverted branch landed', async () => {
    answer = {
      ...landed,
      branch: 'domo-import/main',
      requested: 'main',
      result: 'fast-forwarded',
      diverted: 'An agent is mid-turn in this environment, so "main" was left on "domo-import/main".',
      notified: [{ agentSessionId: 'ag_1', title: 'the agent', via: 'steer' }]
    }
    const wrapper = await openModal()

    button('Import')!.click()

    await vi.waitFor(() => {
      const text = document.body.querySelector('[role="dialog"]')?.textContent ?? ''
      expect(text).toContain('domo-import/main fast-forwarded')
      expect(text).toContain('is mid-turn')
      expect(text).toContain('the agent')
      expect(text).toContain('steer')
    })
    wrapper.unmount()
  })

  // The agent's own files being committed is the thing a person most needs to
  // see, because a commit nobody made looks like something went wrong.
  it('names the commit uncommitted work was parked in', async () => {
    answer = { ...landed, wip: 'f'.repeat(40) }
    const wrapper = await openModal()

    button('Import')!.click()

    await vi.waitFor(() => {
      const text = document.body.querySelector('[role="dialog"]')?.textContent ?? ''
      expect(text).toContain('Merged into main')
      expect(text).toContain('committed first')
      expect(text).toContain('ffffffff')
      expect(text).toContain('nothing was stashed or discarded')
    })
    wrapper.unmount()
  })

  it('shows a conflict as not merged, pointing at the side branch', async () => {
    answer = {
      ...landed,
      branch: 'domo-import/main',
      sha: 'c'.repeat(40),
      commits: [],
      result: 'not-merged',
      wip: 'f'.repeat(40),
      notified: [],
      resolver: { agentSessionId: 'ag_1', title: 'the agent', busy: false },
      reason: 'The imported commits are on "domo-import/main", but merging them into "main" conflicts. '
        + 'The merge was aborted, so the environment\'s working tree is untouched.'
    }
    const wrapper = await openModal()

    button('Import')!.click()

    await vi.waitFor(() => {
      const text = document.body.querySelector('[role="dialog"]')?.textContent ?? ''
      expect(text).toContain('Not merged')
      expect(text).toContain('conflicts')
      expect(text).toContain('working tree is untouched')
      expect(text).toContain('No commits crossed.')
      // One session only, and the reason, so nobody races it.
      expect(text).toContain('the agent was asked to merge it')
      expect(text).toContain('single checkout')
    })
    wrapper.unmount()
  })
})
