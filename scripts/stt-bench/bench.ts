/**
 * How well each transcriber hears real people, with and without context.
 *
 *   node <jiti> scripts/stt-bench/bench.ts [config-id,...]
 *
 * Runs every config (or the ones named, `*` for a prefix) over the clips in
 * `fixtures.ts`, through the same `transcribeWith` the voice bar uses, and
 * prints per set: word error rate with a 95% interval, how many turns came
 * back garbled (half the words wrong or worse), name recall, and latency. Transcripts are cached per
 * config in `.data/stt-bench/results/`, so a rerun only does what is new;
 * delete a file to redo it. Needs the keys in `.env` for the vendor engines.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AGENT_VOICE } from '../../shared/agent-voice'
import type { AgentVoiceSettings } from '../../shared/types'
import { transcribeWith } from '../../server/lib/agent-voice/speech'
import { BENCH_DIR, loadClips, type Clip } from './fixtures'
import { editDistance, nameHit, namesIn, normalize } from './score'

interface Config {
  id: string
  settings: Partial<AgentVoiceSettings>
  context: boolean
  /** Local models share the CPU, so they run one clip at a time. */
  parallel?: number
}

/** Each engine as the app used it before (language guessed, heard cold), then pinned to English, then with context. */
const ENGINES: Array<{ id: string, settings: Partial<AgentVoiceSettings>, parallel?: number }> = [
  { id: 'gemini-3.5-transcribe', settings: { transcriber: 'gemini', geminiTranscribeModel: 'gemini-3.5-transcribe' } },
  { id: 'gemini-3.5-flash', settings: { transcriber: 'gemini', geminiTranscribeModel: 'gemini-3.5-flash' } },
  { id: 'gemini-3.5-flash-lite', settings: { transcriber: 'gemini', geminiTranscribeModel: 'gemini-3.5-flash-lite' } },
  { id: 'gpt-4o-mini-transcribe', settings: { transcriber: 'openai', openaiTranscribeModel: 'gpt-4o-mini-transcribe' } },
  { id: 'gpt-4o-transcribe', settings: { transcriber: 'openai', openaiTranscribeModel: 'gpt-4o-transcribe' } },
  { id: 'gpt-transcribe', settings: { transcriber: 'openai', openaiTranscribeModel: 'gpt-transcribe' } },
  { id: 'whisper-1', settings: { transcriber: 'openai', openaiTranscribeModel: 'whisper-1' } },
  { id: 'local-moonshine-base', settings: { transcriber: 'local', localTranscribeModel: 'onnx-community/moonshine-base-ONNX' }, parallel: 1 },
  { id: 'local-whisper-small.en', settings: { transcriber: 'local', localTranscribeModel: 'onnx-community/whisper-small.en' }, parallel: 1 },
  { id: 'local-whisper-large-v3-turbo', settings: { transcriber: 'local', localTranscribeModel: 'onnx-community/whisper-large-v3-turbo' }, parallel: 1 }
]

/**
 * Apple's SpeechTranscriber, through the "This Mac" engine: only runnable on
 * a Mac with macOS 26. Its DictationTranscriber was measured too, from a
 * Swift probe: 39.3% against 16.9%, and neither used the vocabulary.
 */
const MAC: Config[] = [
  { id: 'apple-speech', settings: { transcriber: 'mac', language: 'en' }, context: false, parallel: 1 },
  { id: 'apple-speech+ctx', settings: { transcriber: 'mac', language: 'en' }, context: true, parallel: 1 }
]

const CONFIGS: Config[] = [...MAC, ...ENGINES.flatMap(engine => [
  { id: engine.id, settings: { ...engine.settings, language: '' }, context: false, parallel: engine.parallel },
  { id: `${engine.id}+ctx`, settings: { ...engine.settings, language: '' }, context: true, parallel: engine.parallel },
  { id: `${engine.id}+en`, settings: { ...engine.settings, language: 'en' }, context: false, parallel: engine.parallel },
  { id: `${engine.id}+en+ctx`, settings: { ...engine.settings, language: 'en' }, context: true, parallel: engine.parallel }
])]

interface Result { text: string, ms: number, error?: string }

