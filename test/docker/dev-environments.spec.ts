import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DevEnvironment } from '~~/shared/types'

/**
 * Docker is driven at the process boundary: `run('docker', [...])` with an
 * argument array, never an interpolated shell string. These tests assert on the
 * exact argv, which is the only thing that a name with a space, a `$` or a
 * newline in it can break. No Docker daemon is involved — see the `.live` spec
 * for the handful of tests that need a real one.
 */

const run = vi.fn(async (_program: string, _args: string[], _options?: unknown) => ({ stdout: '', stderr: '' }))
const inspectContainer = vi.fn()
const devcontainerUp = vi.fn()
const repo = {
  createDevEnvironmentRow: vi.fn(),
  deleteDevEnvironmentRow: vi.fn(),
  getDevEnvironment: vi.fn(),
  getProject: vi.fn(),
  updateDevEnvironment: vi.fn(),
  upsertDevEnvironmentPort: vi.fn()
}

vi.mock('../../server/lib/devcontainer/client', () => ({ run, inspectContainer, devcontainerUp }))
vi.mock('../../server/lib/dev-environment-ports', () => ({
  refreshEnvironmentPorts: vi.fn(async () => []),
  stopEnvironmentForwarders: vi.fn()
}))
vi.mock('../../server/lib/repo', () => repo)

const {
  containerExecArgs,
  createEnvironment,
  ensureEnvironmentAdapter,
  readEnvironmentFile,
  removeEnvironment,
  startEnvironment,
  stopEnvironment,
  writeEnvironmentFile
} = await import('../../server/lib/dev-environments')

function environment(overrides: Partial<DevEnvironment> = {}): DevEnvironment {
  return {
    id: 'env_1',
    projectId: 'prj_1',
    name: 'api',
    containerName: 'domo-dev-env_1',
    containerId: 'container-sha',
    workspacePath: '/workspaces/api',
    hostWorkspacePath: '/tmp/domo/env_1/repo',
    configSource: 'default',
    configPath: null,
    remoteUser: 'vscode',
    status: 'running',
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

/** Every `docker` invocation, as argv. */
function dockerCalls(): string[][] {
  return run.mock.calls.filter(([program]) => program === 'docker').map(([, args]) => args)
}

beforeEach(() => {
  vi.clearAllMocks()
  run.mockResolvedValue({ stdout: '', stderr: '' })
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

describe('ensureEnvironmentAdapter', () => {
  it('installs the Claude Code adapter only when it is missing', async () => {
    await ensureEnvironmentAdapter(environment(), 'claude-code')

    expect(dockerCalls()[0]).toEqual([
      'exec', '--user', 'root', 'container-sha',
      'sh', '-c', 'command -v "$1" >/dev/null 2>&1 || npm install --global "$2"',
      'sh', 'claude-agent-acp', '@agentclientprotocol/claude-agent-acp@0.78.0'
    ])
  })

  it('installs the Codex adapter for a Codex session', async () => {
    await ensureEnvironmentAdapter(environment(), 'codex')

    expect(dockerCalls()[0]!.slice(-2)).toEqual(['codex-acp', '@agentclientprotocol/codex-acp@1.12.0'])
  })
})

describe('start, stop and remove', () => {
  it('starts a container that exists but is not running', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment({ status: 'stopped' }))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: false, publishedPorts: [] })

    await startEnvironment('env_1')

    expect(dockerCalls()).toEqual([['start', 'container-sha']])
    expect(repo.updateDevEnvironment).toHaveBeenCalledWith('env_1', { status: 'running', lastError: null })
  })

  it('does not start a container that is already running', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.updateDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: true, publishedPorts: [] })

    await startEnvironment('env_1')

    expect(dockerCalls()).toEqual([])
  })

  it('asks for a recreate when the container is gone', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    inspectContainer.mockResolvedValue(null)

    await expect(startEnvironment('env_1')).rejects.toThrow(/no longer exists\. Delete and recreate/)
  })

  it('stops the container and marks the environment stopped', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())
    repo.updateDevEnvironment.mockResolvedValue(environment({ status: 'stopped' }))
    inspectContainer.mockResolvedValue({ id: 'container-sha', running: true, publishedPorts: [] })

    await stopEnvironment('env_1')

    expect(dockerCalls()).toEqual([['stop', 'container-sha']])
  })

  it('removes the container with its volumes, and tolerates it being gone', async () => {
    repo.getDevEnvironment.mockResolvedValue(environment())

    await removeEnvironment('env_1')

    expect(run).toHaveBeenCalledWith(
      'docker',
      ['rm', '--force', '--volumes', 'container-sha'],
      { allowFailure: true }
    )
    expect(repo.deleteDevEnvironmentRow).toHaveBeenCalledWith('env_1')
  })

  it('is a no-op for an environment that is not there', async () => {
    repo.getDevEnvironment.mockResolvedValue(null)

    await removeEnvironment('env_gone')

    expect(run).not.toHaveBeenCalled()
    expect(repo.deleteDevEnvironmentRow).not.toHaveBeenCalled()
  })
})

