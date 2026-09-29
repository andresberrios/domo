import { execFile } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { Browser, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DevEnvironment, Project, WorkspaceSeedReport } from '~~/shared/types'
import { launchBrowser, openPage } from '../helpers/browser'
import { SCRATCH } from './global-setup'
import { ENVIRONMENTS_SERVER_ORIGIN } from './origin'

/**
 * Development environments the way a person makes and retires them: in the
 * real app, in a real browser, against a real Docker daemon and real git.
 *
 * What only this layer can show: that the dialog offers a first commit and
 * says which branch a name makes (or reuses), that creation copies the `.env`
 * and installs by lockfile in the container, that git in the container commits
 * onto the host's repository, that retiring removes the worktree and deletes
 * the branch only when nothing is lost, and that a real Nuxt app — Domo
 * itself — installs and serves on the shared pnpm store.
 */

const exec = promisify(execFile)
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/** Creating an environment builds an image and installs; a first run also builds the runtime volume. */
const CREATE_MS = 10 * 60_000

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, ENVIRONMENTS_SERVER_ORIGIN), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  })
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}

const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', ['-C', cwd, '-c', 'user.name=Envlive', '-c', 'user.email=envlive@example.com', ...args])).stdout.trim()

const exists = (path: string) => access(path).then(() => true, () => false)

async function environmentNamed(name: string): Promise<DevEnvironment> {
  const found = (await api<DevEnvironment[]>('/api/dev-environments')).find(environment => environment.name === name)
  if (!found) throw new Error(`No environment named ${name}`)
  return found
}

/** A shell line in the environment, as its own user, in its workspace. */
async function inside(environment: DevEnvironment, script: string): Promise<string> {
  const { stdout } = await exec('docker', [
    'exec', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
    environment.containerId!, 'sh', '-c', script
  ])
  return stdout.trim()
}

/** A checkout in a scratch directory of its own, so its `.domo-worktrees` stays in there too. */
async function checkout(name: string, files: Record<string, string>): Promise<string> {
  const repo = join(SCRATCH, 'projects', name, 'repo')
  await mkdir(repo, { recursive: true })
  await git(repo, 'init', '--quiet', '--initial-branch=main')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  return repo
}

let browser: Browser
let page: Page

beforeAll(async () => {
  // The headless browser volume is several hundred megabytes from two
  // networks, and nothing here uses it.
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ browserTools: false }) })
  browser = await launchBrowser()
  page = await openPage(browser, ENVIRONMENTS_SERVER_ORIGIN)
})

afterAll(async () => {
  await browser?.close()
})

const dialog = () => page.getByRole('dialog')

async function openNewEnvironment(project: Project): Promise<void> {
  await page.goto(`${ENVIRONMENTS_SERVER_ORIGIN}/projects/${project.id}`)
  await page.getByRole('button', { name: 'New environment' }).first().click()
  await dialog().getByPlaceholder('feature-auth').waitFor()
}

/** Create from the dialog and wait for the toast that says it is ready; returns the toast's text. */
async function createFromDialog(name: string): Promise<string> {
  await dialog().getByPlaceholder('feature-auth').fill(name)
  await dialog().getByRole('button', { name: 'Create environment' }).click()
  const toast = page.getByRole('region', { name: /Notifications/ }).getByRole('listitem').filter({ hasText: `${name} is ready` })
  await toast.waitFor({ timeout: CREATE_MS })
  return (await toast.textContent()) ?? ''
}

/** Retire from the environment's own page, and return the confirmation's text and the toast's. */
async function retireFromPage(environment: DevEnvironment): Promise<{ confirmation: string, toast: string }> {
  await page.goto(`${ENVIRONMENTS_SERVER_ORIGIN}/environments/${environment.id}`)
  await page.getByRole('button', { name: 'Environment actions' }).click()
  await page.getByRole('menuitem', { name: 'Retire' }).click()
  const confirmation = (await dialog().textContent()) ?? ''
  await dialog().getByRole('button', { name: 'Retire environment' }).click()
  const toast = page.getByRole('region', { name: /Notifications/ }).getByRole('listitem').filter({ hasText: 'retired' })
  await toast.waitFor({ timeout: 5 * 60_000 })
  return { confirmation, toast: (await toast.textContent()) ?? '' }
}

