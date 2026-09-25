import { createServer } from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Port attributes travel on the container as `domo.portsAttributes`, stamped there when
 * the environment was created. Reading them from the project's config instead would make
 * a detected port's label depend on a file that may have changed since.
 */

const run = vi.fn(async (_program: string, _args: string[], _options?: unknown) => ({ stdout: '', stderr: '' }))
const inspectContainer = vi.fn()
const repo = {
  deleteDevEnvironmentPort: vi.fn(),
  getDevEnvironment: vi.fn(),
  listDevEnvironmentPorts: vi.fn(async (): Promise<unknown[]> => []),
  listDevEnvironments: vi.fn(async () => []),
  updateDevEnvironmentPort: vi.fn(),
  upsertDevEnvironmentPort: vi.fn()
}

vi.mock('../../server/lib/dev-env/docker', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  run,
  inspectContainer
}))
vi.mock('../../server/lib/repo', () => repo)

const { refreshEnvironmentPorts, stopAllEnvironmentForwarders } = await import('../../server/lib/dev-environment-ports')
const { portHelperImage } = await import('../../server/lib/dev-env/port-helper')

const environment = {
  id: 'env_1',
  containerId: 'container-sha',
  containerName: 'domo-dev-env_1',
  remoteUser: 'vscode',
  workspacePath: '/workspaces/api'
}

function inspection(labels: Record<string, string>) {
  return { id: 'container-sha', running: true, labels, namedVolumes: [], publishedPorts: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  repo.getDevEnvironment.mockResolvedValue(environment)
  repo.listDevEnvironmentPorts.mockResolvedValue([])
  // One listening port the environment never declared.
  run.mockResolvedValue({ stdout: 'LISTEN 0 511 *:4321 *:*\n', stderr: '' })
})

describe('refreshEnvironmentPorts', () => {
  it('labels a detected port from the domo.portsAttributes label', async () => {
    inspectContainer.mockResolvedValue(inspection({
      'domo.portsAttributes': JSON.stringify({ 4321: { label: 'Admin', protocol: 'https' } })
    }))

    await refreshEnvironmentPorts('env_1')

    expect(repo.upsertDevEnvironmentPort).toHaveBeenCalledWith(expect.objectContaining({
      innerPort: 4321,
      label: 'Admin',
      appProtocol: 'https',
      source: 'detected'
    }))
  })

  it('matches a port range', async () => {
    inspectContainer.mockResolvedValue(inspection({
      'domo.portsAttributes': JSON.stringify({ '4000-5000': { label: 'App', onAutoForward: 'ignore' } })
    }))

    await refreshEnvironmentPorts('env_1')

    expect(repo.upsertDevEnvironmentPort).not.toHaveBeenCalled()
  })

  it('treats a container with no label, or an unreadable one, as having no attributes', async () => {
    inspectContainer.mockResolvedValue(inspection({ 'domo.portsAttributes': 'not json' }))

    await refreshEnvironmentPorts('env_1')

    expect(repo.upsertDevEnvironmentPort).toHaveBeenCalledWith(expect.objectContaining({
      innerPort: 4321,
      label: null,
      appProtocol: null
    }))
  })
})

