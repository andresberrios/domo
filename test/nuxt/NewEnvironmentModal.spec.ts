import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'

import NewEnvironmentModal from '~/components/NewEnvironmentModal.vue'
import type { Project, RepositoryState } from '~~/shared/types'

/**
 * A worktree is cut from a commit, so a project with none is offered its first
 * commit in the dialog, before anything else can be done there.
 */

const project: Project = {
  id: 'p1',
  name: 'Domo',
  repoPath: '/work/domo',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  retiredAt: null
}

let state: RepositoryState = { repository: true, hasCommits: true, filesToCommit: null, branches: [] }
const committed: string[] = []

registerEndpoint('/api/projects/p1/repository', () => state)
registerEndpoint('/api/projects/p1/initial-commit', {
  method: 'POST',
  handler: () => {
    committed.push('p1')
    state = { repository: true, hasCommits: true, filesToCommit: null, branches: [] }
    return { commit: 'abc' }
  }
})

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(NewEnvironmentModal, { open: true, project }) })
})

function buttonWithText(text: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.includes(text))
}

async function settle() {
  for (let index = 0; index < 5; index++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

beforeEach(() => {
  committed.length = 0
  document.body.innerHTML = ''
})

describe('NewEnvironmentModal', () => {
  it('offers the first commit for a project with none, and blocks creating until it exists', async () => {
    state = { repository: true, hasCommits: false, filesToCommit: 12, branches: [] }
    await mountSuspended(Harness, { attachTo: document.body })
    await settle()

    expect(document.body.textContent).toContain('This project has no commits yet')
    expect(document.body.textContent).toContain('12 files')
    expect(buttonWithText('Create environment')?.disabled).toBe(true)

    buttonWithText('Create first commit')!.click()
    await settle()

    expect(committed).toEqual(['p1'])
    expect(document.body.textContent).not.toContain('This project has no commits yet')
  })

  it('says which branch the name makes, and warns before reusing or colliding with one', async () => {
    state = {
      repository: true,
      hasCommits: true,
      filesToCommit: null,
      branches: [{ name: 'main', checkedOut: true }, { name: 'old-work', checkedOut: false }, { name: 'handoff/Speech', checkedOut: false }]
    }
    await mountSuspended(Harness, { attachTo: document.body })
    await settle()
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="feature-auth"]')!
    const type = async (value: string) => {
      input.value = value
      input.dispatchEvent(new Event('input'))
      await settle()
    }

    await type('fresh-idea')
    expect(document.body.textContent).toContain('Creates the branch fresh-idea from your last commit.')
    expect(buttonWithText('Create environment')?.disabled).toBe(false)

    // The name is the branch as typed: slashes and case stay.
    await type('feature/Auth')
    expect(document.body.textContent).toContain('Creates the branch feature/Auth from your last commit.')
    await type('handoff/Speech')
    expect(document.body.textContent).toContain('The branch handoff/Speech already exists')

    // Git's rules, said as it is typed, and nothing to create until it is fixed.
    await type('Fresh Idea')
    expect(document.body.textContent).toContain('A branch name cannot contain spaces or control characters.')
    expect(buttonWithText('Create environment')?.disabled).toBe(true)

    await type('old-work')
    expect(document.body.textContent).toContain('The branch old-work already exists')
    expect(document.body.textContent).not.toContain('Creates the branch')
    expect(buttonWithText('Create environment')?.disabled).toBe(false)

    await type('main')
    expect(document.body.textContent).toContain('The branch main is checked out elsewhere')
    expect(buttonWithText('Create environment')?.disabled).toBe(true)
  })

  it('says nothing about commits, and offers no carry switch, for a project that has them', async () => {
    state = { repository: true, hasCommits: true, filesToCommit: null, branches: [] }
    await mountSuspended(Harness, { attachTo: document.body })
    await settle()

    expect(document.body.textContent).not.toContain('no commits yet')
    expect(document.body.textContent).not.toContain('Carry uncommitted')
  })
})
