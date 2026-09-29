import type { Collection } from '@tanstack/db'

/**
 * A long, append-mostly log read straight off its collection.
 *
 * `useLiveQuery` is the right tool for a list you show whole: it keeps a
 * `reactive([])` and rebuilds it from the collection on every change. On a
 * transcript that is the wrong shape twice over — the array is rebuilt from
 * thousands of rows to learn that one of them grew by a word, and the rebuild
 * fires the dependents twice (once to empty the array, once to refill it).
 * Both costs scale with the log, not with what changed, so the page got slower
 * the longer an agent worked.
 *
 * This reads the collection's change stream instead. Rows are mapped once, on
 * arrival, into a plain array held behind a `shallowRef`: a delta costs one
 * mapping and one splice whatever the log's length, and Vue sees one new array
 * identity per batch rather than a reactive tree to walk.
 *
 * The array is ordered by `compare` and kept that way as rows arrive, so
 * readers never sort. An unchanged row keeps its mapped object, which is what
 * lets everything downstream — the transcript builder, and Vue's own prop
 * diffing — tell what actually moved.
 */
export function useSyncedLog<TRow extends object, TItem>(
  collection: MaybeRefOrGetter<Collection<any, any, any> | null | undefined>,
  map: (row: TRow) => TItem,
  compare: (a: TItem, b: TItem) => number
) {
  const items = shallowRef<TItem[]>([])
  const isReady = ref(false)

  watchEffect((onCleanup) => {
    const source = toValue(collection)
    items.value = []
    isReady.value = false
    if (!source) return

    /* Plain structures, deliberately outside Vue: only `items` is reactive, and
     * it is replaced wholesale so nothing here needs to be observed. */
    const byKey = new Map<string, TItem>()
    const sorted: TItem[] = []

    const remove = (item: TItem) => {
      const at = indexOf(sorted, item, compare)
      if (at >= 0) sorted.splice(at, 1)
    }

    const subscription = source.subscribeChanges((changes: any[]) => {
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
      isReady.value = true
    }, { includeInitialState: true })

    onCleanup(() => subscription.unsubscribe())
  })

  return { items, isReady }
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
