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
  /** The host port it asked for, when it named one. */
  hostPort: number | null
}

/**
 * Where the dropped publishing is written down, on the container itself: the
 * port scanner reads it to forward exactly what the stack asked to publish,
 * on the host port it asked for when that one is free.
 */
export const REQUESTED_PORTS_LABEL = 'domo.ports'

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

function parsePortKey(key: string, bindings: unknown): PublishedPort | null {
  const [rawPort, protocol = 'tcp'] = key.split('/')
  const containerPort = Number.parseInt(rawPort ?? '', 10)
  if (!Number.isInteger(containerPort)) return null
  const first = Array.isArray(bindings) ? bindings[0] as { HostPort?: string } | undefined : undefined
  const hostPort = Number.parseInt(first?.HostPort ?? '', 10)
  return { containerPort, protocol, hostPort: Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null }
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
  const bindings = (hostConfig.PortBindings ?? {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(bindings)) {
    const port = parsePortKey(key, value)
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

  spec.Labels = {
    ...(spec.Labels as Record<string, string> | undefined),
    ...scope.labels,
    ...(droppedPorts.length && { [REQUESTED_PORTS_LABEL]: JSON.stringify(droppedPorts) })
  }
  spec.HostConfig = hostConfig
  return { spec, requiredSubpaths, networksToJoin, droppedPorts }
}

/**
 * `POST /networks/create` and `POST /volumes/create`: stamp the scope's labels
 * and nothing else. Compose makes both for a stack, and on a daemon of its own
 * they went away with it; on the shared one only a label says whose they are,
 * so retirement can remove exactly them rather than pruning the host.
 */
export function labelCreate(input: unknown, scope: Pick<DoodScope, 'labels'>): Record<string, unknown> {
  const spec = (input && typeof input === 'object' ? { ...input } : {}) as Record<string, unknown>
  spec.Labels = { ...(spec.Labels as Record<string, string> | undefined), ...scope.labels }
  return spec
}

/** What the proxy does with one request line. */
export type RequestRoute =
  | { kind: 'container-create' }
  | { kind: 'label-create' }
  | { kind: 'network-delete', network: string }
  | { kind: 'network-inspect', network: string }
  | { kind: 'forward' }

/**
 * Routes by request line alone. The API version prefix (`/v1.47`) is optional,
 * as the query string is. A network is deleted by id or by name, and whichever
 * it is is what `docker network disconnect` takes too.
 */
export function routeRequest(line: string): RequestRoute {
  const match = line.match(/^(\w+)\s+(\S+)\s+HTTP\/1\.[01]$/i)
  if (!match) return { kind: 'forward' }
  const method = match[1]!.toUpperCase()
  const path = match[2]!.split('?')[0]!.replace(/^\/v[\d.]+(?=\/)/, '')
  if (method === 'POST' && path === '/containers/create') return { kind: 'container-create' }
  if (method === 'POST' && (path === '/networks/create' || path === '/volumes/create')) return { kind: 'label-create' }
  const network = path.match(/^\/networks\/([^/]+)$/)?.[1]
  if (network && method === 'DELETE') return { kind: 'network-delete', network: decodeURIComponent(network) }
  if (network && method === 'GET') return { kind: 'network-inspect', network: decodeURIComponent(network) }
  return { kind: 'forward' }
}
