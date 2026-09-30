/**
 * Real people, talking: stretches of consecutive utterances from two public
 * corpora, each with the utterances before it as conversation context and a
 * vocabulary drawn from the rest of the same recording.
 *
 * - Earnings-22 (CC BY-SA 4.0): earnings calls from companies around the
 *   world, accented speakers on conference-call audio, dense with company,
 *   product and finance names. The stand-in for a developer's jargon.
 * - AMI, single distant microphone (CC BY 4.0): meetings recorded by one mic
 *   on the table, with room echo, crosstalk, hesitations and mumbling. The
 *   stand-in for a phone on a desk in a noisy room.
 *
 * The vocabulary never comes from the stretch under test, only from the rest
 * of the recording, the way a project's docs mention its terms without
 * containing what the developer is about to say.
 *
 * Audio is fetched through the Hugging Face dataset server into
 * `.data/stt-bench/` once, and read from there after.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { termsFromText } from '../../server/lib/agent-voice/context'

export interface Clip {
  id: string
  set: string
  reference: string
  /** The utterances just before, oldest first. */
  conversation: string
  vocabulary: string[]
  /** 16 kHz mono PCM16, on disk. */
  audioPath: string
  seconds: number
}

interface Source {
  set: string
  dataset: string
  config: string
  split: string
  group: string
  start: string
  end: string
  text: string
  /** Where to look for a long recording, in dataset row numbers. */
  offsets: number[]
}

const SOURCES: Source[] = [
  {
    set: 'earnings22',
    dataset: 'distil-whisper/earnings22',
    config: 'chunked',
    split: 'test',
    group: 'file_id',
    start: 'start_ts',
    end: 'end_ts',
    text: 'transcription',
    offsets: [0, 9500, 19000, 28500, 38000, 47500]
  },
  {
    set: 'ami-sdm',
    dataset: 'edinburghcstr/ami',
    config: 'sdm',
    split: 'test',
    group: 'meeting_id',
    start: 'begin_time',
    end: 'end_time',
    text: 'text',
    offsets: [0, 2500, 5000, 7500, 10000]
  }
]

const PER_RECORDING = 24
const CONTEXT_UTTERANCES = 6
const ROWS_PER_LOOK = 600

export const BENCH_DIR = join(process.cwd(), '.data', 'stt-bench')

/** The dataset server drops connections and rate-limits; patience gets through. */
async function get(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok || attempt >= 8) return response
    } catch (error) {
      if (attempt >= 8) throw error
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 5000))
  }
}

async function rows(source: Source, offset: number): Promise<any[]> {
  // The audio links in a listing expire, so a cached listing is only good for
  // clips whose audio is already on disk; it spares the rate limit on a rerun.
  const cache = join(BENCH_DIR, 'rows', `${source.set}-${offset}.json`)
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'))
  const out: any[] = []
  for (let at = offset; at < offset + ROWS_PER_LOOK; at += 100) {
    const params = new URLSearchParams({ dataset: source.dataset, config: source.config, split: source.split, offset: String(at), length: '100' })
    const response = await get(`https://datasets-server.huggingface.co/rows?${params}`)
    if (!response.ok) throw new Error(`${source.dataset} rows ${at}: ${response.status}`)
    const json = await response.json() as { rows: Array<{ row: any }> }
    out.push(...json.rows.map(row => row.row))
  }
  mkdirSync(join(BENCH_DIR, 'rows'), { recursive: true })
  writeFileSync(cache, JSON.stringify(out))
  return out
}

