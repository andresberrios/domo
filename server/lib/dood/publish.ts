import type { RequestedPublishing } from './rewrite'

/**
 * The pure half of publishing an environment's containers on the
 * environment's own `localhost`: what a container's publishing *means* as a
 * set of listeners, how the relay's answer is reported back in Docker's
 * shapes, the error a conflict is refused with, and what `host.docker.internal`
 * resolves to inside a container the environment starts.
 *
 * On a daemon of its own an environment's `docker run -p 5432:5432` bound 5432
 * in the environment's network namespace, and `psql localhost:5432` worked. On
 * the shared daemon nothing is published on the host at all (two environments
 * would collide, see `rewrite.ts`), so Domo publishes it itself: a relay in the
 * environment's namespace (`relay-script.ts`) listens where the client asked
 * and forwards to the container's address on a network the two share — the
 * same semantics as real publishing, where a service bound only to its own
 * loopback is not reachable through a published port either.
 *
 * No I/O here; `network.ts` does the Docker work and calls these.
 */

export type Proto = 'tcp' | 'udp'

/** One socket the relay should hold for a container. */
export interface ListenerSpec {
  /** Stable across reconciles, so an unchanged listener keeps its socket and its allocated port. */
  key: string
  containerId: string
  containerPort: number
  proto: Proto
  /** `''` for every address the environment has; otherwise a literal address. */
  host: string
  /** `[0, 0]`: any free port. `[lo, hi]`: the first free one in the range. */
  range: [number, number]
}

/** What the relay answered for one listener. */
export interface BoundListener {
  key: string
  port: number
  /** What the socket really covers: `['0.0.0.0', '::']` for a dual-stack one. */
  addresses: string[]
}

export interface FailedListener {
  key: string
  host: string
  port: number
  proto: Proto
  reason: 'allocated' | 'in-use' | 'other'
  message?: string
}

/** A published port as Docker reports it. */
export interface Binding {
  containerPort: number
  proto: Proto
  hostIp: string
  hostPort: number
}

type PortBindings = NonNullable<RequestedPublishing['PortBindings']>

const PORT_KEY = /^(\d+)(?:\/(\w+))?$/

function portKey(key: string): { port: number, proto: string } | null {
  const match = key.match(PORT_KEY)
  if (!match) return null
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { port, proto: (match[2] ?? 'tcp').toLowerCase() }
}

/** `''` → any port; `5432` → that one; `8000-8010` → the first free one of them. Null when it is not a port at all. */
export function parseHostPort(value: string | undefined): [number, number] | null {
  const text = (value ?? '').trim()
  if (!text) return [0, 0]
  const match = text.match(/^(\d+)(?:-(\d+))?$/)
  if (!match) return null
  const lo = Number(match[1])
  const hi = match[2] === undefined ? lo : Number(match[2])
  if (lo > 65535 || hi > 65535 || hi < lo) return null
  return [lo, hi]
}

/** `''` and `0.0.0.0` mean every address; brackets around an IPv6 literal are the CLI's, not the address's. */
export function normalizeHostIp(value: string | undefined): string {
  const text = (value ?? '').trim().replace(/^\[(.*)\]$/, '$1')
  return text === '0.0.0.0' ? '' : text
}

/**
 * Why a container's publishing cannot be honoured, or null when it can. Asked
 * at create, so the refusal is loud and early rather than a `start` that fails
 * for a reason nobody can see.
 */
export function publishingError(requested: RequestedPublishing | null): string | null {
  for (const [key, bindings] of Object.entries(requested?.PortBindings ?? {})) {
    const parsed = portKey(key)
    if (!parsed) return `invalid port specification: "${key}"`
    if (parsed.proto === 'sctp') {
      return `Domo: SCTP ports (${key}) cannot be published from a dev environment — only TCP and UDP can be `
        + 'relayed into it. Publish the port over TCP or UDP, or reach the service by name on its network.'
    }
    if (parsed.proto !== 'tcp' && parsed.proto !== 'udp') return `invalid proto "${parsed.proto}"`
    for (const binding of bindings ?? []) {
      if (!parseHostPort(binding?.HostPort)) return `invalid hostPort: ${binding?.HostPort}`
    }
  }
  return null
}

