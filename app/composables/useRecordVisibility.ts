/**
 * Switches the person sets once and every page reads: the two "show me the
 * things that are put away" switches, and whether a transcript shows every
 * row's time or only the one under the pointer.
 *
 * The first two are separate questions and must stay separate. **Archived sessions** is
 * about what the user chose to put out of the way; **retired environments** is
 * about places whose container no longer exists. Every session in a retired
 * environment is unstartable, but that archives none of them — a session can be
 * perfectly visible and simply not runnable — so one switch could never stand
 * in for the other.
 *
 * Shared through `useState` and persisted in `localStorage`: a switch lives in
 * one place but every list in the app reads the same answer, so flipping it
 * once is enough.
 */
function persistedFlag(key: string, stateKey: string) {
  return () => {
    const flag = useState<boolean>(stateKey, () => {
      try {
        return window.localStorage.getItem(key) === 'true'
      } catch {
        return false
      }
    })

    watch(flag, (value) => {
      try {
        window.localStorage.setItem(key, String(value))
      } catch {
        // A browser with storage disabled still gets the switch, just not the memory.
      }
    })

    return flag
  }
}

export const useShowArchivedSessions = persistedFlag('domo:show:archived-sessions', 'show-archived-sessions')
export const useShowRetiredEnvironments = persistedFlag('domo:show:retired-environments', 'show-retired-environments')
export const useShowArchivedSchedules = persistedFlag('domo:show:archived-schedules', 'show-archived-schedules')
export const useAlwaysShowTimes = persistedFlag('domo:transcript:times', 'transcript-times')
