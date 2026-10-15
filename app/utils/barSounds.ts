import type { Chime, SoundVolumes, ToolSound } from '~~/shared/types'
import { playToolSound } from '~/utils/toolSounds'

/** Each chime as tones: frequency in Hz, start and length in seconds. */
const CHIMES: Record<Chime, Array<[number, number, number]>> = {
  // A rising pair: your turn went through.
  sent: [[660, 0, 0.09], [990, 0.1, 0.12]],
  // Hands-free heard the end of the turn: a falling pair, the opposite of the
  // rising "sent" that follows once it is delivered.
  turn: [[880, 0, 0.07], [660, 0.08, 0.09]],
  // Low: nothing was heard.
  nothing: [[220, 0, 0.22]],
  // A soft blip while the agent works.
  working: [[520, 0, 0.06]],
  // A tick: recording.
  record: [[880, 0, 0.05]]
}

/**
 * A sound that means something, for when the screen is in a pocket. Made on
 * the spot in an audio graph a tap already unlocked, so it costs no request
 * and no file. `volume` is its peak, 0..1 of full scale. Returns how long it
 * plays, in seconds.
 */
export function playChime(context: BaseAudioContext, out: AudioNode, kind: Chime, volume: number): number {
  if (volume <= 0) return 0
  for (const [frequency, at, length] of CHIMES[kind]) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    const start = context.currentTime + at
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(volume, start + 0.01)
    gain.gain.linearRampToValueAtTime(0, start + length)
    oscillator.connect(gain).connect(out)
    oscillator.start(start)
    oscillator.stop(start + length + 0.02)
  }
  return Math.max(...CHIMES[kind].map(([, at, length]) => at + length))
}

let previewContext: AudioContext | null = null

/** From a tap: the context Settings plays its previews in, made once. */
export async function previewAudioContext(): Promise<AudioContext> {
  if (!previewContext || previewContext.state === 'closed') previewContext = new AudioContext()
  if (previewContext.state === 'suspended') await previewContext.resume().catch(() => {})
  return previewContext
}

/** One of the bar's sounds at a given volume, to hear it in Settings. */
export async function previewSound(kind: Exclude<keyof SoundVolumes, 'speech'>, volume: number, toolSound: ToolSound) {
  const context = await previewAudioContext()
  if (kind === 'tool') playToolSound(context, context.destination, toolSound, volume)
  else playChime(context, context.destination, kind, volume)
}

/** A WAV played at a gain, as the bar would play speech at `SoundVolumes.speech`. */
export async function playWav(wav: ArrayBuffer, volume: number) {
  const context = await previewAudioContext()
  const buffer = await context.decodeAudioData(wav)
  const source = context.createBufferSource()
  const gain = context.createGain()
  gain.gain.value = volume
  source.buffer = buffer
  source.connect(gain).connect(context.destination)
  source.start()
}
