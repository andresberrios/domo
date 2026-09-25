import { agentName, nameFilter, type Namespace } from './names'

/**
 * The pure half of scoping an environment to its own objects on the shared
 * daemon: what a request *is* (`classifyRequest`), how a filter is narrowed
 * (`scopeFilters`), and which object a reference means
 * (`resolveReference`). The I/O — listing what the environment owns, creating
 * what has to exist first — is `handlers.ts`, which calls these.
 *
 * Scoping prevents accidents, not attacks: an agent with the host daemon can
 * still `--privileged` its way out, and nothing here pretends otherwise.
 */

export type ObjectKind = 'container' | 'network' | 'volume'

/** Docker's own builtin networks, which every environment sees and none owns. */
export const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none'])

/**
 * Actions on a container the environment's own container refuses. It is
 * resolvable — `--network container:$(hostname)` is ordinary — but stopping
 * the environment from inside it kills the agent asking, and renaming it
 * breaks every reference Domo holds.
 */
const OWN_CONTAINER_REFUSED = new Set(['stop', 'restart', 'kill', 'pause', 'unpause', 'rename', 'update', 'DELETE'])

export function refusesOwnContainer(action: string): boolean {
  return OWN_CONTAINER_REFUSED.has(action)
}

export type Classified =
  | { kind: 'refuse', status: number, message: string }
  | { kind: 'container', ref: string, action: string }
  | { kind: 'container-create' }
  | { kind: 'container-list' }
  | { kind: 'container-prune' }
  | { kind: 'network', ref: string, action: '' | 'connect' | 'disconnect' }
  | { kind: 'network-create' }
  | { kind: 'network-list' }
  | { kind: 'network-prune' }
  | { kind: 'volume', ref: string }
  | { kind: 'volume-create' }
  | { kind: 'volume-list' }
  | { kind: 'volume-prune' }
  | { kind: 'events' }
  | { kind: 'system-df' }
  | { kind: 'commit' }
  | { kind: 'forward' }

/** The loud answer for what cannot be translated. Clients print `message` like any daemon error. */
export const domoError = (message: string) => ({ message: `Domo: ${message}` })

const SWARM = /^\/(swarm|services|nodes|secrets|configs|plugins|tasks)(\/|$)/

export function classifyRequest(method: string, path: string, query: URLSearchParams): Classified {
  const segments = path.split('/').slice(1).map(segment => decodeURIComponent(segment))
  const [root, ref, action = ''] = segments

  if (SWARM.test(path) && method !== 'GET' && method !== 'HEAD') {
    return {
      kind: 'refuse',
      status: 403,
      message: `swarm mode and plugins are not available here: the daemon is shared by every environment and by the host, `
        + `and ${method} ${path} would change it for all of them.`
    }
  }

  if (root === 'containers') {
    if (segments.length === 2 && ref === 'create' && method === 'POST') return { kind: 'container-create' }
    if (segments.length === 2 && ref === 'json' && method === 'GET') return { kind: 'container-list' }
    if (segments.length === 2 && ref === 'prune' && method === 'POST') return { kind: 'container-prune' }
    if (ref) return { kind: 'container', ref, action: segments.length === 2 && method === 'DELETE' ? 'DELETE' : action }
  }
  if (root === 'networks') {
    if (segments.length === 1 && method === 'GET') return { kind: 'network-list' }
    if (segments.length === 2 && ref === 'create' && method === 'POST') return { kind: 'network-create' }
    if (segments.length === 2 && ref === 'prune' && method === 'POST') return { kind: 'network-prune' }
    if (ref && (action === '' || action === 'connect' || action === 'disconnect')) return { kind: 'network', ref, action }
  }
  if (root === 'volumes') {
    if (segments.length === 1 && method === 'GET') return { kind: 'volume-list' }
    if (segments.length === 2 && ref === 'create' && method === 'POST') return { kind: 'volume-create' }
    if (segments.length === 2 && ref === 'prune' && method === 'POST') return { kind: 'volume-prune' }
    if (ref && method === 'PUT') {
      return { kind: 'refuse', status: 403, message: 'cluster volumes are a swarm feature and are not available here.' }
    }
    if (ref) return { kind: 'volume', ref }
  }
  if (path === '/events' && method === 'GET') return { kind: 'events' }
  if (path === '/system/df' && method === 'GET') return { kind: 'system-df' }
  if (path === '/commit' && method === 'POST') return { kind: 'commit' }
  if (path === '/build/prune' && method === 'POST') {
    return {
      kind: 'refuse',
      status: 403,
      message: 'the build cache is shared by every environment on this daemon, so it cannot be pruned from inside one. '
        + 'Prune it from the host if you mean to.'
    }
  }
  if (path === '/images/prune' && method === 'POST' && !onlyDangling(query)) {
    return {
      kind: 'refuse',
      status: 403,
      message: 'images are shared by every environment on this daemon, so `image prune -a` would delete the other '
        + 'environments\' images too. `docker image prune` (dangling images only) is allowed.'
    }
  }
  return { kind: 'forward' }
}

