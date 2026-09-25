import { agentName, stripNames, type Namespace } from './names'
import {
  REQUESTED_BINDS_LABEL,
  REQUESTED_PUBLISHING_LABEL,
  type RequestedBinds,
  type RequestedPublishing
} from './rewrite'
import { BUILTIN_NETWORKS } from './scope'

/**
 * What the agent is shown: the daemon's answers with the environment's
 * namespace taken back out of them. Pure functions over parsed JSON, one per
 * shape the daemon answers with, each tolerant of fields being absent — an
 * older daemon, a list entry rather than an inspect — because a transform
 * that throws hands the client the untranslated original.
 *
 * Three things are restored rather than merely renamed: the mounts and the
 * port publishing the client asked for (kept on labels at create, see
 * `rewrite.ts`), and the name. Compose depends on the first and last — it
 * decides whether to recreate a container by comparing `Mounts[].Name` and
 * `NetworkSettings.Networks` keys with its own names — and `docker port` /
 * `docker compose port` read the publishing.
 */

export interface ResponseScope {
  ns: Namespace
  /** The environment's workspace volume, whose mounts are shown as the binds they were asked as. */
  workspaceVolume: string
}

type Json = Record<string, any>

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** `domo.*` labels are Domo's bookkeeping, not the agent's. */
export function hideDomoLabels(labels: unknown): unknown {
  if (!isObject(labels)) return labels
  return Object.fromEntries(Object.entries(labels).filter(([key]) => !key.startsWith('domo.')))
}

function parseLabel<T>(labels: unknown, key: string): T | null {
  if (!isObject(labels) || typeof labels[key] !== 'string') return null
  try {
    return JSON.parse(labels[key]) as T
  } catch {
    return null
  }
}

const unique = (values: string[]) => [...new Set(values)]

function endpointForAgent(endpoint: unknown, scope: ResponseScope): unknown {
  if (!isObject(endpoint)) return endpoint
  const out: Json = { ...endpoint }
  for (const key of ['Aliases', 'DNSNames', 'Links'] as const) {
    if (Array.isArray(out[key])) out[key] = unique(out[key].map((value: string) => stripNames(scope.ns, String(value))))
  }
  return out
}

/**
 * The *requested* publishing, as `NetworkSettings.Ports` would report it.
 *
 * This is the seam for publishing on the environment's `localhost`: until
 * that exists nothing is really bound, so a binding that named its host port
 * is reported as asked and one that left it to the daemon is reported as
 * exposed but unpublished (`null`), which is what `docker port` prints nothing
 * for. When the port is really bound, the allocation belongs here.
 */
export function reportedPorts(actual: unknown, requested: RequestedPublishing | null): unknown {
  if (!requested?.PortBindings) return actual
  const ports: Json = isObject(actual) ? { ...actual } : {}
  for (const [key, bindings] of Object.entries(requested.PortBindings)) {
    const named = (bindings ?? []).filter(binding => binding?.HostPort)
    ports[key] = named.length
      ? named.map(binding => ({ HostIp: binding.HostIp || '0.0.0.0', HostPort: String(binding.HostPort) }))
      : null
  }
  return ports
}

/** `docker ps`'s `Ports` list for the same seam. */
function reportedPortList(actual: unknown, requested: RequestedPublishing | null): unknown {
  if (!requested?.PortBindings) return actual
  const list: Json[] = Array.isArray(actual) ? actual.filter(entry => !entry?.PublicPort) : []
  for (const [key, bindings] of Object.entries(requested.PortBindings)) {
    const [port, type = 'tcp'] = key.split('/')
    const privatePort = Number(port)
    if (!Number.isInteger(privatePort)) continue
    for (const binding of (bindings ?? []).filter(binding => binding?.HostPort)) {
      const publicPort = Number(binding.HostPort)
      if (!Number.isInteger(publicPort)) continue
      list.push({ IP: binding.HostIp || '0.0.0.0', PrivatePort: privatePort, PublicPort: publicPort, Type: type })
    }
  }
  return list
}