describe('refreshEnvironmentPorts on the host daemon', () => {
  const web = {
    Id: 'web-sha',
    Name: '/stack-web-1',
    State: { Running: true, Pid: 4242 },
    Config: {
      Labels: {
        'domo.env': 'env_1',
        'com.docker.compose.service': 'web',
        // What the proxy wrote down when it dropped `ports: "8080"`.
        'domo.ports': JSON.stringify([{ containerPort: 8080, protocol: 'tcp', hostPort: null }])
      }
    },
    HostConfig: { NetworkMode: 'stack_default' }
  }
  const LOOPBACK_8080 = '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1\n'
  const HELPER = 'domo-dev-port-helper'

  /** A daemon with one service, and the global helper running or not. */
  function daemon(options: { helperRunning?: boolean, running?: boolean, exists?: boolean | 'unknown' } = {}) {
    const { running = true, exists = true } = options
    run.mockImplementation(async (_program, args) => {
      if (args[0] === 'ps' && args.includes('--all')) {
        if (exists === 'unknown') throw new Error('Cannot connect to the Docker daemon')
        return { stdout: exists ? 'stack-web-1\n' : '', stderr: '' }
      }
      if (args[0] === 'ps') return { stdout: running ? 'web-sha' : '', stderr: '' }
      if (args[0] === 'inspect' && args.at(-1) === HELPER) {
        return { stdout: options.helperRunning ? `true ${portHelperImage()}` : '', stderr: '' }
      }
      // The per-connection PID lookup, owner label included.
      if (args[0] === 'inspect' && args.includes('--format')) return { stdout: '4242 env_1', stderr: '' }
      if (args[0] === 'inspect') return { stdout: JSON.stringify([web]), stderr: '' }
      if (args[0] === 'exec' && args.includes('/proc/net/tcp')) return { stdout: LOOPBACK_8080, stderr: '' }
      return { stdout: '', stderr: '' }
    })
    inspectContainer.mockResolvedValue(inspection({ 'domo.dood': 'true' }))
    repo.upsertDevEnvironmentPort.mockImplementation(async (input: any) => ({
      ...input, service: input.service ?? null, hostPort: null, forwarded: false
    }))
  }

  afterEach(() => stopAllEnvironmentForwarders())

  it('finds a loopback port in a sibling by entering its namespace through the one helper', async () => {
    daemon()

    await refreshEnvironmentPorts('env_1')

    const started = run.mock.calls.find(([, args]) => args[0] === 'run')![1]
    expect(started).toEqual(expect.arrayContaining(['--name', HELPER, '--pid', 'host']))
    expect(run).toHaveBeenCalledWith(
      'docker', ['exec', HELPER, 'nsenter', '-t', '4242', '-n', 'cat', '/proc/net/tcp', '/proc/net/tcp6'], expect.anything()
    )
    expect(repo.upsertDevEnvironmentPort).toHaveBeenCalledWith(expect.objectContaining({
      service: 'stack-web-1',
      innerPort: 8080,
      label: 'web',
      appProtocol: 'http',
      source: 'detected'
    }))
  })

  it('forwards a port the stack asked to publish, the first time it is seen', async () => {
    daemon({ helperRunning: true })

    await refreshEnvironmentPorts('env_1')

    // Reused, not started again.
    expect(run.mock.calls.some(([, args]) => args[0] === 'run')).toBe(false)
    expect(repo.updateDevEnvironmentPort).toHaveBeenCalledWith(
      'env_1', 8080, expect.objectContaining({ forwarded: true, hostPort: expect.any(Number) }), 'tcp', 'stack-web-1'
    )
  })

  it('does not forward it again once the row exists', async () => {
    daemon({ helperRunning: true })
    repo.listDevEnvironmentPorts.mockResolvedValue([{
      id: 'port_1', devEnvironmentId: 'env_1', service: 'stack-web-1', innerPort: 8080, protocol: 'tcp',
      appProtocol: 'http', label: 'web', source: 'detected', hostPort: null, listening: true, forwarded: false, url: null
    }])

    await refreshEnvironmentPorts('env_1')

    expect(repo.upsertDevEnvironmentPort).not.toHaveBeenCalled()
    expect(repo.updateDevEnvironmentPort).not.toHaveBeenCalledWith(
      'env_1', 8080, expect.objectContaining({ forwarded: true }), 'tcp', 'stack-web-1'
    )
  })

  const row = (patch: Record<string, unknown> = {}) => ({
    id: 'port_1', devEnvironmentId: 'env_1', service: 'stack-web-1', innerPort: 8080, protocol: 'tcp',
    appProtocol: 'http', label: 'web', source: 'detected', hostPort: null, listening: true, forwarded: false, url: null,
    ...patch
  })
  const canListenOn = (port: number) => new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })

  it('forgets a removed service, and gives back the host port its forward held', async () => {
    daemon({ helperRunning: true })
    await refreshEnvironmentPorts('env_1')
    const forwarded = repo.updateDevEnvironmentPort.mock.calls.find(([, , patch]) => patch.forwarded)!
    const hostPort = forwarded[2].hostPort as number
    expect(await canListenOn(hostPort)).toBe(false)

    // `compose down`, or `docker rm -f`: the container is not merely stopped.
    daemon({ helperRunning: true, running: false, exists: false })
    // The row as it was, and then as the delete left it.
    repo.listDevEnvironmentPorts.mockResolvedValueOnce([row({ hostPort, forwarded: true })]).mockResolvedValue([])
    await refreshEnvironmentPorts('env_1')

    expect(repo.deleteDevEnvironmentPort).toHaveBeenCalledWith('env_1', 8080, 'tcp', 'stack-web-1')
    await expect.poll(() => canListenOn(hostPort)).toBe(true)
  })

  it('keeps a stopped service\'s row, which starting it again brings back', async () => {
    daemon({ helperRunning: true, running: false })
    repo.listDevEnvironmentPorts.mockResolvedValue([row({ hostPort: 5432, forwarded: true })])

    await refreshEnvironmentPorts('env_1')

    expect(repo.deleteDevEnvironmentPort).not.toHaveBeenCalled()
  })

  it('forgets nothing when the daemon cannot say what exists', async () => {
    daemon({ helperRunning: true, running: false, exists: 'unknown' })
    repo.listDevEnvironmentPorts.mockResolvedValue([row()])

    await refreshEnvironmentPorts('env_1')

    expect(repo.deleteDevEnvironmentPort).not.toHaveBeenCalled()
  })

  it('looks for no siblings in an environment with a daemon of its own', async () => {
    run.mockResolvedValue({ stdout: '', stderr: '' })
    inspectContainer.mockResolvedValue(inspection({}))

    await refreshEnvironmentPorts('env_1')

    expect(run.mock.calls.some(([, args]) => args[0] === 'ps')).toBe(false)
  })
})
