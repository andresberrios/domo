/**
 * Rewriting a `POST /containers/create` so a dev environment's inner Docker
 * work lands on the *host* daemon instead of a private one.
 *
 * A dev environment runs its own dockerd today, which means its own copy of
 * every image: measured on one install, nine DinD volumes held ~18 GB of
 * layers the host daemon already had. Pointing the environment at the host
 * daemon removes the duplication outright, but a container created that way
 * resolves paths, ports and names in the host's world rather than the
 * environment's, so three things have to be translated on the way through.
 *
 * Written as `(spec, scope) -> { spec, … }` with no I/O for the same reason
 * `home-overlay.ts` is: the decisions are the part that is easy to get wrong
 * and trivial to test, and the caller is left holding the Docker calls. The
 * result reports what the caller must *do* (create these paths, join these
 * networks) rather than doing it, so one pass describes the whole translation.
 *
 * This is a namespace, not a security boundary. A container reaching the host
 * daemon can trivially take the host; that is already true of every dev
 * environment here, and nothing in this file changes it.
 */

/** What an environment's containers are translated *into*. */
export interface DoodScope {
  /** Where the checkout appears inside the environment, e.g. `/workspaces/domo`. */
  workspacePath: string
  /** The named volume that path is really backed by. */
  workspaceVolume: string
  /** Stamped on every container so retiring the environment can sweep by label. */
  labels: Record<string, string>
}

export interface PublishedPort {
  containerPort: number
  protocol: string
}

export interface RewriteResult {
  spec: Record<string, unknown>
  /**
   * Subpaths that must exist inside the workspace volume before the create is
   * forwarded. Docker refuses `volume-subpath` pointing at a path that is not
   * there yet — measured: `cannot access path …: no such file or directory` —
   * and a compose file bind-mounting a directory it expects to be created is
   * ordinary, so the caller makes them first.
   */
  requiredSubpaths: string[]
  /**
   * Networks this container will join. The environment's own container has to
   * join them too or the agent cannot reach the services it just started by
   * name. Unlike mounts and ports, a network can be attached to a *running*
   * container, so this one is fixable after the fact.
   */
  networksToJoin: string[]
  /**
   * Host port publishing that was removed. Two environments running the same
   * compose file both ask for host 3000, and on one daemon the second loses.
   * Domo reaches services through its own forwarder instead, so nothing needs
   * to be published; these are reported so they can be offered for forwarding.
   */
  droppedPorts: PublishedPort[]
}

interface MountSpec {
  Type?: string
  Source?: string
  Target?: string
  ReadOnly?: boolean
  VolumeOptions?: { Subpath?: string }
}

/**
 * `/workspaces/domo/app` -> `app`; the workspace root itself -> `''`.
 * Anything outside the workspace is not ours to translate.
 */
export function workspaceSubpath(source: string, workspacePath: string): string | null {
  if (source === workspacePath) return ''
  if (source.startsWith(`${workspacePath}/`)) return source.slice(workspacePath.length + 1)
  return null
}

function volumeMount(scope: DoodScope, target: string, subpath: string, readOnly: boolean): MountSpec {
  const mount: MountSpec = { Type: 'volume', Source: scope.workspaceVolume, Target: target, ReadOnly: readOnly }
  if (subpath) mount.VolumeOptions = { Subpath: subpath }
  return mount
}

/** `src:dst[:opts]` — a source that is not absolute names a volume, and is left alone. */
function parseBind(bind: string): { source: string, target: string, readOnly: boolean } | null {
  const parts = bind.split(':')
  if (parts.length < 2) return null
  const [source, target, options = ''] = parts
  if (!source?.startsWith('/') || !target) return null
  return { source, target, readOnly: options.split(',').includes('ro') }
}

function parsePortKey(key: string): PublishedPort | null {
  const [rawPort, protocol = 'tcp'] = key.split('/')
  const containerPort = Number.parseInt(rawPort ?? '', 10)
  if (!Number.isInteger(containerPort)) return null
  return { containerPort, protocol }
}

export function rewriteContainerCreate(input: unknown, scope: DoodScope): RewriteResult {
  const spec = (input && typeof input === 'object' ? { ...input } : {}) as Record<string, unknown>
  const hostConfig = { ...(spec.HostConfig as Record<string, unknown> | undefined) }
  const requiredSubpaths: string[] = []
  const mounts: MountSpec[] = Array.isArray(hostConfig.Mounts) ? [...(hostConfig.Mounts as MountSpec[])] : []

  const claim = (subpath: string) => {
    if (subpath && !requiredSubpaths.includes(subpath)) requiredSubpaths.push(subpath)
  }

  // Short syntax. A bind that is not ours stays a bind: it will fail loudly
  // against the host daemon, which is better than being silently redirected.
  if (Array.isArray(hostConfig.Binds)) {
    const kept: string[] = []
    for (const bind of hostConfig.Binds as string[]) {
      const parsed = parseBind(bind)
      const subpath = parsed && workspaceSubpath(parsed.source, scope.workspacePath)
      if (!parsed || subpath === null) { kept.push(bind); continue }
      mounts.push(volumeMount(scope, parsed.target, subpath, parsed.readOnly))
      claim(subpath)
    }
    hostConfig.Binds = kept
  }

  // Long syntax.
  for (let i = 0; i < mounts.length; i++) {
    const mount = mounts[i]
    if (mount?.Type !== 'bind' || typeof mount.Source !== 'string' || !mount.Target) continue
    const subpath = workspaceSubpath(mount.Source, scope.workspacePath)
    if (subpath === null) continue
    mounts[i] = volumeMount(scope, mount.Target, subpath, !!mount.ReadOnly)
    claim(subpath)
  }
  if (mounts.length) hostConfig.Mounts = mounts

  const droppedPorts: PublishedPort[] = []
  for (const key of Object.keys(hostConfig.PortBindings ?? {})) {
    const port = parsePortKey(key)
    if (port) droppedPorts.push(port)
  }
  hostConfig.PortBindings = {}
  // Compose sets this when a `ports:` entry asked for it; with nothing
  // published it would otherwise claim a random host port per exposed port.
  hostConfig.PublishAllPorts = false

  const endpoints = (spec.NetworkingConfig as { EndpointsConfig?: Record<string, unknown> } | undefined)
    ?.EndpointsConfig
  const networksToJoin = Object.keys(endpoints ?? {})
  // `NetworkMode` names a network too, and compose uses it for the project's
  // default network even when EndpointsConfig is empty.
  const networkMode = typeof hostConfig.NetworkMode === 'string' ? hostConfig.NetworkMode : ''
  if (networkMode && !['default', 'bridge', 'host', 'none'].includes(networkMode)
    && !networkMode.startsWith('container:') && !networksToJoin.includes(networkMode)) {
    networksToJoin.push(networkMode)
  }

  spec.Labels = { ...(spec.Labels as Record<string, string> | undefined), ...scope.labels }
  spec.HostConfig = hostConfig
  return { spec, requiredSubpaths, networksToJoin, droppedPorts }
}
