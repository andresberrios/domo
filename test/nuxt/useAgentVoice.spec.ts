import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

import type { AgentVoiceServerMessage, SoundVolumes } from '~~/shared/types'
import { DEFAULT_VOLUMES } from '~~/shared/agent-voice'
import { useAgentVoice } from '~/composables/useAgentVoice'
import { useAudioInputs } from '~/composables/useAudioInputs'

/**
 * The voice bar's browser half against a fake audio stack: what it plays, at
 * what volume, and what it says when the microphone will not work. A real
 * microphone and speaker are checked by hand; these are the decisions.
 */

class FakeSocket {
  static OPEN = 1
  static last: FakeSocket | null = null
  readyState = 1
  sent: any[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor() {
    FakeSocket.last = this
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {}
}

function param(value = 1) {
  const ramps: number[] = []
  return { value, ramps, setValueAtTime() {}, linearRampToValueAtTime(level: number) { ramps.push(level) } }
}

/** Every graph the bar builds, and what went into it. */
const audio = {
  contexts: [] as FakeContext[],
  /** Oscillators as [frequency, peak]: a chime. */
  tones: [] as Array<[number, number]>,
  /** Makes `createMediaStreamSource` throw, as Firefox does for a context of another rate. */
  refuseSource: (_context: FakeContext) => false
}

class FakeNode {
  context: FakeContext
  gain = param()
  port = { onmessage: null as ((event: { data: any }) => void) | null, close() {} }
  constructor(context: FakeContext) {
    this.context = context
  }

  connect<T>(target: T): T {
    return target
  }

  disconnect() {}
}

class FakeContext {
  sampleRate: number
  state = 'running'
  currentTime = 0
  destination = {}
  audioWorklet = { addModule: async () => {} }
  gains: FakeNode[] = []
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 44100
    audio.contexts.push(this)
  }

  async resume() {}
  async close() {
    this.state = 'closed'
  }

  addEventListener() {}
  createGain() {
    const node = new FakeNode(this)
    this.gains.push(node)
    return node
  }

  createOscillator() {
    const oscillator = {
      type: '',
      frequency: { value: 0 },
      // The envelope is set before the oscillator is connected to it.
      connect(gain: FakeNode) {
        audio.tones.push([oscillator.frequency.value, Math.max(...gain.gain.ramps)])
        return gain
      },
      start() {},
      stop() {}
    }
    return oscillator
  }

  createMediaStreamDestination() {
    return { stream: { getAudioTracks: () => [] } }
  }

  createMediaStreamSource() {
    if (audio.refuseSource(this)) throw new DOMException('Connecting AudioNodes from AudioContexts with different sample-rate is currently not supported.', 'NotSupportedError')
    return new FakeNode(this)
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) }
  }

  createBufferSource() {
    return { buffer: null, onended: null, connect: <T>(target: T) => target, start() {}, stop() {} }
  }
}

class FakeTrack {
  stopped = false
  label = 'MacBook Pro Microphone'
  stop() {
    this.stopped = true
  }

  getSettings() {
    return { sampleRate: 48000, echoCancellation: true }
  }

  addEventListener() {}
}

let tracks: FakeTrack[] = []
let getUserMedia: ReturnType<typeof vi.fn>

function stream() {
  const track = new FakeTrack()
  tracks.push(track)
  return { getAudioTracks: () => [track], getTracks: () => [track] }
}

function open(volumes = ref<SoundVolumes | undefined>(undefined)) {
  const scope = effectScope()
  const voice = scope.run(() => useAgentVoice('ag_test', { volumes }))!
  return { voice, volumes, scope }
}

function receive(message: AgentVoiceServerMessage) {
  FakeSocket.last!.onmessage!({ data: JSON.stringify(message) })
}

/** The recorder worklet handing over a frame. */
function frame(value: number) {
  const recorder = (globalThis as any).__worklets.at(-1) as FakeNode
  recorder.port.onmessage!({ data: { type: 'chunk', samples: new Float32Array(2048).fill(value) } })
}

