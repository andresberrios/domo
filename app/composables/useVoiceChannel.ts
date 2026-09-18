import type { VoiceServerMessage } from '~~/shared/types'

const INPUT_SAMPLE_RATE = 16000
const OUTPUT_SAMPLE_RATE = 24000

/**
 * AudioWorklet that hands raw mono frames to the main thread and reports a
 * level so the UI can show the mic actually hearing something.
 */
const RECORDER_WORKLET = `
class DomoRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.offset = 0
    this.muted = false
    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') this.muted = !!event.data.value
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input) return true

    let peak = 0
    for (let i = 0; i < input.length; i++) {
      const sample = this.muted ? 0 : input[i]
      peak = Math.max(peak, Math.abs(sample))
      this.buffer[this.offset++] = sample
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ type: 'chunk', samples: this.buffer.slice(0), level: peak }, [])
        this.offset = 0
        peak = 0
      }
    }
    return true
  }
}
registerProcessor('domo-recorder', DomoRecorder)
`

function floatToPcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
  const floats = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i]! / 0x8000
  return floats
}

export type VoiceConnectionState = 'offline' | 'connecting' | 'live' | 'error'

export interface VoiceToolActivity {
  id: string
  name: string
  args: any
  result?: any
  running: boolean
  at: number
}

/**
 * Owns the browser half of the voice loop: mic capture up, speech playback
 * down, and the live transcript in between. The model session itself lives on
 * the server, so refreshing the page never drops the conversation.
 */
