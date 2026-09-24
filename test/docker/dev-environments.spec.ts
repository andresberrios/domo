import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DevEnvironment } from '~~/shared/types'

/**
 * Docker is driven at the process boundary: `run('docker', [...])` with an
 * argument array, never an interpolated shell string. These tests assert on the
 * exact argv and on the order the steps happen in, which is where the rules live —
 * a `postCreateCommand` that runs before the workspace is chowned, or a failure that
 * leaves an image behind, is not visible anywhere else. No Docker daemon is involved;
 * see the `.live` spec for the handful of tests that need a real one.
 */

const state = vi.hoisted(() => ({ homeMounts: [] as string[] }))
const run = vi.fn(async (_program: string, _args: string[], _options?: unknown) => ({ stdout: '', stderr: '' }))
// The daemon's OS decides which SSH agent branch `detectSshAgent()` takes. Mocked,
// because the real probe runs `docker info` on whatever machine runs the tests:
// on a Mac it answers "Docker Desktop" and the socket test below fails.
const dockerServerOs = vi.fn(async () => 'Ubuntu 24.04.3 LTS')
const inspectContainer = vi.fn()
const populateWorkspaceVolume = vi.fn(async () => undefined)
const copyIntoContainer = vi.fn(async () => undefined)
const buildEnvironmentImage = vi.fn(async () => 'domo-dev-env_1')
const readImageMetadata = vi.fn()
const ensureRuntimeVolume = vi.fn(async () => 'domo-dev-runtime-abc123')
const collectRuntimeVolumes = vi.fn(async () => undefined)
// The proxy is a real listening socket and its own spec is live; here it is
// only a step in the order of things.
const dood = {
  ensureDoodProxy: vi.fn(async ({ environmentId }: { environmentId: string }) =>
    ({ socketPath: `/sockets/${environmentId}.sock`, close: async () => {} })),
  stopDoodProxy: vi.fn(async () => undefined),
  stopEnvironmentContainers: vi.fn(async () => undefined),
  sweepEnvironmentResources: vi.fn(async () => undefined)
}
const repo = {
  createDevEnvironmentRow: vi.fn(),
  // Removal tombstones the row rather than deleting it: the retired sessions
  // that ran here still name it. `pruneRetiredRecords` is what eventually
  // drops it, once nothing does.
  retireDevEnvironmentRow: vi.fn(),
  pruneRetiredRecords: vi.fn(async () => ({ environments: 0, projects: 0 })),
  getDevEnvironment: vi.fn(),
  getProject: vi.fn(),
  updateDevEnvironment: vi.fn(),
  upsertDevEnvironmentPort: vi.fn()
}

vi.mock('../../server/lib/dev-env/docker', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  run,
  dockerServerOs,
  inspectContainer,
  populateWorkspaceVolume,
  copyIntoContainer,
  resourcePrefix: () => 'domo-dev-'
}))
vi.mock('../../server/lib/dev-env/image', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildEnvironmentImage,
  removeImage: async (image: string) => { await run('docker', ['image', 'rm', image], { allowFailure: true }) }
}))
vi.mock('../../server/lib/dev-env/container', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readImageMetadata
}))
vi.mock('../../server/lib/dev-env/runtime-volume', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureRuntimeVolume,
  collectRuntimeVolumes
}))
vi.mock('../../server/lib/dev-environment-ports', () => ({
  refreshEnvironmentPorts: vi.fn(async () => []),
  stopEnvironmentForwarders: vi.fn()
}))
vi.mock('../../server/lib/repo', () => repo)
vi.mock('../../server/lib/dood/manager', () => dood)
// Settings live in Postgres, and this project has none. The home overlay is the
// only thing here that reads them.
vi.mock('../../server/lib/settings', () => ({ getSettings: async () => ({ homeMounts: state.homeMounts }) }))

const {
  containerExecArgs,
  createEnvironment,
  readEnvironmentFile,
  retireEnvironment,
  startEnvironment,
  stopEnvironment,
  writeEnvironmentFile
} = await import('../../server/lib/dev-environments')

const EMPTY_METADATA = {
  entrypoints: [],
  privileged: false,
  init: false,
  capAdd: [],
  securityOpt: [],
  containerEnv: {},
  volumeMounts: [],
  remoteUser: 'vscode',
  containerUser: null
}