beforeEach(() => {
  audio.contexts = []
  audio.tones = []
  audio.refuseSource = () => false
  tracks = []
  ;(globalThis as any).__worklets = []
  getUserMedia = vi.fn(async () => stream())
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('AudioContext', FakeContext)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recorder')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('Audio', class {
    autoplay = false
    srcObject: unknown = null
    paused = false
    async play() {}
    pause() {}
  })
  vi.stubGlobal('AudioWorkletNode', class extends FakeNode {
    constructor(context: FakeContext) {
      super(context)
      ;(globalThis as any).__worklets.push(this)
    }
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices: async () => [], addEventListener() {} }
  })
  useAudioInputs().select('')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the voice bar\'s sounds', () => {
  it('chimes at a tenth of full scale by default, and at the volume Settings give', async () => {
    const { voice, volumes, scope } = open()
    await voice.start()
    receive({ type: 'sent', text: 'hello' })
    expect(audio.tones).toEqual([[660, DEFAULT_VOLUMES.sent], [990, DEFAULT_VOLUMES.sent]])
    expect(DEFAULT_VOLUMES.sent).toBe(0.1)

    volumes.value = { ...DEFAULT_VOLUMES, sent: 0.6, nothing: 0 }
    audio.tones = []
    receive({ type: 'sent', text: 'again' })
    receive({ type: 'nothing-heard', reason: 'silent', seconds: 2 })
    expect(audio.tones).toEqual([[660, 0.6], [990, 0.6]])
    scope.stop()
  })

  it('does not chime "sent" for a hands-free turn whose end it already chimed', async () => {
    const { voice, scope } = open()
    await voice.start()
    receive({ type: 'turn', complete: true, probability: 0.9, seconds: 3 })
    receive({ type: 'sent', text: 'fix the test' })
    expect(audio.tones.map(([frequency]) => frequency)).toEqual([880, 660])

    // The next turn, sent by a tap, has had no turn chime: it gets its own.
    audio.tones = []
    receive({ type: 'sent', text: 'and the next' })
    expect(audio.tones.map(([frequency]) => frequency)).toEqual([660, 990])

    // A turn heard and then dropped leaves nothing behind for the next one.
    audio.tones = []
    receive({ type: 'turn', complete: true, probability: 0.9, seconds: 1 })
    receive({ type: 'nothing-heard', reason: 'no-speech', seconds: 1 })
    receive({ type: 'sent', text: 'third' })
    expect(audio.tones.map(([frequency]) => frequency)).toEqual([880, 660, 220, 660, 990])
    scope.stop()
  })

  it('speaks replies through a gain at the speech volume, changed while it speaks', async () => {
    const volumes = ref<SoundVolumes | undefined>({ ...DEFAULT_VOLUMES, speech: 0.5 })
    const { voice, scope } = open(volumes)
    await voice.start()
    receive({ type: 'audio', data: btoa('\u0000\u0010'.repeat(64)), sampleRate: 24000 })
    await vi.waitFor(() => expect(audio.contexts.find(context => context.sampleRate === 24000)?.gains.some(node => node.gain.value === 0.5)).toBe(true))
    volumes.value = { ...DEFAULT_VOLUMES, speech: 0.2 }
    await nextTick()
    expect(audio.contexts.find(context => context.sampleRate === 24000)!.gains.some(node => node.gain.value === 0.2)).toBe(true)
    scope.stop()
  })

  it('shows a note from the server for a moment', async () => {
    const { voice, scope } = open()
    voice.connect()
    receive({ type: 'notice', message: 'The assistant\'s own voice could not speak' })
    expect(voice.notice.value).toContain('could not speak')
    expect(voice.errorMessage.value).toBeNull()
    scope.stop()
  })
})

describe('the voice bar\'s microphone', () => {
  it('records at the microphone\'s own rate when the browser refuses a 16 kHz graph', async () => {
    audio.refuseSource = context => context.sampleRate === 16000
    const { voice, scope } = open()
    await voice.start()
    expect(voice.errorMessage.value).toBeNull()
    expect(voice.micEnabled.value).toBe(true)
    expect(audio.contexts.some(context => context.sampleRate === 48000 && context.state === 'running')).toBe(true)
    scope.stop()
  })

  it('says why, and lets go of the microphone, when it opens but cannot be recorded', async () => {
    audio.refuseSource = () => true
    const { voice, scope } = open()
    await voice.start()
    expect(voice.micEnabled.value).toBe(false)
    expect(voice.errorMessage.value).toMatch(/could not record it: Connecting AudioNodes/)
    expect(tracks.every(track => track.stopped)).toBe(true)
    scope.stop()
  })

  it('tells someone whose system blocks the browser where to allow it', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Permission denied by system', 'NotAllowedError'))
    const { voice, scope } = open()
    await voice.start()
    expect(voice.errorMessage.value).toMatch(/System Settings, Privacy & Security, Microphone/)
    scope.stop()
  })

  it('falls back to the system default when the chosen microphone is not plugged in', async () => {
    useAudioInputs().select('headset-at-home')
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error(''), { name: 'OverconstrainedError', constraint: 'deviceId' }))
    const { voice, scope } = open()
    await voice.start()
    expect(getUserMedia.mock.calls.map(([constraints]: any) => constraints.audio.deviceId)).toEqual([{ exact: 'headset-at-home' }, undefined])
    expect(voice.micEnabled.value).toBe(true)
    expect(voice.notice.value).toMatch(/not connected/)
    // Still chosen, for when it is back.
    expect(useAudioInputs().selected.value).toBe('headset-at-home')
    scope.stop()
  })

  it('says so when the microphone gives nothing but silence, and stops saying it once it hears something', async () => {
    const { voice, scope } = open()
    await voice.start()
    // A few quiet seconds after the tap are only someone gathering their thoughts.
    for (let i = 0; i < 25; i++) frame(0)
    expect(voice.errorMessage.value).toBeNull()
    for (let i = 0; i < 10; i++) frame(0)
    expect(voice.errorMessage.value).toMatch(/"MacBook Pro Microphone" is sending only silence/)
    frame(0.001)
    expect(voice.errorMessage.value).toBeNull()
    scope.stop()
  })
})

describe('the microphones a browser has', () => {
  it('lists them by the browser\'s names, under the system default, without Chrome\'s aliases', async () => {
    let devices = [
      { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Communications - AirPods' },
      { kind: 'audioinput', deviceId: 'mbp', label: 'MacBook Pro Microphone (Built-in)' },
      { kind: 'audioinput', deviceId: 'pods', label: 'AirPods' },
      { kind: 'audiooutput', deviceId: 'speakers', label: 'MacBook Pro Speakers' }
    ]
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia, enumerateDevices: async () => devices, addEventListener() {} } })
    const inputs = useAudioInputs()
    await inputs.refresh()
    expect(inputs.options.value).toEqual([
      { deviceId: '', label: 'System default (MacBook Pro Microphone (Built-in))' },
      { deviceId: 'mbp', label: 'MacBook Pro Microphone (Built-in)' },
      { deviceId: 'pods', label: 'AirPods' }
    ])
    expect(inputs.named.value).toBe(true)

    // Before the page may use the microphone, the browser gives no names.
    devices = [{ kind: 'audioinput', deviceId: '', label: '' }]
    await inputs.refresh()
    expect(inputs.options.value).toEqual([{ deviceId: '', label: 'System default' }])
    expect(inputs.named.value).toBe(false)
  })
})
