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

import { resolveBindSource, type EnvironmentMount } from './binds'

/** What an environment's containers are translated *into*. */
export interface DoodScope {
  /** Where the checkout appears inside the environment, e.g. `/workspaces/domo`. */
  workspacePath: string
  /** The named volume that path is really backed by. */
  workspaceVolume: string
  /** Stamped on every container so retiring the environment can sweep by label. */
  labels: Record<string, string>
  /**
   * The environment container's own mount table (`binds.ts`), which every
   * bind source is resolved against. The checkout is added when it is not in
   * it, so a scope with none still translates the workspace.
   */
  mounts?: EnvironmentMount[]
  /** This environment's proxy socket on the daemon's host: what `/var/run/docker.sock` means to a service. */
  dockerSocket?: string
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
   * Subpaths that must exist inside a volume before the create is forwarded.
   * Docker refuses `volume-subpath` pointing at a path that is not there yet —
   * measured: `cannot access path …: no such file or directory` — and a
   * compose file bind-mounting a directory it expects to be created is
   * ordinary, so the caller makes them first. Only for volumes the
   * environment mounts writable: it could not have made one in the others
   * either, and Docker's refusal is then the honest answer.
   */
  requiredSubpaths: RequiredSubpath[]
  /**
   * Why the create cannot be translated, when it cannot: a bind of a path that
   * exists only inside the environment, or `network_mode: host` with no
   * environment container to share. The caller answers with it and forwards
   * nothing.
   */
  refusal?: string
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

export interface RequiredSubpath {
  volume: string
  subpath: string
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

function volumeMount(volume: string, target: string, subpath: string, readOnly: boolean): MountSpec {
  const mount: MountSpec = { Type: 'volume', Source: volume, Target: target, ReadOnly: readOnly }
  if (subpath) mount.VolumeOptions = { Subpath: subpath }
  return mount
}

interface ParsedBind {
  source: string
  target: string
  options: string[]
  readOnly: boolean
}

/** `src:dst[:opts]` — a source that is not absolute names a volume, and is left alone. */
function parseBind(bind: string): ParsedBind | null {
  const parts = bind.split(':')
  if (parts.length < 2) return null
  const [source, target, options = ''] = parts
  if (!source?.startsWith('/') || !target) return null
  const list = options ? options.split(',') : []
  return { source, target, options: list, readOnly: list.includes('ro') }
}

/** A bind entry again, with a new source, made read-only when the environment's own mount is. */
function renderBind(bind: ParsedBind, source: string, forceReadOnly: boolean): string {
  let options = bind.options
  if (forceReadOnly && !bind.readOnly) options = [...options.filter(option => option !== 'rw'), 'ro']
  return [source, bind.target, ...(options.length ? [options.join(',')] : [])].join(':')
}

/** The environment's mount table, with the checkout in it whether or not the caller read one. */
function mountTable(scope: DoodScope): EnvironmentMount[] {
  const table = [...(scope.mounts ?? [])]
  if (!table.some(mount => mount.destination === scope.workspacePath)) {
    table.push({ destination: scope.workspacePath, kind: 'volume', volume: scope.workspaceVolume, readOnly: false })
  }
  return table
}

function parsePortKey(key: string, bindings: unknown): PublishedPort | null {
  const [rawPort, protocol = 'tcp'] = key.split('/')
  const containerPort = Number.parseInt(rawPort ?? '', 10)
  if (!Number.isInteger(containerPort)) return null
  const first = Array.isArray(bindings) ? bindings[0] as { HostPort?: string } | undefined : undefined
  const hostPort = Number.parseInt(first?.HostPort ?? '', 10)
  return { containerPort, protocol, hostPort: Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null }
}

/**
 * How the references in a create are to be replaced — already resolved by the
 * caller against what the environment owns (see `scope.ts`), because
 * resolving is I/O and this function is not.
 */
export interface CreateNames {
  /** The name the agent asked for (`?name=`), unprefixed; null for a random one. */
  name: string | null
  container(ref: string): string
  network(ref: string): string
  volume(ref: string): string
  /**
   * The environment's own container: what `host` means for a network, PID or
   * IPC namespace (see `hostModes`). Null when it could not be found.
   */
  environment?: EnvironmentContainer | null
}

export interface EnvironmentContainer {
  id: string
  /** Whether its IPC namespace can be joined (`--ipc shareable`); fixed when it was created. */
  ipcShareable: boolean
}

/** A named volume a create mounts, with what it would be created with. */
export interface VolumeReference {
  name: string
  driver?: string
  driverOptions?: Record<string, string>
  labels?: Record<string, string>
}

export interface CreateReferences {
  containers: string[]
  networks: string[]
  volumes: VolumeReference[]
}

const NETWORK_MODES = new Set(['', 'default', 'bridge', 'host', 'none'])
const CONTAINER_MODE_FIELDS = ['NetworkMode', 'PidMode', 'IpcMode', 'Cgroup'] as const

const isNamedVolumeSource = (source: string) => !!source && !source.startsWith('/') && !source.startsWith('.')

/** `ref[:alias]` for links, `ref[:ro|rw]` for volumes-from: the reference is the first part. */
const firstPart = (value: string) => {
  const bare = value.replace(/^\//, '')
  const index = bare.indexOf(':')
  return index === -1 ? bare : bare.slice(0, index)
}

/**
 * Every container, network and volume a create refers to by name or id — the
 * list the caller resolves before calling `rewriteContainerCreate`. Anything
 * missed here would reach the daemon untranslated, and be resolved against
 * the whole host.
 */
export function createReferences(input: unknown): CreateReferences {
  const spec = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  const hostConfig = (spec.HostConfig ?? {}) as Record<string, any>
  const containers = new Set<string>()
  const networks = new Set<string>()
  const volumes = new Map<string, VolumeReference>()

  for (const field of CONTAINER_MODE_FIELDS) {
    const value = hostConfig[field]
    if (typeof value !== 'string') continue
    if (value.startsWith('container:')) containers.add(value.slice('container:'.length))
    else if (field === 'NetworkMode' && !NETWORK_MODES.has(value)) networks.add(value)
  }
  for (const link of asStrings(hostConfig.Links)) containers.add(firstPart(link))
  for (const from of asStrings(hostConfig.VolumesFrom)) containers.add(firstPart(from))
  const endpoints = spec.NetworkingConfig?.EndpointsConfig as Record<string, any> | undefined
  for (const [network, endpoint] of Object.entries(endpoints ?? {})) {
    if (!NETWORK_MODES.has(network)) networks.add(network)
    for (const link of asStrings(endpoint?.Links)) containers.add(firstPart(link))
  }
  for (const bind of asStrings(hostConfig.Binds)) {
    const source = bind.split(':')[0] ?? ''
    if (isNamedVolumeSource(source) && !volumes.has(source)) volumes.set(source, { name: source })
  }
  for (const mount of Array.isArray(hostConfig.Mounts) ? hostConfig.Mounts : []) {
    if (mount?.Type !== 'volume' || typeof mount.Source !== 'string' || !isNamedVolumeSource(mount.Source)) continue
    const options = mount.VolumeOptions ?? {}
    volumes.set(mount.Source, {
      name: mount.Source,
      ...(options.DriverConfig?.Name && { driver: options.DriverConfig.Name }),
      ...(options.DriverConfig?.Options && { driverOptions: options.DriverConfig.Options }),
      ...(options.Labels && { labels: options.Labels })
    })
  }
  containers.delete('')
  return { containers: [...containers], networks: [...networks], volumes: [...volumes.values()] }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Where the client's original mounts and publishing are written down, on the
 * container itself, so an inspect can show the client exactly what it asked
 * for rather than the volume subpaths and the empty publishing it really got.
 */
export const REQUESTED_BINDS_LABEL = 'domo.binds'
export const REQUESTED_PUBLISHING_LABEL = 'domo.publishing'
/** The namespaces asked for as `host` and translated to the environment's, with what had to be dropped for them (`hostModes`). */
export const REQUESTED_MODES_LABEL = 'domo.modes'

export interface RequestedBinds {
  Binds?: string[]
  Mounts?: unknown[]
}

export interface RequestedPublishing {
  PortBindings?: Record<string, Array<{ HostIp?: string, HostPort?: string }> | null>
  PublishAllPorts?: boolean
}

/**
 * What `host` means for a container's network, PID and IPC namespaces when
 * the host is the environment: the environment container's own
 * (`container:<id>`). Returns the translated modes and the HostConfig fields
 * that had to go with them, as they were asked for, so inspect can show them.
 *
 * Joining another container's network namespace brings its hostname, DNS,
 * `/etc/hosts` and interfaces with it, so Docker refuses everything that would
 * set those (measured: `conflicting options: hostname and the network mode`,
 * `… dns and the network mode`, `… port exposing and the container type network
 * mode`). On a real host `-p` with `--network host` is discarded with a
 * warning, and so it is here — nothing is published, because the service
 * already listens on the environment's own `localhost`.
 *
 * IPC is only joined when the environment was created shareable (Docker's
 * default is `private`, and joining one answers `non-shareable IPC`); an older
 * environment leaves `--ipc host` meaning the daemon host's, as it always did.
 */
export function hostModes(
  spec: Record<string, unknown>,
  hostConfig: Record<string, unknown>,
  environment: EnvironmentContainer | null | undefined
): { requested: Record<string, unknown>, refusal?: string } {
  const requested: Record<string, unknown> = {}
  const target = environment ? `container:${environment.id}` : null
  if (hostConfig.NetworkMode === 'host') {
    if (!target) {
      return {
        requested,
        refusal: 'network_mode: host shares the environment\'s own network, and this environment\'s container '
          + 'could not be found. Start the environment again, or give the service a network of its own.'
      }
    }
    requested.NetworkMode = 'host'
    for (const field of ['ExtraHosts', 'Dns', 'DnsOptions', 'DnsSearch', 'PortBindings', 'PublishAllPorts'] as const) {
      const value = hostConfig[field]
      const meaningful = Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : !!value
      if (meaningful) requested[field] = value
      Reflect.deleteProperty(hostConfig, field)
    }
    for (const field of ['Hostname', 'Domainname', 'MacAddress', 'ExposedPorts'] as const) Reflect.deleteProperty(spec, field)
    delete spec.NetworkingConfig
    hostConfig.NetworkMode = target
  }
  if (hostConfig.PidMode === 'host' && target) {
    requested.PidMode = 'host'
    hostConfig.PidMode = target
  }
  if (hostConfig.IpcMode === 'host' && target && environment?.ipcShareable) {
    requested.IpcMode = 'host'
    hostConfig.IpcMode = target
  }
  return { requested }
}

export function rewriteContainerCreate(input: unknown, scope: DoodScope, names?: CreateNames): RewriteResult {
  const spec = (input && typeof input === 'object' ? { ...input } : {}) as Record<string, unknown>
  const hostConfig = { ...(spec.HostConfig as Record<string, unknown> | undefined) }
  const requiredSubpaths: RequiredSubpath[] = []
  const refusals: string[] = []
  const originalBinds: RequestedBinds = {
    ...(Array.isArray(hostConfig.Binds) && hostConfig.Binds.length && { Binds: hostConfig.Binds as string[] }),
    ...(Array.isArray(hostConfig.Mounts) && hostConfig.Mounts.length && { Mounts: hostConfig.Mounts as unknown[] })
  }
  // Before anything reads the publishing: with the host's network there is none.
  const modes = names ? hostModes(spec, hostConfig, names.environment) : { requested: {} }
  if (modes.refusal) refusals.push(modes.refusal)
  const translatedModes = new Set(Object.keys(modes.requested).filter(key => key.endsWith('Mode')))
  const originalPublishing: RequestedPublishing = {
    ...(isObject(hostConfig.PortBindings) && Object.keys(hostConfig.PortBindings).length
      && { PortBindings: hostConfig.PortBindings as RequestedPublishing['PortBindings'] }),
    ...(hostConfig.PublishAllPorts === true && { PublishAllPorts: true })
  }
  const mounts: MountSpec[] = Array.isArray(hostConfig.Mounts)
    ? (hostConfig.Mounts as MountSpec[]).map(mount => ({ ...mount }))
    : []
  const table = mountTable(scope)
  const resolve = (source: string) => resolveBindSource(source, table, { dockerSocket: scope.dockerSocket }, scope.workspacePath)

  const claim = (volume: string, subpath: string, envReadOnly: boolean) => {
    if (!subpath || envReadOnly) return
    if (!requiredSubpaths.some(entry => entry.volume === volume && entry.subpath === subpath)) {
      requiredSubpaths.push({ volume, subpath })
    }
  }

  // Short syntax. Every absolute source is resolved against the environment's
  // mounts (`binds.ts`); one backed by a volume becomes a volume mount, since
  // `Binds` has no way to say "subpath". A named volume is renamed into the
  // environment.
  const binds: string[] = []
  // Kept apart from the client's own `Mounts`: these already name the real
  // volume, and must not be renamed into the environment's namespace below.
  const fromBinds: MountSpec[] = []
  if (Array.isArray(hostConfig.Binds)) {
    for (const bind of hostConfig.Binds as string[]) {
      const parsed = parseBind(bind)
      if (!parsed) {
        const [source = '', ...rest] = bind.split(':')
        binds.push(names && isNamedVolumeSource(source) ? [names.volume(source), ...rest].join(':') : bind)
        continue
      }
      const resolved = resolve(parsed.source)
      switch (resolved.kind) {
        case 'volume':
          fromBinds.push(volumeMount(resolved.volume, parsed.target, resolved.subpath, parsed.readOnly || resolved.readOnly))
          claim(resolved.volume, resolved.subpath, resolved.readOnly)
          break
        case 'bind':
          binds.push(renderBind(parsed, resolved.source, resolved.readOnly))
          break
        case 'socket':
        case 'system':
          binds.push(renderBind(parsed, resolved.source, false))
          break
        case 'refuse':
          refusals.push(resolved.message)
      }
    }
  }

  // Long syntax.
  const longMounts: MountSpec[] = []
  for (const mount of mounts) {
    if (mount.Type === 'volume' && names && typeof mount.Source === 'string' && isNamedVolumeSource(mount.Source)
      && mount.Source !== scope.workspaceVolume) {
      longMounts.push({ ...mount, Source: names.volume(mount.Source) })
      continue
    }
    if (mount.Type !== 'bind' || typeof mount.Source !== 'string' || !mount.Target || !mount.Source.startsWith('/')) {
      longMounts.push(mount)
      continue
    }
    const resolved = resolve(mount.Source)
    switch (resolved.kind) {
      case 'volume':
        longMounts.push(volumeMount(resolved.volume, mount.Target, resolved.subpath, !!mount.ReadOnly || resolved.readOnly))
        claim(resolved.volume, resolved.subpath, resolved.readOnly)
        break
      case 'bind':
        longMounts.push({ ...mount, Source: resolved.source, ...((mount.ReadOnly || resolved.readOnly) && { ReadOnly: true }) })
        break
      case 'socket':
        // A socket goes through `Binds`: measured on Docker Desktop, a
        // `Mounts` bind of a host socket fails with `bind source path does not
        // exist: /socket_mnt/…`, while `-v` of the same path works.
        binds.push(`${resolved.source}:${mount.Target}${mount.ReadOnly ? ':ro' : ''}`)
        break
      case 'system':
        longMounts.push(mount)
        break
      case 'refuse':
        refusals.push(resolved.message)
    }
  }
  if (Array.isArray(hostConfig.Binds) || binds.length) hostConfig.Binds = binds
  longMounts.push(...fromBinds)
  if (longMounts.length || Array.isArray(hostConfig.Mounts)) hostConfig.Mounts = longMounts

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

  if (names) {
    for (const field of CONTAINER_MODE_FIELDS) {
      const value = hostConfig[field]
      if (typeof value !== 'string' || translatedModes.has(field)) continue
      if (value.startsWith('container:')) hostConfig[field] = `container:${names.container(value.slice(10))}`
      else if (field === 'NetworkMode' && !NETWORK_MODES.has(value)) hostConfig.NetworkMode = names.network(value)
    }
    const link = (value: string) => {
      const ref = firstPart(value)
      const alias = value.replace(/^\//, '').slice(ref.length + 1) || ref
      return `${names.container(ref)}:${alias}`
    }
    if (Array.isArray(hostConfig.Links)) hostConfig.Links = asStrings(hostConfig.Links).map(link)
    if (Array.isArray(hostConfig.VolumesFrom)) {
      hostConfig.VolumesFrom = asStrings(hostConfig.VolumesFrom).map((value) => {
        const ref = firstPart(value)
        return `${names.container(ref)}${value.replace(/^\//, '').slice(ref.length)}`
      })
    }
  }

  const networkingConfig = { ...(spec.NetworkingConfig as Record<string, unknown> | undefined) }
  const endpoints: Record<string, Record<string, unknown>> = {}
  for (const [network, endpoint] of Object.entries((networkingConfig.EndpointsConfig ?? {}) as Record<string, any>)) {
    const renamed = names && !NETWORK_MODES.has(network) ? names.network(network) : network
    endpoints[renamed] = { ...(endpoint ?? {}) }
    if (names && Array.isArray(endpoint?.Links)) {
      endpoints[renamed]!.Links = asStrings(endpoint.Links).map((value) => {
        const ref = firstPart(value)
        return `${names.container(ref)}:${value.replace(/^\//, '').slice(ref.length + 1) || ref}`
      })
    }
  }
  // `NetworkMode` names a network too, and compose uses it for the project's
  // default network even when EndpointsConfig is empty.
  const networkMode = typeof hostConfig.NetworkMode === 'string' ? hostConfig.NetworkMode : ''
  if (networkMode && !NETWORK_MODES.has(networkMode) && !networkMode.startsWith('container:') && !endpoints[networkMode]) {
    endpoints[networkMode] = {}
  }
  const networksToJoin = Object.keys(endpoints).filter(network => !NETWORK_MODES.has(network))
  // The name the agent chose is the one it will look up: the host's name for
  // the container carries the prefix, so the agent's is added as an alias on
  // every network that can hold one (the default bridge cannot — Docker
  // refuses a network-scoped alias there).
  if (names?.name) {
    for (const network of networksToJoin) {
      const aliases = asStrings(endpoints[network]!.Aliases)
      if (!aliases.includes(names.name)) endpoints[network]!.Aliases = [...aliases, names.name]
    }
  }
  if (Object.keys(endpoints).length || spec.NetworkingConfig) {
    spec.NetworkingConfig = { ...networkingConfig, EndpointsConfig: endpoints }
  }

  spec.Labels = {
    ...(spec.Labels as Record<string, string> | undefined),
    ...scope.labels,
    ...(droppedPorts.length && { [REQUESTED_PORTS_LABEL]: JSON.stringify(droppedPorts) }),
    ...(Object.keys(originalBinds).length && { [REQUESTED_BINDS_LABEL]: JSON.stringify(originalBinds) }),
    ...(Object.keys(originalPublishing).length && { [REQUESTED_PUBLISHING_LABEL]: JSON.stringify(originalPublishing) }),
    ...(Object.keys(modes.requested).length && { [REQUESTED_MODES_LABEL]: JSON.stringify(modes.requested) })
  }
  spec.HostConfig = hostConfig
  return { spec, requiredSubpaths, networksToJoin, droppedPorts, ...(refusals.length && { refusal: refusals[0] }) }
}

/**
 * `POST /networks/create` and `POST /volumes/create`: stamp the scope's labels
 * and put the name in the environment's namespace. Compose makes both for a
 * stack, and on a daemon of its own they went away with it; on the shared one
 * only a label says whose they are, so retirement can remove exactly them
 * rather than pruning the host. A volume created with no name gets a random
 * one from the daemon, which is left as it is.
 */
export function labelCreate(
  input: unknown,
  scope: Pick<DoodScope, 'labels'>,
  prefix = ''
): Record<string, unknown> {
  const spec = (input && typeof input === 'object' ? { ...input } : {}) as Record<string, unknown>
  spec.Labels = { ...(spec.Labels as Record<string, string> | undefined), ...scope.labels }
  if (prefix && typeof spec.Name === 'string' && spec.Name) spec.Name = `${prefix}${spec.Name}`
  return spec
}