function environment(overrides: Partial<DevEnvironment> = {}): DevEnvironment {
  return {
    id: 'env_1',
    projectId: 'prj_1',
    name: 'api',
    containerName: 'domo-dev-env_1',
    containerId: 'container-sha',
    workspacePath: '/workspaces/api',
    configSource: 'default',
    configPath: null,
    remoteUser: 'vscode',
    status: 'running',
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    ...overrides
  }
}

/** Every `docker` invocation, as argv. */
function dockerCalls(): string[][] {
  return run.mock.calls.filter(([program]) => program === 'docker').map(([, args]) => args)
}

/** The index of the first `docker` call whose argv contains all of `needles`. */
function stepAt(...needles: string[]): number {
  return dockerCalls().findIndex(args => needles.every(needle => args.some(arg => arg.includes(needle))))
}

beforeEach(() => {
  vi.clearAllMocks()
  // Never the developer's own `~/.claude`: what the seed copies must not depend
  // on what happens to be in the home directory running the suite.
  process.env.NUXT_CLAUDE_CONFIG_DIR = join(tmpdir(), 'domo-no-such-claude-config')
  run.mockResolvedValue({ stdout: '', stderr: '' })
  buildEnvironmentImage.mockResolvedValue('domo-dev-env_1')
  ensureRuntimeVolume.mockResolvedValue('domo-dev-runtime-abc123')
  readImageMetadata.mockResolvedValue(EMPTY_METADATA)
})

afterEach(() => {
  delete process.env.NUXT_CLAUDE_CONFIG_DIR
})

describe('containerExecArgs', () => {
  it('runs as the configured user, in the workspace', () => {
    expect(containerExecArgs(environment())).toEqual([
      'exec', '--interactive', '--user', 'vscode', '--workdir', '/workspaces/api', 'container-sha'
    ])
  })

  it('leaves the user alone when the image has none', () => {
    expect(containerExecArgs(environment({ remoteUser: null }))).toEqual([
      'exec', '--interactive', '--workdir', '/workspaces/api', 'container-sha'
    ])
  })

  it('falls back to the container name before it has an id', () => {
    expect(containerExecArgs(environment({ containerId: null }))).toContain('domo-dev-env_1')
  })

  it('passes environment variables as separate argv entries', () => {
    const args = containerExecArgs(environment(), { ANTHROPIC_API_KEY: 'sk-test', EMPTY: undefined })

    expect(args).toContain('--env')
    expect(args).toContain('ANTHROPIC_API_KEY=sk-test')
    expect(args.some(arg => arg.startsWith('EMPTY'))).toBe(false)
  })

  it('does not let a value with spaces or quotes split into more arguments', () => {
    const args = containerExecArgs(environment(), { GREETING: 'hello "world"; rm -rf /' })

    expect(args).toContain('GREETING=hello "world"; rm -rf /')
    expect(args).toHaveLength(9)
  })
})

describe('file access inside an environment', () => {
  it('reads a file without trimming its content', async () => {
    run.mockResolvedValue({ stdout: 'line\n\n', stderr: '' })

    await expect(readEnvironmentFile(environment(), '/workspaces/api/README.md')).resolves.toBe('line\n\n')
    expect(run).toHaveBeenCalledWith(
      'docker',
      ['exec', '--user', 'vscode', 'container-sha', 'cat', '/workspaces/api/README.md'],
      { trimOutput: false }
    )
  })

  it('writes through stdin and passes the path as a positional argument', async () => {
    await writeEnvironmentFile(environment(), '/workspaces/api/src/new file.ts', 'export const x = 1\n')

    expect(run).toHaveBeenCalledWith(
      'docker',
      [
        'exec', '--interactive', '--user', 'vscode', 'container-sha',
        'sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh',
        '/workspaces/api/src/new file.ts'
      ],
      { input: 'export const x = 1\n' }
    )
  })
})

