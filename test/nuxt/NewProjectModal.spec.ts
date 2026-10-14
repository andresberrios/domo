import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery, readBody } from 'h3'
import { UApp } from '#components'
import { defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'

import NewProjectModal from '~/components/NewProjectModal.vue'
import type { ProjectPathState } from '~~/shared/types'

/**
 * A project can be an existing checkout, a folder that is not a repository
 * yet, or a path that does not exist. The form says which before anything is
 * written, the button names what it will do, and only then is `initialize`
 * sent.
 */

let states: Record<string, ProjectPathState> = {}
const posted: any[] = []

function state(path: string, patch: Partial<ProjectPathState>): ProjectPathState {
  return { path, kind: 'repository', empty: false, toCreate: [], enclosingRepository: null, problem: null, ...patch }
}

registerEndpoint('/api/projects/inspect-path', (event) => {
  const path = String(getQuery(event).path)
  return states[path] ?? state(path, { kind: 'missing', toCreate: [path] })
})
registerEndpoint('/api/projects', {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody(event)
    posted.push(body)
    return { id: 'p1', name: 'x', repoPath: body.repoPath, createdAt: '', updatedAt: '', retiredAt: null }
  }
})
registerEndpoint('/api/fs/list', () => ({
  path: '/home/me/code',
  parent: '/home/me',
  directories: [{ name: 'domo', path: '/home/me/code/domo' }]
}))

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(NewProjectModal, { open: true }) })
})

function buttonWithText(text: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.trim() === text)
}

async function settle(ms = 0) {
  await new Promise(resolve => setTimeout(resolve, ms))
  for (let index = 0; index < 5; index++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function typePath(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="~/code/my-project"]')!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await settle(300)
}

beforeEach(() => {
  posted.length = 0
  states = {}
  document.body.innerHTML = ''
})

describe('NewProjectModal', () => {
  it('adds a checkout as it is', async () => {
    states['/home/me/code/domo'] = state('/home/me/code/domo', { kind: 'repository' })
    await mountSuspended(Harness, { attachTo: document.body })
    await typePath('/home/me/code/domo')

    expect(document.body.textContent).toContain('A git checkout')
    buttonWithText('Add project')!.click()
    await settle()

    expect(posted).toEqual([{ repoPath: '/home/me/code/domo', initialize: false }])
  })

  it('says every folder a missing path would make, and creates it only when asked by name', async () => {
    states['/home/me/cdoe/app'] = state('/home/me/cdoe/app', { kind: 'missing', toCreate: ['/home/me/cdoe', '/home/me/cdoe/app'] })
    await mountSuspended(Harness, { attachTo: document.body })
    await typePath('/home/me/cdoe/app')

    expect(document.body.textContent).toContain('Creates 2 folders (cdoe / app)')
    expect(buttonWithText('Add project')).toBeUndefined()
    buttonWithText('Create and add')!.click()
    await settle()

    expect(posted).toEqual([{ repoPath: '/home/me/cdoe/app', initialize: true }])
  })

  it('offers git init for a plain folder, and says its files are not committed', async () => {
    states['/home/me/notes'] = state('/home/me/notes', { kind: 'directory', empty: false })
    await mountSuspended(Harness, { attachTo: document.body })
    await typePath('/home/me/notes')

    expect(document.body.textContent).toContain('nothing is committed')
    buttonWithText('Initialise and add')!.click()
    await settle()

    expect(posted).toEqual([{ repoPath: '/home/me/notes', initialize: true }])
  })

  it('points at the repository a folder is inside, and refuses a file', async () => {
    states['/home/me/code/domo/app'] = state('/home/me/code/domo/app', { kind: 'directory', enclosingRepository: '/home/me/code/domo' })
    states['/home/me/code/domo'] = state('/home/me/code/domo', { kind: 'repository' })
    states['/home/me/notes.txt'] = state('/home/me/notes.txt', { kind: 'file', problem: '/home/me/notes.txt is a file, not a folder.' })
    await mountSuspended(Harness, { attachTo: document.body })
    await typePath('/home/me/code/domo/app')

    expect(document.body.textContent).toContain('This is inside another git repository')
    buttonWithText('Use that repository')!.click()
    await settle(300)
    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="~/code/my-project"]')!.value).toBe('/home/me/code/domo')
    expect(buttonWithText('Add project')).toBeTruthy()

    await typePath('/home/me/notes.txt')
    expect(document.body.textContent).toContain('is a file, not a folder')
    expect(buttonWithText('Add project')!.disabled).toBe(true)
  })

  it('names a new folder inside the one being browsed, without creating it', async () => {
    await mountSuspended(Harness, { attachTo: document.body })
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Browse"]')!.click()
    await settle()

    buttonWithText('New folder')!.click()
    await settle()
    const name = document.body.querySelector<HTMLInputElement>('input[aria-label="New folder name"]')!
    name.value = 'a/b'
    name.dispatchEvent(new Event('input'))
    await settle()
    expect(document.body.textContent).toContain('A folder name, without slashes.')

    name.value = 'side-project'
    name.dispatchEvent(new Event('input'))
    await settle()
    buttonWithText('Use')!.click()
    await settle(300)

    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="~/code/my-project"]')!.value).toBe('/home/me/code/side-project')
    expect(buttonWithText('Create and add')).toBeTruthy()
    expect(posted).toEqual([])
  })
})
