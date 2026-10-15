/**
 * The transcript row whose time and buttons a tap has shown.
 *
 * A pointer shows them by hovering. A finger has no hover, so a tap on a row
 * shows them instead, and they stay until another row is tapped. One row at a
 * time, across the page: rows nested inside a tool group are rows too. A mouse
 * click shows nothing extra, since hover already has.
 */
export function useRevealedRow() {
  const revealed = useState<string | null>('transcript-revealed-row', () => null)

  /** Taken by the innermost row a tap lands in; the row around it lets it be. */
  const claimed = new WeakSet<Event>()

  function reveal(id: string, event?: Event) {
    if (event) {
      if (claimed.has(event) || (event as PointerEvent).pointerType === 'mouse') return
      claimed.add(event)
    }
    revealed.value = id
  }

  return { revealed, reveal }
}
