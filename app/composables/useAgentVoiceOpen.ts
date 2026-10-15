const STORAGE_KEY = 'domo:agent-voice:open'

/** Whether the composer is in voice mode (`AgentComposer`). One answer for every page, kept across reloads. */
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

const LISTEN_KEY = 'domo:agent-voice:listen'

/**
 * Whether the agent is heard: its replies read aloud, the permission requests
 * and notes it raises, its chimes and tool sounds. Apart from the voice mode
 * (`useAgentVoiceOpen`), which is how a person *gives* input: someone typing
 * can still want to hear the agent. Voice mode turns it on; the speaker in
 * the composer's footer turns it off and on in either mode. One answer for
 * every page, kept across reloads.
 */
export function useAgentVoiceListen() {
  const listen = useState<boolean>('agent-voice-listen', () => {
    try {
      const stored = window.localStorage.getItem(LISTEN_KEY)
      if (stored !== null) return stored === 'true'
      // Before listening had its own switch, an open voice bar read replies unless muted.
      return window.localStorage.getItem(STORAGE_KEY) === 'true'
        && window.localStorage.getItem('domo:agent-voice:speak') !== 'false'
    } catch {
      return false
    }
  })
  watch(listen, (value) => {
    try {
      window.localStorage.setItem(LISTEN_KEY, String(value))
    } catch {
      /* private mode */
    }
  })
  return listen
}
