import { BROWSER_ROOT } from './browser-volume'
import { canonicalBaseGitPath, canonicalWorkspacePath } from './canonical-mounts'
import { run } from './docker'
import { CONTAINER_SSH_AUTH_SOCK, type HomeOverlay } from './home-overlay'
import { CACHES_ROOT, type ResolvedCaches } from './caches'
import { DOOD_FEATURE } from './config'
import type {
  DevEnvironmentConfig,
  ImageMetadata,
  ImageMetadataEntry,
  ResolvedPortConfig,
  VolumeMount
} from './types'

/**
 * The keep-alive entrypoint, mirroring what the Dev Container CLI composes.
 *
 * Every Feature that needs a process contributes an entrypoint — docker-in-docker's
 * `/usr/local/share/docker-init.sh` starts `dockerd` — and those run on every
 * `docker start`, not only the first boot, which is why they live in the container's
 * command instead of being executed once after creation. `exec "$@"` is a no-op here
 * (the image's own command is not kept), and the `sleep` loop is what holds the
 * container open while staying interruptible by the `trap`.
 *
 * The `chmod`s are the forwarded sockets: the SSH agent and, for an environment
 * on the host daemon, Domo's Docker proxy. Docker Desktop hands a forwarded
 * socket over as root:root 0660 whatever its mode on the host, so the remote
 * user cannot reach it; this command runs as root, and it has to happen on
 * every `docker start`, not only at creation. Measured: the mode set here is
 * per container, never reaches the host file, and survives the host socket
 * being re-created at the same path (which is what a Domo restart does).
 */
export function keepAliveScript(entrypoints: string[], options: { dockerSocket?: boolean } = {}): string {
  return [
    'echo Container started',
    'trap "exit 0" 15',
    `[ -S ${CONTAINER_SSH_AUTH_SOCK} ] && chmod 666 ${CONTAINER_SSH_AUTH_SOCK}`,
    ...(options.dockerSocket ? [`[ -S ${CONTAINER_DOCKER_SOCK} ] && chmod 666 ${CONTAINER_DOCKER_SOCK}`] : []),
    ...entrypoints,
    'exec "$@"',
    'while sleep 1 & wait $!; do :; done'
  ].join('\n')
}

/** Where an environment on the host daemon finds Domo's proxy. */
export const CONTAINER_DOCKER_SOCK = '/var/run/docker.sock'

/** Stamped on an environment created with the proxy, so a restart knows to bring one up. */
export const DOOD_CONTAINER_LABEL = 'domo.dood'

/** `ghcr.io/devcontainers/features/docker-outside-of-docker:1` -> `…/docker-outside-of-docker`. */
const featureName = (id: string) => id.replace(/:[^/]*$/, '')