async function runConfig(config: Config, clips: Clip[]): Promise<Record<string, Result>> {
  const path = join(BENCH_DIR, 'results', `${config.id}.json`)
  const results: Record<string, Result> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const settings = { ...DEFAULT_AGENT_VOICE, ...config.settings } as AgentVoiceSettings
  const todo = clips.filter(clip => !results[clip.id] || results[clip.id]!.error)
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const clip = todo[next++]!
      const buffer = readFileSync(clip.audioPath)
      const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
      const context = config.context ? { conversation: clip.conversation, vocabulary: clip.vocabulary } : undefined
      const started = Date.now()
      try {
        const text = await transcribeWith(settings, samples, 16000, { context })
        results[clip.id] = { text, ms: Date.now() - started }
      } catch (error) {
        results[clip.id] = { text: '', ms: Date.now() - started, error: String((error as Error)?.message ?? error) }
      }
      // Saved as it goes: a local model takes a while, and a stopped run keeps what it did.
      if (next % 10 === 0) save()
    }
  }
  const save = () => {
    mkdirSync(join(BENCH_DIR, 'results'), { recursive: true })
    writeFileSync(path, JSON.stringify(results, null, 2))
  }
  // Gemini's per-minute token quota is per model, and six at once exceed it.
  await Promise.all(Array.from({ length: config.parallel ?? (settings.transcriber === 'gemini' ? 3 : 6) }, worker))
  save()
  return results
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** A 95% interval on corpus WER, by resampling clips: differences inside it are noise. */
function interval(pairs: Array<[number, number]>): [number, number] {
  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const rates: number[] = []
  for (let round = 0; round < 1000; round++) {
    let edits = 0
    let words = 0
    for (let i = 0; i < pairs.length; i++) {
      const [e, w] = pairs[Math.floor(random() * pairs.length)]!
      edits += e
      words += w
    }
    rates.push(edits / Math.max(1, words))
  }
  rates.sort((a, b) => a - b)
  return [rates[25]!, rates[974]!]
}

const pct = (value: number) => `${(value * 100).toFixed(1)}`

function summarize(config: Config, clips: Clip[], results: Record<string, Result>) {
  const rows: string[] = []
  for (const set of [...new Set(clips.map(clip => clip.set))]) {
    const pairs: Array<[number, number]> = []
    let names = 0
    let hits = 0
    let errors = 0
    let garbled = 0
    const ms: number[] = []
    for (const clip of clips.filter(c => c.set === set)) {
      const result = results[clip.id]
      if (!result || result.error) {
        errors++
        continue
      }
      const reference = normalize(clip.reference)
      const edits = editDistance(reference, normalize(result.text))
      pairs.push([edits, reference.length])
      // A turn this wrong is one the developer has to repeat.
      if (edits / reference.length >= 0.5) garbled++
      for (const name of namesIn(clip.reference)) {
        names++
        if (nameHit(name, result.text)) hits++
      }
      ms.push(result.ms)
    }
    const edits = pairs.reduce((sum, [e]) => sum + e, 0)
    const words = pairs.reduce((sum, [, w]) => sum + w, 0)
    const [low, high] = interval(pairs)
    const wer = words ? `${pct(edits / words)}% (${pct(low)}–${pct(high)})` : '-'
    const recall = names ? `${((hits / names) * 100).toFixed(0)}%` : '-'
    rows.push(`| ${config.id} | ${set} | ${wer} | ${garbled}/${pairs.length} | ${recall} | ${median(ms)} ms |${errors ? ` ${errors} failed` : ''}`)
  }
  return rows
}

const wanted = process.argv[2]?.split(',')
const matches = (id: string) => !wanted || wanted.some(want => want.endsWith('*') ? id.startsWith(want.slice(0, -1)) : want === id)
const clips = await loadClips()
console.log(`${clips.length} clips, ${Math.round(clips.reduce((sum, clip) => sum + clip.seconds, 0))} s of speech\n`)
const lines = ['| config | set | WER (95% interval) | garbled turns | names | median latency |', '| --- | --- | --- | --- | --- | --- |']
for (const config of CONFIGS.filter(c => matches(c.id))) {
  const results = await runConfig(config, clips)
  const rows = summarize(config, clips, results)
  for (const row of rows) console.log(row)
  lines.push(...rows)
  const failures = Object.values(results).filter(result => result.error)
  if (failures.length) console.log(`  first failure: ${failures[0]!.error}`)
}
console.log(`\n${lines.join('\n')}`)
process.exit(0)
