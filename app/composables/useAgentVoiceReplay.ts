/**
 * A request, from a message in the transcript, to hear it read out again.
 * The voice bar owns the audio, so the message only asks: it opens the bar
 * if it is closed, and the bar reads the text with whatever speaker is set.
 */
export function useAgentVoiceReplay() {
  const request = useState<{ text: string, at: number } | null>('agent-voice-replay', () => null)
  const open = useAgentVoiceOpen()
  function replay(text: string) {
    open.value = true
    request.value = { text, at: Date.now() }
  }
  return { request, replay }
}
