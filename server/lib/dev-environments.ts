import { access } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { DevEnvironment } from '../../shared/types'
import { syncClaudeCredentials } from './claude-credentials'
import { newId } from './db'
import { refreshEnvironmentPorts, stopEnvironmentForwarders } from './dev-environment-ports'
import { resolveEnvironmentConfig, resolveForwardPorts } from './dev-env/config'
import {
  containerRunArgs,
  homeDirectory,
  postCreateArgs,
  readImageMetadata,
  resolveRemoteUser
} from './dev-env/container'
import { inspectContainer, populateWorkspaceVolume, resourcePrefix, run } from './dev-env/docker'
import { buildEnvironmentImage, environmentImageName, removeImage } from './dev-env/image'
import { collectRuntimeVolumes, ensureRuntimeVolume, RUNTIME_ROOT } from './dev-env/runtime-volume'
import { dataDir } from './paths'
import {
  createDevEnvironmentRow,
  deleteDevEnvironmentRow,
  getDevEnvironment,
  getProject,
  updateDevEnvironment,
  upsertDevEnvironmentPort
} from './repo'

const HELPER_IMAGE = process.env.NUXT_DEV_ENV_HELPER_IMAGE || 'busybox:1.37'
/** How long the nested daemon gets to answer `docker info` before creation is called failed. */
function dockerReadyTimeout(): number {
  return Number(process.env.NUXT_DEV_ENV_DOCKER_READY_MS) || 30_000
}

export function safeEnvironmentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase()
}

/** The named volume that holds an environment's checkout. Derived from the id, so it needs no column. */
export function workspaceVolumeName(environmentId: string): string {
  return `${resourcePrefix()}${environmentId}-workspace`.toLowerCase()
}

function containerReference(environment: DevEnvironment): string {
  return environment.containerId || environment.containerName
}

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

/**
 * Removes a container and the one volume `docker rm --volumes` leaves behind. That flag
 * only takes anonymous volumes; the Docker-in-Docker Feature keeps /var/lib/docker in a
 * *named* one (`dind-var-lib-docker-<id>`), so the nested daemon's whole image store used
 * to outlive its environment. Only that volume is removed by name: any other one a
 * project's own config mounts may be shared.
 */
async function removeContainer(reference: string): Promise<void> {
  const inspection = await inspectContainer(reference).catch(() => null)
  const dindVolumes = (inspection?.namedVolumes ?? []).filter(name => name.includes('dind-var-lib-docker'))
  await run('docker', ['rm', '--force', '--volumes', reference], { allowFailure: true }).catch(() => {})
  for (const volume of dindVolumes) {
    await run('docker', ['volume', 'rm', volume], { allowFailure: true }).catch(() => {})
  }
}

function execArgs(input: {
  containerId: string
  user?: string
  workdir?: string
  env?: Record<string, string>
}): string[] {
  const args = ['exec']
  if (input.user) args.push('--user', input.user)
  if (input.workdir) args.push('--workdir', input.workdir)
  for (const [key, value] of Object.entries(input.env ?? {})) args.push('--env', `${key}=${value}`)
  args.push(input.containerId)
  return args
}

/**
 * The three things an environment image has to provide before an agent can work in it.
 * Each failure has a readable cause, because the alternative is a stack trace from
 * something several layers away complaining that a file is missing.
 */
