import { readFileSync } from 'node:fs'
import { WhisperFeatureExtractor } from '@huggingface/transformers'
const { logMelFeatures, windowOf } = await import('../../server/lib/agent-voice/turn.ts')
const ext = new WhisperFeatureExtractor({ feature_size: 80, sampling_rate: 16000, hop_length: 160, chunk_length: 8, n_fft: 400, padding_value: 0, n_samples: 128000, nb_max_frames: 800 })
for (const f of ['/tmp/fx-hf1.pcm', '/tmp/fx-click.pcm']) {
  const b = readFileSync(f); const pcm = new Int16Array(b.buffer, b.byteOffset, b.length >> 1)
  const wave = windowOf(pcm)
  // HF normalisation of the waveform, as the reference's do_normalize does
  let mean = 0; for (const v of wave) mean += v; mean /= wave.length
  let vr = 0; for (const v of wave) vr += (v - mean) ** 2; vr /= wave.length
  const norm = Float32Array.from(wave, v => (v - mean) / Math.sqrt(vr + 1e-7))
  const ref = (await ext(norm)).input_features
  const refData = ref.data, dims = ref.dims
  const mine = logMelFeatures(wave)
  let maxDiff = 0, sum = 0
  for (let i = 0; i < mine.length; i++) { const d = Math.abs(mine[i] - refData[i]); if (d > maxDiff) maxDiff = d; sum += d }
  console.log(f, 'ref dims', dims, 'maxAbsDiff', maxDiff.toFixed(4), 'meanAbsDiff', (sum / mine.length).toFixed(5))
}
