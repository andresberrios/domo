import type { DoodRequest } from './http'
import { engineOk, type EngineClient } from './engine'
import { answer, withResponse, type DoodLayer, type Next, type Outcome } from './layers'
import { unprivateText } from './images'
import { agentName, isNamespaced, stripNames, type Namespace } from './names'
import { mountTableFromInspect, type EnvironmentMount } from './binds'
import type { Binding } from './publish'
import {
  containerInspectForAgent,
  containerListForAgent,
  eventForAgent,
  networkForAgent,
  networkListForAgent,
  networkVisible,
  pruneReportForAgent,
  systemDfForAgent,
  volumeForAgent,
  volumeListForAgent,
  type ResponseScope
} from './responses'
import {
  createReferences,
  labelCreate,
  rewriteContainerCreate,
  type DoodScope,
  type PublishedPort
} from './rewrite'
import {
  BUILTIN_NETWORKS,
  classifyRequest,
  domoError,
  parseFilters,
  refusesOwnContainer,
  renderFilters,
  replacementFor,
  resolveReference,
  scopeFilters,
  type Candidate,
  type ObjectKind,
  type Resolution
} from './scope'

/**
 * The layer that makes the shared daemon look like the environment's own:
 * names namespaced, lists and events and prunes scoped, every reference
 * resolved within the environment, and the answers rewritten back.
 *
 * The decisions are pure and live beside it (`scope.ts`, `rewrite.ts`,
 * `responses.ts`, `names.ts`); this file is the I/O between them — what the
 * environment owns is asked of the daemon through `engine`, on every request
 * that needs it, because a cache here would be one more thing to be wrong
 * about when two clients race.
 */

export interface ScopeLayerOptions {
  ns: Namespace
  scope: DoodScope
  engine: EngineClient
  /** The environment's own container, by name or id. */
  ownContainer: string
  /** Make these directories inside a volume, before a create mounts them as subpaths. */
  ensureSubpaths(volume: string, subpaths: string[]): Promise<void>
  onDroppedPorts?(ports: PublishedPort[]): void
  /** What a container really has published, for inspect and `docker ps` (see `ResponseScope`). */
  published?(containerId: string): Binding[] | undefined
  onError?(error: unknown): void
}

interface Owned {
  containers: Candidate[]
  own: Candidate | null
}

/** The environment's own container, with what a create is translated against: its mounts and its IPC mode. */
interface OwnContainer extends Candidate {
  mounts: EnvironmentMount[]
  ipcShareable: boolean
}

const REFUSED_VERBS: Record<string, string> = {
  stop: 'stopped', restart: 'restarted', kill: 'killed', pause: 'paused', unpause: 'unpaused',
  rename: 'renamed', update: 'updated', DELETE: 'removed'
}