/** A WAV file to 16 kHz mono PCM16. */
function pcm16k(wav: Buffer): Int16Array {
  const channels = wav.readUInt16LE(22)
  const rate = wav.readUInt32LE(24)
  const float = wav.readUInt16LE(20) === 3
  const bytes = wav.readUInt16LE(34) / 8
  const sample = (at: number) => bytes === 2
    ? data.readInt16LE(at)
    : float ? data.readFloatLE(at) * 32767 : data.readInt32LE(at) / 65536
  const at = wav.indexOf('data', 12, 'ascii')
  const data = wav.subarray(at + 8)
  const frames = Math.floor(data.length / (bytes * channels))
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += sample((i * channels + c) * bytes)
    mono[i] = sum / channels
  }
  const ratio = rate / 16000
  const out = new Int16Array(Math.floor(frames / ratio))
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio
    const j = Math.floor(p)
    const a = mono[j] ?? 0
    const b = mono[j + 1] ?? a
    out[i] = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * (p - j))))
  }
  return out
}

/**
 * AMI writes in capitals without punctuation, and a recogniser primed with
 * that copies it, loops on it, and is scored on a style no Domo conversation
 * has. Context is given in sentence case, the way messages are written.
 */
function asProse(text: string): string {
  if (text !== text.toUpperCase()) return text
  const lower = text.toLowerCase().replace(/\bi\b/g, 'I').replace(/\bi'/g, 'I\'')
  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}.`
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

async function clipsFrom(source: Source, offset: number): Promise<Clip[]> {
  const all = await rows(source, offset)
  const groups = new Map<string, any[]>()
  for (const row of all) groups.set(row[source.group], [...(groups.get(row[source.group]) ?? []), row])
  const recording = [...groups.values()].sort((a, b) => b.length - a.length)[0]!
  recording.sort((a, b) => a[source.start] - b[source.start])

  // A stretch from the middle, of utterances long enough to be a turn.
  const chosen: number[] = []
  for (let i = Math.floor(recording.length / 3); i < recording.length && chosen.length < PER_RECORDING; i++) {
    const row = recording[i]
    const seconds = row[source.end] - row[source.start]
    if (seconds >= 2 && seconds <= 15 && wordCount(row[source.text]) >= 6) chosen.push(i)
  }
  const inStretch = new Set(recording.slice(chosen[0], chosen.at(-1)! + 1))
  const elsewhere = recording.filter(row => !inStretch.has(row)).map(row => row[source.text]).join('\n')
  // AMI is written in capitals, which leaves no names to find; it is heard
  // with the conversation alone.
  const vocabulary = elsewhere === elsewhere.toUpperCase() ? [] : [...termsFromText(elsewhere).entries()].sort((a, b) => b[1] - a[1]).map(([term]) => term).slice(0, 80)

  const clips: Clip[] = []
  for (const index of chosen) {
    const row = recording[index]
    const id = `${source.set}-${row[source.group]}-${index}`
    const audioPath = join(BENCH_DIR, 'audio', `${id}.pcm`)
    if (!existsSync(audioPath)) {
      const response = await get(row.audio[0].src)
      if (!response.ok) throw new Error(`${id} audio: ${response.status}`)
      writeFileSync(audioPath, Buffer.from(pcm16k(Buffer.from(await response.arrayBuffer())).buffer))
    }
    const samples = readFileSync(audioPath).length / 2
    clips.push({
      id,
      set: source.set,
      reference: row[source.text],
      conversation: recording.slice(Math.max(0, index - CONTEXT_UTTERANCES), index).map(r => asProse(r[source.text])).join('\n'),
      vocabulary,
      audioPath,
      seconds: Math.round((samples / 16000) * 10) / 10
    })
  }
  return clips
}

export async function loadClips(): Promise<Clip[]> {
  const index = join(BENCH_DIR, 'clips.json')
  if (existsSync(index)) return JSON.parse(readFileSync(index, 'utf8'))
  mkdirSync(join(BENCH_DIR, 'audio'), { recursive: true })
  const clips: Clip[] = []
  for (const source of SOURCES) {
    for (const offset of source.offsets) {
      const found = await clipsFrom(source, offset)
      console.log(`${source.set} @${offset}: ${found.length} clips from ${found[0]?.id.split('-').slice(0, -1).join('-')}`)
      clips.push(...found)
    }
  }
  writeFileSync(index, JSON.stringify(clips, null, 2))
  return clips
}
