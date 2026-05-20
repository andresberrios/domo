/**
 * Bind a `useCall().refresh()` (or any imperative refresh fn) to coarse
 * `table-change` notices on the tab-wide `liveBus()` (Decided #8). The
 * server emits `{table,id,op}` for every helper-layer write to
 * `projects` / `envs` / `sessions`; subscribers refetch when a matching
 * notice lands. Replaces the 4 s rail-poll the old stack needed because
 * sessions had no server→client push channel.
 *
 * Idempotency: refetching twice produces the same result, so a
 * defensive refetch on reconnect (when the singleton resumes) is fine.
 * A missed notice during a brief network blip self-heals on the next
 * legitimate change to the same table.
 *
 * The handler is debounced (~150 ms trailing) so a flurry of updates
 * during an active turn (one `updateSession` per durable event for
 * `lastEventAt` + `status`) collapses into a single SELECT.
 *
 * Usage:
 *
 *   const { data, refresh } = await apiClient.envs.list.useCall({ projectId })
 *   useLiveRefresh(() => refresh(), { tables: ['envs'] })
 *
 * Pass `match` for narrower filtering when the parent id is known and
 * the table change carries enough information to scope it.
 */
import { onScopeDispose } from 'vue'
import type {
  LiveTableChangeFrame,
} from './liveBus'
import type { TableName } from '~~/server/lib/changeBus'

export interface UseLiveRefreshOptions {
  /** Which tables to listen for. */
  tables: TableName[]
  /** Optional extra predicate; default: any notice for a listed table. */
  match?: (frame: LiveTableChangeFrame) => boolean
  /** Trailing debounce in ms (default 150). */
  debounceMs?: number
}

export function useLiveRefresh(
  refresh: () => unknown | Promise<unknown>,
  options: UseLiveRefreshOptions,
): void {
  if (!import.meta.client) return
  const allow = new Set<TableName>(options.tables)
  const debounceMs = options.debounceMs ?? 150
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false

  function schedule() {
    if (pending) return
    pending = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      pending = false
      timer = null
      try {
        const r = refresh()
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          ;(r as Promise<unknown>).catch(() => {
            /* refresh failure shouldn't crash the bus subscription */
          })
        }
      } catch {
        /* swallow */
      }
    }, debounceMs)
  }

  const off = liveBus().onTableChange((frame) => {
    if (!allow.has(frame.table)) return
    if (options.match && !options.match(frame)) return
    schedule()
  })

  onScopeDispose(() => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    off()
  })
}
