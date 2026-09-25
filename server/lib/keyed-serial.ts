/**
 * One queue per key: `run(key, fn)` starts `fn` only once every earlier call
 * for the same key has settled, whether it resolved or threw. Calls for
 * different keys do not wait on each other.
 *
 * Not re-entrant — a `fn` that awaits `run` on its own key waits for itself
 * forever — so callers keep an unlocked inner function for the nested case.
 */
export function keyedSerial() {
  const tails = new Map<string, Promise<unknown>>()
  return function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    const result = previous.then(fn, fn)
    const tail = result.then(() => {}, () => {})
    tails.set(key, tail)
    // Drop the entry once nothing is queued behind this call, so the map holds
    // only keys with work in flight.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }
}
