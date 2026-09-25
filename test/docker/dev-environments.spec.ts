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
const buildEnvironmentImage = vi.fn(async (_input?: unknown) => 'domo-dev-env_1')
const readImageMetadata = vi.fn()
const ensureRuntimeVolume = vi.fn(async () => 'domo-dev-runtime-abc123')
const collectRuntimeVolumes = vi.fn(async () => undefined)
// The proxy is a real listening socket and its own spec is live; here it is
// only a step in the order of things.
const dood = {
  doodSocketPath: (environmentId: string) => `/sockets/${environmentId}.sock`,
  ensureDoodProxy: vi.fn(async ({ environmentId }: { environmentId: string }) =>
    ({ socketPath: `/sockets/${environmentId}.sock`, close: async () => {} })),
  stopDoodProxy: vi.fn(async () => undefined),
  ensureEnvironmentNetwork: vi.fn(async () => undefined),
  stopEnvironmentContainers: vi.fn(async () => undefined)
}
const repo = {
  createDevEnvironmentRow: vi.fn(),
  // Removal tombstones the row rather than deleting it, and the row is kept
  // for good: it is the record that the environment existed.
  retireDevEnvironmentRow: vi.fn(),
  // What the sweep after a cleanup writes when Docker still has something a
  // retired row claims.
  setEnvironmentLeftovers: vi.fn(async (_id: string, _leftovers: unknown[], _health?: unknown) => null),
  getDevEnvironment: vi.fn(),
  getProject: vi.fn(),
  updateDevEnvironment: vi.fn(),
  upsertDevEnvironmentPort: vi.fn(),
  // What the sweep after a cleanup compares Docker against.
  listDevEnvironments: vi.fn(async (): Promise<DevEnvironment[]> => [])
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
  buildEnvironmentImage
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

const { reconcileEnvironmentResources } = await import('../../server/lib/dev-env/reconcile')
const {
  cleanupEnvironment,
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
    leftovers: [],
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

/**
 * A daemon that keeps state, for everything that decides by *observing*: it
 * answers the listings from what it still holds, removes on `rm`, and can
 * refuse a name outright. A `run` mock that answers everything with an empty
 * stdout proves the opposite of what it looks like here — on a real daemon
 * that is the answer both for a clean machine and for one that cannot be
 * reached.
 */
interface FakeDaemon {
  containers: string[]
  networks: string[]
  volumes: string[]
  /** `repo` for `:latest`, `repo:tag` otherwise — the way the sweep names them. */
  images: string[]
  /** `domo.envId` / `domo.env` on a container, network or volume. */
  labels: Record<string, { envId?: string, env?: string }>
  /** Names this daemon will not let go of, whatever it is asked. */
  refuses: string[]
  /** What `ps --filter volume=…` / `network=…` / `ancestor=…` answers: who is in the way. */
  holders: Record<string, string[]>
}

function daemon(state: Partial<FakeDaemon> = {}): FakeDaemon {
  const fake: FakeDaemon = {
    containers: [], networks: [], volumes: [], images: [], labels: {}, refuses: [], holders: {}, ...state
  }
  const answer = (values: string[]) => ({ stdout: values.join('\n'), stderr: '' })
  const withLabels = (name: string) => `${name}\t${fake.labels[name]?.envId ?? ''}\t${fake.labels[name]?.env ?? ''}`
  const remove = (from: 'containers' | 'networks' | 'volumes' | 'images', name: string, allowFailure?: boolean) => {
    if (fake.refuses.includes(name)) {
      if (allowFailure) return answer([])
      throw new Error(`docker failed: Error response from daemon: remove ${name}: volume is in use`)
    }
    fake[from] = fake[from].filter(entry => entry !== name)
    return answer([])
  }
  run.mockImplementation(async (_program: string, args: string[], options?: any) => {
    const filter = args.includes('--filter') ? String(args[args.indexOf('--filter') + 1]) : ''
    if (args[0] === 'ps') {
      const [key, value] = filter.split('=')
      // The blocker lookup, which is what turns "volume is in use" into a
      // sentence naming what to remove.
      if (key === 'volume' || key === 'network' || key === 'ancestor') return answer(fake.holders[value!] ?? [])
      if (key === 'label') {
        const [label, id] = filter.slice('label='.length).split('=')
        return answer(fake.containers.filter(name =>
          (label === 'domo.envId' ? fake.labels[name]?.envId : fake.labels[name]?.env) === id))
      }
      return answer(fake.containers.map(withLabels))
    }
    if (args[0] === 'rm') return remove('containers', args[3]!, options?.allowFailure)
    if (args[0] === 'network' && args[1] === 'ls') {
      return answer(fake.networks.filter(name => fake.labels[name]?.env).map(withLabels))
    }
    if (args[0] === 'network' && args[1] === 'rm') return remove('networks', args[2]!, options?.allowFailure)
    if (args[0] === 'volume' && args[1] === 'ls') {
      // The shared-volume collectors ask by name; the sweep lists everything.
      if (filter.startsWith('name=^')) {
        return answer(fake.volumes.filter(name => name.startsWith(filter.slice('name=^'.length))))
      }
      return answer(fake.volumes.map(withLabels))
    }
    if (args[0] === 'volume' && args[1] === 'rm') return remove('volumes', args[2]!, options?.allowFailure)
    if (args[0] === 'image' && args[1] === 'ls') {
      return answer(fake.images.map(name => name.includes(':') ? name : `${name}:latest`))
    }
    if (args[0] === 'image' && args[1] === 'rm') return remove('images', args[2]!, options?.allowFailure)
    return answer([])
  })
  return fake
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

  it('runs a retire only once a start in flight has finished, and a start queued behind it refuses', async () => {
    let retired = false
    repo.getDevEnvironment.mockImplementation(async () =>
      environment({ status: 'stopped', retiredAt: retired ? '2026-01-02T00:00:00.000Z' : null }))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    repo.retireDevEnvironmentRow.mockImplementation(async () => { retired = true })
    inspectContainer.mockResolvedValue({
      id: 'container-sha', running: false, labels: { 'domo.dood': 'true' }, publishedPorts: [], namedVolumes: []
    })
    let releaseProxy!: () => void
    const order: string[] = []
    dood.ensureDoodProxy.mockImplementationOnce(async ({ environmentId }) => {
      order.push('proxy:start')
      await new Promise<void>((resolve) => { releaseProxy = resolve })
      order.push('proxy:listening')
      return { socketPath: `/sockets/${environmentId}.sock`, close: async () => {} }
    })
    dood.stopDoodProxy.mockImplementationOnce(async () => { order.push('proxy:stop') })

    const starting = startEnvironment('env_1')
    const retiring = retireEnvironment('env_1')
    const late = startEnvironment('env_1')
    await new Promise(resolve => setTimeout(resolve, 10))
    // The retire is waiting: it would otherwise stop, and unlink, the proxy
    // the start is bringing up.
    expect(order).toEqual(['proxy:start'])
    expect(dood.stopDoodProxy).not.toHaveBeenCalled()

    releaseProxy()
    await starting
    await retiring
    expect(order).toEqual(['proxy:start', 'proxy:listening', 'proxy:stop'])
    await expect(late).rejects.toThrow(/was retired/)
    // Nothing started after the retire removed the container.
    expect(dockerCalls().filter(args => args[0] === 'start')).toHaveLength(1)
  })

  it('does not hold one environment behind another', async () => {
    repo.getDevEnvironment.mockImplementation(async (id: string) => environment({ id, status: 'stopped' }))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({
      id: 'container-sha', running: false, labels: { 'domo.dood': 'true' }, publishedPorts: []
    })
    let release!: () => void
    dood.ensureDoodProxy.mockImplementationOnce(({ environmentId }) =>
      new Promise((resolve) => { release = () => resolve({ socketPath: `/sockets/${environmentId}.sock`, close: async () => {} }) }))

    const held = startEnvironment('env_1')
    await expect(startEnvironment('env_2')).resolves.toBeTruthy()
    release()
    await held
  })

  it('asks for a recreate when the container is gone, and says so on the row', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue(null)

    await expect(startEnvironment('env_1')).rejects.toThrow(/no longer exists\. Delete and recreate/)

    // `error` is the one state that means "you have to do something", and this
    // is permanent until somebody does. Throwing at the caller alone left the
    // row saying `stopped`, which is what a healthy environment says.
    expect(repo.updateDevEnvironment).toHaveBeenCalledWith('env_1', {
      status: 'error',
      lastError: expect.stringContaining('no longer exists')
    })
  })

  it('records an environment whose container the daemon will not start', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: false, labels: {}, publishedPorts: [] })
    run.mockRejectedValue(new Error('docker start failed: no space left on device'))

    await expect(startEnvironment('env_1')).rejects.toThrow(/would not start: .*no space left/)

    expect(repo.updateDevEnvironment).toHaveBeenCalledWith('env_1', {
      status: 'error',
      lastError: expect.stringContaining('no space left on device')
    })
  })

  it('clears the error when a start works, because the state is what a banner reads', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment({ status: 'error', lastError: 'it would not start' }))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: false, labels: {}, publishedPorts: [] })

    await startEnvironment('env_1')

    expect(repo.updateDevEnvironment).toHaveBeenCalledWith('env_1', { status: 'running', lastError: null })
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
    const retired = environment({ retiredAt: '2026-01-02T00:00:00.000Z' })
    repo.listDevEnvironments.mockResolvedValue([retired])
    const fake = daemon({
      containers: ['domo-dev-env_1'],
      volumes: ['domo-dev-env_1-workspace', 'dind-var-lib-docker-abc'],
      images: ['domo-dev-env_1'],
      labels: { 'domo-dev-env_1': { envId: 'env_1' } }
    })
    inspectContainer.mockResolvedValue({
      id: 'container-sha',
      labels: {},
      namedVolumes: ['domo-dev-env_1-workspace', 'dind-var-lib-docker-abc'],
      publishedPorts: []
    })

    const report = await retireEnvironment('env_1')

    expect(run).toHaveBeenCalledWith(
      'docker',
      ['rm', '--force', '--volumes', 'container-sha'],
      { allowFailure: true }
    )
    // `docker rm --volumes` only takes anonymous volumes, so both named ones go
    // by name: the DinD one by inspection, the workspace by the sweep.
    expect(dockerCalls()).toContainEqual(['volume', 'rm', 'dind-var-lib-docker-abc'])
    expect(dockerCalls()).toContainEqual(['volume', 'rm', 'domo-dev-env_1-workspace'])
    expect(dockerCalls()).toContainEqual(['image', 'rm', 'domo-dev-env_1'])
    expect(fake).toMatchObject({ containers: [], volumes: [], images: [] })
    expect(report.leftovers).toEqual([])
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

  it('takes what the environment made on the host daemon, container first, and nothing a live one made', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.listDevEnvironments.mockResolvedValue([
      environment({ retiredAt: '2026-01-02T00:00:00.000Z' }),
      environment({ id: 'env_2' })
    ])
    inspectContainer.mockResolvedValue({
      id: 'container-sha', labels: { 'domo.dood': 'true' }, namedVolumes: [], publishedPorts: []
    })
    const fake = daemon({
      containers: ['env_1-web', 'env_2-web', 'domo-dev-port-helper'],
      networks: ['env_1-default', 'env_2-default'],
      volumes: ['env_1-data', 'env_2-data', 'domo-dev-env_1-workspace', 'domo-dev-runtime-abc123'],
      images: [
        'domo-env_1/docker.io/library/app:dev', 'domo-env_2/docker.io/library/app:dev',
        'domo-dev-port-helper:0123456789ab', 'postgres:16'
      ],
      labels: {
        'env_1-web': { env: 'env_1' },
        'env_1-default': { env: 'env_1' },
        'env_1-data': { env: 'env_1' },
        'env_2-web': { env: 'env_2' },
        'env_2-default': { env: 'env_2' },
        'env_2-data': { env: 'env_2' }
      }
    })

    const report = await retireEnvironment('env_1')

    const callAt = (...args: string[]) => run.mock.invocationCallOrder[
      run.mock.calls.findIndex(([, argv]) => args.every((arg, index) => argv[index] === arg))
    ]!
    // Nothing may create anything in its name while it is being taken apart.
    expect(dood.stopDoodProxy.mock.invocationCallOrder[0]).toBeLessThan(callAt('rm'))
    // A container before the network it joined and the volume it mounts.
    expect(callAt('rm', '--force', '--volumes', 'env_1-web')).toBeLessThan(callAt('network', 'rm', 'env_1-default'))
    expect(callAt('network', 'rm', 'env_1-default')).toBeLessThan(callAt('volume', 'rm', 'env_1-data'))
    expect(report.removed.map(leftover => `${leftover.kind} ${leftover.name}`)).toEqual([
      'container env_1-web',
      'network env_1-default',
      'volume env_1-data',
      'volume domo-dev-env_1-workspace',
      'image domo-env_1/docker.io/library/app:dev'
    ])
    // A live environment's stack, the port helper every environment shares,
    // the shared runtime volume and a pulled image all stay — and none of them
    // is "unattributed" either.
    expect(fake.containers).toEqual(['env_2-web', 'domo-dev-port-helper'])
    expect(fake.networks).toEqual(['env_2-default'])
    expect(fake.volumes).toEqual(['env_2-data', 'domo-dev-runtime-abc123'])
    expect(fake.images).toEqual([
      'domo-env_2/docker.io/library/app:dev', 'domo-dev-port-helper:0123456789ab', 'postgres:16'
    ])
    expect(report.unattributed).toEqual([])
  })

  it('retires the row even when Docker cannot be reached, and says what it could not confirm', async () => {
    // Retirement cannot wait for Docker: the sessions are already stood down.
    // But an unreachable daemon observes nothing, and "nothing left" is exactly
    // what that would otherwise read as.
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.listDevEnvironments.mockResolvedValue([environment({ retiredAt: '2026-01-02T00:00:00.000Z' })])
    inspectContainer.mockResolvedValue(null)
    run.mockRejectedValue(new Error('docker ps failed: Cannot connect to the Docker daemon'))

    const report = await retireEnvironment('env_1')

    expect(repo.retireDevEnvironmentRow).toHaveBeenCalledWith('env_1')
    expect(report.leftovers.map(leftover => `${leftover.kind} ${leftover.name}`)).toEqual([
      'container domo-dev-env_1',
      'volume domo-dev-env_1-workspace',
      'volume dind-var-lib-docker-env_1',
      'image domo-dev-env_1'
    ])
    expect(report.leftovers[0]!.error).toMatch(/could not be reached.*Cannot connect/)
    // Written down as unconfirmed, so the next pass — boot, or the button —
    // rewrites it from what Docker really has.
    expect(repo.setEnvironmentLeftovers).toHaveBeenCalledWith(
      'env_1',
      expect.arrayContaining([expect.objectContaining({ name: 'domo-dev-env_1-workspace' })]),
      { status: 'error', lastError: expect.stringMatching(/could not be reached/) }
    )
  })

  it('is a no-op for an environment that is not there', async () => {
    repo.getDevEnvironment.mockResolvedValue(null)

    await retireEnvironment('env_gone')

    expect(run).not.toHaveBeenCalled()
    expect(repo.retireDevEnvironmentRow).not.toHaveBeenCalled()
  })
})

