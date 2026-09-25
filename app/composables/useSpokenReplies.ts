const STORAGE_KEY = 'domo:voice:speak-typed'

/**
 * Whether a message you *type* gets an answer out loud.
 *
 * It exists because the two providers disagree, and one of them disagrees
 * silently. Gemini answers a typed message the same way it answers a spoken
 * one. GPT-Live does not: text has no turn for it to attach speech to, so the
 * backend runs, the answer arrives, and the model says nothing — the measured
 * signature is a `context_injection_incomplete` if the session closes while it
 * is still taking the result in. Domo therefore has to *ask* for speech, and
 * asking is not always what you want: typing is often what you do precisely
 * because you are somewhere you cannot have a voice talking.
 *
 * On by default, because the app is a voice control room and silence is the
 * surprising answer. Persisted in `localStorage` and shared through
 * `useState`, like `useCondensedTranscript()`; Domo is SPA-only (`ssr: false`)
 * so the browser is always there on the first call.
 */
export function useSpokenReplies() {
  const speak = useState<boolean>('voice-speak-typed', () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) !== 'false'
    } catch {
      return true
    }
  })

  watch(speak, (value) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value))
    } catch {
      // A browser with storage disabled still gets the toggle, just not the memory.
    }
  })

  return speak
}