describe('an npm project with no commits yet', () => {
  let repo: string
  let project: Project

  beforeAll(async () => {
    repo = await checkout('npm-app', {
      'package.json': JSON.stringify({ name: 'npm-app', version: '1.0.0', private: true, dependencies: { 'is-number': '7.0.0' } }),
      '.gitignore': 'node_modules\n.env\n',
      '.env': 'SECRET=from-the-host\n',
      'README.md': '# npm app\n'
    })
    await exec('npm', ['install', '--package-lock-only', '--silent'], { cwd: repo })
    project = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'npm app', repoPath: repo }) })
  })

  it('offers the first commit, makes the environment on a new branch, and git in it commits to the host', async () => {
    await openNewEnvironment(project)
    await dialog().getByText('This project has no commits yet').waitFor()
    await expect(dialog().getByRole('button', { name: 'Create environment' }).isDisabled()).resolves.toBe(true)
    await dialog().getByRole('button', { name: 'Create first commit' }).click()
    await dialog().getByText('This project has no commits yet').waitFor({ state: 'detached' })
    expect(await git(repo, 'log', '--format=%s')).toBe('Initial commit')
    // .gitignore is respected: the .env is not in the commit.
    expect((await git(repo, 'ls-files')).split('\n').sort()).toEqual(['.gitignore', 'README.md', 'package-lock.json', 'package.json'])

    await dialog().getByPlaceholder('feature-auth').fill('Checkout Probe')
    await dialog().getByText('Creates the branch checkout-probe from your last commit.').waitFor()
    const toast = await createFromDialog('Checkout Probe')
    expect(toast).toContain('It is on a new branch, checkout-probe, made from your last commit.')
    expect(toast).toContain('Copied .env.')

    const environment = await environmentNamed('Checkout Probe')
    expect(environment).toMatchObject({ status: 'running', branch: 'checkout-probe', branchCreated: true })
    // The ignored .env came along; the dependency was installed in the container, by lockfile.
    await expect(inside(environment, 'cat .env')).resolves.toBe('SECRET=from-the-host')
    await expect(inside(environment, 'node -p "require(\'is-number\')(5)"')).resolves.toBe('true')
    await expect(inside(environment, 'git symbolic-ref --short HEAD')).resolves.toBe('checkout-probe')
    await expect(inside(environment, 'git status --porcelain')).resolves.toBe('')

    await inside(environment, 'echo from-the-container > made-inside.txt && git add made-inside.txt && git commit --quiet -m "made inside"')
    expect(await git(repo, 'log', '-1', '--format=%s', 'checkout-probe')).toBe('made inside')
    // Not in the developer's own checkout: only on the branch.
    expect(await exists(join(repo, 'made-inside.txt'))).toBe(false)

    await page.goto(`${ENVIRONMENTS_SERVER_ORIGIN}/environments/${environment.id}`)
    await page.getByText('Made for this environment.').waitFor()
  }, CREATE_MS)

  it('retires it, removing the worktree and keeping a branch with commits of its own', async () => {
    const environment = await environmentNamed('Checkout Probe')
    const worktree = join(dirname(repo), '.domo-worktrees', environment.id)
    expect(await exists(worktree)).toBe(true)

    const { confirmation, toast } = await retireFromPage(environment)

    expect(confirmation).toContain('its branch checkout-probe is deleted if every commit on it is also on another branch')
    expect(toast).toContain('Kept the branch checkout-probe: 1 commit is on it and on no other branch.')
    expect(await exists(worktree)).toBe(false)
    expect(await git(repo, 'log', '-1', '--format=%s', 'checkout-probe')).toBe('made inside')
  }, CREATE_MS)

  it('warns before reusing a branch, refuses one checked out elsewhere, and never deletes a reused one', async () => {
    await git(repo, 'branch', 'taken')
    await openNewEnvironment(project)

    await dialog().getByPlaceholder('feature-auth').fill('main')
    await dialog().getByText('The branch main is checked out elsewhere').waitFor()
    await expect(dialog().getByRole('button', { name: 'Create environment' }).isDisabled()).resolves.toBe(true)

    await dialog().getByPlaceholder('feature-auth').fill('Taken')
    await dialog().getByText('The branch taken already exists').waitFor()
    const toast = await createFromDialog('Taken')
    expect(toast).toContain('It is on your existing branch taken, checked out with its commits.')

    const environment = await environmentNamed('Taken')
    expect(environment).toMatchObject({ branch: 'taken', branchCreated: false })
    const { confirmation } = await retireFromPage(environment)
    expect(confirmation).toContain('so does your branch taken, which it reused')
    expect(await git(repo, 'branch', '--list', 'taken')).toContain('taken')
  }, CREATE_MS)

  it('deletes the branch it made when nothing on it would be lost', async () => {
    await openNewEnvironment(project)
    await createFromDialog('Scratch Idea')
    const environment = await environmentNamed('Scratch Idea')

    const { toast } = await retireFromPage(environment)

    expect(toast).toContain('Deleted the branch scratch-idea: Every commit on it is also on main.')
    expect(await git(repo, 'branch', '--list', 'scratch-idea')).toBe('')
  }, CREATE_MS)
})