function parseMountString(value: string): { type?: string, source?: string, target?: string } {
  const mount: Record<string, string> = {}
  for (const part of value.split(',')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    mount[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return {
    type: mount.type,
    source: mount.source ?? mount.src,
    target: mount.target ?? mount.dst ?? mount.destination
  }
}

/**
 * Fold an image's `devcontainer.metadata` label into the handful of things Domo is
 * willing to let a base image or a Feature decide. Entries arrive in contribution
 * order (base image, then each Feature, then the config), and later ones win.
 *
 * Bind mounts are dropped: a Feature that mounts a host path would put the host
 * filesystem back inside an environment whose whole point is not having it.
 */
export function mergeImageMetadata(entries: ImageMetadataEntry[], environmentId: string): ImageMetadata {
  const merged: ImageMetadata = {
    entrypoints: [],
    privileged: false,
    init: false,
    capAdd: [],
    securityOpt: [],
    containerEnv: {},
    volumeMounts: [],
    remoteUser: null,
    containerUser: null
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    // Domo takes this Feature's CLI and nothing else. Its bind mount is the
    // host socket, which Domo replaces with its own proxy; its entrypoint falls
    // back to a `socat` relay whenever the socket's group is root — always, on
    // Docker Desktop — and socat's default half-close timeout (0.5 s) cuts off
    // an attached container's output. See `server/lib/dood/proxy.ts`.
    if (entry.id && featureName(entry.id) === featureName(DOOD_FEATURE)) continue
    if (entry.entrypoint) merged.entrypoints.push(entry.entrypoint)
    if (entry.privileged === true) merged.privileged = true
    if (entry.init === true) merged.init = true
    for (const capability of entry.capAdd ?? []) {
      if (!merged.capAdd.includes(capability)) merged.capAdd.push(capability)
    }
    for (const option of entry.securityOpt ?? []) {
      if (!merged.securityOpt.includes(option)) merged.securityOpt.push(option)
    }
    Object.assign(merged.containerEnv, entry.containerEnv ?? {})
    for (const raw of entry.mounts ?? []) {
      const mount = typeof raw === 'string' ? parseMountString(raw) : raw
      if (!mount.source || !mount.target) continue
      if (mount.type !== 'volume') {
        console.warn(`[dev-env] dropped a ${mount.type ?? 'bind'} mount of ${mount.source} contributed by the image`)
        continue
      }
      merged.volumeMounts.push({
        source: mount.source.replaceAll('${devcontainerId}', environmentId),
        target: mount.target
      })
    }
    if (entry.remoteUser) merged.remoteUser = entry.remoteUser
    if (entry.containerUser) merged.containerUser = entry.containerUser
  }
  return merged
}

export async function readImageMetadata(imageName: string, environmentId: string): Promise<ImageMetadata> {
  const { stdout } = await run('docker', [
    'image', 'inspect', imageName, '--format', '{{index .Config.Labels "devcontainer.metadata"}}'
  ], { allowFailure: true })
  let entries: ImageMetadataEntry[] = []
  try {
    const parsed = JSON.parse(stdout || '[]')
    entries = Array.isArray(parsed) ? parsed : [parsed]
  } catch { /* an image without the label simply contributes nothing */ }
  return mergeImageMetadata(entries, environmentId)
}

/** Who Domo runs commands as inside the environment. The project's own answer wins. */
export function resolveRemoteUser(config: DevEnvironmentConfig, metadata: ImageMetadata): string {
  return config.remoteUser || metadata.remoteUser || metadata.containerUser || 'root'
}

export function homeDirectory(user: string): string {
  return user === 'root' ? '/root' : `/home/${user}`
}

/**
 * The three host paths a worktree-backed workspace needs bind-mounted into
 * the container — see `dev-env/canonical-mounts.ts` for why there are three,
 * and `dev-env/host-worktree.ts` for how each is made.
 */
export interface WorkspaceMounts {
  /** The environment's own linked git worktree. */
  hostWorktreePath: string
  /** The small container-only `.git` file, mounted *over* the worktree's own so the host's stays valid for `git worktree remove`. */
  hostGitdirFilePath: string
  /** The project's base checkout's `.git`, shared read-write by every environment of this project. */
  hostBaseGitPath: string
  projectId: string
}

export interface RunContainerInput {
  environmentId: string
  projectId: string
  containerName: string
  imageName: string
  config: DevEnvironmentConfig
  metadata: ImageMetadata
  remoteUser: string
  /** The legacy/display path (`/workspaces/<name>`) every other part of Domo still targets — a symlink to the canonical mount, created after the container starts (`workspaceAliasArgs`). */
  workspacePath: string
  workspace: WorkspaceMounts
  /** The shared caches and the variables that point each tool at them (`caches.ts`). */
  caches: ResolvedCaches
  runtimeVolume: string
  /** The shared headless-browser volume, when the install has one. */
  browserVolume: string | null
  ports: ResolvedPortConfig[]
  codexConfigDir: string | null
  /** The host user's login state, projected into the container's home. */
  homeOverlay: HomeOverlay
  /**
   * The host-side path of this environment's Docker proxy socket, or null for
   * an environment with no Docker. Bind-mounted as a *file*: virtiofs does not
   * carry a socket inside a mounted directory (`ENOTSUP`). And with `-v`, not
   * `--mount`: measured on Docker Desktop 4.92, `--mount type=bind` of a host
   * socket fails with `bind source path does not exist: /socket_mnt/…` while
   * `-v` of the same path works.
   */
  dockerSocket: string | null
}

function mountArg(mount: VolumeMount & { type?: string, readonly?: boolean }): string[] {
  const parts = [`type=${mount.type ?? 'volume'}`, `source=${mount.source}`, `target=${mount.target}`]
  if (mount.readonly) parts.push('readonly')
  return ['--mount', parts.join(',')]
}

/**
 * The full `docker run` argv for an environment. Pure, so the unit layer can read it.
 *
 * `--privileged` is here only when the image's metadata asked for it, which in practice
 * means a project that listed the docker-in-docker Feature itself. `"docker": true`
 * no longer needs it: the environment reaches the host daemon through a socket.
 */
export function containerRunArgs(input: RunContainerInput): string[] {
  const home = homeDirectory(input.remoteUser)
  const args = [
    'run', '--detach', '--name', input.containerName,
    '--label', `domo.envId=${input.environmentId}`,
    '--label', `domo.projectId=${input.projectId}`,
    '--label', `domo.portsAttributes=${JSON.stringify(input.config.portsAttributes ?? {})}`,
    '--add-host', 'host.docker.internal:host-gateway',
    // So a service the agent starts with `--ipc host` can share it, the way
    // `--network host` shares its network (`hostModes` in `dood/rewrite.ts`).
    // Docker's default is `private`, which no other container can join.
    '--ipc', 'shareable',
    // The environment's checkout: a bind mount of its host worktree, at a
    // canonical path — never at `workspacePath` directly, which is a symlink
    // to this, created once the container is up (`workspaceAliasArgs`).
    ...mountArg({ type: 'bind', source: input.workspace.hostWorktreePath, target: canonicalWorkspacePath(input.environmentId) }),
    // Overrides the worktree's own `.git` (copied through by the bind above)
    // with one that names this container's mount of the base checkout,
    // rather than the host's real path. The host's own `.git` is never
    // touched, so `git worktree remove` keeps working there.
    ...mountArg({
      type: 'bind',
      source: input.workspace.hostGitdirFilePath,
      target: `${canonicalWorkspacePath(input.environmentId)}/.git`,
      readonly: true
    }),
    // The project's base checkout's `.git` — shared, read-write, by every
    // environment of this project, the same way the worktrees it backs
    // already share one object database on the host.
    ...mountArg({
      type: 'bind',
      source: input.workspace.hostBaseGitPath,
      target: canonicalBaseGitPath(input.workspace.projectId)
    }),
    // Node and the ACP adapters, shared by every environment and never written to.
    ...mountArg({ source: input.runtimeVolume, target: '/opt/domo', readonly: true })
  ]
  // Written to by every environment's installs (`caches.ts`). Nothing from the
  // host's own dependency trees is ever among them.
  if (input.caches.shared) args.push(...mountArg({ source: input.caches.shared.volume, target: CACHES_ROOT }))
  for (const cache of input.caches.custom) args.push(...mountArg({ source: cache.volume, target: cache.target }))
  // Chromium, its libraries and its fonts, shared by every environment. Not on
  // anything's PATH and not named by any container-wide variable: the browser
  // needs `LD_LIBRARY_PATH` to find the libraries beside it, and setting that
  // for the whole container would put them ahead of the image's own for every
  // process in it. Only the `browser` MCP server gets it — see `browserEnv()`.
  if (input.browserVolume) {
    args.push(...mountArg({ source: input.browserVolume, target: BROWSER_ROOT, readonly: true }))
  }
  // There is deliberately no mount of the host's `~/.claude`. It carries
  // `.credentials.json`, and Anthropic rotates the refresh token on every
  // refresh: a second Claude Code reading the same chain logs the first one out,
  // which here would be the developer's own machine. The non-secret parts are
  // *copied* in at creation instead — see `seedClaudeHome()`.
  if (input.codexConfigDir) {
    args.push(...mountArg({ type: 'bind', source: input.codexConfigDir, target: `${home}/.codex` }))
  }
  // The rest of the host's login state: SSH keys, gh/gcloud/aws/kube logins and
  // the git identity. An environment is a namespace, not a security boundary,
  // and an agent in one is expected to push. `.gitconfig` is the exception —
  // the overlay puts it at `~/.gitconfig-host` and Domo writes `~/.gitconfig`.
  for (const mount of input.homeOverlay.mounts) args.push(...mountArg(mount))
  for (const mount of input.metadata.volumeMounts) args.push(...mountArg(mount))
  if (input.dockerSocket) {
    args.push(
      '--volume', `${input.dockerSocket}:${CONTAINER_DOCKER_SOCK}`,
      '--label', `${DOOD_CONTAINER_LABEL}=true`
    )
  }
  for (const port of input.ports) {
    args.push('--publish', `127.0.0.1:0:${port.innerPort}/${port.protocol}`)
  }
  args.push('--env', `DOMO_DEV_ENVIRONMENT_ID=${input.environmentId}`)
  for (const [key, value] of Object.entries(input.homeOverlay.env)) args.push('--env', `${key}=${value}`)
  // Before the image's and the project's own, which win: a later `--env` of the same name replaces it.
  for (const [key, value] of Object.entries(input.caches.env)) args.push('--env', `${key}=${value}`)
  // The project's own containerEnv wins over anything a Feature contributed.
  for (const [key, value] of Object.entries({ ...input.metadata.containerEnv, ...input.config.containerEnv })) {
    args.push('--env', `${key}=${value}`)
  }
  if (input.metadata.privileged) args.push('--privileged')
  if (input.metadata.init) args.push('--init')
  for (const capability of input.metadata.capAdd) args.push('--cap-add', capability)
  for (const option of input.metadata.securityOpt) args.push('--security-opt', option)
  args.push(
    '--entrypoint', '/bin/sh',
    input.imageName,
    '-c', keepAliveScript(input.metadata.entrypoints, { dockerSocket: !!input.dockerSocket }), '-'
  )
  return args
}

/** The argv for `postCreateCommand`: a string goes through `sh -c`, an array is argv. */
export function postCreateArgs(command: string | string[]): string[] {
  return typeof command === 'string' ? ['sh', '-c', command] : command
}
