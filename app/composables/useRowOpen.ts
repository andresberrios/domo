/**
 * Whether a transcript row, or a card inside one, is expanded — kept by id
 * rather than in the component.
 *
 * A virtual transcript unmounts a row once it scrolls out of the window and
 * mounts it again on the way back. Held in the component, an expanded tool
 * group came back collapsed: the reader lost their place in it, and the row
 * came back a different height from the one the list had laid out, which
 * moved everything under it. It also lets the transcript measure a row before
 * it is on screen and get the height it will really have.
 *
 * Module-level and plain, like the rest of the transcript's memoisation: it
 * lives as long as the tab does, and an id is only ever one thing.
 */
const expanded = reactive(new Set<string>())

export function useRowOpen(id: MaybeRefOrGetter<string>) {
  return computed({
    get: () => expanded.has(toValue(id)),
    set: (open: boolean) => {
      if (open) expanded.add(toValue(id))
      else expanded.delete(toValue(id))
    }
  })
}


/** Collapse everything: for tests, which share the module between cases. */
export function forgetExpandedRows() {
  expanded.clear()
}
