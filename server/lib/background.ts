/**
 * Work a call starts and does not wait for: a note to an agent once its build
 * ends, a generated title, a subscription's notification. The app never waits
 * for it. It is tracked so that a test can (`settleBackground`) before it
 * empties the tables the work is still writing to: a `truncate` racing an
 * insert deadlocks.
 */
const pending = new Set<Promise<unknown>>()

/** Track `work`, which must already handle its own failure. */
export function inBackground(work: Promise<unknown>): void {
  const tracked: Promise<unknown> = work.catch(() => {}).finally(() => pending.delete(tracked))
  pending.add(tracked)
}

/**
 * Wait until no background work is left, including work that the work started.
 * For tests; fails rather than hangs on work that never ends.
 */
export async function settleBackground(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (pending.size) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`${pending.size} background task(s) still running after ${timeoutMs} ms`)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => { timer = setTimeout(resolve, left) })
    ])
    clearTimeout(timer)
  }
}
