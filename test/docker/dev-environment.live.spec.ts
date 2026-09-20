import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { DevEnvironment } from '~~/shared/types'

/**
 * Creating a development environment for real: the real Dev Container CLI, a
 * real Docker daemon, the real `createEnvironment` / `removeEnvironment`. Only
 * what is backed by Postgres (`repo`) is replaced, by an in-memory map that
 * behaves like the tables, and the port scanner, which reads them.
 *
 * `dev-environments.spec.ts` asserts on the argv handed to `docker`; that is
 * how "`devcontainer up` dies on a missing lockfile directory" got through — the
 * argv was right and the CLI still refused it. Nothing short of running the CLI
 * against a checkout that looks like a real project can say.
 *
 * Slow (it pulls the base image and builds the Node and Docker-in-Docker
 * Features on the first run, and installs both ACP adapters into every
 * environment) and needs the network. Opt in: `pnpm test:docker`.
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
      hostWorkspacePath: null,
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

const { run, inspectContainer, populateWorkspaceVolume } = await import('../../server/lib/devcontainer/client')
const { DEFAULT_IMAGE } = await import('../../server/lib/devcontainer/config')
const {
  createEnvironment,
  readEnvironmentFile,
  removeEnvironment,
  workspaceVolumeName
} = await import('../../server/lib/dev-environments')

const HOUR = 60 * 60 * 1000
const HELPER_IMAGE = process.env.NUXT_DEV_ENV_HELPER_IMAGE || 'busybox:1.37'
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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

interface Scenario {
  label: string
  files: Record<string, string>
  /** Where the checkout is mounted; Domo picks `/workspaces/live-test` unless the project's own config says otherwise. */
  workspace?: string
  /** Extra assertions inside the running environment. */
  verify?: (environment: DevEnvironment) => Promise<void>
}

const scenarios: Scenario[] = [
  {
    label: 'no environment definition at all (Domo\'s built-in one)',
    files: {}
  },
  {
    label: 'a .domo.json that only picks an image, with a forwarded port',
    files: {
      '.domo.json': JSON.stringify({
        devEnvironment: { image: DEFAULT_IMAGE, remoteUser: 'vscode', forwardPorts: [3000] }
      })
    },
    verify: async (environment) => {
      const inspection = await inspectContainer(environment.containerId!)
      expect(inspection!.publishedPorts).toContainEqual(
        expect.objectContaining({ innerPort: 3000, protocol: 'tcp', hostPort: expect.any(Number) })
      )
      expect(state.ports).toContainEqual(expect.objectContaining({
        environmentId: environment.id, innerPort: 3000, source: 'declared'
      }))
    }
  },
  {
    label: 'the project\'s own devcontainer.json using an image',
    files: {
      '.devcontainer/devcontainer.json': `// comments and trailing commas are legal here
{
  "image": "${DEFAULT_IMAGE}",
  "remoteUser": "vscode",
  "containerEnv": { "FROM_PROJECT": "yes", },
  "postCreateCommand": "echo ran > /tmp/post-create",
}
`
    },
    verify: async (environment) => {
      await expect(inContainer(environment, 'printenv', 'FROM_PROJECT')).resolves.toBe('yes')
      // Lifecycle commands run after the volume is handed to the remote user, as that user.
      await expect(inContainer(environment, 'stat', '-c', '%U', '/tmp/post-create')).resolves.toBe('vscode')
    }
  },
  {
    label: 'the project\'s own devcontainer.json building a Dockerfile by relative path',
    files: {
      '.devcontainer/devcontainer.json': JSON.stringify({
        build: { dockerfile: 'Dockerfile', context: '..', args: { MARK: 'yes' } },
        remoteUser: 'vscode'
      }),
      '.devcontainer/Dockerfile': `FROM ${DEFAULT_IMAGE}\nARG MARK=no\nCOPY README.md /etc/domo-fixture-readme\nRUN echo "built with $MARK" >> /etc/domo-fixture-readme\n`
    },
    verify: async (environment) => {
      // `context: ..` is the repository root: this only exists if both the
      // Dockerfile and the context resolved against the project's own checkout.
      await expect(inContainer(environment, 'cat', '/etc/domo-fixture-readme')).resolves.toBe('# fixture\nbuilt with yes')
    }
  },
  {
    label: 'a Docker Compose definition that binds the checkout by relative path',
    workspace: '/workspaces/compose-fixture',
    files: {
      '.devcontainer/devcontainer.json': JSON.stringify({
        dockerComposeFile: 'docker-compose.yml',
        service: 'app',
        workspaceFolder: '/workspaces/compose-fixture',
        remoteUser: 'vscode'
      }),
      '.devcontainer/docker-compose.yml': [
        'services:',
        '  app:',
        `    image: ${DEFAULT_IMAGE}`,
        '    command: sleep infinity',
        '    volumes:',
        '      - ..:/workspaces/compose-fixture:cached',
        '      - ../src:/extra-src',
        ''
      ].join('\n')
    },
    verify: async (environment) => {
      // The compose file says `..`, which is the live checkout on the host; both
      // of its binds must have become the environment's own volume instead.
      const bound = (await mounts(environment.containerId!)).filter(mount => mount.Type === 'bind')
      expect(bound.map(mount => mount.Destination)).not.toContain('/extra-src')
      expect(bound.map(mount => mount.Destination)).not.toContain('/workspaces/compose-fixture')
      await expect(inContainer(environment, 'cat', '/extra-src/index.ts')).resolves.toBe('export {}')
    }
  }
]

