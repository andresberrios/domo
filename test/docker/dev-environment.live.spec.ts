import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { DevEnvironment } from '~~/shared/types'

/**
 * Creating a development environment for real: the real Dev Container CLI building a
 * real image, a real `docker run`, the real `createEnvironment` / `removeEnvironment`.
 * Only what is backed by Postgres (`repo`) is replaced, by an in-memory map that behaves
 * like the tables, and the port scanner, which reads them.
 *
 * `dev-environments.spec.ts` asserts on the argv handed to `docker`; that is how
 * "`devcontainer up` dies on a missing lockfile directory" got through — the argv was
 * right and the CLI still refused it. Nothing short of running it against a checkout
 * that looks like a real project can say.
 *
 * Slow (it pulls base images, builds Features and populates the runtime volume on the
 * first run) and needs the network. Opt in: `pnpm test:docker`.
 */

const state = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  ports: [] as any[],
  project: null as any
}))

vi.mock('../../server/lib/repo', () => ({
  getProject: async () => state.project,
  createDevEnvironmentRow: async (input: any) => {
    const now = new Date().toISOString()
    const row = {
      containerId: null,
      configSource: 'default',
      configPath: null,
      remoteUser: null,
      status: 'creating',
      lastError: null,
      createdAt: now,
      updatedAt: now,
      ...input
    }
    state.rows.set(input.id, row)
    return row
  },
  updateDevEnvironment: async (id: string, patch: any) => {
    const row = state.rows.get(id)
    if (!row) return null
    Object.assign(row, patch)
    return row
  },
  getDevEnvironment: async (id: string) => state.rows.get(id) ?? null,
  deleteDevEnvironmentRow: async (id: string) => { state.rows.delete(id) },
  upsertDevEnvironmentPort: async (port: any) => { state.ports.push(port) }
}))
vi.mock('../../server/lib/dev-environment-ports', () => ({
  refreshEnvironmentPorts: async () => [],
  stopEnvironmentForwarders: () => {}
}))

// Every Docker resource Domo creates for these tests is named with this, so a
// crashed run is easy to find and sweep by hand.
const PREFIX = 'domo-live-test-'
process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = PREFIX

const { run, inspectContainer, populateWorkspaceVolume } = await import('../../server/lib/dev-env/docker')
const { DEFAULT_IMAGE } = await import('../../server/lib/dev-env/config')
const { environmentImageName } = await import('../../server/lib/dev-env/image')
const { ensureRuntimeVolume, runtimeVolumeName } = await import('../../server/lib/dev-env/runtime-volume')
const {
  createEnvironment,
  readEnvironmentFile,
  removeEnvironment,
  workspaceVolumeName
} = await import('../../server/lib/dev-environments')

const HOUR = 60 * 60 * 1000
const HELPER_IMAGE = process.env.NUXT_DEV_ENV_HELPER_IMAGE || 'busybox:1.37'
/** A glibc image with git and no Node of its own — the case the runtime volume exists for. */
const BARE_IMAGE_DOCKERFILE = 'FROM debian:bookworm-slim\n'
  + 'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates '
  + '&& rm -rf /var/lib/apt/lists/*\n'
  + 'RUN useradd --create-home --shell /bin/bash dev\n'

const created: string[] = []
const scratch: string[] = []
const volumes: string[] = []

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `domo-live-${prefix}-`))
  scratch.push(path)
  return path
}

async function git(repo: string, ...args: string[]) {
  await run('git', ['-C', repo, '-c', 'user.name=Domo Test', '-c', 'user.email=test@example.com', ...args])
}

async function writeIn(repo: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, '..'), { recursive: true })
    await writeFile(join(repo, name), content, 'utf8')
  }
}

/** A committed git checkout, the way a project is when someone adds it in Domo. */
async function checkout(files: Record<string, string> = {}): Promise<string> {
  const repo = await temp('repo')
  await run('git', ['init', '--quiet', '--initial-branch=main', repo])
  await writeIn(repo, { 'README.md': '# fixture\n', 'src/index.ts': 'export {}\n', ...files })
  await git(repo, 'add', '--all')
  await git(repo, 'commit', '--quiet', '-m', 'fixture')
  return repo
}