/** `image prune` without `-a` sends `dangling=true`, or nothing (the daemon's default is dangling only). */
function onlyDangling(query: URLSearchParams): boolean {
  const filters = parseFilters(query.get('filters'))
  const dangling = filters.dangling ?? []
  return !dangling.some(value => ['false', '0'].includes(value.toLowerCase()))
}

export type Filters = Record<string, string[]>

/**
 * `filters` as sent: current clients send `{"key":{"value":true}}`, older ones
 * `{"key":["value"]}`. Normalised to lists; rendered back in the current form,
 * which every daemon version this proxy talks to accepts.
 */
export function parseFilters(raw: string | null): Filters {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const filters: Filters = {}
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (Array.isArray(value)) filters[key] = value.map(String)
      else if (value && typeof value === 'object') {
        filters[key] = Object.entries(value).filter(([, on]) => on).map(([item]) => item)
      }
    }
    return filters
  } catch {
    return {}
  }
}

export function renderFilters(filters: Filters): string {
  const out: Record<string, Record<string, boolean>> = {}
  for (const [key, values] of Object.entries(filters)) {
    if (!values.length) continue
    out[key] = Object.fromEntries(values.map(value => [value, true]))
  }
  return JSON.stringify(out)
}

/** Adds the environment's label, and translates anchored `name` filters. */
export function scopeFilters(
  filters: Filters,
  ns: Namespace,
  options: { label: string | null, kind: ObjectKind }
): Filters {
  const scoped: Filters = { ...filters }
  if (options.label) scoped.label = [...(filters.label ?? []), options.label]
  if (filters.name) scoped.name = filters.name.map(value => nameFilter(ns, value, options.kind === 'container'))
  return scoped
}

/** One object the environment may reference: its id, and its name on the host. */
export interface Candidate {
  id: string
  /** On the host, without Docker's leading slash. */
  name: string
}

export type Resolution =
  | { found: Candidate, by: 'id' | 'name' | 'prefix' }
  | { found: null, ambiguous: boolean }

/**
 * Which of the environment's objects a reference means, in Docker's own order:
 * an exact full id, then an exact name — as the agent knows it, so without the
 * prefix — then a unique id prefix. Only what the caller passes in is
 * considered, which is the whole of the scoping: another environment's
 * object, or the host's, is simply not found.
 */
export function resolveReference(ref: string, candidates: Candidate[], ns: Namespace): Resolution {
  const bare = ref.replace(/^\//, '')
  if (!bare) return { found: null, ambiguous: false }
  const byId = candidates.find(candidate => candidate.id === bare)
  if (byId) return { found: byId, by: 'id' }
  const byName = candidates.find(candidate => agentName(ns, candidate.name) === bare)
  if (byName) return { found: byName, by: 'name' }
  if (/^[0-9a-f]+$/i.test(bare)) {
    const matches = candidates.filter(candidate => candidate.id.startsWith(bare.toLowerCase()))
    if (matches.length === 1) return { found: matches[0]!, by: 'prefix' }
    if (matches.length > 1) return { found: null, ambiguous: true }
  }
  return { found: null, ambiguous: false }
}

/**
 * What a reference is replaced with on its way to the daemon. A name stays a
 * name (the host's), so what the daemon stores — a network mode, a link —
 * still reads as a name once the prefix is stripped again; an id or a prefix
 * becomes the full id. Nothing found becomes the *prefixed* reference, which
 * cannot exist, so the daemon answers with its own "No such container" /
 * "network … not found" / "no such volume" in its own words — and the prefix
 * is stripped from that message on the way back.
 */
export function replacementFor(ref: string, resolution: Resolution, ns: Namespace, kind: ObjectKind): string {
  if (resolution.found) {
    if (kind === 'volume' || resolution.by === 'name') return resolution.found.name
    return resolution.found.id
  }
  return `${ns.prefix}${ref.replace(/^\//, '')}`
}
