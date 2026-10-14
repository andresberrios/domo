/**
 * Microphone audio at the device's own rate, brought down to `to` and cut
 * into frames of `frameSize`. Only for a browser that will not feed a
 * microphone into an audio context of another rate (Firefox refuses with
 * NotSupportedError); the others resample better themselves. Each output
 * sample is the mean of the input samples it spans, which is a low-pass good
 * enough for speech.
 */
export function createDownsampler(from: number, to: number, frameSize: number) {
  const step = from / to
  let position = 0
  let sum = 0
  let count = 0
  let frame = new Float32Array(frameSize)
  let filled = 0
  return (input: Float32Array): Float32Array[] => {
    const frames: Float32Array[] = []
    for (let i = 0; i < input.length; i++) {
      sum += input[i]!
      count += 1
      position += 1
      if (position < step) continue
      position -= step
      frame[filled++] = sum / count
      sum = 0
      count = 0
      if (filled === frameSize) {
        frames.push(frame)
        frame = new Float32Array(frameSize)
        filled = 0
      }
    }
    return frames
  }
}
