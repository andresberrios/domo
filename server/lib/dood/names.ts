/**
 * How an environment's containers, networks and volumes are named on the
 * shared daemon, and how those names are turned back into the ones the agent
 * chose.
 *
 * Every name an environment picks is created on the host as `<envId>-<name>`.
 * Two environments of one project run one compose file, and on one daemon they
 * would otherwise collide on every `container_name:`, on the compose project
 * name (the directory's, so the same in both), and on every `docker run
 * --name`. The agent never sees the prefix: requests are translated on the
 * way in, and responses have it stripped on the way out.
 *
 * `env_<20 hex>-` fits every Docker name rule at once — containers and volumes
 * accept `[a-zA-Z0-9][a-zA-Z0-9_.-]+`, networks nearly anything — and it can
 * never be a prefix of a name the daemon generates itself (random container
 * names are `adjective_surname`, anonymous volumes 64 hex), so a random name
 * belonging to the environment is simply left as it is.
 *
 * Pure: no Docker, no state.
 */

export interface Namespace {
  environmentId: string
  /** `<envId>-`, what every name the environment chooses is prefixed with. */
  prefix: string
}

export function namespaceFor(environmentId: string): Namespace {
  return { environmentId, prefix: `${environmentId}-` }
}

/** A name the agent chose, as it is created on the host. */
export function hostName(ns: Namespace, name: string): string {
  const bare = name.replace(/^\//, '')
  return `${name.startsWith('/') ? '/' : ''}${ns.prefix}${bare}`
}

/** A host name as the agent sees it. Names the environment did not choose are left alone. */
export function agentName(ns: Namespace, name: string): string {
  if (name.startsWith(`/${ns.prefix}`)) return `/${name.slice(ns.prefix.length + 1)}`
  if (name.startsWith(ns.prefix)) return name.slice(ns.prefix.length)
  return name
}

export function isNamespaced(ns: Namespace, name: string): boolean {
  const bare = name.replace(/^\//, '')
  return bare.startsWith(ns.prefix) && bare.length > ns.prefix.length
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The prefix removed wherever it starts a name inside free text — an error
 * message (`Conflict. The container name "/env_x-web" is already in use`), a
 * link (`/env_x-db:/env_x-web/db`), a volume's mountpoint. Only at a name
 * boundary: the environment's own workspace volume is `domo-dev-env_x-workspace`,
 * and that one is not the agent's to see differently.
 */
export function stripNames(ns: Namespace, text: string): string {
  if (!text.includes(ns.prefix)) return text
  const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(ns.prefix)}(?=[A-Za-z0-9])`, 'g')
  return text.replace(pattern, '$1')
}

/**
 * A `name` filter value as the daemon has to see it. The filter is a regular
 * expression matched against each name (with and without its slash — measured,
 * both `^/web` and `^web` match `/web`); an unanchored one is a substring and
 * still matches a prefixed name, so only an anchor needs the prefix spliced in
 * after it. Optional, because a random name of the environment's has none.
 */
export function nameFilter(ns: Namespace, value: string, withSlash: boolean): string {
  if (!value.startsWith('^')) return value
  const rest = value.slice(1)
  const optional = `(?:${escapeRegExp(ns.prefix)})?`
  if (rest.startsWith('/')) return `^/${optional}${rest.slice(1)}`
  return withSlash ? `^/?${optional}${rest}` : `^${optional}${rest}`
}