let meshEntry: string

beforeAll(async () => {
  // `docker info` first: with no daemon every scenario below would fail with the
  // CLI's own, much less helpful, message.
  await run('docker', ['info', '--format', '{{.ServerVersion}}'])

  process.env.NUXT_DATA_DIR = await temp('data')
  // The tools mounted into an environment are the developer's own config; never
  // hand a test the real ones.
  process.env.NUXT_CLAUDE_CONFIG_DIR = await temp('claude')
  process.env.NUXT_CODEX_CONFIG_DIR = await temp('codex')
  meshEntry = resolve(process.cwd(), 'server/mcp/agent-mesh.mjs')
  process.env.NUXT_DOMO_MCP_ENTRY = meshEntry
})

afterEach(async () => {
  // Whatever a failed assertion left behind.
  for (const id of created.splice(0)) {
    await run('docker', ['compose', '--project-name', `${PREFIX}${id}`, 'down', '--volumes', '--remove-orphans'], {
      allowFailure: true
    })
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
  delete process.env.NUXT_DOMO_MCP_ENTRY
  for (const path of scratch) await rm(path, { recursive: true, force: true })
})

describe.each(scenarios)('an environment for $label', ({ files, workspace = '/workspaces/live-test', verify }) => {
  it('comes up, runs the project and tears down completely', async () => {
    const repo = await checkout(files)
    state.project = { id: 'prj_live', name: 'fixture', repoPath: repo }
    state.ports.length = 0

    const environment = await createEnvironment({ projectId: 'prj_live', name: 'Live Test' })
    created.push(environment.id)
    const volume = workspaceVolumeName(environment.id)

    // What was recorded. There is no host copy: the checkout is the volume.
    expect(environment).toMatchObject({ status: 'running', lastError: null, workspacePath: workspace })
    expect(environment.containerId).toBeTruthy()
    expect(environment.remoteUser).toBeTruthy()
    expect(environment.hostWorkspacePath).toBeNull()
    expect((await inspectContainer(environment.containerId!))?.running).toBe(true)

    // The checkout is the environment's own volume, and nothing binds the
    // developer's tree or Domo's data into it.
    const all = await mounts(environment.containerId!)
    expect(all).toContainEqual(expect.objectContaining({ Type: 'volume', Name: volume, Destination: workspace }))
    expect(all.filter(mount => mount.Type === 'bind').map(mount => mount.Source).join('\n'))
      .not.toContain(repo)

    // The project is in there, owned by the environment's user, and git is happy
    // with it: no dubious-ownership refusal, nothing the CLI left behind.
    await expect(readEnvironmentFile(environment, `${workspace}/README.md`)).resolves.toBe('# fixture\n')
    await expect(inContainer(environment, 'stat', '-c', '%U', '.')).resolves.toBe(environment.remoteUser)
    await expect(inContainer(environment, 'git', 'log', '--oneline')).resolves.toMatch(/fixture/)
    await expect(inContainer(environment, 'git', 'status', '--porcelain')).resolves.toBe('')

    // Work in the environment stays in the environment.
    await inContainer(environment, 'sh', '-c', 'echo scribble > written-inside.txt')
    expect(await exists(join(repo, 'written-inside.txt'))).toBe(false)

    // The agents' runtime: both adapters, and the mesh server the agents call
    // Domo back through.
    await expect(inContainer(environment, 'sh', '-c', 'command -v claude-agent-acp && command -v codex-acp'))
      .resolves.toMatch(/claude-agent-acp\n.*codex-acp/)
    await expect(readEnvironmentFile(environment, '/opt/domo/agent-mesh.mjs'))
      .resolves.toBe(await readFile(meshEntry, 'utf8'))

    // Privileged with a working nested daemon, so agents can `docker compose`.
    await vi.waitFor(async () => {
      const version = await inContainer(environment, 'docker', 'info', '--format', '{{.ServerVersion}}')
      expect(version).toMatch(/^\d+\.\d+/)
    }, { timeout: 90_000, interval: 3_000 })

    await verify?.(environment)

    // The project's own checkout was only read.
    await expect(run('git', ['-C', repo, 'status', '--porcelain'])).resolves.toMatchObject({ stdout: '' })

    // Deleting leaves nothing: the container, every volume it had, the compose
    // project's network and sidecars.
    const kept = all.filter(mount => mount.Type === 'volume' && mount.Name).map(mount => mount.Name!)
    expect(kept).toContain(volume)

    await removeEnvironment(environment.id)

    expect(await inspectContainer(environment.containerId!)).toBeNull()
    for (const name of kept) {
      const left = await run('docker', ['volume', 'ls', '--quiet', '--filter', `name=^${name}$`])
      expect(left.stdout, `volume ${name} outlived its environment`).toBe('')
    }
    const project = await run('docker', [
      'ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${PREFIX}${environment.id}`
    ])
    expect(project.stdout, 'a compose service outlived its environment').toBe('')
  }, HOUR / 4)
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
