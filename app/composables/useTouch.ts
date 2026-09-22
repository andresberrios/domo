/**
 * Is this a touch screen?
 *
 * `(pointer: coarse)` rather than a user-agent sniff, and evaluated on the
 * client only — Domo is SPA-only, so there is no server render to disagree
 * with, but `matchMedia` still has to survive a runtime that does not have it
 * (happy-dom without a stub).
 */
export function useIsTouch() {
  const isTouch = ref(false)

  onMounted(() => {
    const query = window.matchMedia?.('(pointer: coarse)')
    if (!query) return
    isTouch.value = query.matches
    const update = (event: MediaQueryListEvent) => { isTouch.value = event.matches }
    query.addEventListener?.('change', update)
    onUnmounted(() => query.removeEventListener?.('change', update))
  })

  return isTouch
}
