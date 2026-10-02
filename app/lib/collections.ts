import { createCollection } from '@tanstack/db'
import { electricCollectionOptions } from '@tanstack/electric-db-collection'
import type { Row } from '@electric-sql/client'

/**
 * TanStack DB collections backed by ElectricSQL shapes.
 *
 * Postgres is written by the Nitro server; Electric tails the WAL and streams
 * shape changes through our `/api/shape` proxy; TanStack DB keeps the client
 * store in sync and drives every live query in the UI. Nothing here polls.
 */

function shapeUrl(): string {
  const origin = typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin
  return new URL('/api/shape', origin).href
}

const cache = new Map<string, any>()

interface ShapeDef {
  table: string
  where?: string
  params?: string[]
  /**
   * What identifies a row, when it is not an `id` column. The usage tables are
   * keyed on what they describe — a provider, or a provider and a window — so
   * there is no surrogate id to carry, and inventing one would put the same
   * fact in two columns.
   */
  key?: (row: Row) => string
  /**
   * How long the rows stay after the last reader leaves. TanStack DB's own
   * default — five minutes — when this is unset.
   */
  gcTime?: number
}

/**
 * How long a session's own rows are kept once you have navigated away.
 *
 * A transcript is megabytes, and the account-wide shapes are kilobytes, so
 * these are the only ones where the answer matters. Held for the default five
 * minutes, browsing half a dozen agents left every one of their transcripts in
 * memory at once — measured at 335MB climbing to 448MB over seven sessions,
 * which on a phone is the range where the tab is killed rather than slowed.
 *
 * A minute is long enough that stepping into an agent and back out is free,
 * and short enough that reading through a morning's work does not accumulate.
 */
const SESSION_SHAPE_GC_MS = 60_000

/**
 * A synced row's JSON is data, never state — so keep Vue out of it.
 *
 * `useLiveQuery` holds its results in a `reactive([])`, which deep-proxies
 * whatever it is handed and re-tracks every property a reader touches. A
 * transcript row carries a whole ACP payload, so on a long session that is
 * thousands of nested proxies walked again on every delta: the reactivity cost
 * measured several times the work it wrapped, and an agent streaming text froze
 * the page. Nothing mutates these values in the browser — the next Electric
 * message replaces the row — so the tracking buys nothing.
 *
 * The columns are marked, not the row: TanStack DB shallow-copies each row to
 * add its `$synced`/`$key` virtual props, and a copy does not carry the row's
 * own `__v_skip`. What the copy does carry is the *same* nested objects, so
 * marking those is what survives. `reactive()` and the `traverse()` behind
 * every deep watcher both stop at `__v_skip`, which leaves Vue tracking a
 * handful of scalars per row instead of a whole payload tree.
 */
function rawKey(key: (row: Row) => string) {
  return (row: Row) => {
    for (const value of Object.values(row)) {
      if (value !== null && typeof value === 'object') markRaw(value)
    }
    return key(row)
  }
}

function collection(key: string, def: ShapeDef): any {
  const existing = cache.get(key)
  if (existing) return existing

  const created = createCollection(
    electricCollectionOptions({
      id: key,
      shapeOptions: {
        url: shapeUrl(),
        params: {
          table: def.table,
          ...(def.where ? { where: def.where } : {}),
          ...(def.params ? { params: def.params } : {})
        }
      },
      getKey: rawKey(def.key ?? ((row: Row) => row.id as string)),
      ...(def.gcTime === undefined ? {} : { gcTime: def.gcTime })
    })
  )
  cache.set(key, created)
  return created
}

export const voiceSessionsCollection = () => collection('voice_sessions', { table: 'voice_sessions' })
export const agentSessionsCollection = () => collection('agent_sessions', { table: 'agent_sessions' })
export const mcpServersCollection = () => collection('mcp_servers', { table: 'mcp_servers' })
export const permissionsCollection = () => collection('agent_permissions', { table: 'agent_permissions' })
export const cronJobsCollection = () => collection('cron_jobs', { table: 'cron_jobs' })
export const projectsCollection = () => collection('projects', { table: 'projects' })
export const devEnvironmentsCollection = () => collection('dev_environments', { table: 'dev_environments' })
export const notificationsCollection = () => collection('notifications', { table: 'notifications' })

/** Account-wide plan limits, so every page can show them without a fetch. */
export const usageLimitsCollection = () => collection('usage_limits', {
  table: 'usage_limits',
  key: row => `${row.provider}:${row.limit_id}`
})

export const usageProvidersCollection = () => collection('usage_providers', {
  table: 'usage_providers',
  key: row => row.provider as string
})

/** One row: where an installed Domo stands against its update channel. Empty under `pnpm dev`. */
export const appUpdateCollection = () => collection('app_update', { table: 'app_update' })

/**
 * Per-session shapes: only the session on screen is synced, and only for as
 * long as it is being read. See `SESSION_SHAPE_GC_MS`.
 */
export const agentEventsCollection = (agentSessionId: string) =>
  collection(`agent_events:${agentSessionId}`, {
    table: 'agent_events',
    where: 'agent_session_id = $1',
    params: [agentSessionId],
    gcTime: SESSION_SHAPE_GC_MS
  })

export const agentInboxCollection = (agentSessionId: string) =>
  collection(`agent_inbox:${agentSessionId}`, {
    table: 'agent_inbox',
    where: 'agent_session_id = $1',
    params: [agentSessionId],
    gcTime: SESSION_SHAPE_GC_MS
  })

export const voiceMessagesCollection = (voiceSessionId: string) =>
  collection(`voice_messages:${voiceSessionId}`, {
    table: 'voice_messages',
    where: 'session_id = $1',
    params: [voiceSessionId],
    gcTime: SESSION_SHAPE_GC_MS
  })