/**
 * The listeners a container's publishing asks for.
 *
 * `PortBindings` has one key per container port — the CLI and compose both
 * expand a range into its ports — and a list of bindings per key, each its
 * own listener. `PublishAllPorts` (`-P`) adds every exposed port that has no
 * binding of its own, on a free port on every address; `exposed` is the
 * container's `Config.ExposedPorts`, which the daemon has already merged with
 * the image's.
 */
export function listenerSpecs(
  containerId: string,
  requested: RequestedPublishing | null,
  exposed: string[] = []
): ListenerSpec[] {
  const specs: ListenerSpec[] = []
  const bound = new Set<string>()
  const add = (key: string, index: number, host: string, range: [number, number]) => {
    const parsed = portKey(key)
    if (!parsed || (parsed.proto !== 'tcp' && parsed.proto !== 'udp')) return
    const normalized = `${parsed.port}/${parsed.proto}`
    bound.add(normalized)
    specs.push({
      key: `${containerId}/${normalized}/${index}`,
      containerId,
      containerPort: parsed.port,
      proto: parsed.proto,
      host,
      range
    })
  }
  for (const [key, bindings] of Object.entries(requested?.PortBindings ?? {} as PortBindings)) {
    const list = (bindings ?? []).filter(Boolean)
    list.forEach((binding, index) => {
      const range = parseHostPort(binding.HostPort)
      if (range) add(key, index, normalizeHostIp(binding.HostIp), range)
    })
  }
  if (requested?.PublishAllPorts) {
    for (const key of exposed) {
      const parsed = portKey(key)
      if (parsed && !bound.has(`${parsed.port}/${parsed.proto}`)) add(key, 0, '', [0, 0])
    }
  }
  return specs
}

/** The relay's answer for one container, as Docker's bindings. */
export function bindingsFor(specs: ListenerSpec[], bound: BoundListener[]): Binding[] {
  const byKey = new Map(bound.map(entry => [entry.key, entry]))
  const bindings: Binding[] = []
  for (const spec of specs) {
    const entry = byKey.get(spec.key)
    if (!entry) continue
    for (const address of entry.addresses) {
      bindings.push({ containerPort: spec.containerPort, proto: spec.proto, hostIp: address, hostPort: entry.port })
    }
  }
  return bindings
}

/**
 * How Docker refuses a `start` whose port is taken. Two wordings, both real:
 * another published container holding it is the daemon's own "port is
 * already allocated", and anything else in the namespace holding it — the
 * agent's own dev server — is the userland proxy failing to listen.
 */
export function bindFailureMessage(endpoint: string, containerId: string, failure: FailedListener): string {
  const shown = failure.host === '' ? '0.0.0.0' : failure.host.includes(':') ? `[${failure.host}]` : failure.host
  const prefix = `failed to set up container networking: driver failed programming external connectivity on endpoint ${endpoint} (${containerId})`
  if (failure.reason === 'allocated') return `${prefix}: Bind for ${shown}:${failure.port} failed: port is already allocated`
  if (failure.reason === 'in-use') {
    const family = failure.host.includes(':') ? `${failure.proto}6` : `${failure.proto}4`
    return `${prefix}: Error starting userland proxy: listen ${family} ${shown}:${failure.port}: bind: address already in use`
  }
  return `${prefix}: Error starting userland proxy: ${failure.message ?? `could not listen on ${shown}:${failure.port}`}`
}

/** `NetworkSettings.Ports` for a container, from what the relay really holds. */
export function portsFromBindings(actual: Record<string, unknown>, bindings: Binding[]): Record<string, unknown> {
  const ports: Record<string, unknown> = { ...actual }
  const grouped = new Map<string, Array<{ HostIp: string, HostPort: string }>>()
  for (const binding of bindings) {
    const key = `${binding.containerPort}/${binding.proto}`
    const list = grouped.get(key) ?? []
    list.push({ HostIp: binding.hostIp, HostPort: String(binding.hostPort) })
    grouped.set(key, list)
  }
  for (const [key, list] of grouped) ports[key] = list
  return ports
}

/** `docker ps`'s `Ports` for a container: exposed ports stay as they are, published ones gain their host side. */
export function portListFromBindings(actual: unknown[], bindings: Binding[]): unknown[] {
  const published = new Set(bindings.map(binding => `${binding.containerPort}/${binding.proto}`))
  const list = actual.filter((entry: any) => !entry?.PublicPort && !published.has(`${entry?.PrivatePort}/${entry?.Type}`))
  for (const binding of bindings) {
    list.push({ IP: binding.hostIp, PrivatePort: binding.containerPort, PublicPort: binding.hostPort, Type: binding.proto })
  }
  return list
}

