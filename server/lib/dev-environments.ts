import { access } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { DevEnvironment, Project, WorkingTreeMode, WorkspaceSeedReport } from '../../shared/types'
import { newId } from './db'
import { refreshEnvironmentPorts, stopEnvironmentForwarders } from './dev-environment-ports'
import { seedClaudeHome } from './dev-env/claude-home'
import { resolveEnvironmentConfig, resolveForwardPorts, usesHostDaemon } from './dev-env/config'
import {
  containerRunArgs,
  DOOD_CONTAINER_LABEL,
  homeDirectory,
  postCreateArgs,
  readImageMetadata,
  resolveRemoteUser
} from './dev-env/container'
import {
  inspectContainer,
  populateWorkspaceVolume,
  resourcePrefix,
  run,
  type ContainerInspection
} from './dev-env/docker'
import { resolveHomeOverlay } from './dev-env/home-overlay'
import { buildEnvironmentImage, environmentImageName, removeImage } from './dev-env/image'
import {
  browserEnv,
  CHROME_EXECUTABLE,
  collectBrowserVolumes,
  ensureBrowserVolume
} from './dev-env/browser-volume'
import { collectRuntimeVolumes, ensureRuntimeVolume, RUNTIME_ROOT } from './dev-env/runtime-volume'
import { carryMessage, readHostWorkingTree, reconcileArgs, seedReport } from './dev-env/workspace-seed'
import {
  ENVIRONMENT_LABEL,
  ensureDoodProxy,
  ensureEnvironmentNetwork,
  stopDoodProxy,
  stopEnvironmentContainers,
  sweepEnvironmentResources
} from './dood/manager'
import { keyedSerial } from './keyed-serial'
import { dataDir } from './paths'
import { getSettings } from './settings'
import {
  createDevEnvironmentRow,
  getDevEnvironment,
  getProject,
  listDevEnvironments,
  retireDevEnvironmentRow,
  updateDevEnvironment,
  upsertDevEnvironmentPort
} from './repo'

const HELPER_IMAGE = process.env.NUXT_DEV_ENV_HELPER_IMAGE || 'busybox:1.37'
/** How long the environment's Docker gets to answer `docker info` before creation is called failed. */
function dockerReadyTimeout(): number {
  return Number(process.env.NUXT_DEV_ENV_DOCKER_READY_MS) || 30_000
}

/**
 * Every lifecycle operation on one environment runs alone: create, start,
 * stop, ensure-running, retire and the boot-time proxy restore. They are
 * reachable at once — the HTTP API, the voice agent, the mesh and an agent
 * session attaching — and interleaved they undo each other: a retire racing a
 * start removes the container the start is about to use, or stops the proxy
 * the start just brought up. Queued behind a retire, a start finds the row
 * retired and says so.
 */
const lifecycle = keyedSerial()

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

/**
 * A retired environment is a record kept for the sessions that ran in it —
 * there is no container, no volume and no image behind it. Every lifecycle call
 * has to say so rather than fail somewhere inside `docker`.
 */