/**
 * What happens when a cleanup step fails — which is the whole reason any of
 * this exists. `docker volume rm` is refused while anything still has the
 * volume mounted, and before this that answer was swallowed by `allowFailure`,
 * the retirement reported success, and nothing ever looked again.
 *
 * The daemon is faked at the process boundary like everything else here, but it
 * *keeps state*: it answers `volume ls` with what it still has, so the sweep is
 * tested the way it really works — by observation, never by an exit code.
 */
describe('a cleanup that Docker refuses', () => {
  const RETIRED = environment({ retiredAt: '2026-01-03T00:00:00.000Z' })

  beforeEach(() => {
    inspectContainer.mockResolvedValue({
      id: 'container-sha',
      labels: {},
      namedVolumes: [],
      publishedPorts: []
    })
  })

  it('reports the volume it could not remove, naming what is holding it', async () => {
    const fake = daemon({
      volumes: ['domo-dev-env_1-workspace'],
      refuses: ['domo-dev-env_1-workspace'],
      holders: { 'domo-dev-env_1-workspace': ['tidy-runner'] }
    })
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.listDevEnvironments.mockResolvedValue([RETIRED])

    const report = await retireEnvironment('env_1')

    // Nothing retries this in the background, so the message is the whole of
    // what the reader gets: the container in the way, and the command for it.
    expect(report.leftovers).toEqual([
      expect.objectContaining({
        kind: 'volume',
        name: 'domo-dev-env_1-workspace',
        error: 'Container tidy-runner still has it mounted. '
          + 'Remove it (docker rm -f tidy-runner) and run the cleanup again.'
      })
    ])
    // And it is written down, so the row — kept for good — is still the way
    // back to it however much later. A half-cleaned environment is not a quiet
    // field either: it reads as broken, with the blocker in the field the page
    // shows.
    expect(repo.setEnvironmentLeftovers).toHaveBeenCalledWith(
      'env_1',
      [expect.objectContaining({ kind: 'volume', name: 'domo-dev-env_1-workspace', error: expect.any(String) })],
      { status: 'error', lastError: expect.stringContaining('docker rm -f tidy-runner') }
    )
    expect(fake.volumes).toEqual(['domo-dev-env_1-workspace'])
  })

  it('never retries on its own, however long nobody asks', async () => {
    daemon({
      volumes: ['domo-dev-env_1-workspace'],
      refuses: ['domo-dev-env_1-workspace'],
      holders: { 'domo-dev-env_1-workspace': ['tidy-runner'] }
    })
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.listDevEnvironments.mockResolvedValue([RETIRED])
    vi.useFakeTimers()
    try {
      await retireEnvironment('env_1')
      const afterRetirement = dockerCalls().length

      await vi.advanceTimersByTimeAsync(45 * 60_000)

      // A timer here would hide, for as long as it kept going, a problem that
      // one person removing one container would fix in seconds.
      expect(dockerCalls().length).toBe(afterRetirement)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes it when the cleanup is asked for again, once the holder has gone', async () => {
    // The retry: whoever read the message removed the container it named, and
    // asked again. Same sweep, same attribution rule, nothing automatic.
    const fake = daemon({ volumes: ['domo-dev-env_1-workspace'] })
    repo.getDevEnvironment.mockResolvedValue(RETIRED)
    repo.listDevEnvironments.mockResolvedValue([RETIRED])

    const report = await cleanupEnvironment('env_1')

    expect(dockerCalls()).toContainEqual(['volume', 'rm', 'domo-dev-env_1-workspace'])
    expect(fake.volumes).toEqual([])
    expect(report.removed.map(leftover => leftover.name)).toEqual(['domo-dev-env_1-workspace'])
    expect(report.leftovers).toEqual([])
    // Cleared, and the row stops reporting itself broken, which is what a
    // retried cleanup is for.
    expect(repo.setEnvironmentLeftovers).toHaveBeenCalledWith('env_1', [], { status: 'stopped', lastError: null })
  })

  it('leaves a failed creation\'s own error alone while sweeping its wreckage', async () => {
    // Its row is not retired and already says something better than "a volume
    // is still there" — the creation is what failed, and that is what the
    // person reading the page has to know.
    const broken = environment({
      status: 'error',
      lastError: 'postCreateCommand failed: exit 1',
      leftovers: [{ kind: 'volume', name: 'domo-dev-env_1-workspace', error: 'not confirmed' }]
    })
    daemon({ volumes: ['domo-dev-env_1-workspace'] })
    repo.getDevEnvironment.mockResolvedValue(broken)
    repo.listDevEnvironments.mockResolvedValue([broken])

    await cleanupEnvironment('env_1')

    expect(repo.setEnvironmentLeftovers).toHaveBeenCalledWith('env_1', [], null)
  })

  it('refuses a cleanup for an environment that is not there', async () => {
    daemon()
    repo.getDevEnvironment.mockResolvedValue(null)

    await expect(cleanupEnvironment('env_gone')).rejects.toThrow(/not found/)
  })

  it('never touches a live environment, whatever else it finds', async () => {
    const fake = daemon({
      containers: ['domo-dev-env_live'],
      volumes: ['domo-dev-env_1-workspace', 'domo-dev-env_live-workspace', 'domo-dev-env_stranger-workspace'],
      images: ['domo-dev-env_live']
    })
    repo.listDevEnvironments.mockResolvedValue([RETIRED, environment({ id: 'env_live' })])

    await reconcileEnvironmentResources()

    // A live environment's workspace volume is the only copy of an agent's
    // work, and a name no row claims belongs to somebody else.
    expect(fake.volumes).toEqual(['domo-dev-env_live-workspace', 'domo-dev-env_stranger-workspace'])
    expect(fake.containers).toEqual(['domo-dev-env_live'])
    expect(fake.images).toEqual(['domo-dev-env_live'])
  })

  it('asks Docker nothing at all when no environment has ever existed', async () => {
    daemon({ volumes: ['domo-dev-env_1-workspace'] })
    repo.listDevEnvironments.mockResolvedValue([])

    await reconcileEnvironmentResources()

    // An install that does not use development environments must not log a
    // daemon error every half hour for nothing.
    expect(dockerCalls()).toEqual([])
  })

  it('names a resource no row accounts for, and leaves it exactly where it is', async () => {
    const fake = daemon({ volumes: ['domo-dev-env_pruned-workspace'] })
    repo.listDevEnvironments.mockResolvedValue([environment()])

    const report = await reconcileEnvironmentResources()

    // It may be a second install's, and this database cannot tell. Saying so is
    // free; acting on it would cost somebody else their checkout.
    expect(report.unattributed).toEqual(['volume domo-dev-env_pruned-workspace'])
    expect(fake.volumes).toEqual(['domo-dev-env_pruned-workspace'])
  })

  it('records nothing when Docker cannot be asked, rather than calling it clean', async () => {
    // An empty stdout from an unreachable daemon reads exactly like "nothing is
    // there", and acting on that would clear every leftover ever recorded.
    run.mockRejectedValue(new Error('Cannot connect to the Docker daemon'))
    repo.listDevEnvironments.mockResolvedValue([RETIRED])

    const report = await reconcileEnvironmentResources()

    expect(report.unreachable).toMatch(/Cannot connect/)
    expect(repo.setEnvironmentLeftovers).not.toHaveBeenCalled()
  })

  it('fails a cleanup Docker could not be asked for, rather than answering "cleaned up"', async () => {
    run.mockRejectedValue(new Error('Cannot connect to the Docker daemon'))
    repo.getDevEnvironment.mockResolvedValue(RETIRED)
    repo.listDevEnvironments.mockResolvedValue([RETIRED])

    await expect(cleanupEnvironment('env_1')).rejects.toThrow(/could not be reached: Cannot connect/)
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
    // postCreateCommand may already have started a stack before it failed, so
    // the proxy goes before anything is taken down.
    expect(dood.stopDoodProxy).toHaveBeenCalledWith(expect.stringMatching(/^env_/))
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
      expect(repo.setEnvironmentLeftovers).toHaveBeenCalledWith(id, expect.arrayContaining([
        expect.objectContaining({ kind: 'volume', name: `domo-dev-${id}-workspace` })
      ]))
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
    // The row claims everything named from its id before anything is
    // confirmed gone, so a crash halfway is still a row that knows what to
    // look for; the sweep after it removes and clears.
    expect(repo.setEnvironmentLeftovers).toHaveBeenCalledWith(id, [
      expect.objectContaining({ kind: 'container', name: `domo-dev-${id}` }),
      expect.objectContaining({ kind: 'volume', name: `domo-dev-${id}-workspace` }),
      expect.objectContaining({ kind: 'volume', name: `dind-var-lib-docker-${id}` }),
      expect.objectContaining({ kind: 'image', name: `domo-dev-${id}` })
    ])
  })

  it('claims and removes what a failed creation left, the stack its postCreateCommand started included', async () => {
    const rows = new Map<string, DevEnvironment>()
    repo.createDevEnvironmentRow.mockImplementation(async (input: any) => {
      rows.set(input.id, environment(input))
      return rows.get(input.id)
    })
    repo.getDevEnvironment.mockImplementation(async (id: string) => rows.get(id) ?? null)
    repo.listDevEnvironments.mockImplementation(async () => [...rows.values()])
    repo.setEnvironmentLeftovers.mockImplementation(async (id: string, leftovers: any[]) => {
      rows.set(id, { ...rows.get(id)!, leftovers })
      return null
    })
    let fake!: FakeDaemon
    buildEnvironmentImage.mockImplementation(async ({ environmentId }: any) => {
      // What a half-made environment and its postCreateCommand's stack leave.
      fake = daemon({
        volumes: [`domo-dev-${environmentId}-workspace`, `${environmentId}-db`],
        images: [`domo-dev-${environmentId}`],
        containers: [`${environmentId}-db`],
        labels: { [`${environmentId}-db`]: { env: environmentId } }
      })
      throw new Error('feature build failed')
    })

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).rejects.toThrow('feature build failed')

    expect(fake).toMatchObject({ containers: [], volumes: [], images: [] })
    // Confirmed gone, so it owes nothing any more.
    expect([...rows.values()][0]!.leftovers).toEqual([])
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