describe('start, stop and remove', () => {
  it('starts a container that exists but is not running', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment({ status: 'stopped' }))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: false, labels: {}, publishedPorts: [] })

    await startEnvironment('env_1')

    expect(dockerCalls()).toEqual([['start', 'container-sha']])
    expect(repo.updateDevEnvironment).toHaveBeenCalledWith('env_1', { status: 'running', lastError: null })
  })

  it('does not start a container that is already running', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.updateDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: true, labels: {}, publishedPorts: [] })

    await startEnvironment('env_1')

    expect(dockerCalls()).toEqual([])
  })

  it('brings the Docker proxy up before starting an environment created with one', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment({ status: 'stopped' }))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({
      id: 'container-sha', running: false, labels: { 'domo.dood': 'true' }, publishedPorts: []
    })

    await startEnvironment('env_1')

    // The socket is a bind source: a start without it fails.
    expect(dood.ensureDoodProxy).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: 'env_1',
      containerReference: 'container-sha',
      workspacePath: '/workspaces/api',
      workspaceVolume: 'domo-dev-env_1-workspace'
    }))
    const started = run.mock.invocationCallOrder[run.mock.calls.findIndex(([, args]) => args[0] === 'start')]!
    expect(dood.ensureDoodProxy.mock.invocationCallOrder[0]).toBeLessThan(started)
  })

  it('leaves an older environment with no proxy label alone', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment({ status: 'stopped' }))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: false, labels: {}, publishedPorts: [] })

    await startEnvironment('env_1')

    expect(dood.ensureDoodProxy).not.toHaveBeenCalled()
  })

  it('stops what the environment started on the host daemon along with it', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.updateDevEnvironment.mockResolvedValue(environment({ status: 'stopped' }))
    inspectContainer.mockResolvedValue({
      id: 'container-sha', running: true, labels: { 'domo.dood': 'true' }, publishedPorts: []
    })

    await stopEnvironment('env_1')

    expect(dood.stopEnvironmentContainers).toHaveBeenCalledWith('env_1')
    expect(dockerCalls()).toEqual([['stop', 'container-sha']])
  })

  it('asks for a recreate when the container is gone', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue(null)

    await expect(startEnvironment('env_1')).rejects.toThrow(/no longer exists\. Delete and recreate/)
  })

  it('stops the container and marks the environment stopped', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.updateDevEnvironment.mockResolvedValue(environment({ status: 'stopped' }))
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: true, labels: {}, publishedPorts: [] })

    await stopEnvironment('env_1')

    expect(dockerCalls()).toEqual([['stop', 'container-sha']])
  })

  it('removes the container, both volumes and the image', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({
      id: 'container-sha',
      labels: {},
      namedVolumes: ['domo-dev-env_1-workspace', 'dind-var-lib-docker-abc'],
      publishedPorts: []
    })

    await retireEnvironment('env_1')

    expect(run).toHaveBeenCalledWith(
      'docker',
      ['rm', '--force', '--volumes', 'container-sha'],
      { allowFailure: true }
    )
    // `docker rm --volumes` only takes anonymous volumes, so both named ones go by name.
    expect(dockerCalls()).toContainEqual(['volume', 'rm', 'dind-var-lib-docker-abc'])
    expect(dockerCalls()).toContainEqual(['volume', 'rm', 'domo-dev-env_1-workspace'])
    expect(dockerCalls()).toContainEqual(['image', 'rm', 'domo-dev-env_1'])
    expect(collectRuntimeVolumes).toHaveBeenCalled()
    expect(repo.retireDevEnvironmentRow).toHaveBeenCalledWith('env_1')
  })

  it('leaves a named volume the project mounted itself alone, and reads the mounts first', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({
      id: 'container-sha',
      labels: {},
      namedVolumes: ['shared-build-cache', 'dind-var-lib-docker-abc'],
      publishedPorts: []
    })

    await retireEnvironment('env_1')

    expect(dockerCalls()).not.toContainEqual(expect.arrayContaining(['shared-build-cache']))
    // Once the container is gone there is nothing left to ask which volumes it had.
    const removedAt = run.mock.invocationCallOrder[run.mock.calls.findIndex(([, args]) => args[0] === 'rm')]!
    expect(inspectContainer.mock.invocationCallOrder[0]).toBeLessThan(removedAt)
  })

  it('sweeps the host daemon after the container and before the workspace volume', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({
      id: 'container-sha', labels: { 'domo.dood': 'true' }, namedVolumes: [], publishedPorts: []
    })

    await retireEnvironment('env_1')

    const callAt = (first: string, second?: string) => run.mock.invocationCallOrder[
      run.mock.calls.findIndex(([, args]) => args[0] === first && (!second || args.includes(second)))
    ]!
    const swept = dood.sweepEnvironmentResources.mock.invocationCallOrder[0]!
    expect(dood.stopDoodProxy).toHaveBeenCalledWith('env_1')
    // The container may have joined the stack's networks, and the stack's
    // containers mount the workspace volume.
    expect(callAt('rm')).toBeLessThan(swept)
    expect(swept).toBeLessThan(callAt('volume', 'domo-dev-env_1-workspace'))
  })

  it('is a no-op for an environment that is not there', async () => {
    repo.getDevEnvironment.mockResolvedValue(null)

    await retireEnvironment('env_gone')

    expect(run).not.toHaveBeenCalled()
    expect(repo.retireDevEnvironmentRow).not.toHaveBeenCalled()
  })
})