/** Where each original bind put what, by target — to show a workspace volume mount as the bind it was asked as. */
function requestedBindSources(requested: RequestedBinds | null): Map<string, { source: string, readOnly: boolean }> {
  const sources = new Map<string, { source: string, readOnly: boolean }>()
  for (const bind of requested?.Binds ?? []) {
    const [source = '', target = '', options = ''] = bind.split(':')
    if (source.startsWith('/') && target) sources.set(target, { source, readOnly: options.split(',').includes('ro') })
  }
  for (const mount of (requested?.Mounts ?? []) as Json[]) {
    if (mount?.Type === 'bind' && typeof mount.Source === 'string' && mount.Target) {
      sources.set(mount.Target, { source: mount.Source, readOnly: !!mount.ReadOnly })
    }
  }
  return sources
}

function mountPointsForAgent(mounts: unknown, scope: ResponseScope, requested: RequestedBinds | null): unknown {
  if (!Array.isArray(mounts)) return mounts
  const binds = requestedBindSources(requested)
  return mounts.map((mount: Json) => {
    if (!isObject(mount)) return mount
    const bind = mount.Type === 'volume' && mount.Name === scope.workspaceVolume ? binds.get(mount.Destination) : undefined
    if (bind) {
      return {
        Type: 'bind',
        Source: bind.source,
        Destination: mount.Destination,
        Mode: bind.readOnly ? 'ro' : '',
        RW: !bind.readOnly,
        Propagation: 'rprivate'
      }
    }
    return {
      ...mount,
      ...(typeof mount.Name === 'string' && { Name: agentName(scope.ns, mount.Name) }),
      ...(typeof mount.Source === 'string' && { Source: stripNames(scope.ns, mount.Source) })
    }
  })
}

function hostConfigForAgent(
  hostConfig: unknown,
  scope: ResponseScope,
  binds: RequestedBinds | null,
  publishing: RequestedPublishing | null
): unknown {
  if (!isObject(hostConfig)) return hostConfig
  const out: Json = { ...hostConfig }
  if (binds) {
    out.Binds = binds.Binds ?? null
    out.Mounts = binds.Mounts ?? (Array.isArray(hostConfig.Mounts) ? null : hostConfig.Mounts)
  }
  if (publishing) {
    out.PortBindings = publishing.PortBindings ?? {}
    out.PublishAllPorts = !!publishing.PublishAllPorts
  }
  if (typeof out.NetworkMode === 'string') out.NetworkMode = agentName(scope.ns, out.NetworkMode)
  for (const key of ['Links', 'VolumesFrom'] as const) {
    if (Array.isArray(out[key])) out[key] = out[key].map((value: string) => stripNames(scope.ns, String(value)))
  }
  return out
}

function networksForAgent(networks: unknown, scope: ResponseScope): unknown {
  if (!isObject(networks)) return networks
  return Object.fromEntries(Object.entries(networks)
    .map(([name, endpoint]) => [agentName(scope.ns, name), endpointForAgent(endpoint, scope)]))
}

/** `GET /containers/{id}/json`. */
export function containerInspectForAgent(body: unknown, scope: ResponseScope): unknown {
  if (!isObject(body)) return body
  const labels = body.Config?.Labels
  const binds = parseLabel<RequestedBinds>(labels, REQUESTED_BINDS_LABEL)
  const publishing = parseLabel<RequestedPublishing>(labels, REQUESTED_PUBLISHING_LABEL)
  const out: Json = { ...body }
  if (typeof out.Name === 'string') out.Name = agentName(scope.ns, out.Name)
  if (isObject(out.Config)) out.Config = { ...out.Config, Labels: hideDomoLabels(out.Config.Labels) }
  out.HostConfig = hostConfigForAgent(out.HostConfig, scope, binds, publishing)
  out.Mounts = mountPointsForAgent(out.Mounts, scope, binds)
  if (isObject(out.NetworkSettings)) {
    out.NetworkSettings = {
      ...out.NetworkSettings,
      Networks: networksForAgent(out.NetworkSettings.Networks, scope),
      Ports: reportedPorts(out.NetworkSettings.Ports, publishing)
    }
  }
  return out
}

