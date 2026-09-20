import { access, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { AgentAdapter, DevEnvironment } from '../../shared/types'
import { newId } from './db'
import { refreshEnvironmentPorts, stopEnvironmentForwarders } from './dev-environment-ports'
import { resolveDevcontainerConfig, resolveForwardPorts } from './devcontainer/config'
import { devcontainerUp, inspectContainer, populateWorkspaceVolume, resourcePrefix, run } from './devcontainer/client'
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

/** The named volume that holds an environment's checkout. Derived from the id, so it needs no column. */
export function workspaceVolumeName(environmentId: string): string {
  return `${resourcePrefix()}${environmentId}-workspace`.toLowerCase()
}

const HELPER_IMAGE = process.env.NUXT_DEV_ENV_HELPER_IMAGE || 'busybox:1.37'

async function copyRepository(source: string, environmentId: string): Promise<string> {
  const volume = workspaceVolumeName(environmentId)
  await run('docker', ['volume', 'create', '--label', `domo.envId=${environmentId}`, volume])
  const excluded = relative(resolve(source), resolve(dataDir()))
  await populateWorkspaceVolume({
    source,
    volume,
    helperImage: HELPER_IMAGE,
    exclude: excluded && !excluded.startsWith('..') && !isAbsolute(excluded) ? [excluded] : []
  })
  return volume
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

/**
 * Removes a container and everything of its that `docker rm --volumes` leaves
 * behind. That flag only takes anonymous volumes; the Docker-in-Docker Feature
 * keeps /var/lib/docker in a *named* one (`dind-var-lib-docker-<id>`, prefixed
 * with the compose project for compose definitions), so the nested daemon's whole
 * image store used to outlive its environment. Only that volume is removed by
 * name: any other one a project's own config mounts may be shared.
 */
async function removeContainer(reference: string): Promise<void> {
  const inspection = await inspectContainer(reference).catch(() => null)
  const dindVolumes = (inspection?.namedVolumes ?? []).filter(name => name.includes('dind-var-lib-docker'))
  const composeProject = inspection?.labels['com.docker.compose.project']
  if (composeProject) {
    // A compose-based definition: the container is one service of a project with its own
    // network, volumes and possibly sidecars. `down` needs only the project name.
    await run('docker', ['compose', '--project-name', composeProject, 'down', '--volumes', '--remove-orphans'], { allowFailure: true }).catch(() => {})
  }
  await run('docker', ['rm', '--force', '--volumes', reference], { allowFailure: true }).catch(() => {})
  for (const volume of dindVolumes) {
    await run('docker', ['volume', 'rm', volume], { allowFailure: true }).catch(() => {})
  }
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
  const workspacePath = `/workspaces/${safeName}`
  await createDevEnvironmentRow({
    id,
    projectId: project.id,
    name: input.name.trim(),
    containerName: `domo-dev-${id}`,
    workspacePath
  })

  try {
    // Read the definition (and, later, build contexts / compose files) from the project's own
    // checkout; the environment gets a copy in a named volume, never a host directory.
    const resolved = await resolveDevcontainerConfig(project.repoPath, input.name.trim())
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
    const workspaceVolume = await copyRepository(project.repoPath, id)
    const result = await devcontainerUp({
      resolved,
      environmentId: id,
      projectId: project.id,
      environmentName: input.name.trim(),
      workspaceVolume,
      repoPath: project.repoPath,
      ports: declaredPorts,
      claudeConfigDir,
      codexConfigDir,
      // The tar stream left the files owned by root. Hand them to the remote user before
      // postCreateCommand & co. run as that user.
      afterCreate: async (created) => {
        if (!created.remoteUser || created.remoteUser === 'root') return
        await run('docker', [
          'exec', '--user', 'root', created.containerId,
          'chown', '--recursive', `${created.remoteUser}:`, created.workspacePath
        ])
      }
    })
    const inspection = await inspectContainer(result.containerId)
    if (!inspection) throw new Error('The Dev Container was created but could not be inspected.')
    await updateDevEnvironment(id, {
      containerId: result.containerId,
      containerName: inspection.name,
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
      await removeContainer(current.containerId)
    } else {
      const found = await run('docker', [
        'ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`
      ], { allowFailure: true }).catch(() => ({ stdout: '', stderr: '' }))
      for (const containerId of found.stdout.split('\n').filter(Boolean)) {
        await removeContainer(containerId)
      }
    }
    await run('docker', ['volume', 'rm', workspaceVolumeName(id)], { allowFailure: true }).catch(() => {})
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
  await removeContainer(containerReference(environment))
  // The checkout's volume, plus the one older installs named after the container.
  for (const volume of [workspaceVolumeName(id), `${environment.containerName}-workspace`]) {
    await run('docker', ['volume', 'rm', volume], { allowFailure: true }).catch(() => {})
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
