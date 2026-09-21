const STORAGE_KEY = 'domo:transcript:condensed'

/**
 * Whether agent transcripts collapse runs of tool activity. Shared across the
 * app through `useState` and persisted in `localStorage` — Domo is SPA-only
 * (`ssr: false`), so the browser is always there to read on the first call.
 *
 * Condensed is the default: a working agent produces hundreds of tool cards,
 * and the text the user came for is what should be on screen.
 */
export function useCondensedTranscript() {
  const condensed = useState<boolean>('transcript-condensed', () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) !== 'false'
    } catch {
      return true
    }
  })

  watch(condensed, (value) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value))
    } catch {
      // A browser with storage disabled still gets the toggle, just not the memory.
    }
  })

  return condensed
}