export function useVoiceChannel(
  sessionId: MaybeRefOrGetter<string>,
  options: { onSessionChanged?: (sessionId: string) => void } = {}
) {
  const state = ref<VoiceConnectionState>('offline')
  const statusDetail = ref<string>('')
  const micEnabled = ref(false)
  const muted = ref(false)
  const speaking = ref(false)
  const inputLevel = ref(0)
  const outputLevel = ref(0)
  const errorMessage = ref<string | null>(null)

  const liveUserText = ref('')
  const liveAssistantText = ref('')
  const toolActivity = ref<VoiceToolActivity[]>([])

  let socket: WebSocket | null = null
  let captureContext: AudioContext | null = null
  let playbackContext: AudioContext | null = null
  let workletNode: AudioWorkletNode | null = null
  let micStream: MediaStream | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let playbackCursor = 0
  let scheduled: AudioBufferSourceNode[] = []
  let outputDecay: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionalClose = false
  /** Set when the server moved us to a fresh conversation mid-sign-off. */
  let followingHandOver = false

  function send(message: unknown) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  /* ----------------------------- playback ----------------------------- */

  async function ensurePlayback(): Promise<AudioContext> {
    if (!playbackContext || playbackContext.state === 'closed') {
      playbackContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
      playbackCursor = 0
    }
    if (playbackContext.state === 'suspended') await playbackContext.resume()
    return playbackContext
  }

  async function playChunk(base64: string) {
    const context = await ensurePlayback()
    const floats = base64ToFloat32(base64)
    if (!floats.length) return

    const buffer = context.createBuffer(1, floats.length, OUTPUT_SAMPLE_RATE)
    buffer.getChannelData(0).set(floats)

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)

    const startAt = Math.max(context.currentTime + 0.02, playbackCursor)
    source.start(startAt)
    playbackCursor = startAt + buffer.duration
    scheduled.push(source)
    speaking.value = true

    let peak = 0
    for (let i = 0; i < floats.length; i += 32) peak = Math.max(peak, Math.abs(floats[i]!))
    outputLevel.value = peak

    source.onended = () => {
      scheduled = scheduled.filter(node => node !== source)
      if (!scheduled.length) {
        speaking.value = false
        outputLevel.value = 0
      }
    }
  }

  function stopPlayback() {
    for (const source of scheduled) {
      try {
        source.stop()
      } catch {
        /* already finished */
      }
    }
    scheduled = []
    playbackCursor = playbackContext?.currentTime ?? 0
    speaking.value = false
    outputLevel.value = 0
  }

  /* ------------------------------ capture ----------------------------- */

  async function startMic() {
    if (micEnabled.value) return
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
    } catch (error) {
      errorMessage.value = `Microphone access denied: ${error instanceof Error ? error.message : error}`
      state.value = 'error'
      return
    }

    captureContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
    const blob = new Blob([RECORDER_WORKLET], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    await captureContext.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)

    sourceNode = captureContext.createMediaStreamSource(micStream)
    workletNode = new AudioWorkletNode(captureContext, 'domo-recorder')
    workletNode.port.onmessage = (event) => {
      const { type, samples, level } = event.data ?? {}
      if (type !== 'chunk') return
      inputLevel.value = level ?? 0
      if (muted.value) return
      send({ type: 'audio', data: floatToPcm16Base64(samples) })
    }
    sourceNode.connect(workletNode)
    // Keep the graph alive without echoing the mic back to the speakers.
    const sink = captureContext.createGain()
    sink.gain.value = 0
    workletNode.connect(sink).connect(captureContext.destination)

    micEnabled.value = true
  }

  function stopMic() {
    workletNode?.port.close()
    workletNode?.disconnect()
    sourceNode?.disconnect()
    micStream?.getTracks().forEach(track => track.stop())
    void captureContext?.close().catch(() => {})
    workletNode = null
    sourceNode = null
    micStream = null
    captureContext = null
    micEnabled.value = false
    inputLevel.value = 0
    if (socket?.readyState === WebSocket.OPEN) send({ type: 'audio-stream-end' })
  }

  function setMuted(value: boolean) {
    muted.value = value
    workletNode?.port.postMessage({ type: 'mute', value })
  }

  /* ---------------------------- connection ---------------------------- */

  function handleMessage(message: VoiceServerMessage) {
    switch (message.type) {
      case 'status':
        state.value = message.status === 'live' ? 'live' : message.status === 'error' ? 'error' : 'connecting'
        statusDetail.value = message.detail ?? ''
        break
      case 'audio':
        void playChunk(message.data)
        break
      case 'interrupted':
        stopPlayback()
        liveAssistantText.value = ''
        break
      case 'turn-complete':
        liveUserText.value = ''
        liveAssistantText.value = ''
        break
      case 'transcript':
        if (message.role === 'user') liveUserText.value = message.final ? '' : message.text
        else liveAssistantText.value = message.final ? '' : message.text
        break
      case 'tool':
        if (message.phase === 'start') {
          toolActivity.value = [
            ...toolActivity.value,
            { id: `${message.name}-${Date.now()}`, name: message.name, args: message.args, running: true, at: Date.now() }
          ].slice(-8)
        } else {
          const index = [...toolActivity.value].reverse().find(item => item.name === message.name && item.running)
          if (index) {
            index.running = false
            index.result = message.result
            toolActivity.value = [...toolActivity.value]
          }
        }
        break
      case 'error':
        errorMessage.value = message.message
        // A session that cannot connect would otherwise swallow the mic stream
        // silently; stop capturing so the user sees why and can retry.
        if (micEnabled.value && state.value !== 'live') stopMic()
        break
      case 'message':
        // Persisted rows arrive through Electric; nothing to do here.
        break
      case 'session-changed':
        followingHandOver = true
        options.onSessionChanged?.(message.sessionId)
        break
    }
  }

  function connect() {
    const id = toValue(sessionId)
    if (!id || socket) return

    intentionalClose = false
    state.value = 'connecting'
    errorMessage.value = null

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/voice/ws?sessionId=${id}`)
    socket = ws

    // Handlers of a socket that `switchSession` already replaced must not touch
    // the state of the one that took its place.
    ws.onopen = () => {
      if (socket === ws) send({ type: 'start' })
    }
    ws.onmessage = (event) => {
      if (socket !== ws) return
      try {
        handleMessage(JSON.parse(event.data) as VoiceServerMessage)
      } catch {
        /* ignore malformed frame */
      }
    }
    ws.onerror = () => {
      if (socket !== ws) return
      errorMessage.value = 'Voice connection failed'
      state.value = 'error'
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      state.value = 'offline'
      if (!intentionalClose) {
        reconnectTimer = setTimeout(connect, 1500)
      }
    }
  }

  function disconnect({ stopSession = false } = {}) {
    intentionalClose = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    if (stopSession) send({ type: 'stop' })
    stopMic()
    stopPlayback()
    socket?.close()
    socket = null
    state.value = 'offline'
  }

  /**
   * Follow the session id to another conversation without dropping the mic, so
   * someone mid-conversation can keep talking. Speech still playing is only kept
   * for a server handover, where it is the old conversation's sign-off.
   */
  function switchSession() {
    const keepPlayback = followingHandOver
    followingHandOver = false
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    if (!keepPlayback) stopPlayback()
    liveUserText.value = ''
    liveAssistantText.value = ''
    toolActivity.value = []
    const previous = socket
    socket = null
    previous?.close()
    connect()
  }

  async function startTalking() {
    connect()
    await ensurePlayback()
    await startMic()
  }

  function stopTalking() {
    stopMic()
  }

  function sendText(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    connect()
    send({ type: 'text', text: trimmed })
  }

  onMounted(() => {
    outputDecay = setInterval(() => {
      if (!speaking.value && outputLevel.value > 0) outputLevel.value = Math.max(0, outputLevel.value - 0.1)
    }, 120)
  })

  onScopeDispose(() => {
    if (outputDecay) clearInterval(outputDecay)
    disconnect()
  })

  return {
    state,
    statusDetail,
    micEnabled,
    muted,
    speaking,
    inputLevel,
    outputLevel,
    errorMessage,
    liveUserText,
    liveAssistantText,
    toolActivity,
    connect,
    disconnect,
    switchSession,
    startTalking,
    stopTalking,
    setMuted,
    sendText,
    stopPlayback
  }
}
