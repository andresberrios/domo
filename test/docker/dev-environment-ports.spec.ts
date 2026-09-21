import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Port attributes travel on the container as `domo.portsAttributes`, stamped there when
 * the environment was created. Reading them from the project's config instead would make
 * a detected port's label depend on a file that may have changed since.
 */

const run = vi.fn(async (_program: string, _args: string[], _options?: unknown) => ({ stdout: '', stderr: '' }))
const inspectContainer = vi.fn()
const repo = {
  getDevEnvironment: vi.fn(),
  listDevEnvironmentPorts: vi.fn(async () => []),
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

const { refreshEnvironmentPorts } = await import('../../server/lib/dev-environment-ports')

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