/** What is inside the container, as the environment's own user. */
async function inContainer(environment: DevEnvironment, ...command: string[]): Promise<string> {
  const output = await run('docker', [
    'exec', '--user', environment.remoteUser!, '--workdir', environment.workspacePath,
    environment.containerId!, ...command
  ], { allowFailure: true })
  return output.stdout
}

async function mounts(containerId: string): Promise<Array<{ Type: string, Name?: string, Source: string, Destination: string }>> {
  const output = await run('docker', ['inspect', '--format', '{{json .Mounts}}', containerId])
  return JSON.parse(output.stdout)
}

async function isPrivileged(containerId: string): Promise<boolean> {
  const output = await run('docker', ['inspect', '--format', '{{.HostConfig.Privileged}}', containerId])
  return output.stdout === 'true'
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

async function create(name = 'Live Test'): Promise<DevEnvironment> {
  const environment = await createEnvironment({ projectId: 'prj_live', name })
  created.push(environment.id)
  return environment
}

beforeAll(async () => {
  // `docker info` first: with no daemon every test below would fail with a much less
  // helpful message from several layers down.
  await run('docker', ['info', '--format', '{{.ServerVersion}}'])

  process.env.NUXT_DATA_DIR = await temp('data')
  // The tools mounted into an environment are the developer's own config; never
  // hand a test the real ones.
  process.env.NUXT_CLAUDE_CONFIG_DIR = await temp('claude')
  process.env.NUXT_CODEX_CONFIG_DIR = await temp('codex')
})

afterEach(async () => {
  // Whatever a failed assertion left behind.
  for (const id of created.splice(0)) {
    const found = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`], {
      allowFailure: true
    })
    for (const container of found.stdout.split('\n').filter(Boolean)) {
      const named = (await mounts(container).catch(() => []))
        .filter(mount => mount.Type === 'volume' && mount.Name?.includes('dind-var-lib-docker'))
        .map(mount => mount.Name!)
      await run('docker', ['rm', '--force', '--volumes', container], { allowFailure: true })
      for (const volume of named) await run('docker', ['volume', 'rm', '--force', volume], { allowFailure: true })
    }
    await run('docker', ['volume', 'rm', '--force', workspaceVolumeName(id)], { allowFailure: true })
    await run('docker', ['image', 'rm', '--force', environmentImageName(id)], { allowFailure: true })
  }
  for (const volume of volumes.splice(0)) {
    await run('docker', ['volume', 'rm', '--force', volume], { allowFailure: true })
  }
})

afterAll(async () => {
  delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
  delete process.env.NUXT_DATA_DIR
  delete process.env.NUXT_CLAUDE_CONFIG_DIR
  delete process.env.NUXT_CODEX_CONFIG_DIR
  for (const path of scratch) await rm(path, { recursive: true, force: true })
})

describe('an environment for a project with no .domo.json', () => {
  it('comes up with the built-in definition and tears down completely', async () => {
    const repo = await checkout()
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await create()

    expect(environment).toMatchObject({
      status: 'running',
      lastError: null,
      workspacePath: '/workspaces/live-test',
      configSource: 'default',
      configPath: null
    })
    expect((await inspectContainer(environment.containerId!))?.running).toBe(true)

    // The checkout is the environment's own volume, and nothing binds the developer's
    // tree or Domo's data into it.
    const all = await mounts(environment.containerId!)
    expect(all).toContainEqual(expect.objectContaining({
      Type: 'volume',
      Name: workspaceVolumeName(environment.id),
      Destination: '/workspaces/live-test'
    }))
    expect(all.filter(mount => mount.Type === 'bind').map(mount => mount.Source).join('\n')).not.toContain(repo)

    // The project is in there, owned by the environment's user, and git is happy with it.
    await expect(readEnvironmentFile(environment, '/workspaces/live-test/README.md')).resolves.toBe('# fixture\n')
    await expect(inContainer(environment, 'stat', '-c', '%U', '.')).resolves.toBe(environment.remoteUser)
    await expect(inContainer(environment, 'git', 'log', '--oneline')).resolves.toMatch(/fixture/)
    await expect(inContainer(environment, 'git', 'status', '--porcelain')).resolves.toBe('')

    // Work in the environment stays in the environment.
    await inContainer(environment, 'sh', '-c', 'echo scribble > written-inside.txt')
    expect(await exists(join(repo, 'written-inside.txt'))).toBe(false)

    // The default definition asks for Node and Docker, so both are there.
    await expect(inContainer(environment, 'node', '--version')).resolves.toMatch(/^v22\./)
    expect(await isPrivileged(environment.containerId!)).toBe(true)
    await expect(inContainer(environment, 'docker', 'info', '--format', '{{.ServerVersion}}'))
      .resolves.toMatch(/^\d+\.\d+/)

    // The project's own checkout was only read.
    await expect(run('git', ['-C', repo, 'status', '--porcelain'])).resolves.toMatchObject({ stdout: '' })

    const kept = all.filter(mount => mount.Type === 'volume' && mount.Name).map(mount => mount.Name!)
    await removeEnvironment(environment.id)

    expect(await inspectContainer(environment.containerId!)).toBeNull()
    for (const name of kept) {
      if (name.startsWith(`${PREFIX}runtime-`)) continue // shared, and deliberately kept
      const left = await run('docker', ['volume', 'ls', '--quiet', '--filter', `name=^${name}$`])
      expect(left.stdout, `volume ${name} outlived its environment`).toBe('')
    }
    const image = await run('docker', ['images', '--quiet', environmentImageName(environment.id)])
    expect(image.stdout, 'the environment image outlived its environment').toBe('')
  }, HOUR / 4)
})

describe('an environment for a bare glibc image with no Node of its own', () => {
  it('runs unprivileged, and Domo\'s runtime works in it anyway', async () => {
    const repo = await checkout({
      'Dockerfile.dev': BARE_IMAGE_DOCKERFILE,
      '.domo.json': JSON.stringify({
        devEnvironment: {
          build: { dockerfile: 'Dockerfile.dev', context: '.' },
          docker: false,
          remoteUser: 'dev',
          containerEnv: { FROM_PROJECT: 'yes' },
          forwardPorts: [3000],
          portsAttributes: { 3000: { label: 'Web app', protocol: 'http' } },
          postCreateCommand: 'echo ran > /tmp/post-create'
        }
      })
    })
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await create()

    expect(environment).toMatchObject({
      status: 'running',
      remoteUser: 'dev',
      configSource: 'domo',
      configPath: '.domo.json'
    })
    // `docker: false` means exactly that: no nested daemon, no privileges.
    expect(await isPrivileged(environment.containerId!)).toBe(false)
    expect((await mounts(environment.containerId!)).map(mount => mount.Name).join('\n'))
      .not.toContain('dind-var-lib-docker')
    await expect(inContainer(environment, 'sh', '-c', 'command -v node || echo none')).resolves.toBe('none')

    // The workspace belongs to the remote user, and postCreateCommand ran as them.
    await expect(inContainer(environment, 'stat', '-c', '%U', '.')).resolves.toBe('dev')
    await expect(inContainer(environment, 'stat', '-c', '%U', '/tmp/post-create')).resolves.toBe('dev')
    await expect(inContainer(environment, 'printenv', 'FROM_PROJECT')).resolves.toBe('yes')
    await expect(inContainer(environment, 'printenv', 'DOMO_DEV_ENVIRONMENT_ID')).resolves.toBe(environment.id)

    // The declared port is published, and its attributes rode along on the container.
    const inspection = await inspectContainer(environment.containerId!)
    expect(inspection!.publishedPorts).toContainEqual(
      expect.objectContaining({ innerPort: 3000, protocol: 'tcp', hostPort: expect.any(Number) })
    )
    expect(JSON.parse(inspection!.labels['domo.portsAttributes']!))
      .toEqual({ 3000: { label: 'Web app', protocol: 'http' } })
    expect(state.ports).toContainEqual(expect.objectContaining({
      environmentId: environment.id, innerPort: 3000, source: 'declared'
    }))

    // The point of the whole runtime volume: an ACP adapter starts and answers, in an
    // image that has no Node. `initialize` needs no account.
    const initialize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }
    })
    const answer = await run('docker', [
      'exec', '--interactive', '--user', 'dev', '--workdir', environment.workspacePath,
      environment.containerId!, '/opt/domo/bin/claude-agent-acp'
    ], { input: `${initialize}\n` })
    expect(JSON.parse(answer.stdout.split('\n')[0]!)).toMatchObject({
      id: 1,
      result: { agentInfo: { name: '@agentclientprotocol/claude-agent-acp' } }
    })

    await removeEnvironment(environment.id)
    expect(await inspectContainer(environment.containerId!)).toBeNull()
  }, HOUR / 4)
})

describe('an environment whose image cannot run Domo\'s runtime', () => {
  it('fails creation with a readable message and leaves nothing behind', async () => {
    // With git, so the preflight gets as far as the bundled Node and reports the real
    // problem: the binary is glibc-linked and musl has no loader for it.
    const repo = await checkout({
      'Dockerfile.alpine': 'FROM alpine:3\nRUN apk add --no-cache git\n',
      '.domo.json': JSON.stringify({
        devEnvironment: { build: { dockerfile: 'Dockerfile.alpine' }, docker: false }
      })
    })
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }

    let id = ''
    await expect(
      createEnvironment({ projectId: 'prj_live', name: 'Live Test Alpine' })
        .catch((error) => {
          id = [...state.rows.keys()][0]!
          throw error
        })
    ).rejects.toThrow(/glibc-based/)

    created.push(id)
    expect(state.rows.get(id)).toMatchObject({ status: 'error' })
    const containers = await run('docker', ['ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`])
    expect(containers.stdout, 'a container outlived a failed creation').toBe('')
    const volume = await run('docker', [
      'volume', 'ls', '--quiet', '--filter', `name=^${workspaceVolumeName(id)}$`
    ])
    expect(volume.stdout, 'the workspace volume outlived a failed creation').toBe('')
    const image = await run('docker', ['images', '--quiet', environmentImageName(id)])
    expect(image.stdout, 'the image outlived a failed creation').toBe('')
  }, HOUR / 4)
})

