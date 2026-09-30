import type { AgentVoiceClientMessage, AgentVoiceServerMessage } from '~~/shared/types'
import type { AgentVoiceMode } from '~~/shared/agent-voice'
import { RECORDER_WORKLET, base64ToFloat32, floatToPcm16Base64 } from '~/utils/pcm'

const INPUT_SAMPLE_RATE = 16000
const OUTPUT_SAMPLE_RATE = 24000

/** Hands-free: a pause this long ends a segment and asks the server whether the turn is over. */
const SEGMENT_SILENCE_MS = 500
/** Hands-free: the quietest thing that is ever speech. RMS of a 128 ms frame, 0..1. */
const SPEECH_RMS_FLOOR = 0.02
/** Hands-free: speech has to stand this far above the room. */
const SPEECH_ABOVE_NOISE = 2.5
/** Hands-free: a segment that goes on this long is sent as it is. Noise never pauses. */
const MAX_SEGMENT_MS = 15_000
/** Speech this long while the agent is talking is an interruption, not a cough. */
const BARGE_IN_MS = 400
/** After the speaker goes quiet, the room still rings with it for a moment. */
const ECHO_TAIL_MS = 500
/** How many frames before speech was noticed are sent with it, so the first syllable is not clipped. */
const PRE_ROLL_FRAMES = 2
/** Device dictation: how long a segment's end waits for the recogniser to finalise its last words. */
const DICTATION_SETTLE_MAX_MS = 2000
/** And how long the recogniser must have been quiet for its words to count as final. */
const DICTATION_QUIET_MS = 350
/** Words the recogniser finalises this long after a segment ended still belong to it. */
const DICTATION_GRACE_MS = 2500
/** Web Speech phrase biasing takes a short list; the most likely terms come first. */
const DICTATION_PHRASES = 100
const MODE_KEY = 'domo:agent-voice:mode'
const SPEAK_KEY = 'domo:agent-voice:speak'
const DEVICE_KEY = 'domo:agent-voice:input-device'

export type AgentVoiceState = 'offline' | 'connecting' | 'live' | 'error'

export interface AudioInputDevice {
  deviceId: string
  label: string
}

/**
 * The browser half of talking to a coding agent: the microphone up, the
 * agent's voice down, and the decision of when the developer has finished
 * talking. Everything that transcribes, delivers and synthesises is on the
 * server (`server/lib/agent-voice/runtime.ts`); this decides only where a
 * recording starts and stops.
 *
 * Two ways to end a turn. **Click**: a button opens the recording and the
 * same button closes it, and what was recorded is the turn. **Hands-free**:
 * the microphone stays open, a pause closes a *segment*, and the server holds
 * the segments until a sign-off ("over") or a spoken command. Hands-free is
 * also where barge-in lives: speech while the agent is talking stops the
 * playback and becomes the next segment.
 *
 * **Every audio context is resumed inside a tap.** iOS creates them
 * suspended when they are made outside a gesture and refuses to resume them
 * from anywhere else, so a microphone opened on mount captured nothing on a
 * phone, and a turn that recorded nothing vanished without a word. The
 * gesture handlers below resume both contexts, and `captureSuspended` says
 * when that has not happened yet.
 */
/** How often the "still working" blip repeats while a spoken turn is being worked on. */
const WORKING_TICK_MS = 2500
/** Tool sounds closer together than this are one sound. */
const TOOL_SOUND_GAP_MS = 1200