/** One entry of `GET /containers/json`. */
export function containerSummaryForAgent(entry: unknown, scope: ResponseScope): unknown {
  if (!isObject(entry)) return entry
  const binds = parseLabel<RequestedBinds>(entry.Labels, REQUESTED_BINDS_LABEL)
  const publishing = parseLabel<RequestedPublishing>(entry.Labels, REQUESTED_PUBLISHING_LABEL)
  const out: Json = { ...entry, Labels: hideDomoLabels(entry.Labels) }
  if (Array.isArray(out.Names)) out.Names = out.Names.map((name: string) => stripNames(scope.ns, String(name)))
  out.Mounts = mountPointsForAgent(out.Mounts, scope, binds)
  out.Ports = reportedPortList(out.Ports, publishing)
  if (isObject(out.HostConfig) && typeof out.HostConfig.NetworkMode === 'string') {
    out.HostConfig = { ...out.HostConfig, NetworkMode: agentName(scope.ns, out.HostConfig.NetworkMode) }
  }
  if (isObject(out.NetworkSettings)) {
    out.NetworkSettings = { ...out.NetworkSettings, Networks: networksForAgent(out.NetworkSettings.Networks, scope) }
  }
  return out
}

export function containerListForAgent(body: unknown, scope: ResponseScope): unknown {
  return Array.isArray(body) ? body.map(entry => containerSummaryForAgent(entry, scope)) : body
}

/**
 * `GET /networks/{id}`, and each entry of the list. `visible` says which
 * attached containers the agent may see: its own, never the environment's
 * container (it joined only so the agent can reach services by name; a real
 * host is not an endpoint of the networks it runs), and never anyone else's —
 * a builtin network like `bridge` holds every environment's containers.
 */
export function networkForAgent(body: unknown, scope: ResponseScope, visible?: (id: string) => boolean): unknown {
  if (!isObject(body)) return body
  const out: Json = { ...body, Labels: hideDomoLabels(body.Labels) }
  if (typeof out.Name === 'string') out.Name = agentName(scope.ns, out.Name)
  if (isObject(out.Containers)) {
    out.Containers = Object.fromEntries(Object.entries(out.Containers)
      .filter(([id]) => !visible || visible(id))
      .map(([id, endpoint]) => [id, isObject(endpoint) && typeof endpoint.Name === 'string'
        ? { ...endpoint, Name: agentName(scope.ns, endpoint.Name) }
        : endpoint]))
  }
  return out
}

/** Whether a network entry is one the environment may see at all. */
export function networkVisible(entry: unknown, environmentLabel: [string, string]): boolean {
  if (!isObject(entry)) return false
  if (typeof entry.Name === 'string' && BUILTIN_NETWORKS.has(entry.Name)) return true
  return isObject(entry.Labels) && entry.Labels[environmentLabel[0]] === environmentLabel[1]
}

export function networkListForAgent(
  body: unknown,
  scope: ResponseScope,
  environmentLabel: [string, string],
  visible?: (id: string) => boolean
): unknown {
  if (!Array.isArray(body)) return body
  return body.filter(entry => networkVisible(entry, environmentLabel)).map(entry => networkForAgent(entry, scope, visible))
}

/** `GET /volumes/{name}`, `POST /volumes/create`, and each entry of the list. */
export function volumeForAgent(body: unknown, scope: ResponseScope): unknown {
  if (!isObject(body)) return body
  const out: Json = { ...body, Labels: hideDomoLabels(body.Labels) }
  if (typeof out.Name === 'string') out.Name = agentName(scope.ns, out.Name)
  if (typeof out.Mountpoint === 'string') out.Mountpoint = stripNames(scope.ns, out.Mountpoint)
  return out
}

