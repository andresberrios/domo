import { readFileSync, writeFileSync } from 'node:fs'
import { env, pipeline } from '@huggingface/transformers'
import { KokoroTTS, TextSplitterStream } from 'kokoro-js'
env.cacheDir = '/tmp/domo-data/models/hf'
const load = f => { const b = readFileSync(f); const pcm = new Int16Array(b.buffer, b.byteOffset, b.length >> 1); return Float32Array.from(pcm, v => v / 32768) }

let t = Date.now()
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })
console.log('kokoro loaded in', Date.now() - t, 'ms')
for (const text of ["Let me check what's in the current directory.", "You've got three files here: a readme, a TypeScript index file, and a package file."]) {
  t = Date.now(); const audio = await tts.generate(text, { voice: 'am_michael' })
  console.log('kokoro', JSON.stringify(text.slice(0, 30)), 'audio', (audio.audio.length / audio.sampling_rate).toFixed(1) + 's', 'rate', audio.sampling_rate, 'in', Date.now() - t, 'ms')
}
t = Date.now(); let first = null; let n = 0
const splitter = new TextSplitterStream(); const stream = tts.stream(splitter, { voice: 'am_michael' })
splitter.push("Same three files as before. The readme has four lines. Nothing here needs attention right now, but tell me if you want tests added."); splitter.close()
for await (const { text, audio } of stream) { n++; if (!first) first = Date.now() - t }
console.log('kokoro stream: first chunk at', first, 'ms,', n, 'chunks, total', Date.now() - t, 'ms')

for (const model of ['onnx-community/moonshine-base-ONNX', 'onnx-community/whisper-base']) {
  try {
    t = Date.now()
    const asr = await pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'cpu' })
    console.log(model, 'loaded in', Date.now() - t, 'ms')
    for (const f of ['/tmp/fx-click.pcm', '/tmp/fx-hf2.pcm']) { t = Date.now(); const out = await asr(load(f)); console.log(' ', f, Date.now() - t, 'ms', JSON.stringify(out.text)) }
  } catch (e) { console.log(model, 'failed:', e.message.slice(0, 200)) }
}
