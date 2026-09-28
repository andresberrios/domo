const STORAGE_KEY = 'domo:agent-voice:open'

/** Whether the voice bar on an agent's page is open. One answer for every page, kept across reloads. */
export function useAgentVoiceOpen() {
  const open = useState<boolean>('agent-voice-open', () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })
  watch(open, (value) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value))
    } catch {
      /* private mode */
    }
  })
  return open
}
