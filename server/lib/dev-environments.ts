import { access, cp, mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import type { AgentAdapter, DevEnvironment } from '../../shared/types'
import { newId } from './db'
import { refreshEnvironmentPorts, stopEnvironmentForwarders } from './dev-environment-ports'
import { resolveDevcontainerConfig, resolveForwardPorts } from './devcontainer/config'
import { devcontainerUp, inspectContainer, run } from './devcontainer/client'
import { dataDir } from './paths'
import {
  createDevEnvironmentRow,
  deleteDevEnvironmentRow,
  getDevEnvironment,
  getProject,
  updateDevEnvironment,
  upsertDevEnvironmentPort
} from './repo'

function environmentRoot(id: string): string {
  return join(dataDir(), 'dev-environments', id)
}

function safeEnvironmentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase()
}

function containerReference(environment: DevEnvironment): string {
  return environment.containerId || environment.containerName
}

export async function ensureEnvironmentAdapter(
  environment: DevEnvironment,
  adapter: AgentAdapter
): Promise<void> {
  const [command, packageSpec] = adapter === 'codex'
    ? ['codex-acp', '@agentclientprotocol/codex-acp@1.12.0']
    : ['claude-agent-acp', '@agentclientprotocol/claude-agent-acp@0.78.0']
  await run('docker', [
    'exec', '--user', 'root', containerReference(environment),
    'sh', '-c', 'command -v "$1" >/dev/null 2>&1 || npm install --global "$2"',
    'sh', command, packageSpec
  ])
}

async function copyRepository(source: string, destination: string): Promise<void> {
  const excluded = resolve(dataDir())
  await mkdir(destination, { recursive: true })
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => {
      const absolute = resolve(path)
      return absolute !== excluded && !absolute.startsWith(`${excluded}${sep}`)
    }
  })
}

async function installDomoRuntime(containerId: string, remoteUser: string | null, workspacePath: string): Promise<void> {
  await run('docker', [
    'exec', '--user', 'root', containerId,
    'npm', 'install', '--global',
    '@agentclientprotocol/claude-agent-acp@0.78.0',
    '@agentclientprotocol/codex-acp@1.12.0'
  ])
  const meshEntry = process.env.NUXT_DOMO_MCP_ENTRY
  if (meshEntry) {
    await run('docker', ['exec', '--user', 'root', containerId, 'mkdir', '-p', '/opt/domo'])
    await run('docker', ['cp', meshEntry, `${containerId}:/opt/domo/agent-mesh.mjs`])
    await run('docker', ['exec', '--user', 'root', containerId, 'chmod', '755', '/opt/domo/agent-mesh.mjs'])
  }
  const args = ['exec']
  if (remoteUser) args.push('--user', remoteUser)
  const home = !remoteUser || remoteUser === 'root' ? '/root' : `/home/${remoteUser}`
  args.push('--env', `HOME=${home}`, containerId, 'git', 'config', '--global', '--add', 'safe.directory', workspacePath)
  await run('docker', args)
}