describe('Domo itself, a Nuxt app on pnpm', () => {
  it('installs by lockfile on the shared store and serves its dev server', async () => {
    // A clone of this checkout's HEAD, so nothing is made in the developer's own repository.
    const repo = join(SCRATCH, 'projects', 'domo', 'repo')
    await mkdir(dirname(repo), { recursive: true })
    await exec('git', ['clone', '--quiet', '--local', rootDir, repo])
    const project = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'domo', repoPath: repo }) })

    const created = await api<DevEnvironment & { workspaceSeed: WorkspaceSeedReport }>('/api/dev-environments', {
      method: 'POST',
      body: JSON.stringify({ projectId: project.id, name: 'nuxt-probe' })
    })

    // `nuxt prepare` is its postinstall, so this is also Nuxt resolving its modules from the global virtual store.
    expect(created.workspaceSeed.install).toEqual({ command: 'pnpm install --frozen-lockfile', error: null })
    const environment = await environmentNamed('nuxt-probe')
    // node_modules is links into the shared store, not a copy on the host's disk.
    await expect(inside(environment, 'readlink node_modules/nuxt')).resolves.toMatch(/\/opt\/domo-caches\/pnpm\//)

    await exec('docker', [
      'exec', '--detach', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
      environment.containerId!, 'sh', '-c', 'pnpm exec nuxt dev --port 3999 --host 127.0.0.1 > /tmp/nuxt-dev.log 2>&1'
    ])
    const page = await inside(environment, [
      'for i in $(seq 1 120); do curl -sf http://127.0.0.1:3999/ > /tmp/page.html && break; sleep 1; done',
      'cat /tmp/page.html'
    ].join('; '))
    expect(page).toContain('<div id="__nuxt"')
    // A module served from the store, outside the project root, and not refused.
    const storeModule = /src="(\/_nuxt\/[^"]*entry[^"]*)"|href="(\/_nuxt\/[^"]*domo-caches[^"]*)"/.exec(page)
    expect(storeModule, page.slice(0, 2000)).not.toBeNull()
    const url = storeModule![1] ?? storeModule![2]
    await expect(inside(environment, `curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3999${url}'`)).resolves.toBe('200')

    await api(`/api/dev-environments/${environment.id}`, { method: 'DELETE' })
  }, CREATE_MS)
})