function assertNotRetired(environment: DevEnvironment): void {
  if (!environment.retiredAt) return
  throw new Error(
    `Development environment "${environment.name}" was retired; its container and checkout no longer exist.`
  )
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

/**
 * The environment's socket onto the host daemon (`server/lib/dood/`). It has to
 * be listening before the container is created *or started*: the socket is
 * bind-mounted as a file, and a bind whose source is missing fails the start.
 */
function ensureDockerProxy(environment: {
  id: string
  containerReference: string
  workspacePath: string
}) {
  return ensureDoodProxy({
    environmentId: environment.id,
    containerReference: environment.containerReference,
    workspacePath: environment.workspacePath,
    workspaceVolume: workspaceVolumeName(environment.id),
    helperImage: HELPER_IMAGE
  })
}

/** Whether the container was created with the proxy mounted — fixed at creation, so it is on a label. */
const hasDockerProxy = (inspection: ContainerInspection | null) =>
  inspection?.labels[DOOD_CONTAINER_LABEL] === 'true'

function execArgs(input: {
  containerId: string
  user?: string
  workdir?: string
  env?: Record<string, string>
  /** Needed whenever the command is fed on stdin. */
  interactive?: boolean
}): string[] {
  const args = ['exec']
  if (input.interactive) args.push('--interactive')
  if (input.user) args.push('--user', input.user)
  if (input.workdir) args.push('--workdir', input.workdir)
  for (const [key, value] of Object.entries(input.env ?? {})) args.push('--env', `${key}=${value}`)
  args.push(input.containerId)
  return args
}

/**
 * The things an environment image has to provide before an agent can work in it.
 * Each failure has a readable cause, because the alternative is a stack trace from
 * something several layers away complaining that a file is missing.
 */
async function preflight(
  containerId: string,
  wantsDocker: boolean,
  browserVolume: string | null
): Promise<void> {
  await run('docker', [...execArgs({ containerId }), 'git', '--version']).catch(() => {
    throw new Error('The environment image does not have `git` installed, and Domo needs it in the workspace.')
  })
  await run('docker', [...execArgs({ containerId }), `${RUNTIME_ROOT}/node/bin/node`, '--version']).catch(() => {
    throw new Error(
      'The environment image cannot run Domo\'s bundled Node. The image must be glibc-based '
      + '(Debian, Ubuntu, Fedora, …); Alpine and other musl images are not supported.'
    )
  })
  // The browser has a *higher* glibc floor than the bundled Node — its
  // libraries come from the builder image, and Node is built for an older one —
  // so an image can pass the check above and still have no working browser.
  // Measured on `ubuntu:22.04` (glibc 2.35): Node reports its version happily
  // and the browser dies with `GLIBC_2.36' not found`. Caught here rather than
  // left for the first agent that tries to look at a page, because then the
  // failure lands on whoever is using the feature instead of on whoever chose
  // the image.
  if (browserVolume) {
    await run('docker', [
      ...execArgs({ containerId, env: browserEnv() }), CHROME_EXECUTABLE, '--version'
    ]).catch(() => {
      throw new Error(
        'The environment image cannot run Domo\'s bundled headless browser, which needs a newer '
        + 'glibc than the rest of Domo does (Debian 12 / Ubuntu 24.04 or later; Ubuntu 22.04 is too old). '
        + 'Use a newer base image, or turn the headless browser off in Settings → Development environments.'
      )
    })
  }
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
        `Docker did not answer inside the environment within ${Math.round(timeout / 1000)}s. `
        + 'Check that the image has the `docker` CLI and that the host\'s Docker daemon is running.'
      )
    }
    await new Promise(wait => setTimeout(wait, Math.min(1_000, timeout / 4)))
  }
}

/**
 * Builds the container's own `~/.ssh`: a real directory holding the config
 * Domo generates, and a symlink per entry of the host's `~/.ssh-host`.
 *
 * Not a mount, because a macOS config aborts Linux ssh — see
 * `containerSshConfig()`. The names still have to resolve under `~/.ssh`,
 * which is what the symlinks are for, and the modes are what ssh insists on
 * before it will read either.
 *
 * The directory, the mount point and every entry name arrive as argv; nothing
 * is interpolated into the script.
 */
const SSH_HOME_SCRIPT = [
  'set -e',
  'dir="$1"; host="$2"; shift 2',
  'mkdir -p "$dir"',
  'chmod 700 "$dir"',
  'cat > "$dir/config"',
  'chmod 600 "$dir/config"',
  'for entry in "$@"; do ln -sfn "$host/$entry" "$dir/$entry"; done'
].join('\n')

/**
 * Reconciles the copied checkout with the HEAD copied beside it — see
 * `workspace-seed.ts` for which direction, and why there are two.
 *
 * It fails creation when it fails. The alternative is an environment that looks
 * created and quietly carries invisible work back out, which is the whole thing
 * being fixed; a repository with no commits yet is the one case that is not a
 * failure, because there is no HEAD to reconcile against.
 */