describe('two environments of the same project', () => {
  it('share one runtime volume, built once', async () => {
    const repo = await checkout({
      '.domo.json': JSON.stringify({
        devEnvironment: {
          image: DEFAULT_IMAGE,
          docker: false,
          remoteUser: 'vscode',
          features: { 'ghcr.io/devcontainers/features/node:1': { version: '20' } }
        }
      })
    })
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }

    const first = await create('Live Test One')
    const second = await create('Live Test Two')
    const shared = await ensureRuntimeVolume()

    expect(shared).toBe(runtimeVolumeName((await run('docker', ['version', '--format', '{{.Server.Arch}}'])).stdout))
    for (const environment of [first, second]) {
      expect((await mounts(environment.containerId!))).toContainEqual(expect.objectContaining({
        Type: 'volume', Name: shared, Destination: '/opt/domo', RW: false
      }))
      // The Feature the project asked for was baked into the image.
      await expect(inContainer(environment, 'node', '--version')).resolves.toMatch(/^v20\./)
    }
    const built = await run('docker', ['volume', 'ls', '--quiet', '--filter', `name=^${PREFIX}runtime-`])
    expect(built.stdout.split('\n').filter(Boolean)).toEqual([shared])
  }, HOUR / 2)
})

describe('populateWorkspaceVolume', () => {
  it('copies a checkout, keeping hidden files and leaving out a data dir that lives inside it', async () => {
    const repo = await checkout({
      '.hidden': 'dotfile\n',
      '.domo-data/dev-environments/env_old/repo/stale.txt': 'old\n',
      'tools/state/domo/uploads/photo.png': 'not a copy target\n'
    })
    const volume = `${PREFIX}populate-${Date.now()}`
    volumes.push(volume)
    await run('docker', ['volume', 'create', volume])

    await populateWorkspaceVolume({
      source: repo,
      volume,
      helperImage: HELPER_IMAGE,
      exclude: ['.domo-data', 'tools/state/domo']
    })

    const listing = (await run('docker', [
      'run', '--rm', '--volume', `${volume}:/w`, HELPER_IMAGE,
      'find', '/w', '-not', '-path', '/w/.git/*', '-type', 'f'
    ])).stdout.split('\n').sort()

    expect(listing).toEqual(expect.arrayContaining(['/w/README.md', '/w/src/index.ts', '/w/.hidden']))
    expect(listing.join('\n')).not.toMatch(/stale\.txt|photo\.png/)
    // macOS `tar` adds AppleDouble companions unless told not to.
    expect(listing.filter(path => path.split('/').pop()!.startsWith('._'))).toEqual([])
  }, 5 * 60 * 1000)
})