/**
 * Where a published port's traffic goes: the container's address on a network
 * the environment is also on, since that is the only address the relay — in
 * the environment's namespace — can reach. Failing that, any address it has,
 * which the daemon may or may not route.
 */
export function targetAddress(
  networks: Record<string, { IPAddress?: string, NetworkID?: string }> | undefined,
  environmentNetworkIds: Set<string>
): string | null {
  const endpoints = Object.values(networks ?? {}).filter(endpoint => endpoint?.IPAddress)
  const shared = endpoints.find(endpoint => endpoint.NetworkID && environmentNetworkIds.has(endpoint.NetworkID))
  return (shared ?? endpoints[0])?.IPAddress ?? null
}

/**
 * The names that mean "the machine Docker runs on". Inside a dev environment
 * that machine is the environment: a service calling back to a dev server the
 * agent started has to reach the environment, not the developer's Mac, which
 * is what Docker Desktop's own DNS answers for both names when nothing in
 * `/etc/hosts` says otherwise.
 */
export const HOST_NAMES = ['host.docker.internal', 'gateway.docker.internal']

/**
 * A container's `ExtraHosts` with the environment standing in for the host:
 * every `host-gateway` (compose's `extra_hosts: host.docker.internal:host-gateway`)
 * becomes the environment's address, and the host names are added when the
 * client did not map them itself. An explicit address the client gave is kept.
 */
export function extraHostsFor(extraHosts: unknown, environmentIp: string): string[] {
  const entries = Array.isArray(extraHosts) ? extraHosts.filter((entry): entry is string => typeof entry === 'string') : []
  const named = new Set<string>()
  const out = entries.map((entry) => {
    const separator = entry.includes('=') ? '=' : ':'
    const index = entry.indexOf(separator)
    if (index <= 0) return entry
    const name = entry.slice(0, index)
    named.add(name)
    return entry.slice(index + 1) === 'host-gateway' ? `${name}${separator}${environmentIp}` : entry
  })
  for (const name of HOST_NAMES) if (!named.has(name)) out.push(`${name}:${environmentIp}`)
  return out
}

/** Which of an environment's networks a new container lands on, as a network name or id; null for none. */
export function primaryNetwork(hostConfig: Record<string, unknown>, endpoints: Record<string, unknown> | undefined): string | null {
  const mode = typeof hostConfig.NetworkMode === 'string' ? hostConfig.NetworkMode : ''
  if (mode === 'none' || mode === 'host' || mode.startsWith('container:')) return null
  if (mode && mode !== 'default') return mode
  // The CLI sends `default` for both, meaning the daemon's default network: the bridge.
  const first = Object.keys(endpoints ?? {}).find(name => name !== 'default')
  return first ?? 'bridge'
}

/** The environment's address on a network, matched by name or by (a prefix of) its id. */
export function environmentAddress(
  networks: Record<string, { IPAddress?: string, NetworkID?: string }> | undefined,
  network: string
): string | null {
  for (const [name, endpoint] of Object.entries(networks ?? {})) {
    if (!endpoint?.IPAddress) continue
    if (name === network || (endpoint.NetworkID && network.length >= 12 && endpoint.NetworkID.startsWith(network))) {
      return endpoint.IPAddress
    }
  }
  return null
}

/**
 * The `ExtraHosts` the client asked for, kept on the container so inspect
 * shows what was asked rather than the environment's address. JSON, `null`
 * when it asked for none.
 */
export const REQUESTED_HOSTS_LABEL = 'domo.hosts'

/** Docker's own refusal, which the daemon no longer gets to make: the publishing is gone by the time it sees the create. */
export function conflictingNetworkMode(hostConfig: Record<string, unknown>, requested: RequestedPublishing | null): string | null {
  const mode = typeof hostConfig.NetworkMode === 'string' ? hostConfig.NetworkMode : ''
  const publishes = Object.keys(requested?.PortBindings ?? {}).length > 0 || !!requested?.PublishAllPorts
  if (publishes && mode.startsWith('container:')) {
    return 'conflicting options: port publishing and the container type network mode'
  }
  return null
}