async function reconcileWorkingTree(input: {
  containerId: string
  remoteUser: string
  home: string
  workspacePath: string
  mode: WorkingTreeMode
  dirtyPaths: string[]
  environmentName: string
  repoPath: string
}): Promise<WorkspaceSeedReport> {
  const result = await run('docker', [
    ...execArgs({
      containerId: input.containerId,
      user: input.remoteUser,
      workdir: input.workspacePath,
      env: { HOME: input.home }
    }),
    ...reconcileArgs({
      mode: input.mode,
      workspacePath: input.workspacePath,
      message: carryMessage({ environmentName: input.environmentName, repoPath: input.repoPath })
    })
  ]).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not reconcile the copied checkout with its HEAD: ${message}. `
      + 'The environment would have started with files its own git does not describe.'
    )
  })
  if (result.stderr.includes('no-head')) {
    console.warn(
      `[dev-env] ${input.environmentName} was created from a checkout with no commit to reconcile against; `
      + 'its working tree was copied as it stood.'
    )
  }
  return seedReport({
    mode: input.mode,
    paths: input.dirtyPaths,
    commit: input.mode === 'carry' ? result.stdout.trim() || null : null
  })
}

export async function createEnvironment(input: {
  projectId: string
  name: string
  /** What to do with whatever is uncommitted on the host. Defaults to `discard`. */
  workingTree?: WorkingTreeMode
}): Promise<DevEnvironment & { workspaceSeed: WorkspaceSeedReport }> {
  const project = await getProject(input.projectId)
  if (!project) throw new Error('Project not found')
  if (project.retiredAt) throw new Error('That project has been retired; its environments cannot be recreated.')
  await access(join(project.repoPath, '.git'))

  const id = newId('env')
  return lifecycle(id, () => create(id, project, input))
}

async function create(
  id: string,
  project: Project,
  input: { name: string, workingTree?: WorkingTreeMode }
): Promise<DevEnvironment & { workspaceSeed: WorkspaceSeedReport }> {
  const workingTree = input.workingTree ?? 'discard'
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
    // Codex keeps a single `auth.json` that the mount shares rather than forks,
    // so its directory is still mounted. Claude's is *copied* — see seedClaudeHome().
    const codexConfigDir = await toolConfigDir('NUXT_CODEX_CONFIG_DIR', '.codex')

    const settings = await getSettings()
    const runtimeVolume = await ensureRuntimeVolume()
    // A browser is worth having and is not worth failing an environment over:
    // it is several hundred megabytes fetched from two networks, and an
    // environment with no browser still runs agents perfectly well.
    const browserVolume = settings.browserTools
      ? await ensureBrowserVolume().catch((error) => {
        console.warn(`[dev-env] no headless browser for ${id}: ${error}`)
        return null
      })
      : null
    // Read before the tar and only to be able to say what happened; the reconcile
    // below runs on what actually landed in the volume, not on this list.
    const dirtyPaths = await readHostWorkingTree(project.repoPath)
    const workspaceVolume = await copyRepository(project.repoPath, id)
    const imageName = await buildEnvironmentImage({
      config: resolved.config,
      environmentId: id,
      name,
      repoPath: project.repoPath
    })
    const metadata = await readImageMetadata(imageName, id)
    const remoteUser = resolveRemoteUser(resolved.config, metadata)
    const home = homeDirectory(remoteUser)
    // Bind mounts are fixed at `docker run`, so the setting applies to
    // environments created from here on, not to ones that already exist.
    const overlay = await resolveHomeOverlay({
      containerHome: home,
      workspacePath,
      paths: settings.homeMounts
    })
    // Before `docker run`: the socket is mounted as a file, and it has to exist.
    const dockerSocket = usesHostDaemon(resolved.config)
      ? (await ensureDockerProxy({ id, containerReference: containerName, workspacePath })).socketPath
      : null
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
      browserVolume,
      ports: declaredPorts,
      codexConfigDir,
      homeOverlay: overlay,
      dockerSocket
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
    await preflight(inspection.id, resolved.config.docker, browserVolume)
    // Before `postCreateCommand`, which may already start a stack: its
    // published ports and its `host.docker.internal` live in this namespace.
    if (dockerSocket) await ensureEnvironmentNetwork(id)

    // The tar stream left the checkout owned by root; hand it to the user everything
    // else runs as, before anything else touches it.
    if (remoteUser !== 'root') {
      await run('docker', [
        ...execArgs({ containerId: inspection.id, user: 'root' }),
        'chown', '--recursive', `${remoteUser}:`, workspacePath
      ])
      // A mount target's missing parent (`~/.config`, when only `~/.config/gh`
      // is mounted) is created by Docker as root, and gcloud then cannot write
      // beside its own directory. Not recursive: the mounted content is the
      // host's and stays as it is.
      if (overlay.parentDirectories.length) {
        await run('docker', [
          ...execArgs({ containerId: inspection.id, user: 'root' }),
          'chown', `${remoteUser}:`, ...overlay.parentDirectories
        ]).catch((error) => {
          console.warn(`[dev-env] could not hand the mounted home directories to ${remoteUser}: ${error}`)
        })
      }
    }
    // The container's own git config. It *includes* the host's rather than
    // being it — see `containerGitconfig()` for why — and carries the
    // safe.directory this used to set with `git config --global --add`.
    await run('docker', [
      ...execArgs({ containerId: inspection.id, user: remoteUser, env: { HOME: home }, interactive: true }),
      'sh', '-c', 'cat > "$1"', 'sh', `${home}/.gitconfig`
    ], { input: overlay.gitconfig })
    if (overlay.ssh) {
      await run('docker', [
        ...execArgs({ containerId: inspection.id, user: remoteUser, env: { HOME: home }, interactive: true }),
        'sh', '-c', SSH_HOME_SCRIPT, 'sh', `${home}/.ssh`, `${home}/.ssh-host`, ...overlay.ssh.links
      ], { input: overlay.ssh.config })
    }
    // Before anything else looks at the checkout, and in particular before
    // `postCreateCommand` and any agent: the tar copied the host's *working tree*,
    // so until this runs the environment's files and its HEAD disagree. Needs the
    // generated `~/.gitconfig` above, which is where the commit identity comes from.
    const workspaceSeed = await reconcileWorkingTree({
      containerId: inspection.id,
      remoteUser,
      home,
      workspacePath,
      mode: workingTree,
      dirtyPaths,
      environmentName: name,
      repoPath: project.repoPath
    })
    // After the preflight, because it runs the CLI out of the runtime volume.
    await seedClaudeHome({ containerId: inspection.id, user: remoteUser, home })
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
    return { ...((await getDevEnvironment(id)) ?? environment), workspaceSeed }
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
    // `postCreateCommand` may already have started a stack on the host daemon.
    await stopDoodProxy(id).catch(() => {})
    await sweepEnvironmentResources(id).catch(() => {})
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

export function startEnvironment(id: string): Promise<DevEnvironment> {
  return lifecycle(id, () => start(id))
}

async function start(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  assertNotRetired(environment)
  const inspection = await inspectContainer(containerReference(environment))
  if (!inspection) throw new Error('The environment container no longer exists. Delete and recreate the environment.')
  if (hasDockerProxy(inspection)) await ensureDockerProxy(proxyTarget(environment))
  if (!inspection.running) await run('docker', ['start', inspection.id])
  // A new namespace: the relay and the redirect in the old one went with it.
  if (hasDockerProxy(inspection)) await ensureEnvironmentNetwork(id)
  const updated = (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
  await refreshEnvironmentPorts(id)
  return updated
}

export function stopEnvironment(id: string): Promise<DevEnvironment> {
  return lifecycle(id, () => stop(id))
}

async function stop(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  assertNotRetired(environment)
  const inspection = await inspectContainer(containerReference(environment))
  stopEnvironmentForwarders(id)
  if (inspection?.running) await run('docker', ['stop', inspection.id])
  if (hasDockerProxy(inspection)) {
    await stopEnvironmentContainers(id)
    // Drops the relay, which would otherwise hold a namespace nothing uses.
    await ensureEnvironmentNetwork(id)
  }
  return (await updateDevEnvironment(id, { status: 'stopped' }))!
}

export function ensureEnvironmentRunning(id: string): Promise<DevEnvironment> {
  return lifecycle(id, () => ensureRunning(id))
}

async function ensureRunning(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  assertNotRetired(environment)
  const inspection = await inspectContainer(containerReference(environment))
  if (inspection?.running) {
    if (hasDockerProxy(inspection)) await ensureDockerProxy(proxyTarget(environment))
    if (environment.status !== 'running') {
      return (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
    }
    return environment
  }
  return start(id)
}

/**
 * Retire an environment: destroy its container, its workspace volume and its
 * image, and keep the row.
 *
 * The row outliving all three is the point. It is the only record of where the
 * agent sessions that ran here ran, and it is what makes every one of them
 * unstartable — `sessionStartability` reads `retiredAt` rather than anything
 * written on the sessions themselves. Nothing about the environment is
 * recoverable, since the checkout only ever existed in the volume, so this is
 * never a thing to restart. The row is kept for good (`pruneRetiredProjects`
 * says why).
 *
 * Standing those sessions down — stopping their adapters first — belongs to
 * `retireProjectEnvironment` in `projects.ts`, one layer up: importing
 * `acpManager` here would cycle back through this file.
 */
export function retireEnvironment(id: string): Promise<void> {
  return lifecycle(id, () => retire(id))
}

async function retire(id: string): Promise<void> {
  const environment = await getDevEnvironment(id)
  if (!environment) return
  stopEnvironmentForwarders(id)
  await stopDoodProxy(id)
  const left = await destroyEnvironmentResources(environment)
  // Refused before the row changes, so retiring again is the way to finish.
  // Every removal used to be allowed to fail and the row was retired anyway:
  // an environment retired while Docker Desktop's disk was full kept a
  // 1.1 GB workspace volume nothing would ever look for again.
  if (left.length) {
    throw new Error(
      `Could not retire "${environment.name}": ${left.join('; ')} could not be removed. `
      + 'It has not been marked retired; retire it again once that is fixed.'
    )
  }
  await collectRuntimeVolumes().catch(() => {})
  await collectBrowserVolumes().catch(() => {})
  await retireDevEnvironmentRow(id)
}

/** Whatever of a retired environment is still on the daemon, by name. Pure. */
export function retirementLeftovers(
  environmentId: string,
  daemon: { containers: Array<{ id: string, labels: Record<string, string> }>, volumes: string[], images: string[] }
): string[] {
  const left: string[] = []
  const containers = daemon.containers.filter(container =>
    container.labels['domo.envId'] === environmentId || container.labels[ENVIRONMENT_LABEL] === environmentId)
  if (containers.length) left.push(`${containers.length} container(s)`)
  const volumes = new Set([workspaceVolumeName(environmentId), `dind-var-lib-docker-${environmentId}`])
  for (const volume of daemon.volumes) if (volumes.has(volume)) left.push(`volume ${volume}`)
  if (daemon.images.includes(environmentImageName(environmentId))) {
    left.push(`image ${environmentImageName(environmentId)}`)
  }
  return left
}

/** One read of the daemon for every leftover check. Throws when Docker cannot be reached. */
async function readDaemon(): Promise<Parameters<typeof retirementLeftovers>[1]> {
  const [containers, volumes, images] = await Promise.all([
    run('docker', ['ps', '-a', '--format', '{{.ID}}\t{{json .Labels}}']),
    run('docker', ['volume', 'ls', '--quiet']),
    run('docker', ['image', 'ls', '--format', '{{.Repository}}'])
  ])
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)
  return {
    containers: lines(containers.stdout).map((line) => {
      const [id = '', labels = ''] = line.split('\t')
      // `docker ps` prints labels as `a=b,c=d`; the domo ones never hold a comma.
      const parsed: Record<string, string> = {}
      for (const pair of labels.replace(/^"|"$/g, '').split(',')) {
        const index = pair.indexOf('=')
        if (index > 0) parsed[pair.slice(0, index)] = pair.slice(index + 1)
      }
      return { id, labels: parsed }
    }),
    volumes: lines(volumes.stdout),
    images: lines(images.stdout)
  }
}

/**
 * Remove everything an environment has on the daemon, and say what is left —
 * checked against the daemon afterwards, not inferred from exit codes, because
 * `rm` of something already gone and `rm` of something still in use look
 * alike to a caller that allows failure. A volume can be briefly in use by a
 * container still being torn down, so it tries three times.
 */
async function destroyEnvironmentResources(environment: DevEnvironment): Promise<string[]> {
  const id = environment.id
  let left: string[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1_000))
    await removeContainer(containerReference(environment))
    // A half-made container the row never learnt the id of.
    const labelled = await run('docker', ['ps', '-aq', '--filter', `label=domo.envId=${id}`], { allowFailure: true })
      .catch(() => ({ stdout: '' }))
    for (const container of labelled.stdout.split('\n').filter(Boolean)) await removeContainer(container)
    // After the container, which may have joined the stack's networks; before
    // the workspace volume, which the stack's containers mount.
    await sweepEnvironmentResources(id).catch(() => {})
    await run('docker', ['volume', 'rm', workspaceVolumeName(id)], { allowFailure: true }).catch(() => {})
    await run('docker', ['volume', 'rm', `dind-var-lib-docker-${id}`], { allowFailure: true }).catch(() => {})
    await removeImage(environmentImageName(id))
    try {
      left = retirementLeftovers(id, await readDaemon())
    } catch (error) {
      return [`Docker is not reachable (${error instanceof Error ? error.message : String(error)}), so nothing`]
    }
    if (!left.length) return []
  }
  return left
}

/**
 * Remove what environments this database has already retired still left on
 * the daemon — the leaks from before retirement checked its own work. Only
 * rows it knows about: a workspace volume with no row at all may belong to
 * another Domo on the same daemon (a worktree's dev server), so it is never
 * guessed at. Runs in the background from boot.
 */
export async function healRetiredEnvironments(): Promise<void> {
  const retired = (await listDevEnvironments(undefined, true)).filter(environment => environment.retiredAt)
  if (!retired.length) return
  const daemon = await readDaemon()
  for (const environment of retired) {
    if (!retirementLeftovers(environment.id, daemon).length) continue
    await lifecycle(environment.id, async () => {
      const left = await destroyEnvironmentResources(environment)
      if (left.length) console.warn(`[dev-env] retired ${environment.id} still has ${left.join('; ')}`)
      else console.info(`[dev-env] removed what retired environment ${environment.id} had left behind`)
    })
  }
}

function proxyTarget(environment: DevEnvironment) {
  return {
    id: environment.id,
    containerReference: containerReference(environment),
    workspacePath: environment.workspacePath
  }
}

/**
 * Bring every environment's Docker proxy back after a restart, and a running
 * one's published ports and redirect with it. Stopped ones too: the proxy
 * costs a listening socket, and without it a `docker start` from anywhere but
 * Domo — Docker Desktop's own button — fails on the missing bind source.
 */
export async function restoreDockerProxies(): Promise<void> {
  for (const environment of await listDevEnvironments()) {
    if (environment.retiredAt) continue
    await lifecycle(environment.id, async () => {
      const inspection = await inspectContainer(containerReference(environment)).catch(() => null)
      if (!hasDockerProxy(inspection)) return
      await ensureDockerProxy(proxyTarget(environment))
      // A running environment's published ports and its host.docker.internal
      // redirect died with the Domo that held them.
      if (inspection?.running) await ensureEnvironmentNetwork(environment.id)
    }).catch(error =>
      console.warn(`[dood] could not restore ${environment.id}:`, error instanceof Error ? error.message : error)
    )
  }
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
