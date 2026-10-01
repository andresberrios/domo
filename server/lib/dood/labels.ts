/**
 * The `domo.*` label namespace, virtualised for the proxy's client.
 *
 * The proxy keeps its bookkeeping in `domo.*` labels (`domo.env`, the
 * requested ports and binds) and hides them from the environment. A client
 * that is itself a Domo — Domo developing Domo, in an environment — keeps its
 * own bookkeeping under the same keys, and would otherwise have them
 * overwritten on create and hidden on every read, so it could never find what
 * it made. So the client's `domo.*` labels are stored escaped
 * (`domo.x` → `domo.nested.x`) and handed back unescaped, and its label
 * filters are escaped to match: the client sees exactly its own labels and
 * never the proxy's. A third level escapes again, so any depth works.
 */

const DOMO = 'domo.'
const NESTED = 'domo.nested.'

/** A client's label key as the daemon stores it. */
export function escapeLabelKey(key: string): string {
  return key.startsWith(DOMO) ? `${NESTED}${key.slice(DOMO.length)}` : key
}

/** A stored label key as the client sees it, or null for one of the proxy's own. */
export function clientLabelKey(key: string): string | null {
  if (key.startsWith(NESTED)) return `${DOMO}${key.slice(NESTED.length)}`
  return key.startsWith(DOMO) ? null : key
}

/** A client's labels, escaped for the daemon. */
export function escapeLabels(labels: unknown): Record<string, string> | undefined {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return undefined
  return Object.fromEntries(Object.entries(labels as Record<string, string>).map(([key, value]) => [escapeLabelKey(key), value]))
}

/** Stored labels as the client sees them: the proxy's hidden, the client's unescaped. */
export function clientLabels<T>(labels: T): T {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return labels
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
    const visible = clientLabelKey(key)
    if (visible !== null) out[visible] = value
  }
  return out as T
}

/** A `label` filter value (`key` or `key=value`) as the daemon must see it. */
export function escapeLabelFilter(filter: string): string {
  const at = filter.indexOf('=')
  return at === -1 ? escapeLabelKey(filter) : `${escapeLabelKey(filter.slice(0, at))}${filter.slice(at)}`
}