export async function createEnvironment(input: {
  projectId: string
  name: string
}): Promise<DevEnvironment> {
  const project = await getProject(input.projectId)
  if (!project) throw new Error('Project not found')
  await access(join(project.repoPath, '.git'))

  const id = newId('env')
  const safeName = safeEnvironmentName(input.name) || id
  const hostWorkspace = join(environmentRoot(id), 'repo')
  const workspacePath = `/workspaces/${safeName}`
  await createDevEnvironmentRow({
    id,
    projectId: project.id,
    name: input.name.trim(),
    containerName: `domo-dev-${id}`,
    workspacePath,
    hostWorkspacePath: hostWorkspace
  })

  try {
    await copyRepository(project.repoPath, hostWorkspace)
    const resolved = await resolveDevcontainerConfig(hostWorkspace, input.name.trim())
    const declaredPorts = resolveForwardPorts(resolved.config)
    for (const port of declaredPorts) {
      await upsertDevEnvironmentPort({
        environmentId: id,
        ...port,
        source: 'declared'
      })
    }
    const configuredClaudeDir = process.env.NUXT_CLAUDE_CONFIG_DIR
      || (process.env.HOME ? join(process.env.HOME, '.claude') : null)
    const claudeConfigDir = configuredClaudeDir
      ? await access(configuredClaudeDir).then(() => configuredClaudeDir).catch(() => null)
      : null
    const configuredCodexDir = process.env.NUXT_CODEX_CONFIG_DIR
      || (process.env.HOME ? join(process.env.HOME, '.codex') : null)
    const codexConfigDir = configuredCodexDir
      ? await access(configuredCodexDir).then(() => configuredCodexDir).catch(() => null)
      : null
    const result = await devcontainerUp({
      resolved,
      environmentId: id,
      projectId: project.id,
      environmentName: input.name.trim(),
      hostWorkspace,
      ports: declaredPorts,
      claudeConfigDir,
      codexConfigDir
    })
    const inspection = await inspectContainer(result.containerId)
    if (!inspection) throw new Error('The Dev Container was created but could not be inspected.')
    await updateDevEnvironment(id, {
      containerId: result.containerId,
      containerName: inspection.name,
      hostWorkspacePath: hostWorkspace,
      workspacePath: result.workspacePath,
      configSource: resolved.source,
      configPath: resolved.displayPath,
      remoteUser: result.remoteUser
    })
    await installDomoRuntime(result.containerId, result.remoteUser, result.workspacePath)
    const environment = (await updateDevEnvironment(id, {
      status: 'running',
      lastError: null
    }))!
    await refreshEnvironmentPorts(id)
    return (await getDevEnvironment(id)) ?? environment
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateDevEnvironment(id, { status: 'error', lastError: message })
    const current = await getDevEnvironment(id)
    if (current?.containerId) {
      await run('docker', ['rm', '--force', '--volumes', current.containerId], { allowFailure: true }).catch(() => {})
    } else {
      const found = await run('docker', [
        'ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`
      ], { allowFailure: true }).catch(() => ({ stdout: '', stderr: '' }))
      for (const containerId of found.stdout.split('\n').filter(Boolean)) {
        await run('docker', ['rm', '--force', '--volumes', containerId], { allowFailure: true }).catch(() => {})
      }
    }
    throw error
  }
}

export async function startEnvironment(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  const inspection = await inspectContainer(containerReference(environment))
  if (!inspection) throw new Error('The environment container no longer exists. Delete and recreate the environment.')
  if (!inspection.running) await run('docker', ['start', inspection.id])
  const updated = (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
  await refreshEnvironmentPorts(id)
  return updated
}

export async function stopEnvironment(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  const inspection = await inspectContainer(containerReference(environment))
  stopEnvironmentForwarders(id)
  if (inspection?.running) await run('docker', ['stop', inspection.id])
  return (await updateDevEnvironment(id, { status: 'stopped' }))!
}

export async function ensureEnvironmentRunning(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  const inspection = await inspectContainer(containerReference(environment))
  if (inspection?.running) {
    if (environment.status !== 'running') {
      return (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
    }
    return environment
  }
  return startEnvironment(id)
}

export async function removeEnvironment(id: string): Promise<void> {
  const environment = await getDevEnvironment(id)
  if (!environment) return
  stopEnvironmentForwarders(id)
  await run('docker', ['rm', '--force', '--volumes', containerReference(environment)], { allowFailure: true }).catch(() => {})
  if (!environment.containerId) {
    await run('docker', ['volume', 'rm', `${environment.containerName}-workspace`], { allowFailure: true }).catch(() => {})
  }
  const root = resolve(environmentRoot(id))
  const environmentsDir = resolve(join(dataDir(), 'dev-environments'))
  const relativeRoot = relative(environmentsDir, root)
  if (relativeRoot && !relativeRoot.startsWith('..') && !relativeRoot.startsWith(sep)) {
    await rm(root, { recursive: true, force: true })
  }
  await deleteDevEnvironmentRow(id)
}

export function containerExecArgs(environment: DevEnvironment, env: NodeJS.ProcessEnv = {}): string[] {
  const args = ['exec', '--interactive']
  if (environment.remoteUser) args.push('--user', environment.remoteUser)
  args.push('--workdir', environment.workspacePath)
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) args.push('--env', `${key}=${value}`)
  }
  args.push(containerReference(environment))
  return args
}

export async function readEnvironmentFile(environment: DevEnvironment, path: string): Promise<string> {
  const args = ['exec']
  if (environment.remoteUser) args.push('--user', environment.remoteUser)
  args.push(containerReference(environment), 'cat', path)
  return (await run('docker', args, { trimOutput: false })).stdout
}

export async function writeEnvironmentFile(
  environment: DevEnvironment,
  path: string,
  content: string
): Promise<void> {
  const args = ['exec', '--interactive']
  if (environment.remoteUser) args.push('--user', environment.remoteUser)
  args.push(
    containerReference(environment),
    'sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path
  )
  await run('docker', args, { input: content })
}
