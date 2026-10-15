import type { AgentVoiceClientMessage, AgentVoiceServerMessage, Chime, SoundVolumes, ToolSound } from '~~/shared/types'
import { DEFAULT_VOLUMES, type AgentVoiceMode } from '~~/shared/agent-voice'
import { playChime } from '~/utils/barSounds'
import { createDownsampler } from '~/utils/downsample'
import { isAndroid, micEchoCancellation } from '~/utils/echoCancellation'
import { RECORDER_WORKLET, base64ToFloat32, floatToPcm16Base64 } from '~/utils/pcm'
import { playToolSound } from '~/utils/toolSounds'

const INPUT_SAMPLE_RATE = 16000
/** The recorder's frame, in samples at `INPUT_SAMPLE_RATE`: 128 ms. */
const FRAME_SAMPLES = 2048
/** A microphone that has given nothing but exact zeros for this long is not working. */
const DEAD_MIC_MS = 4000
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

export type AgentVoiceState = 'offline' | 'connecting' | 'live' | 'error'

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
/** And the first one this soon after the turn was sent, so the wait is heard from the start. */
const WORKING_FIRST_MS = 700
/** Tool sounds closer together than this are one sound. */
const TOOL_SOUND_GAP_MS = 1200

export function useAgentVoice(
  agentSessionId: MaybeRefOrGetter<string>,
  options: {
    /** Whether the agent is working. From the session row; the socket does not say. */
    busy?: MaybeRefOrGetter<boolean>
    /** What a tool call sounds like, from Settings. */
    toolSound?: MaybeRefOrGetter<ToolSound | undefined>
    /** How loud each sound is, from Settings; read as each one plays. */
    volumes?: MaybeRefOrGetter<SoundVolumes | undefined>
    /** What the composer has attached (`resource_link` blocks): it goes with the next spoken turn. */
    attachments?: MaybeRefOrGetter<any[] | undefined>
    /** Those attachments went with a turn. */
    onAttachmentsSent?: (uris: string[]) => void
  } = {}
) {
  const state = ref<AgentVoiceState>('offline')
  const mode = ref<AgentVoiceMode>(readStored(MODE_KEY) === 'handsfree' ? 'handsfree' : 'click')
  /** Whether replies and sounds are heard; shared with the composer's speaker (`useAgentVoiceListen`). */
  const speakEnabled = useAgentVoiceListen()
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
  const inputs = useAudioInputs()

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
  /** Android: the microphone closed mid-sentence; the speaker moves back to media once it is quiet. */
  let reopenWhenQuiet = false
  /** A message to read again, waiting for the socket. */
  let pendingReplay: string | null = null
  let lastPlaybackEndedAt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionalClose = false
  let commandTimer: ReturnType<typeof setTimeout> | null = null
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let workingTimer: ReturnType<typeof setTimeout> | null = null
  let lastToolSoundAt = 0
  /** The turn-end chime played for the turn now being delivered, so "sent" is not chimed too. */
  let turnChimed = false
  /** The microphone problem on show, so a working microphone can take it away again. */
  let micProblem: string | null = null
  /** Since the microphone opened: whether anything but exact zeros came from it, and for how long it has not. */
  let micHeardAnything = false
  let micSilentMs = 0
  /** The voice's own gain, so its volume can change while it speaks. */
  let speechGain: GainNode | null = null

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

  function volume(kind: keyof SoundVolumes): number {
    return toValue(options.volumes)?.[kind] ?? DEFAULT_VOLUMES[kind]
  }

  function showMicProblem(message: string) {
    micProblem = message
    errorMessage.value = message
  }

  function clearMicProblem() {
    if (micProblem && errorMessage.value === micProblem) errorMessage.value = null
    micProblem = null
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

  /**
   * Close the speaker side, so the next sound opens it afresh.
   *
   * On Android, Chrome fixes an output's channel when the output is opened:
   * media if it opened before the microphone, the call channel if after,
   * since opening a microphone with echo cancellation puts the phone in call
   * mode. The phone's echo canceller works on the call channel, and the
   * volume keys switch to it, so speech left on the media channel was both
   * heard back by the microphone and deaf to the volume keys. Reopening it
   * once the microphone is open puts it where the canceller can see it.
   */
  function closePlayback() {
    stopPlayback()
    for (const connection of loopbackConnections) connection.close()
    loopbackConnections = []
    if (playbackElement) {
      playbackElement.pause()
      playbackElement.srcObject = null
    }
    playbackElement = null
    playbackOut = null
    speechGain = null
    void playbackContext?.close().catch(() => {})
    playbackContext = null
  }

  /** Where speech and sounds go: the media element, or the context if it could not be made. */
  function output(context: AudioContext): AudioNode {
    return playbackOut ?? context.destination
  }

  /** Where speech goes: through its own volume, then `output`. */
  function speechOut(context: AudioContext): AudioNode {
    if (!speechGain || speechGain.context !== context) {
      speechGain = context.createGain()
      speechGain.connect(output(context))
    }
    speechGain.gain.value = volume('speech')
    return speechGain
  }
  watch(() => toValue(options.volumes)?.speech, () => {
    if (speechGain) speechGain.gain.value = volume('speech')
  })

  async function playChunk(base64: string, sampleRate: number) {
    const context = await ensurePlayback()
    const floats = base64ToFloat32(base64)
    if (!floats.length) return

    const buffer = context.createBuffer(1, floats.length, sampleRate || OUTPUT_SAMPLE_RATE)
    buffer.getChannelData(0).set(floats)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(speechOut(context))

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
        if (reopenWhenQuiet && !micEnabled.value) closePlayback()
        reopenWhenQuiet = false
      }
    }
  }

  /** One of the bar's signals (`playChime`), at its volume from Settings. */
  function chime(kind: Chime) {
    if (!playbackContext || playbackContext.state !== 'running') return
    playChime(playbackContext, output(playbackContext), kind, volume(kind))
  }

  /** The tool call sound chosen in Settings (`playToolSound`), at most one burst at a time. */
  function toolSound() {
    if (!playbackContext || playbackContext.state !== 'running') return
    const now = Date.now()
    if (now - lastToolSoundAt < TOOL_SOUND_GAP_MS) return
    lastToolSoundAt = now
    playToolSound(playbackContext, output(playbackContext), toValue(options.toolSound) ?? 'typing', volume('tool'))
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
      // The first blip soon after the turn went, then every couple of seconds.
      workingTimer = setTimeout(function tick() {
        chime('working')
        workingTimer = setTimeout(tick, WORKING_TICK_MS)
      }, WORKING_FIRST_MS)
    } else if (!working && workingTimer) {
      clearTimeout(workingTimer)
      workingTimer = null
    }
  }
  watch([awaitingReply, speaking, synthesizing, () => toValue(options.busy)], syncWorking)

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
    if (speaking.value) lastPlaybackEndedAt = Date.now()
    speaking.value = false
    outputLevel.value = 0
  }

  /* ------------------------------ devices ----------------------------- */

  /**
   * A microphone chosen here or in Settings (`useAudioInputs`) takes over at
   * once. Playback is untouched, so earbuds can keep the sound.
   */
  watch(inputs.selected, async () => {
    if (!micEnabled.value) return
    const wasRecording = recording.value && mode.value === 'click'
    stopMic({ endTurn: false })
    await startMic()
    if (wasRecording && micEnabled.value) recording.value = true
  })

  /* ------------------------------ capture ----------------------------- */

  function constraints(deviceId: string): MediaStreamConstraints {
    return {
      audio: {
        ...deviceId ? { deviceId: { exact: deviceId } } : {},
        channelCount: 1,
        echoCancellation: micEchoCancellation(),
        noiseSuppression: true,
        autoGainControl: true
      }
    }
  }

  /**
   * The chosen microphone, or the system's default when the chosen one is not
   * here: a headset left at home should not leave the bar without a
   * microphone.
   */
  async function openMicrophone(): Promise<MediaStream> {
    const chosen = inputs.selected.value
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(chosen))
    } catch (error) {
      const name = (error as { name?: string })?.name
      if (!chosen || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw error
      logDevice(`the chosen microphone is not here (${name}); using the system default`)
      showNotice('The chosen microphone is not connected, so the system default is listening.', 6000)
      return await navigator.mediaDevices.getUserMedia(constraints(''))
    }
  }

  /**
   * The capture graph: microphone, recorder worklet, 128 ms frames at 16 kHz.
   * The context runs at 16 kHz so the browser does the resampling, which it
   * does well; a browser that refuses to feed a microphone into a context of
   * another rate (Firefox) gets one at the microphone's own rate, and the
   * frames are brought down here.
   */
  async function buildCapture(stream: MediaStream): Promise<AudioContext> {
    let context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
    captureContext = context
    let source: MediaStreamAudioSourceNode
    try {
      source = context.createMediaStreamSource(stream)
    } catch (error) {
      void context.close().catch(() => {})
      // At the microphone's own rate: Firefox compares the two, and the
      // output device's rate, a context's default, may not be it.
      const rate = stream.getAudioTracks()[0]?.getSettings().sampleRate
      logDevice(`no 16 kHz capture (${error instanceof Error ? error.message : error}); recording at ${rate ?? 'the default'} Hz and resampling in the page`)
      context = new AudioContext(rate ? { sampleRate: rate } : undefined)
      captureContext = context
      source = context.createMediaStreamSource(stream)
    }
    sourceNode = source
    const syncSuspended = () => { captureSuspended.value = context.state !== 'running' }
    context.addEventListener('statechange', syncSuspended)
    await context.resume().catch(() => {})
    syncSuspended()

    const blob = new Blob([RECORDER_WORKLET], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }

    const toFrames = context.sampleRate === INPUT_SAMPLE_RATE
      ? (samples: Float32Array) => [samples]
      : createDownsampler(context.sampleRate, INPUT_SAMPLE_RATE, FRAME_SAMPLES)
    const recorder = new AudioWorkletNode(context, 'domo-recorder')
    workletNode = recorder
    recorder.port.onmessage = (event) => {
      const { type, samples } = event.data ?? {}
      if (type !== 'chunk') return
      for (const frame of toFrames(samples as Float32Array)) onFrame(frame)
    }
    source.connect(recorder)
    const sink = context.createGain()
    sink.gain.value = 0
    recorder.connect(sink).connect(context.destination)
    return context
  }

  async function startMic() {
    if (micEnabled.value) return
    let stream: MediaStream
    try {
      stream = await openMicrophone()
    } catch (error) {
      logDevice(`microphone refused: ${(error as Error)?.name}: ${(error as Error)?.message}`)
      showMicProblem(microphoneError(error))
      return
    }
    micStream = stream

    let context: AudioContext
    try {
      context = await buildCapture(stream)
    } catch (error) {
      // The microphone is open but nothing records it: close it again, or the
      // system shows it in use with nothing on the screen to say why.
      logDevice(`capture failed: ${error instanceof Error ? `${error.name}: ${error.message}` : error}`)
      releaseCapture()
      showMicProblem(`The microphone opened, but this browser could not record it: ${error instanceof Error ? error.message : error}`)
      return
    }
    clearMicProblem()
    micEnabled.value = true
    noiseFloor = 0
    micHeardAnything = false
    micSilentMs = 0
    const track = stream.getAudioTracks()[0]
    track?.addEventListener('ended', () => {
      if (micStream !== stream) return
      stopMic()
      showMicProblem('The microphone was disconnected. Tap to use another one.')
    })
    // Android: the speaker opened before the microphone is on the media
    // channel, out of the echo canceller's sight (closePlayback). Reopen it now,
    // inside the same tap, so it opens on the call channel.
    if (isAndroid() && playbackContext) {
      closePlayback()
      await ensurePlayback()
      logDevice('speaker reopened after the microphone, on the call channel')
    }
    const granted = track?.getSettings() as any
    logDevice(`microphone: ${track?.label || 'unnamed'} at ${granted?.sampleRate ?? '?'} Hz into ${context.sampleRate} Hz, echo cancellation ${JSON.stringify(granted?.echoCancellation)}, noise suppression ${granted?.noiseSuppression}`)
    void startDictation()
    void inputs.refresh()
  }

  function releaseCapture() {
    workletNode?.port.close()
    workletNode?.disconnect()
    sourceNode?.disconnect()
    micStream?.getTracks().forEach(track => track.stop())
    void captureContext?.close().catch(() => {})
    workletNode = null
    sourceNode = null
    micStream = null
    captureContext = null
  }

  function stopMic({ endTurn = true } = {}) {
    // The recogniser is stopped once the segment's words are in, not before.
    if (endTurn && recording.value && mode.value === 'click') void endSegment(true).then(() => stopDictation())
    else stopDictation()
    releaseCapture()
    micEnabled.value = false
    captureSuspended.value = false
    // Android: the phone leaves call mode with the microphone, so the speaker
    // is reopened on the media channel by the next sound (closePlayback), but
    // only once the agent has finished what it is saying.
    if (isAndroid() && playbackContext) {
      if (scheduled.length) reopenWhenQuiet = true
      else closePlayback()
    }
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

  /**
   * A real microphone is never exactly silent: there is always some hiss.
   * Exact zeros mean the system is handing over nothing (a muted or virtual
   * input, an input level at zero, a device that is not the one in use), and
   * the bar would otherwise sit there "listening" to it forever.
   */
  function watchForDeadMic(samples: Float32Array, frameMs: number) {
    if (micHeardAnything) return
    if (samples.some(sample => sample !== 0)) {
      micHeardAnything = true
      clearMicProblem()
      return
    }
    micSilentMs += frameMs
    if (micSilentMs < DEAD_MIC_MS || micProblem) return
    const label = micStream?.getAudioTracks()[0]?.label
    logDevice(`microphone ${label || ''} gives only silence`)
    showMicProblem(`${label ? `"${label}"` : 'The microphone'} is sending only silence. Pick another microphone in the voice settings, or check the system's sound input and its level.`)
  }

  /** One 128 ms frame from the microphone. */
  function onFrame(samples: Float32Array) {
    const level = rms(samples)
    inputLevel.value = Math.min(1, level * 6)
    const frameMs = (samples.length / INPUT_SAMPLE_RATE) * 1000
    watchForDeadMic(samples, frameMs)

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
        // Hands-free already chimed the end of this turn; a failure has its own tone.
        if (!turnChimed) chime('sent')
        turnChimed = false
        showNotice(`Sent: ${message.text}`, 6000)
        break
      case 'attachments-sent':
        options.onAttachmentsSent?.(message.uris)
        break
      case 'turn':
        holding.value = !message.complete
        if (message.complete) {
          chime('turn')
          turnChimed = true
        }
        break
      case 'nothing-heard':
        holding.value = false
        turnChimed = false
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
        turnChimed = false
        noteCommand(message.name)
        break
      case 'audio':
        if (speakEnabled.value) void playChunk(message.data, message.sampleRate)
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
        turnChimed = false
        errorMessage.value = message.message
        break
      case 'notice':
        showNotice(message.message, 8000)
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
      sendAttachments()
      if (pendingReplay) {
        send({ type: 'replay', text: pendingReplay })
        pendingReplay = null
      }
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

  /**
   * A new session behind the same bar — an assistant's handoff — gets a new
   * socket at once. The microphone stays as it is, so a hands-free
   * conversation goes on across it.
   */
  watch(() => toValue(agentSessionId), (next, previous) => {
    if (!socket || next === previous) return
    const old = socket
    socket = null
    old.close()
    connect()
  })

  function sendAttachments() {
    send({ type: 'attachments', content: toValue(options.attachments) ?? [] })
  }
  watch(() => toValue(options.attachments), sendAttachments, { deep: true })

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
  }
  // However it changed — here, or the composer's speaker — the server is told,
  // and nothing goes on playing once it is off.
  watch(speakEnabled, (enabled) => {
    if (!enabled) stopPlayback()
    send({ type: 'speak', enabled })
  })

  /**
   * Get the audio graphs running from a gesture, when they are not yet: a
   * browser starts them only in one (iOS only in a tap), and with the voice
   * only listening there is no microphone tap to do it.
   */
  async function unlock() {
    if (playbackContext?.state === 'running') return
    await resumeAudio()
  }

  /** A typed message went: the working blip plays until the reply is heard, as for a spoken one. */
  function expectReply() {
    awaitingReply.value = true
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

  /** Read an agent message out again. From a tap, so the audio graphs can start. */
  async function replay(text: string) {
    connect()
    await resumeAudio()
    if (socket?.readyState === WebSocket.OPEN) send({ type: 'replay', text })
    else pendingReplay = text
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
    if (workingTimer) clearTimeout(workingTimer)
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
    connect,
    start,
    stop,
    toggleRecording,
    setMode,
    setSpeak,
    unlock,
    expectReply,
    hush,
    cancel,
    sendHeld,
    discardHeld,
    replay
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

/** One microphone, socket and speaker for one session; see `useAgentVoice`. */
export type AgentVoice = ReturnType<typeof useAgentVoice>
