/**
 * Subscribe to a session entity's Electric Agents durable stream and expose
 * its collections as Vue-reactive state.
 *
 * Per the design the chat surface consumes the stream *directly from the
 * browser* — not through a Domo procedure. agents-server is VPS-local and
 * Domo has no auth, so we go through the same-origin `/_agents` reverse
 * proxy (see `server/routes/_agents/[...].ts`).
 *
 * `@electric-ax/agents-runtime` ships no Vue binding (React only), so we
 * wrap its framework-agnostic core: resolve the entity's stream path,
 * build an EntityStreamDB with our custom `state:` collections, preload,
 * then mirror each TanStack DB collection into a `shallowRef` on every
 * change (sessions are small; re-reading `.toArray` is simpler and less
 * bug-prone than hand-reconciling change batches). Client-only + dynamic
 * import, same pattern as CodeMirror/xterm.
 *
 * **Browser-safe import boundary.** We import only from
 * `@electric-ax/agents-runtime/client` (no `node:` deps). The full entry's
 * `createRuntimeServerClient` (used for `getEntityInfo`) pulls
 * `model-runner` → `node:os/path/fs`, which fails the client/production
 * build — so the stream *path* is resolved server-side via the
 * `sessions.streamInfo` procedure instead, keyed by the Domo session id.
 */
import { shallowRef, watch, onScopeDispose, type Ref } from 'vue'
import type {
  EventRow,
  InboxRow,
  PendingDiffRow,
  SessionMetaRow,
} from '~/utils/sessionStreamTypes'

export interface SessionStream {
  events: Ref<EventRow[]>
  sessionMeta: Ref<SessionMetaRow | null>
  pendingDiffs: Ref<PendingDiffRow[]>
  inbox: Ref<InboxRow[]>
  ready: Ref<boolean>
  error: Ref<string | null>
}

interface MinimalCollection {
  readonly toArray: ReadonlyArray<unknown>
  subscribeChanges: (
    cb: () => void,
    opts?: { includeInitialState?: boolean },
  ) => { unsubscribe: () => void }
}
interface MinimalDb {
  collections: Record<string, MinimalCollection>
  preload: () => Promise<void>
  close: () => void
}

export function useSessionStream(
  sessionId: Ref<string | null | undefined>,
): SessionStream {
  const events = shallowRef<EventRow[]>([])
  const sessionMeta = shallowRef<SessionMetaRow | null>(null)
  const pendingDiffs = shallowRef<PendingDiffRow[]>([])
  const inbox = shallowRef<InboxRow[]>([])
  const ready = shallowRef(false)
  const error = shallowRef<string | null>(null)

  let disposed = false
  let teardown: (() => void) | null = null

  function reset() {
    teardown?.()
    teardown = null
    events.value = []
    sessionMeta.value = null
    pendingDiffs.value = []
    inbox.value = []
    ready.value = false
    error.value = null
  }

  async function connect(id: string) {
    if (!import.meta.client) return
    try {
      // Browser-safe entry only — the full `@electric-ax/agents-runtime`
      // entry's `createRuntimeServerClient` pulls `model-runner` →
      // `node:os/path/fs` and breaks the client/production build. The
      // stream *path* is resolved server-side instead.
      const { createEntityStreamDB, appendPathToUrl } = await import(
        '@electric-ax/agents-runtime/client'
      )
      if (disposed || sessionId.value !== id) return

      const { streamPath } = await apiClient.sessions.streamInfo.call({ id })
      if (disposed || sessionId.value !== id) return

      const baseUrl = `${window.location.origin}/_agents`

      // Custom `state:` collections (defaults: pk `key`, type `state:<name>`).
      const db = createEntityStreamDB(
        appendPathToUrl(baseUrl, streamPath),
        {
          events: {},
          sessionMeta: {},
          pendingDiffs: { primaryKey: 'callId' },
          inboxState: {},
        },
      ) as unknown as MinimalDb
      await db.preload()
      if (disposed || sessionId.value !== id) {
        db.close()
        return
      }

      const subs: Array<{ unsubscribe: () => void }> = []
      const bind = <T>(name: string, ref: Ref<T[]>) => {
        const col = db.collections[name]
        if (!col) return
        ref.value = [...(col.toArray as T[])]
        subs.push(
          col.subscribeChanges(() => {
            ref.value = [...(col.toArray as T[])]
          }),
        )
      }
      bind<EventRow>('events', events)
      bind<PendingDiffRow>('pendingDiffs', pendingDiffs)
      bind<InboxRow>('inbox', inbox)

      const metaCol = db.collections.sessionMeta
      const syncMeta = () => {
        sessionMeta.value =
          (metaCol?.toArray?.[0] as SessionMetaRow | undefined) ?? null
      }
      if (metaCol) {
        syncMeta()
        subs.push(metaCol.subscribeChanges(syncMeta))
      }

      ready.value = true
      teardown = () => {
        for (const s of subs) {
          try {
            s.unsubscribe()
          } catch {
            /* already gone */
          }
        }
        try {
          db.close()
        } catch {
          /* already closed */
        }
      }
    } catch (e) {
      if (!disposed) error.value = e instanceof Error ? e.message : String(e)
    }
  }

  watch(
    sessionId,
    (id) => {
      reset()
      if (id) void connect(id)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    teardown?.()
  })

  return { events, sessionMeta, pendingDiffs, inbox, ready, error }
}