describe('createEnvironment', () => {
  let repoPath: string
  let dataRoot: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'domo-env-data-'))
    repoPath = await mkdtemp(join(tmpdir(), 'domo-env-repo-'))
    process.env.NUXT_DATA_DIR = dataRoot
    await mkdir(join(repoPath, '.git'), { recursive: true })
    await writeFile(join(repoPath, 'README.md'), '# project\n', 'utf8')
    await writeFile(
      join(repoPath, '.domo.json'),
      JSON.stringify({ devEnvironment: { image: 'ghcr.io/acme/dev:latest', forwardPorts: [3000] } }),
      'utf8'
    )

    repo.getProject.mockResolvedValue({ id: 'prj_1', name: 'api', repoPath })
    repo.createDevEnvironmentRow.mockImplementation(async (input: any) => environment(input))
    repo.updateDevEnvironment.mockResolvedValue(environment())
    repo.getDevEnvironment.mockResolvedValue(environment())
    devcontainerUp.mockResolvedValue({
      containerId: 'container-sha',
      workspacePath: '/workspaces/api',
      remoteUser: 'vscode'
    })
    inspectContainer.mockResolvedValue({
      id: 'container-sha',
      name: 'domo-dev-env_1',
      running: true,
      publishedPorts: []
    })
  })

  afterEach(async () => {
    delete process.env.NUXT_DATA_DIR
    await rm(dataRoot, { recursive: true, force: true })
    await rm(repoPath, { recursive: true, force: true })
  })

  it('copies the checkout, declares its ports and boots a Dev Container', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    const copied = repo.createDevEnvironmentRow.mock.calls[0]![0].hostWorkspacePath
    await expect(readFile(join(copied, 'README.md'), 'utf8')).resolves.toBe('# project\n')

    expect(repo.upsertDevEnvironmentPort).toHaveBeenCalledWith(expect.objectContaining({
      innerPort: 3000,
      protocol: 'tcp',
      source: 'declared'
    }))
    expect(devcontainerUp).toHaveBeenCalledWith(expect.objectContaining({
      environmentName: 'API work',
      hostWorkspace: copied,
      resolved: expect.objectContaining({ source: 'domo' })
    }))
  })

  it('makes the workspace safe for git and installs both adapters, as argv', async () => {
    await createEnvironment({ projectId: 'prj_1', name: 'API work' })

    expect(dockerCalls()).toContainEqual([
      'exec', '--user', 'root', 'container-sha',
      'npm', 'install', '--global',
      '@agentclientprotocol/claude-agent-acp@0.78.0',
      '@agentclientprotocol/codex-acp@1.12.0'
    ])
    expect(dockerCalls()).toContainEqual([
      'exec', '--user', 'vscode', '--env', 'HOME=/home/vscode', 'container-sha',
      'git', 'config', '--global', '--add', 'safe.directory', '/workspaces/api'
    ])
  })

  it('refuses a project that is not a Git checkout', async () => {
    await rm(join(repoPath, '.git'), { recursive: true, force: true })

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).rejects.toThrow()
    expect(devcontainerUp).not.toHaveBeenCalled()
  })

  it('records the failure and tears the container down again when the boot fails', async () => {
    devcontainerUp.mockRejectedValue(new Error('no privileged containers allowed'))

    await expect(createEnvironment({ projectId: 'prj_1', name: 'API work' })).rejects
      .toThrow('no privileged containers allowed')

    expect(repo.updateDevEnvironment).toHaveBeenCalledWith(
      expect.any(String),
      { status: 'error', lastError: 'no privileged containers allowed' }
    )
    expect(dockerCalls()).toContainEqual(['rm', '--force', '--volumes', 'container-sha'])
  })
})
