import type { ToolSound } from '~~/shared/types'

/**
 * The sound of the agent using a tool, made on the spot in the playback
 * graph: no file, no request.
 *
 * A key on a keyboard is three sounds, and all three are here: the switch's
 * sharp click (a few milliseconds of bright noise), the key bottoming out (a
 * short low thump), and the quieter click as it comes back up. Typing is
 * those in bursts at an uneven rhythm, with the odd heavier space bar, and
 * no two keys quite the same, which is what keeps it from sounding like a
 * drum machine.
 */

interface Key {
  /** Seconds from now. */
  at: number
  /** 0..1, how hard the key was struck. */
  force: number
  space: boolean
}

function noiseBurst(context: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const frames = Math.max(1, Math.floor(context.sampleRate * seconds))
  const buffer = context.createBuffer(1, frames, context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (context.sampleRate * decay))
  return buffer
}

function play(context: BaseAudioContext, out: AudioNode, buffer: AudioBuffer, at: number, volume: number, filter: BiquadFilterType, frequency: number, q = 0.8) {
  const source = context.createBufferSource()
  source.buffer = buffer
  const shape = context.createBiquadFilter()
  shape.type = filter
  shape.frequency.value = frequency
  shape.Q.value = q
  const gain = context.createGain()
  gain.gain.value = volume
  source.connect(shape).connect(gain).connect(out)
  source.start(context.currentTime + at)
}

function keystroke(context: BaseAudioContext, out: AudioNode, key: Key, laptop: boolean) {
  const vary = () => 0.85 + Math.random() * 0.3
  const loud = 0.2 * (0.6 + key.force * 0.4)
  // The switch: bright, very short. A laptop's scissor keys barely click.
  play(context, out, noiseBurst(context, 0.012, 0.0025), key.at, loud * (laptop ? 0.5 : 1), 'highpass', 2800 * vary())
  // Bottoming out: low and a little longer; the space bar's is deeper.
  const body = key.space ? 180 : laptop ? 520 : 320
  play(context, out, noiseBurst(context, 0.04, key.space ? 0.012 : 0.007), key.at + 0.003, loud * (key.space ? 1.3 : 1), 'bandpass', body * vary(), 1.4)
  // The key coming back up, quieter, a moment later.
  play(context, out, noiseBurst(context, 0.008, 0.002), key.at + 0.07 + Math.random() * 0.04, loud * 0.35, 'highpass', 3500 * vary())
}

/** A burst of typing: a few keys, uneven, now and then a space. */
function typing(): Key[] {
  const keys: Key[] = []
  let at = 0
  const count = 4 + Math.floor(Math.random() * 5)
  for (let i = 0; i < count; i++) {
    const space = i > 1 && i < count - 1 && Math.random() < 0.18
    keys.push({ at, force: 0.5 + Math.random() * 0.5, space })
    at += (space ? 0.14 : 0.07) + Math.random() * 0.09
  }
  return keys
}

export function playToolSound(context: BaseAudioContext, out: AudioNode, kind: ToolSound) {
  switch (kind) {
    case 'off':
      return
    case 'tick':
      play(context, out, noiseBurst(context, 0.02, 0.004), 0, 0.18, 'bandpass', 2400, 1.2)
      return
    case 'laptop':
      for (const key of typing()) keystroke(context, out, key, true)
      return
    default:
      for (const key of typing()) keystroke(context, out, key, false)
  }
}