export function useAgentVoice(
  agentSessionId: MaybeRefOrGetter<string>,
  options: {
    /** Whether the agent is working. From the session row; the socket does not say. */
    busy?: MaybeRefOrGetter<boolean>
  } = {}
) {
  const state = ref<AgentVoiceState>('offline')
  const mode = ref<AgentVoiceMode>(readStored(MODE_KEY) === 'handsfree' ? 'handsfree' : 'click')
  const speakEnabled = ref(readStored(SPEAK_KEY) !== 'false')
  const micEnabled = ref(false)
  /** The browser has the capture graph paused; a tap on the microphone fixes it. */
  const captureSuspended = ref(false)
  /** Click mode: a recording is open. Hands-free: speech is being heard. */
  const recording = ref(false)
  const transcribing = ref(false)
  /** The server is making speech. */
  const synthesizing = ref(false)
  /** Speech is coming out of the speakers. */
  const speaking = ref(false)
  const inputLevel = ref(0)
  const outputLevel = ref(0)
  /** Hands-free: what has been heard and is being held for the sign-off. */
  const utterance = ref('')
  const lastSent = ref('')
  const spokenText = ref<string | null>(null)
  const lastCommand = ref<string | null>(null)
  /** A line worth showing for a moment: what was sent, or that nothing was heard. */
  const notice = ref<string | null>(null)
  /** Hands-free: the server is holding a turn it thinks is not finished. */
  const holding = ref(false)
  /** A spoken turn was sent and nothing has been said back yet. */
  const awaitingReply = ref(false)
  const errorMessage = ref<string | null>(null)
  /** The device's own recogniser is the transcriber (Settings), and this browser has one. */
  const dictation = ref(false)
  const inputDevices = ref<AudioInputDevice[]>([])
  const inputDeviceId = ref<string>(readStored(DEVICE_KEY) ?? '')

  let socket: WebSocket | null = null
  let captureContext: AudioContext | null = null
  let playbackContext: AudioContext | null = null
  let workletNode: AudioWorkletNode | null = null
  let micStream: MediaStream | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let playbackCursor = 0
  let scheduled: AudioBufferSourceNode[] = []
  /**
   * Speech leaves the graph through a media element rather than the
   * context's own output. Chrome's echo canceller only subtracts what it
   * knows is playing, and on Android it knows about media elements and
   * WebRTC, not about `AudioContext.destination`. The element is the whole
   * difference between the microphone hearing the agent and not.
   */
  let playbackOut: MediaStreamAudioDestinationNode | null = null
  let playbackElement: HTMLAudioElement | null = null
  let loopbackConnections: RTCPeerConnection[] = []
  let lastPlaybackEndedAt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionalClose = false
  let commandTimer: ReturnType<typeof setTimeout> | null = null
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let workingTimer: ReturnType<typeof setInterval> | null = null
  let lastToolSoundAt = 0

  // device dictation
  let dictationWanted = false
  let dictationLanguage = ''
  let dictationPhrases: string[] = []
  let recognizer: any = null
  let interimPending = false
  /** Words the recogniser gave for the segment being recorded: settled, and still interim. */
  let dictatedFinal = ''
  let dictatedInterim = ''
  let lastResultAt = 0
  let lastSegmentEndAt = 0
  /** The language in Settings, for the device's recogniser and its voices. */
  let deviceLanguage = 'en'

  // device speech
  let deviceUtterances = 0
  let deviceSpeechUnlocked = false

  // hands-free segmentation
  let silentMs = 0
  let segmentMs = 0
  let bargeMs = 0
  let preRoll: string[] = []
  let candidates: string[] = []
  /** The room, as a slowly tracked RMS of frames that were not speech. */
  let noiseFloor = 0

  function send(message: AgentVoiceClientMessage) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  function showNotice(text: string, ms = 4000) {
    notice.value = text
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { notice.value = null }, ms)
  }

  /* ----------------------------- playback ----------------------------- */

  async function ensurePlayback(): Promise<AudioContext> {
    if (!playbackContext || playbackContext.state === 'closed') {
      playbackContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
      playbackCursor = 0
    }
    if (playbackContext.state === 'suspended') await playbackContext.resume().catch(() => {})
    if (!playbackOut) {
      playbackOut = playbackContext.createMediaStreamDestination()
      playbackElement = new Audio()
      playbackElement.autoplay = true
      playbackElement.srcObject = playbackOut.stream
      // Then, once it is up, the same speech by way of WebRTC, which is the
      // one path Chrome's echo canceller always subtracts.
      const element = playbackElement
      void loopback(playbackOut.stream).then((remote) => {
        if (!remote || playbackElement !== element) return
        element.srcObject = remote
        void element.play().catch(() => {})
        logDevice('speech plays through a WebRTC loopback, for the echo canceller')
      })
    }
    if (playbackElement?.paused) await playbackElement.play().catch(() => {})
    return playbackContext
  }

  /**
   * The agent's voice sent to this page itself over WebRTC and played from
   * the receiving end. Chrome's echo canceller removes from the microphone
   * only what it knows is playing, and what it reliably knows about is audio
   * received over a peer connection; a media element playing a stream made
   * in the page is not always enough, and on a phone's loudspeaker the agent
   * then heard itself and stopped. Opus at a high bitrate, so the voice does
   * not suffer for it. Null when the browser will not connect to itself, and
   * the element keeps playing the stream directly.
   */
  async function loopback(stream: MediaStream): Promise<MediaStream | null> {
    try {
      const sender = new RTCPeerConnection()
      const receiver = new RTCPeerConnection()
      sender.onicecandidate = (event) => { if (event.candidate) void receiver.addIceCandidate(event.candidate).catch(() => {}) }
      receiver.onicecandidate = (event) => { if (event.candidate) void sender.addIceCandidate(event.candidate).catch(() => {}) }
      const remote = new Promise<MediaStream>((resolve) => {
        receiver.ontrack = event => resolve(event.streams[0] ?? new MediaStream([event.track]))
      })
      for (const track of stream.getAudioTracks()) sender.addTrack(track, stream)
      const offer = await sender.createOffer()
      await sender.setLocalDescription(offer)
      await receiver.setRemoteDescription(offer)
      const answer = await receiver.createAnswer()
      answer.sdp = answer.sdp?.replace(/(a=fmtp:\d+ [^\r\n]*useinbandfec=1)/, '$1;maxaveragebitrate=128000;stereo=0')
      await receiver.setLocalDescription(answer)
      await sender.setRemoteDescription(answer)
      loopbackConnections = [sender, receiver]
      return await Promise.race([remote, new Promise<null>(resolve => setTimeout(() => resolve(null), 4000))])
    } catch (error) {
      logDevice(`no WebRTC loopback: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  /** Where speech and sounds go: the media element, or the context if it could not be made. */
  function output(context: AudioContext): AudioNode {
    return playbackOut ?? context.destination
  }

  async function playChunk(base64: string, sampleRate: number) {
    const context = await ensurePlayback()
    const floats = base64ToFloat32(base64)
    if (!floats.length) return

    const buffer = context.createBuffer(1, floats.length, sampleRate || OUTPUT_SAMPLE_RATE)
    buffer.getChannelData(0).set(floats)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(output(context))

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
        lastPlaybackEndedAt = Date.now()
      }
    }
  }

  /**
   * A sound that means something, for when the screen is in a pocket: a rising
   * pair for "your turn went through", a low one for "nothing was heard", a
   * tick for "recording". Made here, in the playback context a tap already
   * unlocked, so it costs no request and no model.
   */
  function chime(kind: 'sent' | 'nothing' | 'record' | 'working') {
    if (!playbackContext || playbackContext.state !== 'running') return
    const context = playbackContext
    const tones = kind === 'sent'
      ? [[660, 0, 0.09], [990, 0.1, 0.12]]
      : kind === 'nothing'
        ? [[220, 0, 0.22]]
        : kind === 'working'
          ? [[520, 0, 0.06]]
          : [[880, 0, 0.05]]
    for (const [frequency, at, length] of tones as Array<[number, number, number]>) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      const start = context.currentTime + at
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.25, start + 0.01)
      gain.gain.linearRampToValueAtTime(0, start + length)
      oscillator.connect(gain).connect(output(context))
      oscillator.start(start)
      oscillator.stop(start + length + 0.02)
    }
  }

  /**
   * Keys being pressed: three short bursts of filtered noise, quiet, a little
   * apart. Different from every tone above, so a tool call is recognisable
   * without being a note, and dull enough to hear ten times in a row.
   */
  function toolSound() {
    if (!playbackContext || playbackContext.state !== 'running') return
    const now = Date.now()
    if (now - lastToolSoundAt < TOOL_SOUND_GAP_MS) return
    lastToolSoundAt = now
    const context = playbackContext
    const rate = context.sampleRate
    for (const [at, length] of [[0, 0.03], [0.07, 0.025], [0.15, 0.035]] as Array<[number, number]>) {
      const frames = Math.floor(rate * length)
      const buffer = context.createBuffer(1, frames, rate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2
      const source = context.createBufferSource()
      source.buffer = buffer
      const filter = context.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 2400
      filter.Q.value = 1.2
      const gain = context.createGain()
      gain.gain.value = 0.18
      source.connect(filter).connect(gain).connect(output(context))
      source.start(context.currentTime + at)
    }
  }

  /**
   * While a spoken turn is being worked on and nothing is being said, a soft
   * blip every couple of seconds, so a phone in a pocket knows the agent is
   * still on it. Stops at the first word of the answer, or when the agent
   * goes idle.
   */
  function syncWorking() {
    const working = awaitingReply.value && toValue(options.busy) !== false && !speaking.value && !synthesizing.value
    if (working && !workingTimer) {
      workingTimer = setInterval(() => chime('working'), WORKING_TICK_MS)
    } else if (!working && workingTimer) {
      clearInterval(workingTimer)
      workingTimer = null
    }
  }
  watch([awaitingReply, speaking, synthesizing, () => toValue(options.busy)], syncWorking)

  /**
   * "This device" as the speaker: the browser says each piece itself, in the
   * voice chosen on this device (`deviceVoice`). It starts at once and costs
   * nothing, but it does not go through the media element, so an echo
   * canceller may not know it is playing; the barge-in guard still applies.
   */
  function sayOnDevice(text: string) {
    if (!('speechSynthesis' in window)) {
      errorMessage.value = 'This browser cannot speak. Pick another speaker in Settings.'
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = deviceVoice(deviceLanguage)
    if (voice) {
      utterance.voice = voice
      utterance.lang = voice.lang
    }
    const done = () => {
      deviceUtterances = Math.max(0, deviceUtterances - 1)
      if (!deviceUtterances) {
        speaking.value = false
        lastPlaybackEndedAt = Date.now()
      }
    }
    utterance.onstart = () => { speaking.value = true }
    utterance.onend = done
    utterance.onerror = (event: any) => {
      done()
      if (event?.error === 'interrupted' || event?.error === 'canceled') return
      logDevice(`speech error ${event?.error} (voice ${voice?.name ?? 'default'})`)
      errorMessage.value = event?.error === 'not-allowed'
        ? 'The browser will not speak until the microphone has been tapped.'
        : `The device could not speak: ${event?.error}`
    }
    // Chrome can leave its queue paused after a tab was in the background,
    // and then says nothing at all until told to go on.
    if (window.speechSynthesis.paused) window.speechSynthesis.resume()
    if (!deviceUtterances) logDevice(`speaking with ${voice ? `${voice.name} (${voice.lang})` : 'the default voice'}`)
    deviceUtterances += 1
    window.speechSynthesis.speak(utterance)
  }

  /** iOS only lets a page speak once a tap has made it speak something. */
  function unlockDeviceSpeech() {
    if (deviceSpeechUnlocked || !('speechSynthesis' in window)) return
    deviceSpeechUnlocked = true
    // A space, not nothing: some browsers skip an empty utterance, and it does
    // not count as the page having spoken.
    const silent = new SpeechSynthesisUtterance(' ')
    silent.volume = 0
    window.speechSynthesis.speak(silent)
  }

  function stopPlayback() {
    if (deviceUtterances && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      deviceUtterances = 0
    }
    for (const source of scheduled) {
      try {
        source.stop()
      } catch {
        /* already finished */
      }
    }
    scheduled = []
    playbackCursor = playbackContext?.currentTime ?? 0
    if (speaking.value) lastPlaybackEndedAt = Date.now()
    speaking.value = false
    outputLevel.value = 0
  }

  /* ------------------------------ devices ----------------------------- */

  /**
   * Labels are only given out once the microphone has been allowed, so this
   * is worth calling again after the first successful `startMic`.
   */
  async function refreshDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      inputDevices.value = devices
        .filter(device => device.kind === 'audioinput')
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }))
      // A remembered device that is gone falls back to the browser's choice.
      if (inputDeviceId.value && !inputDevices.value.some(device => device.deviceId === inputDeviceId.value)) {
        inputDeviceId.value = ''
      }
    } catch {
      inputDevices.value = []
    }
  }

  /** Switch microphones. Playback is untouched, so earbuds can keep the sound. */
  async function setInputDevice(deviceId: string) {
    inputDeviceId.value = deviceId
    writeStored(DEVICE_KEY, deviceId)
    if (!micEnabled.value) return
    const wasRecording = recording.value && mode.value === 'click'
    stopMic({ endTurn: false })
    await startMic()
    if (wasRecording) recording.value = true
  }

  /* ------------------------------ capture ----------------------------- */

  async function startMic() {
    if (micEnabled.value) return
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...inputDeviceId.value ? { deviceId: { exact: inputDeviceId.value } } : {},
          channelCount: 1,
          // "all": cancel everything the device plays, the agent's voice and
          // the device's own speech included, not only WebRTC audio (Chrome
          // 141+). Older browsers read it as true.
          echoCancellation: 'all' as unknown as boolean,
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
    const context = captureContext
    const syncSuspended = () => { captureSuspended.value = context.state !== 'running' }
    context.addEventListener('statechange', syncSuspended)
    await context.resume().catch(() => {})
    syncSuspended()

    const blob = new Blob([RECORDER_WORKLET], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    await context.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)

    sourceNode = context.createMediaStreamSource(micStream)
    workletNode = new AudioWorkletNode(context, 'domo-recorder')
    workletNode.port.onmessage = (event) => {
      const { type, samples } = event.data ?? {}
      if (type !== 'chunk') return
      onFrame(samples as Float32Array)
    }
    sourceNode.connect(workletNode)
    const sink = context.createGain()
    sink.gain.value = 0
    workletNode.connect(sink).connect(context.destination)
    micEnabled.value = true
    noiseFloor = 0
    const granted = micStream.getAudioTracks()[0]?.getSettings() as any
    logDevice(`microphone: echo cancellation ${JSON.stringify(granted?.echoCancellation)}, noise suppression ${granted?.noiseSuppression}`)
    void startDictation()
    void refreshDevices()
  }

  function stopMic({ endTurn = true } = {}) {
    // The recogniser is stopped once the segment's words are in, not before.
    if (endTurn && recording.value && mode.value === 'click') void endSegment(true).then(() => stopDictation())
    else stopDictation()
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
    captureSuspended.value = false
    recording.value = false
    inputLevel.value = 0
    silentMs = 0
    segmentMs = 0
    bargeMs = 0
    preRoll = []
    candidates = []
  }

  /** What a tap is allowed to do that nothing else is: get the audio graphs running. */
  async function resumeAudio() {
    unlockDeviceSpeech()
    await ensurePlayback()
    const context = captureContext
    if (context && context.state !== 'running') {
      await context.resume().catch(() => {})
      captureSuspended.value = (context.state as AudioContextState) !== 'running'
    }
  }

  function rms(samples: Float32Array): number {
    let sum = 0
    for (let i = 0; i < samples.length; i += 4) sum += samples[i]! * samples[i]!
    return Math.sqrt(sum / Math.ceil(samples.length / 4))
  }

  /** One 128 ms frame from the microphone. */
  function onFrame(samples: Float32Array) {
    const level = rms(samples)
    inputLevel.value = Math.min(1, level * 6)
    const frameMs = (samples.length / INPUT_SAMPLE_RATE) * 1000

    if (mode.value === 'click') {
      if (recording.value) send({ type: 'audio', data: floatToPcm16Base64(samples) })
      return
    }

    // While the agent is talking, and for a moment after, the room may still
    // carry some of it past the echo canceller; that is what the barge-in
    // guard below is for.
    const outputActive = speaking.value || synthesizing.value || Date.now() - lastPlaybackEndedAt < ECHO_TAIL_MS

    const data = floatToPcm16Base64(samples)
    // The room is whatever the quiet frames settle at: it follows a drop
    // quickly and a rise slowly, so a train pulling in raises the bar for
    // speech without a word of speech ever being counted as the room.
    const threshold = Math.max(SPEECH_RMS_FLOOR, noiseFloor * SPEECH_ABOVE_NOISE)
    const loud = level >= threshold
    if (!loud) noiseFloor = level < noiseFloor ? level : noiseFloor + (level - noiseFloor) * 0.05

    if (!recording.value) {
      if (!loud) {
        preRoll = [...preRoll, data].slice(-PRE_ROLL_FRAMES)
        bargeMs = 0
        candidates = []
        return
      }
      // Speech while the agent is talking has to last a moment before it
      // counts, or its own voice through the speakers would interrupt it.
      if (outputActive) {
        candidates.push(data)
        bargeMs += frameMs
        if (bargeMs < BARGE_IN_MS) return
        hush()
      }
      recording.value = true
      silentMs = 0
      segmentMs = 0
      for (const frame of [...preRoll, ...candidates]) send({ type: 'audio', data: frame })
      preRoll = []
      candidates = []
      bargeMs = 0
      return
    }

    send({ type: 'audio', data })
    segmentMs += frameMs
    silentMs = loud ? 0 : silentMs + frameMs
    if (silentMs >= SEGMENT_SILENCE_MS || segmentMs >= MAX_SEGMENT_MS) {
      recording.value = false
      silentMs = 0
      segmentMs = 0
      void endSegment(false)
    }
  }

  /* --------------------------- device dictation ------------------------ */

  /**
   * When Settings picks "This device", the browser's own recogniser hears the
   * words (Web Speech: Google's service in Chrome, Apple's dictation in
   * Safari) and the server gets text. Audio still goes up, because the turn
   * detector listens to it, and it still decides where a segment ends.
   *
   * The recogniser runs on the microphone track already open where the
   * browser allows it (Chrome), so echo cancellation applies and there is one
   * capture, not two. Words are only kept while a segment is being recorded or
   * just after, so the agent's own voice in the room is not taken for a turn.
   * A segment's end waits for the recogniser to finalise its last words, so
   * the text always arrives before the `segment-end` it belongs to.
   */
  function recognitionClass(): any {
    return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null
  }

  function inDictationWindow(): boolean {
    return recording.value || Date.now() - lastSegmentEndAt < DICTATION_GRACE_MS
  }

  /** Web Speech wants a full tag; Settings stores the language alone. */
  function dictationLang(): string {
    const code = dictationLanguage.toLowerCase()
    const preferred = navigator.languages?.find(tag => !code || tag.toLowerCase().startsWith(code))
    if (preferred?.includes('-')) return preferred
    return ({ en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', ja: 'ja-JP', zh: 'zh-CN' } as Record<string, string>)[code]
      ?? navigator.language ?? 'en-US'
  }

  /** What the device's recogniser and voice did, into the server log: they can only be debugged from there. */
  function logDevice(message: string) {
    send({ type: 'dictation-log', message })
  }

  async function startDictation() {
    if (recognizer || !dictationWanted || !micEnabled.value) return
    const Recognition = recognitionClass()
    if (!Recognition) {
      dictation.value = false
      errorMessage.value = 'This browser has no speech recognition of its own. Pick another transcriber in Settings.'
      logDevice('no SpeechRecognition in this browser')
      return
    }
    const instance = new Recognition()
    recognizer = instance
    instance.continuous = true
    instance.interimResults = true
    instance.lang = dictationLang()
    // Phrases only work on the device's own model (Chrome), and asking for
    // them from the cloud one fails the whole session.
    let local = false
    try {
      if (typeof Recognition.available === 'function') {
        local = await Recognition.available({ langs: [instance.lang], processLocally: true }) === 'available'
      }
    } catch {
      local = false
    }
    if (recognizer !== instance) return
    const Phrase = (window as any).SpeechRecognitionPhrase
    if (local) {
      instance.processLocally = true
      if (Phrase && dictationPhrases.length) {
        try {
          instance.phrases = dictationPhrases.slice(0, DICTATION_PHRASES).map(text => new Phrase(text, 5))
        } catch {
          /* this recogniser takes no phrases */
        }
      }
    }
    instance.onresult = (event: any) => {
      if (recognizer !== instance) return
      lastResultAt = Date.now()
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = String(result[0]?.transcript ?? '').trim()
        if (!result.isFinal) interim = `${interim} ${text}`.trim()
        else if (inDictationWindow()) dictatedFinal = `${dictatedFinal} ${text}`.trim()
      }
      dictatedInterim = inDictationWindow() ? interim : ''
      interimPending = !!interim
    }
    instance.onerror = (event: any) => {
      logDevice(`error ${event.error}${event.message ? `: ${event.message}` : ''}`)
      if (event.error === 'no-speech' || event.error === 'aborted') return
      errorMessage.value = event.error === 'network'
        ? 'This browser\'s dictation could not reach its speech service. Pick another transcriber in Settings.'
        : event.error === 'audio-capture'
          ? 'This browser will not share the microphone with its dictation. Pick another transcriber in Settings.'
          : `Dictation stopped: ${event.error}`
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error)) dictationWanted = false
    }
    // The recogniser ends itself after a while of silence; it is started again
    // for as long as the microphone is open.
    instance.onend = () => {
      if (recognizer !== instance) return
      recognizer = null
      interimPending = false
      if (dictationWanted && micEnabled.value) setTimeout(() => void startDictation(), 250)
    }
    const track = micStream?.getAudioTracks()[0]
    let how = 'its own microphone'
    try {
      if (track) {
        instance.start(track)
        how = 'the open microphone track'
      } else instance.start()
    } catch {
      try {
        instance.start()
      } catch (error) {
        recognizer = null
        logDevice(`could not start: ${error instanceof Error ? error.message : error}`)
        return
      }
    }
    logDevice(`started (${instance.lang}, ${local ? `on the device, ${dictationPhrases.length} phrases` : 'the browser\'s speech service'}, on ${how})`)
  }

  /** `graceful` lets the recogniser deliver the words it is still finalising. */
  function stopDictation({ graceful = false } = {}) {
    const instance = recognizer
    recognizer = null
    if (!graceful) interimPending = false
    try {
      if (graceful) instance?.stop()
      else instance?.abort()
    } catch {
      /* already stopped */
    }
  }

  /** Until the recogniser has finalised what it heard, or it has had long enough. */
  async function dictationSettled() {
    const started = Date.now()
    while (Date.now() - started < DICTATION_SETTLE_MAX_MS) {
      if (!interimPending && Date.now() - lastResultAt > DICTATION_QUIET_MS) return
      await new Promise(resolve => setTimeout(resolve, 80))
    }
  }

  /**
   * A segment ended. With device dictation, the words go up first: what the
   * recogniser finalised, and whatever it is still unsure of, since a
   * recogniser listening to an open microphone may hold its last words as
   * interim for as long as the room makes noise. A recogniser whose interim
   * words were taken is restarted, so they cannot come back as a final and
   * join the next turn.
   */
  function endSegment(final: boolean): Promise<void> {
    lastSegmentEndAt = Date.now()
    if (!dictation.value) {
      send({ type: 'segment-end', final })
      return Promise.resolve()
    }
    return dictationSettled().then(() => {
      const text = `${dictatedFinal} ${dictatedInterim}`.trim()
      const tookInterim = !!dictatedInterim
      dictatedFinal = ''
      dictatedInterim = ''
      interimPending = false
      if (tookInterim && recognizer) {
        stopDictation()
        void startDictation()
      }
      logDevice(`segment end: ${text ? `${text.split(/\s+/).length} words${tookInterim ? ' (some still interim)' : ''}` : 'no words'}`)
      if (text) send({ type: 'dictated', text })
      send({ type: 'segment-end', final })
    })
  }

  function configureDictation(enabled: boolean, language: string, phrases: string[]) {
    deviceLanguage = language
    const changed = enabled !== dictationWanted || language !== dictationLanguage || phrases.join('\n') !== dictationPhrases.join('\n')
    dictationWanted = enabled
    dictationLanguage = language
    dictationPhrases = phrases
    dictation.value = enabled && !!recognitionClass()
    if (!changed) return
    // Phrases and language are read at start, so a change restarts it, between turns.
    if (recognizer && !recording.value) stopDictation()
    if (enabled) void startDictation()
    else stopDictation()
  }

  /* ---------------------------- connection ---------------------------- */

  function noteCommand(name: string) {
    lastCommand.value = name
    if (commandTimer) clearTimeout(commandTimer)
    commandTimer = setTimeout(() => { lastCommand.value = null }, 2500)
  }

  function handleMessage(message: AgentVoiceServerMessage) {
    switch (message.type) {
      case 'status':
        transcribing.value = message.transcribing
        synthesizing.value = message.speaking
        speakEnabled.value = message.speak
        break
      case 'dictation':
        configureDictation(message.enabled, message.language, message.phrases)
        break
      case 'utterance':
        utterance.value = message.text
        break
      case 'sent':
        lastSent.value = message.text
        utterance.value = ''
        holding.value = false
        awaitingReply.value = true
        chime('sent')
        showNotice(`Sent: ${message.text}`, 6000)
        break
      case 'turn':
        holding.value = !message.complete
        break
      case 'nothing-heard':
        holding.value = false
        chime('nothing')
        showNotice(
          message.reason === 'no-speech'
            ? `Heard ${message.seconds}s of audio but no words in it.`
            : message.reason === 'silent'
              ? `Heard ${message.seconds}s of silence. Is the right microphone selected?`
              : 'That was too short to be a message.'
        )
        break
      case 'command':
        noteCommand(message.name)
        break
      case 'audio':
        if (speakEnabled.value) void playChunk(message.data, message.sampleRate)
        break
      case 'say':
        if (speakEnabled.value) sayOnDevice(message.text)
        break
      case 'speaking':
        spokenText.value = message.text
        if (message.text) awaitingReply.value = false
        break
      case 'tool':
        toolSound()
        break
      case 'hushed':
        stopPlayback()
        break
      case 'error':
        errorMessage.value = message.message
        break
    }
  }

  function connect() {
    const id = toValue(agentSessionId)
    if (!id || socket) return
    intentionalClose = false
    state.value = 'connecting'
    errorMessage.value = null

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/agent-voice/ws?agentSessionId=${id}`)
    socket = ws
    ws.onopen = () => {
      if (socket !== ws) return
      state.value = 'live'
      send({ type: 'speak', enabled: speakEnabled.value })
    }
    ws.onmessage = (event) => {
      if (socket !== ws) return
      try {
        handleMessage(JSON.parse(event.data) as AgentVoiceServerMessage)
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
      if (!intentionalClose) reconnectTimer = setTimeout(connect, 1500)
    }
  }

  function disconnect() {
    intentionalClose = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    stopMic()
    stopPlayback()
    socket?.close()
    socket = null
    state.value = 'offline'
  }

  /* ------------------------------ controls ---------------------------- */

  /** From a tap: connect, get the audio graphs running, open the microphone. */
  async function start() {
    connect()
    await resumeAudio()
    await startMic()
    await resumeAudio()
  }

  function stop() {
    stopMic()
  }

  /** Click mode, from a tap: open the recording, or close it and send what was said. */
  async function toggleRecording() {
    if (mode.value !== 'click') return
    if (!micEnabled.value) await start()
    else await resumeAudio()
    if (!micEnabled.value) return
    if (recording.value) {
      recording.value = false
      void endSegment(true)
    } else {
      // Talking over the agent means its answer is not wanted any more.
      if (speaking.value || synthesizing.value) hush()
      recording.value = true
      chime('record')
    }
  }

  function setMode(value: AgentVoiceMode) {
    if (mode.value === value) return
    if (recording.value) void endSegment(mode.value === 'click')
    recording.value = false
    silentMs = 0
    segmentMs = 0
    bargeMs = 0
    candidates = []
    mode.value = value
    writeStored(MODE_KEY, value)
  }

  function setSpeak(enabled: boolean) {
    speakEnabled.value = enabled
    writeStored(SPEAK_KEY, String(enabled))
    if (!enabled) stopPlayback()
    send({ type: 'speak', enabled })
  }

  /** Stop the voice. The agent keeps working. */
  function hush() {
    stopPlayback()
    send({ type: 'hush' })
  }

  function cancel() {
    stopPlayback()
    send({ type: 'cancel' })
  }

  function sendHeld() {
    send({ type: 'send' })
  }

  function discardHeld() {
    send({ type: 'discard' })
  }

  onScopeDispose(() => {
    for (const connection of loopbackConnections) connection.close()
    loopbackConnections = []
    if (commandTimer) clearTimeout(commandTimer)
    if (noticeTimer) clearTimeout(noticeTimer)
    if (workingTimer) clearInterval(workingTimer)
    disconnect()
  })

  return {
    state,
    mode,
    speakEnabled,
    micEnabled,
    captureSuspended,
    recording,
    transcribing,
    synthesizing,
    speaking,
    inputLevel,
    outputLevel,
    utterance,
    lastSent,
    spokenText,
    lastCommand,
    notice,
    holding,
    dictation,
    errorMessage,
    inputDevices,
    inputDeviceId,
    connect,
    start,
    stop,
    toggleRecording,
    setMode,
    setSpeak,
    setInputDevice,
    refreshDevices,
    hush,
    cancel,
    sendHeld,
    discardHeld
  }
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}