async function preflight(containerId: string, wantsDocker: boolean): Promise<void> {
  await run('docker', [...execArgs({ containerId }), 'git', '--version']).catch(() => {
    throw new Error('The environment image does not have `git` installed, and Domo needs it in the workspace.')
  })
  await run('docker', [...execArgs({ containerId }), `${RUNTIME_ROOT}/node/bin/node`, '--version']).catch(() => {
    throw new Error(
      'The environment image cannot run Domo\'s bundled Node. The image must be glibc-based '
      + '(Debian, Ubuntu, Fedora, …); Alpine and other musl images are not supported.'
    )
  })
  if (!wantsDocker) return
  const timeout = dockerReadyTimeout()
  const deadline = Date.now() + timeout
  for (;;) {
    const ready = await run('docker', [
      ...execArgs({ containerId }), 'docker', 'info', '--format', '{{.ServerVersion}}'
    ]).then(() => true, () => false)
    if (ready) return
    if (Date.now() >= deadline) {
      throw new Error(
        `The nested Docker daemon did not come up within ${Math.round(timeout / 1000)}s. `
        + 'Check that this machine allows privileged containers.'
      )
    }
    await new Promise(wait => setTimeout(wait, Math.min(1_000, timeout / 4)))
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
  const name = input.name.trim()
  const safeName = safeEnvironmentName(name) || id
  const workspacePath = `/workspaces/${safeName}`
  const containerName = `${resourcePrefix()}${id}`
  await createDevEnvironmentRow({ id, projectId: project.id, name, containerName, workspacePath })

  try {
    // The definition, build contexts and Dockerfiles are read from the project's own
    // checkout; the environment gets a copy in a named volume, never a host directory.
    const resolved = await resolveEnvironmentConfig(project.repoPath)
    const declaredPorts = resolveForwardPorts(resolved.config)
    for (const port of declaredPorts) {
      await upsertDevEnvironmentPort({ environmentId: id, ...port, source: 'declared' })
    }
    const claudeConfigDir = await toolConfigDir('NUXT_CLAUDE_CONFIG_DIR', '.claude')
    const codexConfigDir = await toolConfigDir('NUXT_CODEX_CONFIG_DIR', '.codex')
    const claudeCredentialsFile = await syncClaudeCredentials()

    const runtimeVolume = await ensureRuntimeVolume()
    const workspaceVolume = await copyRepository(project.repoPath, id)
    const imageName = await buildEnvironmentImage({
      config: resolved.config,
      environmentId: id,
      name,
      repoPath: project.repoPath
    })
    const metadata = await readImageMetadata(imageName, id)
    const remoteUser = resolveRemoteUser(resolved.config, metadata)
    const { stdout: containerId } = await run('docker', containerRunArgs({
      environmentId: id,
      projectId: project.id,
      containerName,
      imageName,
      config: resolved.config,
      metadata,
      remoteUser,
      workspacePath,
      workspaceVolume,
      runtimeVolume,
      ports: declaredPorts,
      claudeConfigDir,
      codexConfigDir,
      claudeCredentialsFile
    }))
    const inspection = await inspectContainer(containerId)
    if (!inspection) throw new Error('The environment container was created but could not be inspected.')
    await updateDevEnvironment(id, {
      containerId: inspection.id,
      containerName: inspection.name,
      workspacePath,
      configSource: resolved.source,
      configPath: resolved.displayPath,
      remoteUser
    })

    // Before anything assumes the image can host an agent. `git config` below is itself
    // one of the things a preflight failure would otherwise report as a bare `exit 127`.
    await preflight(inspection.id, resolved.config.docker)

    // The tar stream left the checkout owned by root; hand it to the user everything
    // else runs as, before anything else touches it.
    if (remoteUser !== 'root') {
      await run('docker', [
        ...execArgs({ containerId: inspection.id, user: 'root' }),
        'chown', '--recursive', `${remoteUser}:`, workspacePath
      ])
    }
    const home = homeDirectory(remoteUser)
    await run('docker', [
      ...execArgs({ containerId: inspection.id, user: remoteUser, env: { HOME: home } }),
      'git', 'config', '--global', '--add', 'safe.directory', workspacePath
    ])
    if (resolved.config.postCreateCommand) {
      await run('docker', [
        ...execArgs({ containerId: inspection.id, user: remoteUser, workdir: workspacePath, env: { HOME: home } }),
        ...postCreateArgs(resolved.config.postCreateCommand)
      ]).catch((error) => {
        throw new Error(`postCreateCommand failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    const environment = (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
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
    await removeImage(environmentImageName(id))
    throw error
  }
}

async function toolConfigDir(variable: string, fallbackName: string): Promise<string | null> {
  const configured = process.env[variable]
    || (process.env.HOME ? join(process.env.HOME, fallbackName) : null)
  if (!configured) return null
  return access(configured).then(() => configured).catch(() => null)
}

export async function startEnvironment(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  const inspection = await inspectContainer(containerReference(environment))
  if (!inspection) throw new Error('The environment container no longer exists. Delete and recreate the environment.')
  // The mount source is a fixed path, so refreshing the file's *contents* is the
  // whole of re-mounting it: an access token that expired while the environment
  // was stopped would otherwise be all the agent inside it ever sees.
  await syncClaudeCredentials()
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
  await run('docker', ['volume', 'rm', workspaceVolumeName(id)], { allowFailure: true }).catch(() => {})
  await removeImage(environmentImageName(id))
  await collectRuntimeVolumes().catch(() => {})
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