export function volumeListForAgent(body: unknown, scope: ResponseScope): unknown {
  if (!isObject(body) || !Array.isArray(body.Volumes)) return body
  return { ...body, Volumes: body.Volumes.map(volume => volumeForAgent(volume, scope)) }
}

/** `POST /{containers,networks,volumes}/prune`: what went, by the names the agent knows. */
export function pruneReportForAgent(body: unknown, scope: ResponseScope): unknown {
  if (!isObject(body)) return body
  const out: Json = { ...body }
  for (const key of ['NetworksDeleted', 'VolumesDeleted'] as const) {
    if (Array.isArray(out[key])) out[key] = out[key].map((name: string) => agentName(scope.ns, String(name)))
  }
  return out
}

/**
 * `GET /system/df`: the environment's containers and volumes only. Images and
 * the build cache are shared on purpose, and the totals are the daemon's —
 * that one is not closable, and is documented as such.
 */
export function systemDfForAgent(body: unknown, scope: ResponseScope, environmentLabel: [string, string]): unknown {
  if (!isObject(body)) return body
  const ours = (entry: Json) => isObject(entry?.Labels) && entry.Labels[environmentLabel[0]] === environmentLabel[1]
  const out: Json = { ...body }
  if (Array.isArray(out.Containers)) out.Containers = out.Containers.filter(ours).map(entry => containerSummaryForAgent(entry, scope))
  if (Array.isArray(out.Volumes)) out.Volumes = out.Volumes.filter(ours).map(entry => volumeForAgent(entry, scope))
  return out
}

/**
 * The state an event stream filters against. Seeded from what the environment
 * owns when the stream opens, and grown as its containers are created — a
 * network `connect` for a container created a moment ago names only its id.
 */
export interface EventScope extends ResponseScope {
  environmentLabel: [string, string]
  containers: Set<string>
  volumes: Set<string>
}

/**
 * One `GET /events` line, or `null` to drop it. Container events carry the
 * container's labels as attributes, so the label decides; network and volume
 * events carry names, so the namespace (and the containers they concern)
 * decide. Image and builder events are shared like the cache they describe.
 */
export function eventForAgent(event: unknown, scope: EventScope): unknown | null {
  if (!isObject(event)) return event
  const actor: Json = isObject(event.Actor) ? event.Actor : {}
  const attributes: Json = isObject(actor.Attributes) ? actor.Attributes : {}
  const id = String(actor.ID ?? event.id ?? '')
  const type = String(event.Type ?? '')
  const namespaced = (name: unknown) => typeof name === 'string' && name.startsWith(scope.ns.prefix)

  if (type === 'container') {
    if (attributes[scope.environmentLabel[0]] !== scope.environmentLabel[1]) return null
    scope.containers.add(id)
    if (event.Action === 'destroy') scope.containers.delete(id)
  } else if (type === 'network') {
    const builtin = BUILTIN_NETWORKS.has(String(attributes.name ?? ''))
    const container = typeof attributes.container === 'string' ? attributes.container : ''
    if (container && !scope.containers.has(container)) return null
    if (!container && !namespaced(attributes.name) && !builtin) return null
    if (builtin && !container) return null
  } else if (type === 'volume') {
    const container = typeof attributes.container === 'string' ? attributes.container : ''
    const ours = namespaced(id) || scope.volumes.has(id) || (!!container && scope.containers.has(container))
    if (!ours) return null
  } else if (['service', 'node', 'secret', 'config', 'plugin'].includes(type)) {
    return null
  }

  const out: Json = { ...event }
  const strippedAttributes = Object.fromEntries(Object.entries(attributes)
    .filter(([key]) => !key.startsWith('domo.'))
    .map(([key, value]) => [key, key === 'name' || key === 'container' ? agentName(scope.ns, String(value)) : value]))
  out.Actor = { ...actor, ID: type === 'volume' ? agentName(scope.ns, id) : actor.ID, Attributes: strippedAttributes }
  if (type === 'volume' && typeof out.id === 'string') out.id = agentName(scope.ns, out.id)
  return out
}
