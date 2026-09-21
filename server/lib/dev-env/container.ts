import { run } from './docker'
import { CONTAINER_SSH_AUTH_SOCK, type HomeOverlay } from './home-overlay'
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
 * The `chmod` is the forwarded SSH agent socket. Docker Desktop hands it over
 * owned by root with no group or world access, so the remote user cannot reach
 * it; this command runs as root, and it has to happen on every `docker start`,
 * not only at creation.
 */
export function keepAliveScript(entrypoints: string[]): string {
  return [
    'echo Container started',
    'trap "exit 0" 15',
    `[ -S ${CONTAINER_SSH_AUTH_SOCK} ] && chmod 666 ${CONTAINER_SSH_AUTH_SOCK}`,
    ...entrypoints,
    'exec "$@"',
    'while sleep 1 & wait $!; do :; done'
  ].join('\n')
}

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

export interface RunContainerInput {
  environmentId: string
  projectId: string
  containerName: string
  imageName: string
  config: DevEnvironmentConfig
  metadata: ImageMetadata
  remoteUser: string
  workspacePath: string
  workspaceVolume: string
  runtimeVolume: string
  ports: ResolvedPortConfig[]
  codexConfigDir: string | null
  /** The host user's login state, projected into the container's home. */
  homeOverlay: HomeOverlay
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
 * means the docker-in-docker Feature: an environment created with `"docker": false`
 * runs unprivileged.
 */
export function containerRunArgs(input: RunContainerInput): string[] {
  const home = homeDirectory(input.remoteUser)
  const args = [
    'run', '--detach', '--name', input.containerName,
    '--label', `domo.envId=${input.environmentId}`,
    '--label', `domo.projectId=${input.projectId}`,
    '--label', `domo.portsAttributes=${JSON.stringify(input.config.portsAttributes ?? {})}`,
    '--add-host', 'host.docker.internal:host-gateway',
    ...mountArg({ source: input.workspaceVolume, target: input.workspacePath }),
    // Node and both ACP adapters, shared by every environment and never written to.
    ...mountArg({ source: input.runtimeVolume, target: '/opt/domo', readonly: true })
  ]
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
  for (const port of input.ports) {
    args.push('--publish', `127.0.0.1:0:${port.innerPort}/${port.protocol}`)
  }
  args.push('--env', `DOMO_DEV_ENVIRONMENT_ID=${input.environmentId}`)
  for (const [key, value] of Object.entries(input.homeOverlay.env)) args.push('--env', `${key}=${value}`)
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
    '-c', keepAliveScript(input.metadata.entrypoints), '-'
  )
  return args
}

/** The argv for `postCreateCommand`: a string goes through `sh -c`, an array is argv. */
export function postCreateArgs(command: string | string[]): string[] {
  return typeof command === 'string' ? ['sh', '-c', command] : command
}
