import { access, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { branchNameProblem, environmentSlug } from '../../shared/dev-environments'
import type { AgentAdapter, DevEnvironment, EnvironmentUpgrade, Project, WorkspaceSeedReport } from '../../shared/types'
import { newId } from './db'
import { refreshEnvironmentPorts, stopEnvironmentForwarders } from './dev-environment-ports'
import {
  ENVIRONMENT_ID_LABEL,
  findEnvironmentContainer,
  listEnvironmentContainers,
  MISSING_CONTAINER_ERROR,
  nextEnvironmentStatus,
  watchEnvironmentContainers,
  type ContainerWatcher
} from './dev-env/container-state'
import { canonicalBaseGitPath, canonicalWorkspacePath, workspaceAliasArgs } from './dev-env/canonical-mounts'
import { seedClaudeHome } from './dev-env/claude-home'
import { resolveEnvironmentConfig, resolveForwardPorts, usesHostDaemon } from './dev-env/config'
import {
  containerRunArgs,
  DOOD_CONTAINER_LABEL,
  homeDirectory,
  postCreateArgs,
  readImageMetadata,
  resolveRemoteUser,
  type RunContainerInput,
  type WorkspaceMounts
} from './dev-env/container'
import {
  dockerServerOs,
  inspectContainer,
  resourcePrefix,
  run,
  type ContainerInspection
} from './dev-env/docker'
import {
  cacheMountTargets,
  ensureCacheVolumes,
  pnpmRelinkArgs,
  pnpmSetupArgs,
  resolveCaches,
  sharedCacheVolumeName,
  type ResolvedCaches
} from './dev-env/caches'
import type { DevEnvironmentConfig, ResolvedEnvironmentConfig, ResolvedPortConfig } from './dev-env/types'
import { defaultInstallCommand, presentLockfiles } from './dev-env/dependencies'
import {
  containerGitdirFilePath,
  createHostWorktree,
  hostCommonGitDir,
  hostWorktreeExists,
  hostWorktreePath
} from './dev-env/host-worktree'
import { alignUserArgs, planAlignment } from './dev-env/user-alignment'
import { seedReport } from './dev-env/workspace-seed'
import {
  environmentResources,
  homeVolumeName,
  observeEnvironmentResources,
  ownedResources
} from './dev-env/leftovers'
import { sweepEnvironmentResources, type CleanupReport } from './dev-env/reconcile'
import { resolveHomeOverlay, type HomeOverlay } from './dev-env/home-overlay'
import { createHomeVolume, migrateHome } from './dev-env/home-volume'
import { buildEnvironmentImage, collectCachedImages } from './dev-env/image'
import {
  browserEnv,
  CHROME_EXECUTABLE,
  collectBrowserVolumes,
  ensureBrowserVolume
} from './dev-env/browser-volume'
import {
  ADAPTER_PACKAGES,
  collectRuntimeVolumes,
  ensureRuntimeVolume,
  pinnedAdapterVersions,
  RUNTIME_ROOT
} from './dev-env/runtime-volume'
import { ensureSeccompProfile } from './dev-env/seccomp'
import {
  doodSocketFile,
  doodSocketPath,
  ensureDoodProxy,
  ensureEnvironmentNetwork,
  ENVIRONMENT_LABEL,
  stopDoodProxy,
  stopEnvironmentContainers
} from './dood/manager'
import { keyedSerial } from './keyed-serial'
import { getSettings } from './settings'
import {
  createDevEnvironmentRow,
  getDevEnvironment,
  getProject,
  listDevEnvironments,
  retireDevEnvironmentRow,
  setEnvironmentLeftovers,
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
 * reachable at once — the HTTP API, the mesh and an agent
 * session attaching — and interleaved they undo each other: a retire racing a
 * start removes the container the start is about to use, or stops the proxy
 * the start just brought up. Queued behind a retire, a start finds the row
 * retired and says so.
 */
const lifecycle = keyedSerial()

/**
 * The builds under way, so a retirement can stop one rather than queue behind
 * it for the minutes an image build takes. Only the environment's own steps
 * stop (its image, its install, its postCreateCommand, and the next step); the
 * shared volumes another build may be waiting for are left to finish.
 */
const builds = new Map<string, AbortController>()

function containerReference(environment: DevEnvironment): string {
  return environment.containerId || environment.containerName
}

/**
 * A retired environment is a record kept for the sessions that ran in it —
 * there is no container, no volume and no image behind it. Every lifecycle call
 * has to say so rather than fail somewhere inside `docker`.
 */
export function assertNotRetired(environment: DevEnvironment): void {
  if (!environment.retiredAt) return
  throw new Error(
    `Development environment "${environment.name}" was retired; its container and checkout no longer exist.`
  )
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
  socketPath?: string
}) {
  return ensureDoodProxy({
    environmentId: environment.id,
    containerReference: environment.containerReference,
    workspacePath: environment.workspacePath,
    socketPath: environment.socketPath,
    workspaceAlias: { legacyPath: environment.workspacePath, canonicalPath: canonicalWorkspacePath(environment.id) },
    helperImage: HELPER_IMAGE
  })
}

/**
 * The proxy socket the container mounts, by its file name, which every install
 * derives the same way. The directory is the install that created the
 * container's, and an environment whose row was copied into another install's
 * database still mounts the first one's: listening at this install's own path
 * would leave its `docker` refused, and its start failing on a missing bind
 * source.
 */
function mountedDoodSocket(environmentId: string, inspection: ContainerInspection | null): string | undefined {
  const file = doodSocketFile(environmentId)
  return (inspection?.bindSources ?? []).find(source => basename(source) === file)
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
 * `Promise.all`, except that it waits for every one to finish before it
 * throws: a creation that fails cleans up after itself, and an image build
 * still running then would leave an image behind that nothing claims.
 */
async function allSettledOrThrow<T extends readonly unknown[]>(work: [...{ [K in keyof T]: Promise<T[K]> }]): Promise<T> {
  const settled = await Promise.allSettled(work)
  const failed = settled.find(result => result.status === 'rejected')
  if (failed) throw (failed as PromiseRejectedResult).reason
  return settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T
}

/**
 * How long each step of a creation took, logged once it is done: creation is
 * what people wait on, and a guess about which step is slow is no substitute.
 */
function stepTimer(signal?: AbortSignal) {
  const start = Date.now()
  let last = start
  const steps: string[] = []
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  return {
    /** Also where a build that was asked to stop does, between steps. */
    mark(step: string) {
      signal?.throwIfAborted()
      const now = Date.now()
      steps.push(`${step} ${seconds(now - last)}`)
      last = now
    },
    /** A step run alongside others: timed on its own, and marked by whatever waits for it. */
    async measure<T>(step: string, work: Promise<T>): Promise<T> {
      const began = Date.now()
      try {
        return await work
      } finally {
        steps.push(`${step} ${seconds(Date.now() - began)}`)
      }
    },
    summary: () => `${seconds(Date.now() - start)} (${steps.join(', ')})`
  }
}

export interface EnvironmentCreationInput {
  projectId: string
  name: string
}

export type CreatedEnvironment = DevEnvironment & { workspaceSeed: WorkspaceSeedReport }

export async function createEnvironment(input: EnvironmentCreationInput): Promise<CreatedEnvironment> {
  return (await beginEnvironment(input)).built
}

/**
 * Check the request and write the `creating` row, then build in the
 * background. The row is returned as soon as it exists; `built` settles when
 * the environment is running or has failed, and the row says which either way
 * (`status`, `lastError`). For a caller that cannot wait minutes for an image
 * build, which is every agent.
 */
export async function beginEnvironment(
  input: EnvironmentCreationInput
): Promise<{ environment: DevEnvironment, built: Promise<CreatedEnvironment> }> {
  const project = await getProject(input.projectId)
  if (!project) throw new Error('Project not found')
  if (project.retiredAt) throw new Error('That project has been retired; its environments cannot be recreated.')
  await access(join(project.repoPath, '.git'))

  const id = newId('env')
  // The name is the environment's branch, verbatim, so it has to be one.
  const name = input.name.trim()
  const problem = branchNameProblem(name)
  if (problem) throw new Error(`"${name}" cannot name an environment, because it is also its branch: ${problem}`)
  const workspacePath = `/workspaces/${environmentSlug(name)}`
  const containerName = `${resourcePrefix()}${id}`
  const environment = await createDevEnvironmentRow({ id, projectId: project.id, name, containerName, workspacePath })
  // Inside the environment's lifecycle queue, like every other operation on
  // it: a start or a retirement asked for while it builds waits for the build
  // rather than racing it. The row is written first, outside the queue, so
  // the caller has an id to ask about the moment this returns.
  const controller = new AbortController()
  builds.set(id, controller)
  const built = lifecycle(id, () => buildEnvironment({
    id, name, workspacePath, containerName, project, signal: controller.signal
  })).finally(() => builds.delete(id))
  // Whoever holds `built` sees the rejection; this only keeps a caller that
  // does not from crashing the process. The row already records the failure.
  built.catch(() => {})
  return { environment, built }
}

async function buildEnvironment(input: {
  id: string
  name: string
  workspacePath: string
  containerName: string
  project: Project
  signal: AbortSignal
}): Promise<CreatedEnvironment> {
  const { id, name, workspacePath, containerName, project, signal } = input
  const timer = stepTimer(signal)
  try {
    // The definition, build contexts and Dockerfiles are read from the project's own
    // checkout; the environment gets a worktree of its own beside it (`host-worktree.ts`).
    const resolved = await resolveEnvironmentConfig(project.repoPath)
    const declaredPorts = resolveForwardPorts(resolved.config)
    for (const port of declaredPorts) {
      await upsertDevEnvironmentPort({ environmentId: id, ...port, source: 'declared' })
    }
    const settings = await getSettings()
    timer.mark('config')
    const caches = resolveCaches(resolved.config.caches)
    // Independent of each other, and together most of a creation: the shared
    // volumes (slow once per install), the worktree and the image.
    const [runtimeVolume, browserVolume, worktree, imageName, homeVolume] = await allSettledOrThrow([
      timer.measure('runtime volume', ensureRuntimeVolume()),
      // A browser is worth having and is not worth failing an environment over:
      // it is several hundred megabytes fetched from two networks, and an
      // environment with no browser still runs agents perfectly well.
      timer.measure('browser volume', optionalBrowserVolume(id, settings.browserTools)),
      // A clean checkout of the last commit, as git users expect of a worktree,
      // plus the ignored files the project needs to run (a `.env`). Nothing has
      // to be reconciled inside the container afterwards.
      timer.measure('worktree', createHostWorktree({
        repoPath: project.repoPath,
        projectId: project.id,
        environmentId: id,
        branch: name,
        copyIgnored: resolved.config.copyIgnored
      }).then(async (made) => {
        // At once, so a creation that fails after this still knows which branch it is on.
        await updateDevEnvironment(id, { branch: made.branch.name })
        return made
      })),
      timer.measure('image', ensureCacheVolumes(caches).then(() => buildEnvironmentImage({
        config: resolved.config,
        environmentId: id,
        name,
        repoPath: project.repoPath,
        signal
      }))),
      createHomeVolume(id)
    ])
    timer.mark('prepared')
    const plan = await planContainer({
      id,
      project,
      containerName,
      workspacePath,
      imageName,
      resolved,
      homeMounts: settings.homeMounts,
      workspace: {
        hostWorktreePath: worktree.worktreePath,
        hostGitdirFilePath: worktree.gitdirFilePath,
        hostBaseGitPath: worktree.commonGitDir,
        projectId: project.id
      },
      caches,
      homeVolume,
      runtimeVolume,
      browserVolume,
      ports: declaredPorts
    })
    const { inspection, dockerSocket } = await runPlannedContainer(plan)
    timer.mark('container')
    const { remoteUser, homeOverlay: overlay } = plan.run

    const install = await setUpContainer({
      id,
      containerId: inspection.id,
      config: resolved.config,
      remoteUser,
      workspacePath,
      worktreePath: worktree.worktreePath,
      caches,
      overlay,
      browserVolume,
      dockerSocket,
      timer,
      signal
    })
    const environment = (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
    await refreshEnvironmentPorts(id)
    console.info(`[dev-env] created ${id} in ${timer.summary()}`)
    return {
      ...((await getDevEnvironment(id)) ?? environment),
      workspaceSeed: seedReport({ ...worktree.seed, install, branch: worktree.branch })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateDevEnvironment(id, { status: 'error', lastError: message })
    await removeBuiltContainer(id)
    // `postCreateCommand` may already have started a stack on the host daemon,
    // and nothing may add to it while it is taken down.
    await stopDoodProxy(id).catch(() => {})
    // Same hazard as a retirement, and the same answer: any removal can fail
    // for a reason that has nothing to do with this environment, and the row
    // is what makes the leftover findable afterwards. It is not retired — a
    // failed creation is not a retirement — so it has to claim the resources
    // explicitly, and the sweep below is what removes each one and confirms it
    // is really gone.
    // The worktree is claimed with the rest, and the sweep removes it after
    // the container that mounts it.
    await claimResources(id, project)
    await sweepEnvironmentResources()
    throw error
  }
}

/**
 * The container a build of `id` got as far as running, if any. By inspection,
 * for a Docker-in-Docker volume named some other way; the sweep claims the
 * rest by name and by label.
 */
async function removeBuiltContainer(id: string): Promise<void> {
  const current = await getDevEnvironment(id)
  if (current?.containerId) {
    await removeContainer(current.containerId)
    return
  }
  const found = await run('docker', [
    'ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`
  ], { allowFailure: true }).catch(() => ({ stdout: '', stderr: '' }))
  for (const containerId of found.stdout.split('\n').filter(Boolean)) {
    await removeContainer(containerId)
  }
}

/**
 * Build again what a restart cut off. A build runs in the server's process,
 * so a row still `creating` at boot died with the old one. Every step is made
 * again or reused (the worktree, the volumes, the image), after the container
 * it may have got as far as running is removed. In the lifecycle queue, so a
 * session spawned into it, whose prompt waits in its inbox, starts once it is
 * up, and fails with the build's own error if it fails.
 */
export async function resumeEnvironmentBuilds(): Promise<string[]> {
  const resumed: string[] = []
  for (const environment of await listDevEnvironments()) {
    if (environment.status !== 'creating') continue
    const { id, name, workspacePath, containerName } = environment
    const project = await getProject(environment.projectId)
    if (!project || project.retiredAt) {
      await updateDevEnvironment(id, { status: 'error', lastError: 'Domo restarted while this environment was being created, and its project is gone.' })
      continue
    }
    const controller = new AbortController()
    builds.set(id, controller)
    lifecycle(id, async () => {
      await removeBuiltContainer(id)
      return buildEnvironment({ id, name, workspacePath, containerName, project, signal: controller.signal })
    }).finally(() => builds.delete(id)).catch(() => {})
    resumed.push(id)
  }
  return resumed
}

/** Everything `docker run` of an environment's container takes, worked out before anything is replaced. */
interface ContainerPlan {
  run: Omit<RunContainerInput, 'dockerSocket'>
  /** Whether it gets a Docker proxy onto the host daemon. */
  hostDaemon: boolean
  config: ResolvedEnvironmentConfig
}

/**
 * The container's run options, for a creation and an upgrade alike: an
 * upgraded container has to get exactly what a new one would, so both come
 * from here. Each step can fail on its own account, so an upgrade calls this
 * while the old container is still there.
 */
async function planContainer(input: {
  id: string
  project: Project
  containerName: string
  workspacePath: string
  imageName: string
  resolved: ResolvedEnvironmentConfig
  homeMounts: string[]
  workspace: WorkspaceMounts
  caches: ResolvedCaches
  homeVolume: string
  runtimeVolume: string
  browserVolume: string | null
  ports: ResolvedPortConfig[]
}): Promise<ContainerPlan> {
  const { id, project, resolved } = input
  const metadata = await readImageMetadata(input.imageName, id)
  const remoteUser = resolveRemoteUser(resolved.config, metadata)
  // Bind mounts are fixed at `docker run`: a change to the setting reaches an
  // environment when it is created or upgraded.
  const homeOverlay = await resolveHomeOverlay({
    containerHome: homeDirectory(remoteUser),
    workspacePath: input.workspacePath,
    safeDirectories: [canonicalWorkspacePath(id), canonicalBaseGitPath(project.id)],
    paths: input.homeMounts
  })
  return {
    run: {
      environmentId: id,
      projectId: project.id,
      containerName: input.containerName,
      imageName: input.imageName,
      config: resolved.config,
      metadata,
      remoteUser,
      workspacePath: input.workspacePath,
      workspace: input.workspace,
      caches: input.caches,
      homeVolume: input.homeVolume,
      runtimeVolume: input.runtimeVolume,
      browserVolume: input.browserVolume,
      ports: input.ports,
      // Codex keeps a single `auth.json` that the mount shares rather than forks,
      // so its directory is still mounted. Claude's is *copied* — see seedClaudeHome().
      codexConfigDir: await toolConfigDir('NUXT_CODEX_CONFIG_DIR', '.codex'),
      seccompProfile: await ensureSeccompProfile(),
      homeOverlay
    },
    hostDaemon: usesHostDaemon(resolved.config),
    config: resolved
  }
}

/**
 * `docker run` the planned container and record it on the row, adapter
 * versions included: they are the runtime volume's it now mounts.
 */
async function runPlannedContainer(plan: ContainerPlan): Promise<{ inspection: ContainerInspection, dockerSocket: string | null }> {
  const { environmentId: id, containerName, workspacePath, remoteUser } = plan.run
  // Before `docker run`: the socket is mounted as a file, and it has to exist.
  const dockerSocket = plan.hostDaemon
    ? (await ensureDockerProxy({ id, containerReference: containerName, workspacePath })).socketPath
    : null
  const { stdout: containerId } = await run('docker', containerRunArgs({ ...plan.run, dockerSocket }))
  const inspection = await inspectContainer(containerId)
  if (!inspection) throw new Error('The environment container was created but could not be inspected.')
  await updateDevEnvironment(id, {
    containerId: inspection.id,
    containerName: inspection.name,
    workspacePath,
    configSource: plan.config.source,
    configPath: plan.config.displayPath,
    remoteUser,
    adapterVersions: pinnedAdapterVersions()
  })
  return { inspection, dockerSocket }
}

/**
 * Everything a freshly run container needs before an agent works in it, for a
 * creation and an upgrade alike: an upgrade's container is new, and its
 * writable layer has none of it. What lands in the home volume (the pnpm
 * config, Claude's onboarding) is written only where it is missing; the git
 * config and the ssh directory are written again, from a home overlay that may
 * have changed since.
 */
async function setUpContainer(input: {
  id: string
  containerId: string
  config: DevEnvironmentConfig
  remoteUser: string
  workspacePath: string
  /** The worktree on the host. */
  worktreePath: string
  caches: ResolvedCaches
  overlay: HomeOverlay
  browserVolume: string | null
  dockerSocket: string | null
  timer: ReturnType<typeof stepTimer>
  /** A retirement asking the build to stop: the install and `postCreateCommand` stop with it. */
  signal: AbortSignal
  /**
   * Remove the checkout's pnpm-made `node_modules` before the install, so it
   * links them again: their links point into a virtual store that is not on
   * this container's cache volume (an upgrade from another Domo's).
   */
  relinkPnpm?: boolean
}): Promise<WorkspaceSeedReport['install']> {
  const { id, containerId, config, remoteUser, workspacePath, worktreePath, caches, overlay, browserVolume, dockerSocket, timer, signal } = input
  const home = homeDirectory(remoteUser)
  const canonicalPath = canonicalWorkspacePath(id)
  // Before anything assumes the image can host an agent. `git config` below is itself
  // one of the things a preflight failure would otherwise report as a bare `exit 127`.
  await preflight(containerId, config.docker, browserVolume)
  // Before `postCreateCommand`, which may already start a stack: its
  // published ports and its `host.docker.internal` live in this namespace.
  if (dockerSocket) await ensureEnvironmentNetwork(id)

  timer.mark('preflight')
  // Before anything runs as the remote user, which may be about to get a new uid.
  await alignRemoteUser({ containerId, remoteUser, worktreePath })
  // Before anything addresses the checkout by the path the rest of Domo, the
  // project's config and its compose files all use.
  await run('docker', [
    ...execArgs({ containerId, user: 'root' }),
    ...workspaceAliasArgs({ canonicalPath, legacyPath: workspacePath })
  ])
  // Every environment's installs write here, as whichever user each one runs as.
  const cacheTargets = cacheMountTargets(caches)
  // Not pnpm's own directories: the environment's user makes those (`PNPM_ROOT`).
  if (cacheTargets.length) {
    await run('docker', [...execArgs({ containerId, user: 'root' }), 'chmod', '1777', ...cacheTargets])
  }
  // No `chown` of the checkout: it is the host's own worktree now, not a
  // root-owned tar extraction, and its files belong to the developer.
  if (remoteUser !== 'root') {
    // A mount target's missing parent (`~/.config`, when only `~/.config/gh`
    // is mounted) is created by Docker as root, and gcloud then cannot write
    // beside its own directory. Not recursive: the mounted content is the
    // host's and stays as it is.
    if (overlay.parentDirectories.length) {
      await run('docker', [
        ...execArgs({ containerId, user: 'root' }),
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
    ...execArgs({ containerId, user: remoteUser, env: { HOME: home }, interactive: true }),
    'sh', '-c', 'cat > "$1"', 'sh', `${home}/.gitconfig`
  ], { input: overlay.gitconfig })
  if (overlay.ssh) {
    await run('docker', [
      ...execArgs({ containerId, user: remoteUser, env: { HOME: home }, interactive: true }),
      'sh', '-c', SSH_HOME_SCRIPT, 'sh', `${home}/.ssh`, `${home}/.ssh-host`, ...overlay.ssh.links
    ], { input: overlay.ssh.config })
  }
  if (input.relinkPnpm) {
    await run('docker', [
      ...execArgs({ containerId, user: remoteUser, env: { HOME: home } }),
      ...pnpmRelinkArgs(canonicalPath)
    ])
  }
  // Before any install: pnpm finds the shared store, and its virtual store
  // on the same volume, through its global config (`caches.ts`).
  if (caches.pnpm) {
    await run('docker', [
      ...execArgs({ containerId, user: remoteUser, env: { HOME: home } }),
      ...pnpmSetupArgs({ environmentId: id, checkout: canonicalPath })
    ])
  }
  // After the preflight, because it runs the CLI out of the runtime volume.
  await seedClaudeHome({ containerId, user: remoteUser, home })
  timer.mark('home')
  // The worktree has no `node_modules` or `.venv`: dependencies are installed
  // here, for this container's platform, never copied from the host. On by
  // default unless the project installs its own way (`postCreateCommand`);
  // `installDependencies` says either explicitly.
  const install = (config.installDependencies ?? !config.postCreateCommand)
    ? await installDependencies({ containerId, user: remoteUser, home, workspacePath, checkout: worktreePath, signal })
    : null
  timer.mark('install')
  if (config.postCreateCommand) {
    await run('docker', [
      ...execArgs({ containerId, user: remoteUser, workdir: workspacePath, env: { HOME: home } }),
      ...postCreateArgs(config.postCreateCommand)
    ], { signal }).catch((error) => {
      if (signal.aborted) throw error
      throw new Error(`postCreateCommand failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  timer.mark('postCreateCommand')
  return install
}

/**
 * The install a project with no `postCreateCommand` gets, by its lockfile
 * (`dependencies.ts`). Never fails the creation: an environment with no
 * dependencies installed still runs agents, and the report says what went
 * wrong so the agent or the developer can fix it — an image without the tool,
 * or a lockfile out of date.
 */
async function installDependencies(input: {
  containerId: string
  user: string
  home: string
  workspacePath: string
  /** The worktree on the host, where the lockfiles are read. */
  checkout: string
  signal: AbortSignal
}): Promise<WorkspaceSeedReport['install']> {
  const command = defaultInstallCommand(await presentLockfiles(input.checkout))
  if (!command) return null
  const exec = execArgs({ containerId: input.containerId, user: input.user, workdir: input.workspacePath, env: { HOME: input.home } })
  const printed = command.join(' ')
  const available = await run('docker', [...exec, 'sh', '-c', 'command -v "$1"', 'sh', command[0]!]).then(() => true, () => false)
  if (!available) return { command: printed, error: `the image has no ${command[0]}` }
  return run('docker', [...exec, ...command], { signal: input.signal }).then(
    () => ({ command: printed, error: null }),
    error => ({ command: printed, error: error instanceof Error ? error.message : String(error) })
  )
}

/**
 * Give the remote user the worktree owner's uid when the daemon passes host
 * ids through (a Linux daemon; Docker Desktop maps them) — `user-alignment.ts`.
 * An image without `usermod`, or a root remote user, is warned about rather
 * than failed: the environment still runs, and what it writes is the only thing
 * at stake.
 */
async function alignRemoteUser(input: { containerId: string, remoteUser: string, worktreePath: string }): Promise<void> {
  const owner = await stat(input.worktreePath)
  const containerUid = input.remoteUser === 'root'
    ? 0
    : Number.parseInt((await run('docker', [...execArgs({ containerId: input.containerId }), 'id', '-u', input.remoteUser])
      .catch(() => ({ stdout: '' }))).stdout, 10)
  // An image that cannot say who its user is gets nothing renumbered on a guess.
  if (!Number.isInteger(containerUid)) return
  const plan = planAlignment({
    daemonOs: await dockerServerOs(),
    remoteUser: input.remoteUser,
    hostUid: owner.uid,
    hostGid: owner.gid,
    containerUid
  })
  if (plan.kind === 'root-owned') {
    console.warn(`[dev-env] ${input.containerId} runs as root on a Linux daemon: what it writes in the checkout will be root's on the host.`)
    return
  }
  if (plan.kind !== 'renumber') return
  await run('docker', [
    ...execArgs({ containerId: input.containerId, user: 'root' }),
    ...alignUserArgs({ user: input.remoteUser, uid: plan.uid, gid: plan.gid })
  ]).catch((error) => {
    console.warn(`[dev-env] could not give ${input.remoteUser} the checkout owner's uid ${plan.uid}: ${error}`)
  })
}

/**
 * Write down what a cleanup owes before it is confirmed, so a crash in the
 * middle of one is still a row that knows what to look for.
 *
 * A retired environment needs none of this: `retired_at` claims everything
 * named from its id or labelled with it on its own. This is for the rows that
 * are *not* retired and still own resources nothing will ever use — the
 * wreckage of a failed creation. So they are named: the four derived from the
 * id, and whatever Docker says the environment made through its proxy
 * (`postCreateCommand` can start a whole stack). If Docker cannot be asked,
 * the derived names are still worth writing down.
 */
async function claimResources(id: string, project: Project): Promise<void> {
  const made = await observeEnvironmentResources()
    .then(present => ownedResources(id, present))
    .catch(() => [])
  const worktree = { kind: 'worktree' as const, name: hostWorktreePath(project.repoPath, id) }
  const owed = new Map([...environmentResources(id), ...made, worktree]
    .map(({ kind, name }) => [`${kind} ${name}`, { kind, name, error: 'Cleanup after a failed creation has not been confirmed.' }]))
  await setEnvironmentLeftovers(id, [...owed.values()])
}

async function toolConfigDir(variable: string, fallbackName: string): Promise<string | null> {
  const configured = process.env[variable]
    || (process.env.HOME ? join(process.env.HOME, fallbackName) : null)
  if (!configured) return null
  return access(configured).then(() => configured).catch(() => null)
}

/**
 * Record that an environment needs somebody, and hand back the error to throw.
 *
 * `error` is the one state that means "this is broken and you have to do
 * something", and until now only a failed creation ever reached it — a
 * container that had been removed underneath Domo, or one the daemon refuses to
 * start, threw at the caller and left the row saying `stopped`, which is what a
 * perfectly healthy environment says. Both of those are permanent until a
 * person acts, which is exactly the bar for writing it.
 *
 * Deliberately not written for a failed `stop`: the container is still running,
 * nothing is lost, and the next attempt is a button away.
 */
async function breakEnvironment(id: string, reason: string): Promise<Error> {
  await updateDevEnvironment(id, { status: 'error', lastError: reason })
  return new Error(reason)
}

export function startEnvironment(id: string): Promise<DevEnvironment> {
  return lifecycle(id, () => start(id))
}

async function start(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  assertNotRetired(environment)
  const inspection = await inspectContainer(containerReference(environment))
  if (!inspection) {
    // Already broken, most often a failed creation, which removed its own
    // container: what broke it says more than that the container is gone.
    if (environment.status === 'error' && environment.lastError) throw new Error(environment.lastError)
    throw await breakEnvironment(id, MISSING_CONTAINER_ERROR)
  }
  if (hasDockerProxy(inspection)) await ensureDockerProxy(proxyTarget(environment, inspection))
  if (!inspection.running) {
    await run('docker', ['start', inspection.id]).catch(async (error) => {
      throw await breakEnvironment(
        id,
        `The environment container would not start: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
  // A new namespace: the relay and the redirect in the old one went with it.
  if (hasDockerProxy(inspection)) await ensureEnvironmentNetwork(id)
  // A start that worked clears the field, for the reason the agent sessions
  // clear theirs: `last_error` is history and `status` is state, and a banner
  // keyed on the history outlives what it described.
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
    if (hasDockerProxy(inspection)) await ensureDockerProxy(proxyTarget(environment, inspection))
    if (environment.status !== 'running') {
      return (await updateDevEnvironment(id, { status: 'running', lastError: null }))!
    }
    return environment
  }
  return start(id)
}

/**
 * Whether an environment runs the adapters Domo installs today, by the
 * versions recorded for it (`environmentAdapterVersions`). Null when they
 * were never recorded and cannot be read now.
 */
export function adaptersAreCurrent(versions: Partial<Record<AgentAdapter, string>> | null): boolean | null {
  if (!versions) return null
  return Object.entries(pinnedAdapterVersions()).every(([adapter, version]) => versions[adapter as AgentAdapter] === version)
}

/** What a new container would change for an environment, and whether it can have one. */
export interface EnvironmentUpgradeStatus {
  adaptersCurrent: boolean | null
  /** The container it runs in, when another Domo (another resource prefix) made it: an upgrade moves it to this one. */
  otherInstallContainer: string | null
  home: EnvironmentUpgrade['home']
  /** Why an upgrade is refused, when it is. */
  blocked: string | null
}

export async function environmentUpgradeStatus(id: string): Promise<EnvironmentUpgradeStatus> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  assertNotRetired(environment)
  const project = await getProject(environment.projectId)
  const [versions, inspection] = await Promise.all([
    environmentAdapterVersions(environment),
    inspectContainer(containerReference(environment))
  ])
  return {
    adaptersCurrent: adaptersAreCurrent(versions),
    otherInstallContainer: ownContainerName(id) === environment.containerName.toLowerCase() ? null : environment.containerName,
    home: await homeSource(id, inspection),
    blocked: project ? await upgradeRefusal(environment, project) : 'Project not found'
  }
}

/** The name this Domo gives an environment's container, and its image. */
function ownContainerName(id: string): string {
  return `${resourcePrefix()}${id}`.toLowerCase()
}

async function homeSource(id: string, inspection: ContainerInspection | null): Promise<EnvironmentUpgrade['home']> {
  if (inspection) return inspection.namedVolumes.includes(homeVolumeName(id)) ? 'kept' : 'migrated'
  const volume = await run('docker', ['volume', 'inspect', homeVolumeName(id)], { allowFailure: true })
  return volume.stdout && volume.stdout !== '[]' ? 'kept' : 'lost'
}

/** What stops an upgrade before it begins: the worktree a new container mounts, and one already under way. */
async function upgradeRefusal(environment: DevEnvironment, project: Project): Promise<string | null> {
  if (environment.status === 'creating') return 'The environment is still being created.'
  if (environment.status === 'upgrading') return 'The environment is already being upgraded.'
  if (await hostWorktreeExists(project.repoPath, environment.id)) return null
  return `The environment's worktree is gone from ${hostWorktreePath(project.repoPath, environment.id)}, `
    + 'so there is no checkout to give a new container. Retire the environment.'
}

export type EnvironmentUpgradeReport = EnvironmentUpgrade & { environment: DevEnvironment }

/**
 * Give an environment a new container: new adapters, a rebuilt image, and
 * whatever else is fixed at `docker run` (`.domo.json`, `homeMounts`, the
 * headless browser), with exactly the options a creation would give it
 * (`planContainer`). One another Domo made (another resource prefix) moves to
 * this one: its container, image, home volume, socket and caches are this
 * Domo's afterwards.
 *
 * Nothing an agent would miss is in the container. The checkout is the host's
 * worktree, the remote user's home is a volume (`home-volume.ts`), and the
 * dependencies are on the cache volume, so its sessions resume where they left
 * off. What goes is the writable layer — whatever was installed outside those
 * — and `postCreateCommand` and the install run again to restore the declared
 * part.
 *
 * Checked and marked `upgrading` at once; the rest runs in the lifecycle
 * queue, like every other operation on the environment, and `upgraded`
 * settles with the outcome, which is also on the row (`status`, `lastError`,
 * `lastUpgrade`). `beforeReplace` runs once everything that can fail on its
 * own account (the image build above all) is done and the old container is
 * about to stop: its agents work on until then.
 *
 * Up to the old container's removal, a failure puts the environment back as
 * it was and writes no `error`: nothing is broken and nobody has to act. Past
 * it, the environment is `error` with every volume still there, and another
 * upgrade is the way out. A stopped environment is stopped again afterwards.
 */
export async function beginUpgrade(
  id: string,
  options: { beforeReplace?: () => void | Promise<void> } = {}
): Promise<{ environment: DevEnvironment, upgraded: Promise<EnvironmentUpgradeReport> }> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  assertNotRetired(environment)
  const project = await getProject(environment.projectId)
  if (!project) throw new Error('Project not found')
  const refusal = await upgradeRefusal(environment, project)
  if (refusal) throw new Error(refusal)
  // What a failure before the removal puts back.
  const previous = { status: environment.status, lastError: environment.lastError }
  const marked = (await updateDevEnvironment(id, { status: 'upgrading' }))!
  const controller = new AbortController()
  builds.set(id, controller)
  const upgraded = lifecycle(id, () => upgrade(id, { previous, signal: controller.signal, beforeReplace: options.beforeReplace }))
    .finally(() => builds.delete(id))
  // Whoever holds `upgraded` sees the rejection; the row already records it.
  upgraded.catch(() => {})
  return { environment: marked, upgraded }
}

export async function upgradeEnvironment(id: string): Promise<EnvironmentUpgradeReport> {
  return (await beginUpgrade(id)).upgraded
}

async function upgrade(id: string, input: {
  previous: Pick<DevEnvironment, 'status' | 'lastError'>
  signal: AbortSignal
  beforeReplace?: () => void | Promise<void>
}): Promise<EnvironmentUpgradeReport> {
  const { signal } = input
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  // Retired while it waited in the queue: the retirement owns the row now.
  assertNotRetired(environment)
  const project = await getProject(environment.projectId)
  if (!project) {
    await updateDevEnvironment(id, input.previous)
    throw new Error('Project not found')
  }
  // Again, inside the queue: whatever ran before this in it wrote its own status.
  await updateDevEnvironment(id, { status: 'upgrading' })

  const before = await inspectContainer(containerReference(environment))
  const home = await homeSource(id, before)
  const hadProxy = hasDockerProxy(before)
  // Stopped stays stopped. A container that is gone (`error`) comes back running.
  const wasRunning = before ? before.running : true
  // Read off the old container when they were never recorded: the row says `upgrading` by now.
  const adaptersBefore = await environmentAdapterVersions({ ...environment, status: before?.running ? 'running' : 'stopped' })
  // The stored path, never derived again from the name: Claude Code keys a
  // transcript by its working directory, so another path would orphan every
  // session here. The container's name is this Domo's, whoever made the old one.
  const { workspacePath } = environment
  const containerName = ownContainerName(id)
  const movedFrom = environment.containerName.toLowerCase() === containerName ? null : environment.containerName
  const timer = stepTimer(signal)
  /** Whatever is stopped has to be put back if the upgrade stops short of the removal. */
  let stopping = false
  let migratedVolume: string | null = null
  let replacing = false

  try {
    const resolved = await resolveEnvironmentConfig(project.repoPath)
    const declaredPorts = resolveForwardPorts(resolved.config)
    for (const port of declaredPorts) {
      await upsertDevEnvironmentPort({ environmentId: id, ...port, source: 'declared' })
    }
    const settings = await getSettings()
    const caches = resolveCaches(resolved.config.caches)
    const [runtimeVolume, browserVolume, imageName] = await allSettledOrThrow([
      timer.measure('runtime volume', ensureRuntimeVolume()),
      timer.measure('browser volume', optionalBrowserVolume(id, settings.browserTools)),
      timer.measure('image', ensureCacheVolumes(caches).then(() => buildEnvironmentImage({
        config: resolved.config,
        environmentId: id,
        name: environment.name,
        repoPath: project.repoPath,
        signal
      })))
    ])
    const plan = await planContainer({
      id,
      project,
      containerName,
      workspacePath,
      imageName,
      resolved,
      homeMounts: settings.homeMounts,
      workspace: {
        hostWorktreePath: hostWorktreePath(project.repoPath, id),
        hostGitdirFilePath: containerGitdirFilePath(project.repoPath, id),
        hostBaseGitPath: await hostCommonGitDir(project.repoPath),
        projectId: project.id
      },
      caches,
      // Created below, once it is known whether it is a copy.
      homeVolume: homeVolumeName(id),
      runtimeVolume,
      browserVolume,
      ports: declaredPorts
    })
    const { remoteUser } = plan.run
    // The home belongs to the old user, and is mounted at the old user's home.
    if (environment.remoteUser && remoteUser !== environment.remoteUser) {
      throw new Error(
        `The image now runs as "${remoteUser}", and this environment's home is "${environment.remoteUser}"'s. `
        + 'An upgrade keeps the home, so it cannot change the user: create a new environment instead.'
      )
    }
    const stranded = before && hadProxy ? await namespaceSharers(id, before.id) : []
    timer.mark('prepared')

    // From here the old container is going. Its agents first, then its stack:
    // `stop` stops that for the same reason, and its services are about to
    // lose the namespace and the peer they were created against.
    stopping = true
    await input.beforeReplace?.()
    stopEnvironmentForwarders(id)
    const stopped = hadProxy ? await stopEnvironmentContainers(id) : 0
    if (before?.running) await run('docker', ['stop', before.id])
    // The proxy caches the old container's id and mounts, and holds a relay in
    // a namespace that is going away. Nothing may be made in the gap.
    await stopDoodProxy(id)
    // From the stopped container, so nothing is writing to it.
    if (before && home === 'migrated') {
      migratedVolume = await migrateHome({
        environmentId: id,
        containerId: before.id,
        home: homeDirectory(remoteUser),
        mountDestinations: before.mountDestinations,
        helperImage: HELPER_IMAGE
      })
    }
    timer.mark('stopped')

    replacing = true
    // Not `removeContainer()`, which removes a Docker-in-Docker volume: a
    // project that lists that Feature itself keeps its daemon's state in it.
    if (before) await run('docker', ['rm', '--force', before.id])
    if (!migratedVolume) await createHomeVolume(id)
    const { inspection, dockerSocket } = await runPlannedContainer(plan)
    timer.mark('container')
    // The proxy joins a network only when a container is created on it.
    const networks = dockerSocket ? await rejoinEnvironmentNetworks(id, inspection.id) : []
    await setUpContainer({
      id,
      containerId: inspection.id,
      config: resolved.config,
      remoteUser,
      workspacePath,
      worktreePath: plan.run.workspace.hostWorktreePath,
      caches,
      overlay: plan.run.homeOverlay,
      browserVolume,
      dockerSocket,
      timer,
      signal,
      // Its pnpm virtual store was on the other cache volume, and every
      // `node_modules` link in the checkout points into it.
      relinkPnpm: caches.pnpm && !!before && !before.namedVolumes.includes(sharedCacheVolumeName())
    })
    if (wasRunning) {
      await refreshEnvironmentPorts(id)
    } else {
      await run('docker', ['stop', inspection.id])
      // Drops the relay, as `stop` does.
      if (dockerSocket) await ensureEnvironmentNetwork(id)
    }
    if (before) await removeUntaggedImage(before.image)
    // The other Domo's tag of its image: nothing claims it once the row names this one's.
    if (movedFrom) await run('docker', ['image', 'rm', movedFrom.toLowerCase()], { allowFailure: true }).catch(() => {})
    const outcome: EnvironmentUpgrade = {
      finishedAt: new Date().toISOString(),
      adapters: { from: adaptersBefore, to: pinnedAdapterVersions() },
      home,
      networks,
      stopped,
      stranded,
      movedFrom,
      releasedVolumes: movedFrom && before ? await releasedVolumes(before, inspection) : []
    }
    await updateDevEnvironment(id, { status: wasRunning ? 'running' : 'stopped', lastError: null, lastUpgrade: outcome })
    // Only now does nothing mount the old ones.
    await collectRuntimeVolumes().catch(() => {})
    await collectCachedImages().catch(() => {})
    await collectBrowserVolumes().catch(() => {})
    console.info(`[dev-env] upgraded ${id} in ${timer.summary()}`)
    return { ...outcome, environment: (await getDevEnvironment(id))! }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (replacing) {
      // Nothing is swept and no volume removed: the home and the checkout are
      // as they were, and another upgrade is worth trying.
      throw await breakEnvironment(id, `The environment could not be upgraded: ${reason}`)
    }
    await putBack(id, { before, hadProxy, previous: input.previous, stopping })
    throw error
  }
}

/** The browser volume when the setting wants one: worth having, never worth failing an environment over. */
function optionalBrowserVolume(id: string, wanted: boolean): Promise<string | null> {
  if (!wanted) return Promise.resolve(null)
  return ensureBrowserVolume().catch((error) => {
    console.warn(`[dev-env] no headless browser for ${id}: ${error}`)
    return null
  })
}

/**
 * Undo the part of an upgrade that came before the removal: the old container
 * is still there, so it is started again if it was running. Its stack is not —
 * a stop does not restart it either. The row says what it said before.
 */
async function putBack(id: string, input: {
  before: ContainerInspection | null
  hadProxy: boolean
  previous: Pick<DevEnvironment, 'status' | 'lastError'>
  /** Whether anything was stopped yet. */
  stopping: boolean
}): Promise<void> {
  const environment = await getDevEnvironment(id)
  if (!environment) return
  await updateDevEnvironment(id, input.previous)
  if (!input.stopping) return
  if (input.before?.running) {
    await start(id).catch(error => console.warn(`[dev-env] could not start ${id} again after a failed upgrade: ${error}`))
  } else if (input.hadProxy) {
    // A stopped environment keeps its proxy, so a start from outside Domo works.
    await ensureDockerProxy(proxyTarget(environment, input.before)).catch(() => {})
  }
}

/**
 * The other Domo's volumes an old container mounted (its runtime, browser and
 * cache volumes) that nothing of this Domo's mounts now: no container of an
 * environment this Domo has a live row for. Reported, never removed — that
 * Domo may still be running and using them.
 */
async function releasedVolumes(before: ContainerInspection, after: ContainerInspection): Promise<string[]> {
  const candidates = before.namedVolumes.filter(volume =>
    !after.namedVolumes.includes(volume) && !volume.startsWith(resourcePrefix()))
  if (!candidates.length) return []
  const ours = new Set((await listDevEnvironments()).filter(environment => !environment.retiredAt).map(environment => environment.id))
  const released: string[] = []
  for (const volume of candidates) {
    const users = await run('docker', [
      'ps', '--all', '--filter', `volume=${volume}`, '--format', `{{.Label "${ENVIRONMENT_ID_LABEL}"}}`
    ], { allowFailure: true }).catch(() => ({ stdout: '' }))
    if (!users.stdout.split('\n').map(line => line.trim()).some(user => ours.has(user))) released.push(volume)
  }
  return released
}

/**
 * The old container's image, once a rebuild has moved the environment's tag
 * off it and nothing else names it: a Dockerfile is always rebuilt, and the
 * image it replaced would otherwise stay on the disk untagged for good. One
 * with a tag is left alone, a definition's cached image included, and one a
 * container still uses is refused by Docker.
 */
async function removeUntaggedImage(image: string): Promise<void> {
  if (!image) return
  const tags = await run('docker', ['image', 'inspect', '--format', '{{len .RepoTags}}', image], { allowFailure: true })
    .catch(() => ({ stdout: '' }))
  if (tags.stdout.trim() !== '0') return
  await run('docker', ['image', 'rm', image], { allowFailure: true }).catch(() => {})
}

/**
 * The environment's own containers created into one of its namespaces, named
 * for the report. `hostModes` in `dood/rewrite.ts` turns `network_mode: host`
 * and the others into `container:<the environment's id>`, fixed at the
 * service's create; after an upgrade that id is gone.
 */
async function namespaceSharers(environmentId: string, ownContainerId: string): Promise<string[]> {
  const found = await run('docker', [
    'ps', '--all', '--quiet', '--filter', `label=${ENVIRONMENT_LABEL}=${environmentId}`
  ], { allowFailure: true }).catch(() => ({ stdout: '' }))
  const ids = found.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  if (!ids.length) return []
  const described = await run('docker', [
    'inspect', '--format',
    '{{.Name}}\t{{.HostConfig.NetworkMode}}\t{{.HostConfig.PidMode}}\t{{.HostConfig.IpcMode}}',
    ...ids
  ], { allowFailure: true }).catch(() => ({ stdout: '' }))
  const shares = `container:${ownContainerId}`
  return described.stdout.split('\n').map(line => line.trim()).filter(Boolean).flatMap((line) => {
    const [name = '', ...modes] = line.split('\t')
    if (!modes.includes(shares)) return []
    const shown = name.replace(/^\//, '')
    return [shown.startsWith(`${environmentId}-`) ? shown.slice(environmentId.length + 1) : shown]
  })
}

/**
 * Put the new container on every network the environment's stacks made. The
 * proxy joins one only when a container is created on it (`joinNetworks` in
 * `dood/scope-layer.ts`), so a stack brought up again from containers that
 * already exist would otherwise be out of the agent's reach, by name.
 */
async function rejoinEnvironmentNetworks(environmentId: string, containerId: string): Promise<string[]> {
  const found = await run('docker', [
    'network', 'ls', '--format', '{{.Name}}', '--filter', `label=${ENVIRONMENT_LABEL}=${environmentId}`
  ], { allowFailure: true }).catch(() => ({ stdout: '' }))
  const joined: string[] = []
  for (const network of found.stdout.split('\n').map(line => line.trim()).filter(Boolean)) {
    const connected = await run('docker', ['network', 'connect', network, containerId]).then(() => true, () => false)
    if (connected) joined.push(network)
  }
  return joined
}

/**
 * Bring one row in line with what Docker says its container is doing
 * (`dev-env/container-state.ts`). In the lifecycle queue, so it reads the
 * container only after a start, stop, build or retirement under way is done,
 * and never undoes one: a `docker start` raises the event that queues this,
 * and by the time it runs the row already says `running`.
 *
 * A container that stopped on its own — the machine or Docker Desktop
 * restarted — is `stopped`, not `error`: nothing is lost, the next prompt to
 * one of its agents starts it again (`ensureEnvironmentRunning`), and so does
 * Start. Nothing restarts it before somebody asks. One that came back from
 * outside Domo (Docker Desktop's own button) gets its proxy, published ports
 * and forwards back, which a start through Domo would have done.
 */
export function reconcileEnvironmentStatus(id: string): Promise<void> {
  return lifecycle(id, async () => {
    const environment = await getDevEnvironment(id)
    if (!environment) return
    const patch = nextEnvironmentStatus(environment, findEnvironmentContainer(environment, await listEnvironmentContainers()))
    if (!patch) return
    await updateDevEnvironment(id, patch)
    if (patch.status === 'running') {
      const inspection = await inspectContainer(containerReference(environment))
      if (hasDockerProxy(inspection)) {
        await ensureDockerProxy(proxyTarget(environment, inspection))
        await ensureEnvironmentNetwork(id)
      }
      await refreshEnvironmentPorts(id)
    } else {
      stopEnvironmentForwarders(id)
    }
  })
}

/**
 * Every row against one listing. Only the rows that disagree are looked at
 * again, each in its own queue: the listing was taken outside them, and one
 * of them may be mid-start.
 */
export async function reconcileEnvironmentStatuses(): Promise<void> {
  const environments = (await listDevEnvironments()).filter(environment => !environment.retiredAt)
  if (!environments.length) return
  const containers = await listEnvironmentContainers()
  await Promise.all(environments
    .filter(environment => nextEnvironmentStatus(environment, findEnvironmentContainer(environment, containers)))
    .map(environment => reconcileEnvironmentStatus(environment.id)))
}

let containerWatcher: ContainerWatcher | null = null

/**
 * Keep every environment's `status` to what Docker reports, from boot until
 * shutdown: one `docker events` stream, a full look whenever it (re)opens,
 * and a poll while it is down. Events for one environment are coalesced, so a
 * `die` and a `stop` together are one look.
 */
export function watchEnvironmentStatuses(): void {
  if (containerWatcher) return
  const queued = new Set<string>()
  // Once per outage: while Docker is down, the poll fails every time.
  let failing = false
  const warn = (error: unknown) => {
    if (failing) return
    failing = true
    console.warn('[dev-env] could not read environment containers:', error instanceof Error ? error.message : error)
  }
  const ok = () => {
    failing = false
  }
  containerWatcher = watchEnvironmentContainers({
    onChange(id) {
      if (queued.has(id)) return
      queued.add(id)
      // Taken off before the look starts, so an event during it queues another.
      void lifecycle(id, async () => queued.delete(id))
        .then(() => reconcileEnvironmentStatus(id))
        .then(ok, warn)
    },
    onReconcile: () => void reconcileEnvironmentStatuses().then(ok, warn)
  })
}

export function stopWatchingEnvironmentStatuses(): void {
  containerWatcher?.stop()
  containerWatcher = null
}

/**
 * Retire an environment: destroy everything it has on the daemon — its
 * container, its worktree, its image, and whatever its agents made
 * through its Docker proxy — and keep the row.
 *
 * The row outliving all of it is the point. It is the only record of where the
 * agent sessions that ran here ran, it is what makes every one of them
 * unstartable — `sessionStartability` reads `retiredAt` rather than anything
 * written on the sessions themselves — and it is what claims whatever Docker
 * would not remove, for as long as that takes. Its commits stay in the project's
 * repository (the worktree shared its refs), but uncommitted work goes with the worktree, so this
 * is never a thing to restart. The row is kept for good
 * (`pruneRetiredProjects` says why).
 *
 * **A removal that failed is not a retirement that succeeded.** Every step can
 * fail for a reason that has nothing to do with this environment, and used to
 * fail silently and for ever: what is still there afterwards is written to the
 * row and returned to whoever asked, with the container that is blocking it
 * named in the message. Nothing retries it on a timer — `cleanupEnvironment`
 * below is the second ask, and `dev-env/reconcile.ts` says why.
 *
 * Standing those sessions down — stopping their adapters first — belongs to
 * `retireProjectEnvironment` in `projects.ts`, one layer up: importing
 * `acpManager` here would cycle back through this file.
 */
export function retireEnvironment(id: string): Promise<CleanupReport> {
  builds.get(id)?.abort(new Error('It was retired while it was being built.'))
  return lifecycle(id, () => retire(id))
}

async function retire(id: string): Promise<CleanupReport> {
  const environment = await getDevEnvironment(id)
  if (!environment) return { removed: [], leftovers: [], unattributed: [], branches: [] }
  stopEnvironmentForwarders(id)
  // The proxy first: nothing may create anything in the environment's name
  // while it is being taken apart. Its relay and its redirect go with it, and
  // they are processes of this Domo rather than anything on the daemon.
  await stopDoodProxy(id)
  // Its socket, too, when no proxy was listening to close it (a restore that
  // failed at boot): a file under ~/.domo/s that nothing would look at again.
  await rm(doodSocketPath(id), { force: true }).catch(() => {})
  // By inspection rather than by name, for a Docker-in-Docker Feature that
  // named its volume something other than the id.
  await removeContainer(containerReference(environment))
  // Before the sweep, because `retired_at` is what makes the row claim
  // everything named from its id and everything labelled with it: until it is
  // set, a leftover of this environment is a resource the sweep is required to
  // leave alone.
  await retireDevEnvironmentRow(id)
  // The sweep is the removal, not a check after one: it asks Docker what it
  // has and takes what the row claims, container before network before volume
  // before image. Whether anything went is decided by *observing*, never by an
  // exit code — `docker volume rm` fails the same way for a volume something
  // still has mounted and for one that was never created, and only the first
  // of those is a leftover.
  const report = await settle(environment, await sweepEnvironmentResources())
  // After the environment's container is gone, or its runtime volume is still
  // in use.
  await collectRuntimeVolumes().catch(() => {})
  await collectCachedImages().catch(() => {})
  await collectBrowserVolumes().catch(() => {})
  return report
}

/**
 * The part of a sweep's report that is about one environment — and, when
 * Docker could not be asked at all, a leftover per resource named from its id
 * rather than a report of nothing.
 *
 * An unreachable daemon is the one failure the sweep cannot write down: it
 * observed nothing, so it has nothing to record. Left like that, a retirement
 * against a Docker that is down would answer that everything went. So the
 * derived names are recorded as owed and *unconfirmed*, the row reads as
 * `error`, and the next pass — at boot, or when somebody presses the button —
 * rewrites them from what Docker actually has.
 */
async function settle(environment: DevEnvironment, report: CleanupReport): Promise<CleanupReport> {
  const id = environment.id
  if (report.unreachable) {
    const error = `Docker could not be reached to confirm it was removed (${report.unreachable}).`
    const owed = environmentResources(id, environment.containerName).map(resource => ({ ...resource, error }))
    await setEnvironmentLeftovers(id, owed.map(({ kind, name }) => ({ kind, name, error })), {
      status: 'error',
      lastError: `Docker could not be reached to confirm this environment was removed: ${report.unreachable}`
    })
    return { ...report, removed: [], leftovers: owed }
  }
  return {
    removed: report.removed.filter(leftover => leftover.environmentId === id),
    leftovers: report.leftovers.filter(leftover => leftover.environmentId === id),
    unattributed: report.unattributed,
    branches: report.branches.filter(branch => branch.environmentId === id)
  }
}

/**
 * Try again to remove what a retirement — or a failed creation — could not.
 *
 * This is the other half of reporting a refusal rather than retrying it behind
 * the user's back. Nothing Domo can do clears a container somebody else's tool
 * left mounting the volume; what clears it is a person or an agent reading the
 * `leftovers` error, removing the thing it names, and asking again. So the
 * asking has to exist, on every surface that can retire something.
 *
 * It is the ordinary sweep, so it is bound by the same attribution rule: this
 * removes what the *rows* claim and nothing else, and an environment with
 * nothing owed answers that there was nothing to do. A daemon that cannot be
 * reached is an error here rather than an empty report, which would read as
 * "cleaned up".
 */
export async function cleanupEnvironment(id: string): Promise<CleanupReport> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  const report = await sweepEnvironmentResources()
  if (report.unreachable) throw new Error(`Docker could not be reached: ${report.unreachable}`)
  return settle(environment, report)
}

function proxyTarget(environment: DevEnvironment, inspection: ContainerInspection | null) {
  return {
    id: environment.id,
    containerReference: containerReference(environment),
    workspacePath: environment.workspacePath,
    socketPath: mountedDoodSocket(environment.id, inspection)
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
    // A resumed build brings its own up, and waiting behind it would hold the boot for minutes.
    if (environment.retiredAt || environment.status === 'creating') continue
    await lifecycle(environment.id, async () => {
      const inspection = await inspectContainer(containerReference(environment)).catch(() => null)
      if (!hasDockerProxy(inspection)) return
      await ensureDockerProxy(proxyTarget(environment, inspection))
      // A running environment's published ports and its host.docker.internal
      // redirect died with the Domo that held them.
      if (inspection?.running) await ensureEnvironmentNetwork(environment.id)
    }).catch(error =>
      console.warn(`[dood] could not restore ${environment.id}:`, error instanceof Error ? error.message : error)
    )
  }
}

/**
 * The adapter versions an environment runs, which are the ones in the runtime
 * volume its container mounted at creation — not necessarily the ones Domo
 * would install today. Recorded at creation; an environment from before that
 * is asked once, while it is running, and the answer is kept. Null when it has
 * never been recorded and the container is not running to ask.
 */
export async function environmentAdapterVersions(
  environment: DevEnvironment
): Promise<Partial<Record<AgentAdapter, string>> | null> {
  if (environment.adapterVersions) return environment.adapterVersions
  if (environment.retiredAt || environment.status !== 'running') return null
  const script = [
    'const [root, ...names] = process.argv.slice(1)',
    'const out = {}',
    'for (const name of names) {',
    '  try { out[name] = require(`${root}/node_modules/${name}/package.json`).version } catch {}',
    '}',
    'process.stdout.write(JSON.stringify(out))'
  ].join('\n')
  const packages = Object.entries(ADAPTER_PACKAGES).map(([adapter, entry]) => ({
    adapter: adapter as AgentAdapter,
    name: entry.spec.slice(0, entry.spec.lastIndexOf('@'))
  }))
  const read = await run('docker', [
    'exec', containerReference(environment),
    `${RUNTIME_ROOT}/node/bin/node`, '--eval', script, `${RUNTIME_ROOT}/adapters`, ...packages.map(entry => entry.name)
  ]).catch(() => null)
  if (!read) return null
  let found: Record<string, string>
  try {
    found = JSON.parse(read.stdout)
  } catch {
    return null
  }
  const versions: Partial<Record<AgentAdapter, string>> = {}
  for (const entry of packages) {
    if (found[entry.name]) versions[entry.adapter] = found[entry.name]
  }
  await updateDevEnvironment(environment.id, { adapterVersions: versions })
  return versions
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
  content: string | Buffer
): Promise<void> {
  const args = ['exec', '--interactive']
  if (environment.remoteUser) args.push('--user', environment.remoteUser)
  args.push(
    containerReference(environment),
    'sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path
  )
  await run('docker', args, { input: content })
}