describe('createEnvironment', () => {
  let repoPath: string
  let dataRoot: string
  let hostHome: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'domo-env-data-'))
    repoPath = await mkdtemp(join(tmpdir(), 'domo-env-repo-'))
    // Never the developer's own home, for the same reason as `~/.claude`.
    hostHome = await mkdtemp(join(tmpdir(), 'domo-env-home-'))
    await mkdir(join(hostHome, '.config', 'gh'), { recursive: true })
    await mkdir(join(hostHome, '.ssh'), { recursive: true })
    await writeFile(join(hostHome, '.ssh', 'config'), 'Host github.com\n  UseKeychain yes\n', 'utf8')
    await writeFile(join(hostHome, '.ssh', 'id_ed25519'), 'key\n', 'utf8')
    await writeFile(join(hostHome, '.ssh', 'known_hosts'), '\n', 'utf8')
    await writeFile(join(hostHome, '.gitconfig'), '[user]\n\tname = Ana\n', 'utf8')
    process.env.NUXT_HOME_OVERLAY_DIR = hostHome
    delete process.env.SSH_AUTH_SOCK
    state.homeMounts = ['.ssh', '.gitconfig', '.config/gh']
    process.env.NUXT_DATA_DIR = dataRoot
    await mkdir(join(repoPath, '.git'), { recursive: true })
    await writeFile(join(repoPath, 'README.md'), '# project\n', 'utf8')
    await writeFile(
      join(repoPath, '.domo.json'),
      JSON.stringify({
        devEnvironment: {
          image: 'ghcr.io/acme/dev:latest',
          remoteUser: 'vscode',
          forwardPorts: [3000],
          postCreateCommand: 'pnpm install'
        }
      }),
      'utf8'
    )

    repo.getProject.mockResolvedValue({ id: 'prj_1', name: 'api', repoPath })
    repo.createDevEnvironmentRow.mockImplementation(async (input: any) => environment(input))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    repo.getDevEnvironment.mockResolvedValue(environment())
    run.mockImplementation(async (_program, args) => ({
      stdout: args[0] === 'run' ? 'container-sha' : '',
      stderr: ''
    }))
    inspectContainer.mockResolvedValue({
      id: 'container-sha',
      name: 'domo-dev-env_1',
      running: true,
      labels: {},
      namedVolumes: [],
      publishedPorts: []
    })
  })

  afterEach(async () => {
    delete process.env.NUXT_DATA_DIR
    delete process.env.NUXT_HOME_OVERLAY_DIR
    state.homeMounts = []
    await rm(dataRoot, { recursive: true, force: true })
    await rm(repoPath, { recursive: true, force: true })
    await rm(hostHome, { recursive: true, force: true })
  })

  it('builds, runs, preflights, chowns and only then runs postCreateCommand', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    expect(buildEnvironmentImage).toHaveBeenCalledWith(expect.objectContaining({
      repoPath,
      name: 'API work',
      config: expect.objectContaining({ image: 'ghcr.io/acme/dev:latest' })
    }))
    const order = [
      stepAt('run', 'domo-dev-env_1'),
      stepAt('git', '--version'),
      stepAt('/opt/domo/node/bin/node'),
      stepAt('chown'),
      // The container's own git config, which replaced `git config --global`.
      stepAt('cat > "$1"', '/home/vscode/.gitconfig'),
      // The copied working tree is reconciled with the HEAD copied beside it before
      // anything else can look at the checkout — and after the git config, which is
      // where the identity a carried commit needs comes from.
      stepAt('git reset --hard --quiet'),
      // The seed runs the CLI out of the runtime volume, so it belongs after the
      // preflight that proves the runtime volume can run at all.
      stepAt('claude', '--version'),
      stepAt('.claude.json'),
      stepAt('pnpm install')
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.includes(-1)).toBe(false)
  })

  it('mounts a Docker proxy that is already listening when the environment asked for Docker', async () => {
    await writeFile(
      join(repoPath, '.domo.json'),
      JSON.stringify({ devEnvironment: { image: 'ghcr.io/acme/dev:latest', docker: true } }),
      'utf8'
    )

    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const runArgs = dockerCalls().find(args => args[0] === 'run')!
    expect(runArgs).toContainEqual(expect.stringMatching(/^\/sockets\/env_\w+\.sock:\/var\/run\/docker\.sock$/))
    expect(runArgs).not.toContain('--privileged')
    const ran = run.mock.invocationCallOrder[run.mock.calls.findIndex(([, args]) => args[0] === 'run')]!
    expect(dood.ensureDoodProxy.mock.invocationCallOrder[0]).toBeLessThan(ran)
  })

  it('has no proxy for an environment without Docker, and sweeps on a failed create', async () => {
    run.mockImplementation(async (_program, args) => {
      if (args.includes('pnpm install')) throw new Error('exit 1')
      return { stdout: args[0] === 'run' ? 'container-sha' : '', stderr: '' }
    })

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).rejects.toThrow(/postCreateCommand/)

    expect(dood.ensureDoodProxy).not.toHaveBeenCalled()
    expect(dockerCalls().find(args => args[0] === 'run')!.join(' ')).not.toContain('docker.sock')
    // postCreateCommand may already have started a stack before it failed.
    expect(dood.sweepEnvironmentResources).toHaveBeenCalledWith(expect.stringMatching(/^env_/))
  })

  it('mounts the host\'s login state, skipping what this host does not have', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const mounts = dockerCalls().find(args => args[0] === 'run')!
      .flatMap((arg, index, all) => arg === '--mount' ? [all[index + 1]!] : [])

    expect(mounts).toContain(`type=bind,source=${hostHome}/.config/gh,target=/home/vscode/.config/gh`)
    // The host file goes beside the container's own config, read-only.
    expect(mounts).toContain(`type=bind,source=${hostHome}/.gitconfig,target=/home/vscode/.gitconfig-host,readonly`)
    // `.ssh` goes beside it too, and read-write: ssh appends to `known_hosts`.
    expect(mounts).toContain(`type=bind,source=${hostHome}/.ssh,target=/home/vscode/.ssh-host`)
    expect(mounts.join('\n')).not.toContain('target=/home/vscode/.ssh,')
  })

  it('skips an entry this host does not have, without an error', async () => {
    state.homeMounts = ['.ssh', '.kube']

    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const mounts = dockerCalls().find(args => args[0] === 'run')!
      .flatMap((arg, index, all) => arg === '--mount' ? [all[index + 1]!] : [])

    expect(mounts.join('\n')).not.toContain('/.kube')
  })

  it('builds the container\'s own ~/.ssh, wrapping the host config it cannot use', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    // Every name arrives as argv; the script itself is fixed.
    const setup = run.mock.calls.find(([, args]) => args.includes('/home/vscode/.ssh-host'))!
    expect(setup[1].slice(-5)).toEqual([
      'sh', '/home/vscode/.ssh', '/home/vscode/.ssh-host', 'id_ed25519', 'known_hosts'
    ])
    // `config` is the one entry that is not symlinked: Domo writes it.
    expect(setup[1]).not.toContain('config')

    const config = (setup[2] as { input: string }).input
    // A macOS `UseKeychain yes` is fatal to Linux ssh unless this comes first.
    expect(config.split('\n')[1]).toBe('IgnoreUnknown UseKeychain')
    expect(config).toContain('Include ~/.ssh-host/config')

    const order = [
      stepAt('cat > "$1"', '/home/vscode/.gitconfig'),
      stepAt('mkdir -p "$dir"', '/home/vscode/.ssh-host'),
      stepAt('pnpm install')
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('builds no ~/.ssh when the host mounts do not include one', async () => {
    state.homeMounts = ['.gitconfig']

    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    expect(dockerCalls().flat().join('\n')).not.toContain('.ssh-host')
  })

  it('writes the container\'s own git config, and hands the created parents to the user', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const write = run.mock.calls.find(([, args]) => args.at(-1) === '/home/vscode/.gitconfig')!
    expect(write[1]).toEqual([
      'exec', '--interactive', '--user', 'vscode', '--env', 'HOME=/home/vscode', 'container-sha',
      'sh', '-c', 'cat > "$1"', 'sh', '/home/vscode/.gitconfig'
    ])
    const contents = (write[2] as { input: string }).input
    expect(contents).toContain('path = ~/.gitconfig-host')
    // What `git config --global --add safe.directory` used to do.
    expect(contents).toContain('directory = /workspaces/api')

    // Docker creates `~/.config` as root when it makes the `gh` mount target.
    expect(dockerCalls()).toContainEqual([
      'exec', '--user', 'root', 'container-sha', 'chown', 'vscode:', '/home/vscode/.config'
    ])
  })

  it('offers the SSH agent socket when this machine has one', async () => {
    const socket = join(hostHome, 'agent.sock')
    await writeFile(socket, '', 'utf8')
    process.env.SSH_AUTH_SOCK = socket

    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const runArgs = dockerCalls().find(args => args[0] === 'run')!
    expect(runArgs).toContain(`type=bind,source=${socket},target=/run/host-services/ssh-auth.sock`)
    expect(runArgs).toContain('SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock')
  })

  it('mounts Docker Desktop\'s own forwarded socket, whatever SSH_AUTH_SOCK says', async () => {
    // The daemon is in a VM there: the host's socket path is not one it can mount.
    dockerServerOs.mockResolvedValueOnce('Docker Desktop')
    const socket = join(hostHome, 'agent.sock')
    await writeFile(socket, '', 'utf8')
    process.env.SSH_AUTH_SOCK = socket

    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const runArgs = dockerCalls().find(args => args[0] === 'run')!
    expect(runArgs).toContain('type=bind,source=/run/host-services/ssh-auth.sock,target=/run/host-services/ssh-auth.sock')
    expect(runArgs).toContain('SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock')
    expect(runArgs.join('\n')).not.toContain(socket)
  })

  it('seeds the Claude home as the remote user, and never mounts the host\'s', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    expect(dockerCalls()).toContainEqual([
      'exec', '--user', 'vscode', 'container-sha', 'mkdir', '-p', '/home/vscode/.claude'
    ])
    // Only if the CLI has not written one: after that it is the CLI's to manage.
    expect(dockerCalls()).toContainEqual([
      'exec', '--interactive', '--user', 'vscode', 'container-sha',
      'sh', '-c', 'test -f "$1" || cat > "$1"', 'sh', '/home/vscode/.claude.json'
    ])
    expect(dockerCalls().find(args => args[0] === 'run')!.join('\n')).not.toContain('.claude')
  })

  it('copies only the allow-listed config, and only what the host has', async () => {
    const source = await mkdtemp(join(tmpdir(), 'domo-claude-src-'))
    process.env.NUXT_CLAUDE_CONFIG_DIR = source
    await writeFile(join(source, 'CLAUDE.md'), '# global\n')
    await writeFile(join(source, '.credentials.json'), '{"claudeAiOauth":{}}')

    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    expect(copyIntoContainer).toHaveBeenCalledWith({
      source,
      entries: ['CLAUDE.md'],
      containerId: 'container-sha',
      user: 'vscode',
      target: '/home/vscode/.claude'
    })
    await rm(source, { recursive: true, force: true })
  })

  it('copies nothing when the host has no Claude config at all', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    expect(copyIntoContainer).not.toHaveBeenCalled()
  })

  it('copies the checkout into a volume and declares its ports', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const id = repo.createDevEnvironmentRow.mock.calls[0]![0].id
    expect(dockerCalls()).toContainEqual([
      'volume', 'create', '--label', `domo.envId=${id}`, `domo-dev-${id}-workspace`
    ])
    expect(populateWorkspaceVolume).toHaveBeenCalledWith(expect.objectContaining({
      source: repoPath,
      volume: `domo-dev-${id}-workspace`
    }))
    expect(repo.upsertDevEnvironmentPort).toHaveBeenCalledWith(expect.objectContaining({
      innerPort: 3000,
      protocol: 'tcp',
      source: 'declared'
    }))
    expect(repo.updateDevEnvironment).toHaveBeenCalledWith(id, expect.objectContaining({
      configSource: 'domo',
      configPath: '.domo.json',
      remoteUser: 'vscode'
    }))
  })

  /**
   * The tar copies the host's *working tree*, so until this runs the environment's
   * files and the HEAD beside them disagree — and the agent's first `git add -A`
   * sweeps the host's uncommitted work into a branch that is exported back as if
   * the agent had written it. That is the bug; these are its terms.
   */
  describe('the copied working tree', () => {
    /** The reconcile script, as the one `docker exec` that carries it. */
    function reconcileCall(): string[] | undefined {
      return dockerCalls().find(args => args.some(arg => arg.includes('git rev-parse --verify --quiet HEAD')))
    }

    it('is reset to HEAD as the environment\'s own user, with a HOME git can read', async () => {
      await createEnvironment({ projectId: 'prj_1', name: 'API work' })

      const call = reconcileCall()!
      expect(call.slice(0, 8)).toEqual([
        'exec', '--user', 'vscode', '--workdir', '/workspaces/api-work', '--env', 'HOME=/home/vscode', 'container-sha'
      ])
      // The mode and the workspace are argv, never spliced into the script.
      expect(call.slice(-3)).toEqual(['discard', '/workspaces/api-work', expect.stringContaining('chore: carry')])
      expect(call.join('\n')).toContain('git clean -fdq')
    })

    it('commits instead of resetting when the caller asks for the host\'s work', async () => {
      await createEnvironment({ projectId: 'prj_1', name: 'API work', workingTree: 'carry' })

      expect(reconcileCall()!.slice(-3)[0]).toBe('carry')
    })

    it('reports what the host had uncommitted, so an absent change is never a silent one', async () => {
      run.mockImplementation(async (program, args) => {
        if (program === 'git' && args.includes('status')) {
          return { stdout: ' M app/assets/css/main.css\0?? scratch.md\0', stderr: '' }
        }
        return { stdout: args[0] === 'run' ? 'container-sha' : '', stderr: '' }
      })

      const created = await createEnvironment({ projectId: 'prj_1', name: 'API work' })

      expect(run).toHaveBeenCalledWith('git', ['-C', repoPath, 'status', '--porcelain', '-z'], expect.anything())
      expect(created.workspaceSeed).toEqual({
        mode: 'discard',
        paths: ['app/assets/css/main.css', 'scratch.md'],
        total: 2,
        commit: null
      })
    })

    it('reports the commit a carried tree landed on', async () => {
      run.mockImplementation(async (program, args) => {
        if (program === 'git' && args.includes('status')) return { stdout: ' M a.ts\0', stderr: '' }
        if (args.some(arg => typeof arg === 'string' && arg.includes('git rev-parse --verify'))) {
          return { stdout: 'c0ffee1234567890', stderr: '' }
        }
        return { stdout: args[0] === 'run' ? 'container-sha' : '', stderr: '' }
      })

      const created = await createEnvironment({ projectId: 'prj_1', name: 'API work', workingTree: 'carry' })

      expect(created.workspaceSeed).toMatchObject({ mode: 'carry', total: 1, commit: 'c0ffee1234567890' })
    })

    // Better no environment than one whose files its own git does not describe:
    // that is exactly the state the export cannot be trusted from.
    it('fails creation, and cleans up, when the reconcile cannot run', async () => {
      run.mockImplementation(async (_program, args) => {
        if (args.some(arg => typeof arg === 'string' && arg.includes('git reset --hard'))) {
          throw new Error('docker exec failed: fatal: detected dubious ownership')
        }
        return { stdout: args[0] === 'run' ? 'container-sha' : '', stderr: '' }
      })

      await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' }))
        .rejects.toThrow(/reconcile the copied checkout/)

      const id = repo.createDevEnvironmentRow.mock.calls[0]![0].id
      expect(dockerCalls()).toContainEqual(['volume', 'rm', `domo-dev-${id}-workspace`])
    })
  })

  it('mounts the shared runtime volume read-only, and the checkout at the workspace', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const id = repo.createDevEnvironmentRow.mock.calls[0]![0].id
    const runCall = dockerCalls().find(args => args[0] === 'run')!
    expect(runCall).toContain('type=volume,source=domo-dev-runtime-abc123,target=/opt/domo,readonly')
    expect(runCall).toContain(`type=volume,source=domo-dev-${id}-workspace,target=/workspaces/api-work`)
    expect(runCall).not.toContain('--privileged')
  })

  // A data dir inside the project would otherwise be copied into its own environment.
  it.each([
    ['at the top level', '.data', '.data'],
    ['nested', join('tools', 'state', 'domo'), join('tools', 'state', 'domo')],
    ['outside it', null, null]
  ])('leaves the Domo data dir out of the copy when it is %s', async (_label, inside, excluded) => {
    process.env.NUXT_DATA_DIR = inside ? join(repoPath, inside) : dataRoot

    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    expect(populateWorkspaceVolume).toHaveBeenCalledWith(expect.objectContaining({
      exclude: excluded ? [excluded] : []
    }))
  })

  it.each([
    ['the image build', () => buildEnvironmentImage.mockRejectedValue(new Error('feature build failed')),
      'feature build failed'],
    ['docker run', () => run.mockImplementation(async (_program, args) => {
      if (args[0] === 'run') throw new Error('no privileged containers allowed')
      return { stdout: '', stderr: '' }
    }), 'no privileged containers allowed'],
    ['postCreateCommand', () => run.mockImplementation(async (_program, args) => {
      if (args.includes('pnpm install')) throw new Error('exit 1')
      return { stdout: args[0] === 'run' ? 'container-sha' : '', stderr: '' }
    }), 'postCreateCommand failed']
  ])('records the failure and leaves nothing behind when %s fails', async (_label, arrange, message) => {
    arrange()

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).rejects.toThrow(message)

    const id = repo.createDevEnvironmentRow.mock.calls[0]![0].id
    expect(repo.updateDevEnvironment).toHaveBeenCalledWith(id, {
      status: 'error',
      lastError: expect.stringContaining(message)
    })
    expect(dockerCalls()).toContainEqual(['rm', '--force', '--volumes', 'container-sha'])
    expect(dockerCalls()).toContainEqual(['volume', 'rm', `domo-dev-${id}-workspace`])
    expect(dockerCalls()).toContainEqual(['image', 'rm', `domo-dev-${id}`])
  })

  it('takes the dind volume with it when the half-made container had one', async () => {
    buildEnvironmentImage.mockRejectedValue(new Error('feature build failed'))
    repo.getDevEnvironment.mockResolvedValue(environment({ containerId: null }))
    run.mockImplementation(async (_program, args) => ({
      stdout: args[0] === 'ps' ? 'half-made-container' : '',
      stderr: ''
    }))
    inspectContainer.mockResolvedValue({
      id: 'half-made-container',
      labels: {},
      namedVolumes: ['dind-var-lib-docker-xyz'],
      publishedPorts: []
    })

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).rejects.toThrow('feature build failed')

    expect(dockerCalls()).toContainEqual(['rm', '--force', '--volumes', 'half-made-container'])
    expect(dockerCalls()).toContainEqual(['volume', 'rm', 'dind-var-lib-docker-xyz'])
  })

  it.each([
    ['git', ['git', '--version'], /does not have `git` installed/],
    ['Domo\'s Node', ['/opt/domo/node/bin/node'], /must be glibc-based/]
  ])('fails creation with a readable message when the image has no %s', async (_label, needles, message) => {
    run.mockImplementation(async (_program, args) => {
      if (needles.every(needle => args.includes(needle))) throw new Error('exit 126')
      return { stdout: args[0] === 'run' ? 'container-sha' : '', stderr: '' }
    })

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).rejects.toThrow(message)
  })

  it('waits for Docker to answer, and gives up with a readable message', async () => {
    process.env.NUXT_DEV_ENV_DOCKER_READY_MS = '30'
    await writeFile(
      join(repoPath, '.domo.json'),
      JSON.stringify({ devEnvironment: { image: 'ghcr.io/acme/dev:latest', docker: true } }),
      'utf8'
    )
    let attempts = 0
    run.mockImplementation(async (_program, args) => {
      if (args.includes('info')) {
        attempts += 1
        throw new Error('cannot connect')
      }
      return { stdout: args[0] === 'run' ? 'container-sha' : '', stderr: '' }
    })

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' }))
      .rejects.toThrow(/Docker did not answer inside the environment/)

    expect(attempts).toBeGreaterThan(1)
    delete process.env.NUXT_DEV_ENV_DOCKER_READY_MS
  })

  it('accepts a daemon that takes a few tries to answer', async () => {
    await writeFile(
      join(repoPath, '.domo.json'),
      JSON.stringify({ devEnvironment: { image: 'ghcr.io/acme/dev:latest', docker: true } }),
      'utf8'
    )
    let attempts = 0
    run.mockImplementation(async (_program, args) => {
      if (args.includes('info') && ++attempts < 3) throw new Error('cannot connect')
      return { stdout: args[0] === 'run' ? 'container-sha' : '', stderr: '' }
    })

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).resolves.toBeTruthy()
    expect(attempts).toBe(3)
  })

  it('refuses a project that is not a Git checkout', async () => {
    await rm(join(repoPath, '.git'), { recursive: true, force: true })

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).rejects.toThrow()
    expect(buildEnvironmentImage).not.toHaveBeenCalled()
  })
})