const json = (body: Buffer | null): unknown => {
  if (!body?.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

const withBody = (request: DoodRequest, body: unknown): DoodRequest =>
  ({ ...request, body: Buffer.from(JSON.stringify(body), 'utf8') })

/** The path with the object reference (the second segment) replaced. */
function replaceRef(request: DoodRequest, replacement: string): DoodRequest {
  const segments = request.path.split('/')
  segments[2] = encodeURIComponent(replacement)
  return { ...request, path: segments.join('/') }
}

function withQuery(request: DoodRequest, key: string, value: string): DoodRequest {
  const query = new URLSearchParams(request.query)
  query.set(key, value)
  return { ...request, query }
}

export function scopeLayer(options: ScopeLayerOptions): DoodLayer {
  const { ns, engine } = options
  const [labelKey, labelValue] = Object.entries(options.scope.labels)[0] ?? ['domo.env', ns.environmentId]
  const environmentLabel: [string, string] = [labelKey, labelValue]
  const labelFilter = `${labelKey}=${labelValue}`
  const responseScope: ResponseScope = { ns, published: options.published }
  const listFilter = encodeURIComponent(renderFilters({ label: [labelFilter] }))

  // Everything cached here is fixed when the container is created: its id,
  // its name, its mounts and its IPC mode.
  let ownCache: OwnContainer | null = null
  const ownContainer = async (): Promise<OwnContainer | null> => {
    if (ownCache) return ownCache
    const response = await engine.request('GET', `/containers/${encodeURIComponent(options.ownContainer)}/json`)
    if (response.status !== 200) return null
    ownCache = {
      id: String(response.body.Id),
      name: String(response.body.Name ?? '').replace(/^\//, ''),
      mounts: mountTableFromInspect(response.body),
      ipcShareable: response.body.HostConfig?.IpcMode === 'shareable'
    }
    return ownCache
  }

  const owned = async (): Promise<Owned> => {
    const [list, own] = await Promise.all([
      engineOk(engine, 'GET', `/containers/json?all=1&filters=${listFilter}`),
      ownContainer()
    ])
    const containers: Candidate[] = (list as any[]).map(entry => ({
      id: String(entry.Id),
      name: String(entry.Names?.[0] ?? '').replace(/^\//, '')
    }))
    return { containers: own ? [...containers, own] : containers, own }
  }

  const ownedNetworks = async (): Promise<Array<Candidate & { raw: any }>> => {
    const list = await engineOk(engine, 'GET', '/networks') as any[]
    return list.filter(entry => networkVisible(entry, environmentLabel))
      .map(entry => ({ id: String(entry.Id), name: String(entry.Name), raw: entry }))
  }

  const ownedVolumes = async (): Promise<Candidate[]> => {
    const list = await engineOk(engine, 'GET', `/volumes?filters=${listFilter}`)
    return ((list?.Volumes ?? []) as any[]).map(entry => ({ id: String(entry.Name), name: String(entry.Name) }))
  }

  /** Memoised per request: one listing of each kind, however many references a create holds. */
  const lookups = () => {
    let containers: Promise<Owned> | null = null
    let networks: Promise<Candidate[]> | null = null
    let volumes: Promise<Candidate[]> | null = null
    const candidates = {
      container: async () => (await (containers ??= owned())).containers,
      network: () => (networks ??= ownedNetworks()),
      volume: () => (volumes ??= ownedVolumes())
    }
    return {
      owned: () => (containers ??= owned()),
      async resolve(kind: ObjectKind, ref: string): Promise<{ resolution: Resolution, replacement: string }> {
        const resolution = resolveReference(ref, await candidates[kind](), ns)
        return { resolution, replacement: replacementFor(ref, resolution, ns, kind) }
      }
    }
  }

  const ambiguous = (ref: string) => answer(400, { message: `multiple IDs found with provided prefix: ${ref}` })

  /** Filter values that name an object, resolved to what they mean in the environment. */
  const resolveFilterRefs = async (
    filters: Record<string, string[]>,
    refs: Record<string, ObjectKind>,
    lookup: ReturnType<typeof lookups>
  ) => {
    for (const [key, kind] of Object.entries(refs)) {
      if (!filters[key]) continue
      filters[key] = await Promise.all(filters[key].map(async value =>
        kind === 'volume' && value.startsWith('/') ? value : (await lookup.resolve(kind, value)).replacement))
    }
    return filters
  }

  const scopedList = async (
    request: DoodRequest,
    kind: ObjectKind,
    label: boolean,
    refs: Record<string, ObjectKind> = {}
  ): Promise<DoodRequest> => {
    const lookup = lookups()
    const filters = scopeFilters(parseFilters(request.query.get('filters')), ns, { label: label ? labelFilter : null, kind })
    await resolveFilterRefs(filters, refs, lookup)
    return withQuery(request, 'filters', renderFilters(filters))
  }

  const joinNetworks = async (networks: string[]) => {
    const own = await ownContainer()
    if (!own) return
    for (const network of networks) {
      // Already connected is the ordinary case once a stack has more than one
      // service; anything else, the create that follows reports for itself.
      await engine.request('POST', `/networks/${encodeURIComponent(network)}/connect`, { Container: own.id })
        .catch(options.onError)
    }
  }

  const leaveNetwork = async (network: string) => {
    const own = await ownContainer()
    if (!own) return
    await engine.request('POST', `/networks/${encodeURIComponent(network)}/disconnect`, { Container: own.id, Force: true })
      .catch(options.onError)
  }

  /**
   * Docker Desktop cannot `restart` a container that bind-mounts a host
   * socket: measured on 29.8, the restart fails with `failed to fulfil mount
   * request: open /socket_mnt/<path>: no such file or directory`, and the
   * container is left stopped — while `stop` then `start` of the same
   * container works every time (its API proxy sets the socket up on a start,
   * and a restart never passes through there). Every service given
   * `/var/run/docker.sock` mounts this environment's proxy socket, so such a
   * restart is done as a stop, here, and the request forwarded as the start.
   * Null when the container mounts no such socket and the restart can go as
   * it is.
   */
  const restartAsStop = async (id: string, query: URLSearchParams): Promise<{ answer: Outcome } | true | null> => {
    const socket = options.scope.dockerSocket
    if (!socket) return null
    const inspected = await engine.request('GET', `/containers/${id}/json`)
    const binds: unknown[] = Array.isArray(inspected.body?.HostConfig?.Binds) ? inspected.body.HostConfig.Binds : []
    if (!binds.some(bind => typeof bind === 'string' && bind.startsWith(`${socket}:`))) return null
    const stopQuery = new URLSearchParams()
    for (const key of ['t', 'signal']) {
      const value = query.get(key)
      if (value !== null) stopQuery.set(key, value)
    }
    const suffix = stopQuery.size ? `?${stopQuery}` : ''
    const stopped = await engine.request('POST', `/containers/${id}/stop${suffix}`)
    if (stopped.status >= 400) return { answer: answer(stopped.status, stopped.body ?? { message: 'could not stop the container' }) }
    return true
  }

  const handlers = {
    async container(request: DoodRequest, next: Next, ref: string, action: string): Promise<Outcome> {
      const lookup = lookups()
      const { resolution, replacement } = await lookup.resolve('container', ref)
      if (!resolution.found && resolution.ambiguous) return ambiguous(ref)
      const own = (await lookup.owned()).own
      if (resolution.found && own && resolution.found.id === own.id && refusesOwnContainer(action)) {
        const verb = REFUSED_VERBS[action] ?? action
        return answer(403, domoError(
          `${ref} is this environment's own container, and it cannot be ${verb} from inside it. `
          + 'Stop, restart or retire the environment from Domo instead.'
        ))
      }
      let forwarded = replaceRef(request, replacement)
      if (action === 'restart' && resolution.found) {
        const stopped = await restartAsStop(resolution.found.id, request.query)
        if (stopped && stopped !== true) return stopped.answer
        if (stopped) forwarded = { ...forwarded, path: forwarded.path.replace(/\/restart$/, '/start'), query: new URLSearchParams() }
      }
      if (action === 'rename') {
        const name = request.query.get('name')
        if (name) forwarded = withQuery(forwarded, 'name', `${ns.prefix}${name.replace(/^\//, '')}`)
      }
      const outcome = await next(forwarded)
      if (action === 'json') return withResponse(outcome, { json: body => containerInspectForAgent(body, responseScope) })
      return outcome
    },

    async containerCreate(request: DoodRequest, next: Next): Promise<Outcome> {
      const spec = json(request.body)
      // Not ours to translate; the daemon's own error is the answer.
      if (spec === undefined) return next(request)
      const lookup = lookups()
      const name = request.query.get('name')?.replace(/^\//, '') || null
      const refs = createReferences(spec)
      const replacements = new Map<string, string>()
      const key = (kind: ObjectKind, ref: string) => `${kind}\0${ref}`
      await Promise.all([
        ...refs.containers.map(async ref => replacements.set(key('container', ref), (await lookup.resolve('container', ref)).replacement)),
        ...refs.networks.map(async ref => replacements.set(key('network', ref), (await lookup.resolve('network', ref)).replacement)),
        ...refs.volumes.map(async (volume) => {
          const { resolution, replacement } = await lookup.resolve('volume', volume.name)
          replacements.set(key('volume', volume.name), replacement)
          // Created here, with the label, rather than implicitly by the daemon
          // on create — an implicitly created volume carries no label, and the
          // retirement sweep would never find it.
          if (!resolution.found) {
            await engineOk(engine, 'POST', '/volumes/create', {
              Name: replacement,
              ...(volume.driver && { Driver: volume.driver }),
              ...(volume.driverOptions && { DriverOpts: volume.driverOptions }),
              Labels: { ...volume.labels, ...options.scope.labels }
            })
          }
        })
      ])
      const lookupName = (kind: ObjectKind) => (ref: string) => replacements.get(key(kind, ref)) ?? `${ns.prefix}${ref}`
      const own = await ownContainer()
      const result = rewriteContainerCreate(spec, { ...options.scope, ...(own && { mounts: own.mounts }) }, {
        name,
        container: lookupName('container'),
        network: lookupName('network'),
        volume: lookupName('volume'),
        environment: own && { id: own.id, ipcShareable: own.ipcShareable }
      })
      if (result.refusal) return answer(400, domoError(result.refusal))
      const byVolume = new Map<string, string[]>()
      for (const { volume, subpath } of result.requiredSubpaths) byVolume.set(volume, [...(byVolume.get(volume) ?? []), subpath])
      for (const [volume, subpaths] of byVolume) await options.ensureSubpaths(volume, subpaths)
      // Best effort: a service that cannot be reached by name is worse than
      // one that was never created, but not by enough to refuse the create.
      if (result.networksToJoin.length) await joinNetworks(result.networksToJoin)
      if (result.droppedPorts.length) options.onDroppedPorts?.(result.droppedPorts)
      let forwarded = withBody(request, result.spec)
      if (name) forwarded = withQuery(forwarded, 'name', `${ns.prefix}${name}`)
      return next(forwarded)
    },

    async network(request: DoodRequest, next: Next, ref: string, action: '' | 'connect' | 'disconnect'): Promise<Outcome> {
      const lookup = lookups()
      const { resolution, replacement } = await lookup.resolve('network', ref)
      if (!resolution.found && resolution.ambiguous) return ambiguous(ref)
      let forwarded = replaceRef(request, replacement)
      const builtin = !!resolution.found && BUILTIN_NETWORKS.has(resolution.found.name)

      if (action === 'connect' || action === 'disconnect') {
        const body = json(request.body) as Record<string, any> | undefined
        if (body && typeof body.Container === 'string') {
          const container = await lookup.resolve('container', body.Container)
          const rewritten: Record<string, any> = { ...body, Container: container.replacement }
          const found = container.resolution.found
          if (action === 'connect' && found && isNamespaced(ns, found.name) && !builtin) {
            const endpoint = { ...(body.EndpointConfig ?? {}) }
            const aliases: string[] = Array.isArray(endpoint.Aliases) ? endpoint.Aliases : []
            const alias = agentName(ns, found.name)
            if (!aliases.includes(alias)) endpoint.Aliases = [...aliases, alias]
            rewritten.EndpointConfig = endpoint
          }
          forwarded = withBody(forwarded, rewritten)
        }
        return next(forwarded)
      }

      if (request.method === 'DELETE') {
        // The environment joined so the agent could reach the services by
        // name; the stack's owner does not know it is there, and a network
        // with an endpoint left cannot be removed.
        if (resolution.found && !builtin) await leaveNetwork(resolution.found.id)
        return next(forwarded)
      }

      const visible = await visibleContainers(lookup)
      return withResponse(await next(forwarded), { json: body => networkForAgent(body, responseScope, visible) })
    },

    async networkPrune(request: DoodRequest, next: Next): Promise<Outcome> {
      // A network the environment is the only endpoint of is unused as far as
      // the agent can tell (it cannot see the environment there), so it goes.
      const own = await ownContainer()
      if (own) {
        for (const network of await ownedNetworks()) {
          if (BUILTIN_NETWORKS.has(network.name)) continue
          const inspected = await engine.request('GET', `/networks/${network.id}`)
          const endpoints = Object.keys(inspected.body?.Containers ?? {})
          if (endpoints.length && endpoints.every(id => id === own.id)) await leaveNetwork(network.id)
        }
      }
      const forwarded = await scopedList(request, 'network', true)
      return withResponse(await next(forwarded), { json: body => pruneReportForAgent(body, responseScope) })
    },

    async volume(request: DoodRequest, next: Next, ref: string): Promise<Outcome> {
      const { replacement } = await lookups().resolve('volume', ref)
      const outcome = await next(replaceRef(request, replacement))
      return request.method === 'GET' ? withResponse(outcome, { json: body => volumeForAgent(body, responseScope) }) : outcome
    },

    /**
     * The legacy builder's `networkmode` (`DOCKER_BUILDKIT=0`, API clients):
     * a network or a `container:` is the environment's, like a create's, and
     * `host` is the environment's own namespace. BuildKit builds never get
     * here with anything but `host`/`none`/`default` — buildx refuses the rest
     * itself (`network mode "x" not supported by buildkit`) — and a BuildKit
     * `host` stays the daemon's, since BuildKit has no `container:` mode.
     */
    async build(request: DoodRequest, next: Next): Promise<Outcome> {
      const mode = request.query.get('networkmode')
      if (!mode || ['default', 'bridge', 'none'].includes(mode)) return next(request)
      const buildkit = request.query.get('version') === '2'
      let translated = mode
      if (mode === 'host') {
        if (buildkit) return next(request)
        const own = await ownContainer()
        if (own) translated = `container:${own.id}`
      } else if (mode.startsWith('container:')) {
        translated = `container:${(await lookups().resolve('container', mode.slice('container:'.length))).replacement}`
      } else {
        translated = (await lookups().resolve('network', mode)).replacement
      }
      return next(withQuery(request, 'networkmode', translated))
    },

    async events(request: DoodRequest, next: Next): Promise<Outcome> {
      const lookup = lookups()
      const forwarded = await scopedList(request, 'container', false, {
        container: 'container', network: 'network', volume: 'volume'
      })
      const [{ containers }, volumes] = await Promise.all([lookup.owned(), ownedVolumes()])
      const own = await ownContainer()
      const scope = {
        ...responseScope,
        environmentLabel,
        containers: new Set(containers.filter(candidate => candidate.id !== own?.id).map(candidate => candidate.id)),
        volumes: new Set(volumes.map(volume => volume.name))
      }
      return withResponse(await next(forwarded), { line: event => eventForAgent(event, scope) })
    }
  }

  /** Which endpoints of a network the agent may see: its own containers, never the environment's. */
  const visibleContainers = async (lookup: ReturnType<typeof lookups>) => {
    const { containers, own } = await lookup.owned()
    const ids = new Set(containers.filter(candidate => candidate.id !== own?.id).map(candidate => candidate.id))
    return (id: string) => ids.has(id)
  }

  return {
    wantsBody(request) {
      const kind = classifyRequest(request.method, request.path, request.query).kind
      return kind === 'container-create' || kind === 'network-create' || kind === 'volume-create'
        || (kind === 'network' && request.method === 'POST')
    },

    async handle(request, next) {
      const route = classifyRequest(request.method, request.path, request.query)
      switch (route.kind) {
        case 'refuse':
          return answer(route.status, domoError(route.message))
        case 'container':
          return handlers.container(request, next, route.ref, route.action)
        case 'container-create':
          return handlers.containerCreate(request, next)
        case 'container-list':
          return withResponse(
            await next(await scopedList(request, 'container', true, {
              before: 'container', since: 'container', network: 'network', volume: 'volume'
            })),
            { json: body => containerListForAgent(body, responseScope) }
          )
        case 'container-prune':
          return next(await scopedList(request, 'container', true))
        case 'network':
          return handlers.network(request, next, route.ref, route.action)
        case 'network-create': {
          const spec = json(request.body)
          if (spec === undefined) return next(request)
          return next(withBody(request, labelCreate(spec, options.scope, ns.prefix)))
        }
        case 'network-list': {
          // Not narrowed by label: the builtins carry none, and must be listed.
          const lookup = lookups()
          const forwarded = await scopedList(request, 'network', false)
          const visible = await visibleContainers(lookup)
          return withResponse(await next(forwarded), {
            json: body => networkListForAgent(body, responseScope, environmentLabel, visible)
          })
        }
        case 'network-prune':
          return handlers.networkPrune(request, next)
        case 'volume':
          return handlers.volume(request, next, route.ref)
        case 'volume-create': {
          const spec = json(request.body)
          if (spec === undefined) return next(request)
          return withResponse(
            await next(withBody(request, labelCreate(spec, options.scope, ns.prefix))),
            { json: body => volumeForAgent(body, responseScope) }
          )
        }
        case 'volume-list':
          return withResponse(await next(await scopedList(request, 'volume', true)), {
            json: body => volumeListForAgent(body, responseScope)
          })
        case 'volume-prune':
          return withResponse(await next(await scopedList(request, 'volume', true)), {
            json: body => pruneReportForAgent(body, responseScope)
          })
        case 'events':
          return handlers.events(request, next)
        case 'system-df':
          return withResponse(await next(request), {
            json: body => systemDfForAgent(body, responseScope, environmentLabel)
          })
        case 'build':
          return handlers.build(request, next)
        case 'commit': {
          const ref = request.query.get('container')
          if (!ref) return next(request)
          const { replacement } = await lookups().resolve('container', ref)
          return next(withQuery(request, 'container', replacement))
        }
        default:
          return next(request)
      }
    }
  }
}

/** Every error message the daemon sends, with the environment's prefixes taken out of the names in it. */
export const errorRewriter = (ns: Namespace) => (message: string) => stripNames(ns, unprivateText(ns, message))
