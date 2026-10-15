import { and, gte, lt } from '@tanstack/db'
import type { Collection } from '@tanstack/db'

/**
 * A long, append-mostly log read straight off its collections, newest first.
 *
 * Two costs used to grow with everything an agent had ever done. Rebuilding a
 * reactive array from thousands of rows on every streamed word is the first,
 * and reading the change stream into a plain array behind a `shallowRef` is
 * what fixed it: a delta costs one mapping and one splice. The second was the
 * download itself. A long session's shape is megabytes of tool output, and the
 * browser parsed all of it before the page could draw a row; on a phone that
 * was seconds of one frozen frame.
 *
 * So the collections are on-demand (see `agentEventsCollection`) and the log is
 * a window: the newest page of rows, then each earlier page only when
 * `loadEarlier()` asks for it. A window is "everything from this `seq` on", so
 * the live tail streams into it and an edit to a row inside it lands, while
 * rows below it are never fetched. Where each page begins is `pageFloor`'s
 * answer, which the server gives without sending the rows (`agentEventsPageFloor`).
 *
 * `seq` is global, so several collections — an assistant's sessions — share
 * one floor and read as one log; they are given oldest first.
 *
 * The array is ordered by `compare` and kept that way as rows arrive, so
 * readers never sort. An unchanged row keeps its mapped object, which is what
 * lets everything downstream tell what actually moved.
 */
export function useSyncedLog<TRow extends object, TItem>(
  collection: MaybeRefOrGetter<Collection<any, any, any> | Collection<any, any, any>[] | null | undefined>,
  map: (row: TRow) => TItem,
  compare: (a: TItem, b: TItem) => number,
  /**
   * Where the page below `ceiling` begins: the `seq` to load from, or null
   * when what is left is the rest of the log.
   */
  pageFloor: (ceiling: number | null) => Promise<number | null>
) {
  const items = shallowRef<TItem[]>([])
  const isReady = ref(false)
  /** Every row is loaded: there is nothing earlier to ask for. */
  const complete = ref(false)
  const loadingEarlier = ref(false)

  let loadEarlierNow: () => Promise<void> = async () => {}

  const collections = computed(() => {
    const source = toValue(collection)
    return Array.isArray(source) ? source : source ? [source] : []
  })

  // Started again only when the collections themselves change. A caller's list
  // is rebuilt whenever anything it is derived from changes — an assistant's
  // sessions on any status change — and starting again means loading the page
  // again, with the transcript empty meanwhile.
  watch(() => collections.value.map(entry => entry.id).join('\n'), (_key, _previous, onCleanup) => {
    const sources = collections.value
    items.value = []
    isReady.value = false
    complete.value = false
    loadingEarlier.value = false
    loadEarlierNow = async () => {}
    if (!sources.length) return

    let cancelled = false
    const subscriptions: Array<{ unsubscribe: () => void }> = []
    onCleanup(() => {
      cancelled = true
      subscriptions.forEach(subscription => subscription.unsubscribe())
    })

    /* Plain structures, deliberately outside Vue: only `items` is reactive, and
     * it is replaced wholesale so nothing here needs to be observed. */
    const byKey = new Map<string, TItem>()
    const sorted: TItem[] = []
    /** The lowest `seq` in the window; null once the window is the whole log. */
    let floor: number | null = null

    const remove = (item: TItem) => {
      const at = indexOf(sorted, item, compare)
      if (at >= 0) sorted.splice(at, 1)
    }

    const onChanges = (changes: any[]) => {
      if (cancelled) return
      for (const change of changes) {
        const key = String(change.key)
        const previous = byKey.get(key)

        if (change.type === 'delete') {
          if (previous) {
            remove(previous)
            byKey.delete(key)
          }
          continue
        }

        const next = map(change.value as TRow)
        if (previous) remove(previous)
        byKey.set(key, next)
        insert(sorted, next, compare)
      }
      // One new identity per batch: Vue re-reads the array, not the rows in it.
      items.value = sorted.slice()
    }

    /** Subscribe every collection to `[from, to)`; resolves once its rows are in. */
    async function subscribe(from: number | null, to: number | null) {
      const where = (row: any) =>
        from === null ? lt(row.seq, to!) : to === null ? gte(row.seq, from) : and(gte(row.seq, from), lt(row.seq, to))
      await Promise.all(sources.map(entry => new Promise<void>((resolve) => {
        let reported = false
        const subscription = entry.subscribeChanges(onChanges, {
          includeInitialState: true,
          ...(from === null && to === null ? {} : { where }),
          // On-demand, the initial state is whatever this load brings.
          onLoadSubsetResult: (result: unknown) => {
            reported = true
            if (result instanceof Promise) result.then(() => resolve(), () => resolve())
            else resolve()
          }
        } as any)
        subscriptions.push(subscription)
        if (cancelled) subscription.unsubscribe()
        // Nothing to load — an eager collection already holds every row.
        if (!reported) resolve()
      })))
    }

    void (async () => {
      // Not knowing where the newest page starts is no reason to show nothing:
      // the whole log is slower, but it is the transcript.
      floor = await pageFloor(null).catch(() => null)
      if (cancelled) return
      await subscribe(floor, null)
      if (cancelled) return
      complete.value = floor === null
      isReady.value = true
    })()

    loadEarlierNow = async () => {
      if (cancelled || floor === null || loadingEarlier.value || !isReady.value) return
      loadingEarlier.value = true
      try {
        const ceiling = floor
        const next = await pageFloor(ceiling)
        if (cancelled) return
        await subscribe(next, ceiling)
        if (cancelled) return
        floor = next
        complete.value = next === null
      } finally {
        loadingEarlier.value = false
      }
    }
  }, { immediate: true })

  return { items, isReady, complete, loadingEarlier, loadEarlier: () => loadEarlierNow() }
}

/** Where `item` belongs, by `compare`. Appends — the common case — are O(1). */
function insert<T>(sorted: T[], item: T, compare: (a: T, b: T) => number) {
  if (!sorted.length || compare(sorted[sorted.length - 1]!, item) <= 0) {
    sorted.push(item)
    return
  }
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (compare(sorted[mid]!, item) <= 0) low = mid + 1
    else high = mid
  }
  sorted.splice(low, 0, item)
}

/**
 * Where `item` sits, by identity.
 *
 * The search is by `compare`, but the match is by reference: two rows may share
 * a sort position — a `created_at` to the second, on messages a fast agent
 * wrote in the same second — and removing the wrong one would drop a row that
 * is still there and leave a stale one behind.
 */
function indexOf<T>(sorted: T[], item: T, compare: (a: T, b: T) => number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (compare(sorted[mid]!, item) < 0) low = mid + 1
    else high = mid
  }
  for (let at = low; at < sorted.length && compare(sorted[at]!, item) === 0; at += 1) {
    if (sorted[at] === item) return at
  }
  return -1
}
