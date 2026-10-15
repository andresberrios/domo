/**
 * A request, from a message in the transcript, to hear it read out again.
 * The composer owns the audio, so the message only asks: it turns listening
 * on if it is off, and the composer reads the text with whatever speaker is set.
 */
export function useAgentVoiceReplay() {
  const request = useState<{ text: string, at: number } | null>('agent-voice-replay', () => null)
  const listen = useAgentVoiceListen()
  function replay(text: string) {
    listen.value = true
    request.value = { text, at: Date.now() }
  }
  return { request, replay }
}
