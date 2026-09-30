import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { dataDir } from '../paths'
import { EMPTY_SPEECH_CONTEXT, type SpeechContext } from './context'
import { wavFromPcm16, type SpeechChunk } from './speech'

const run = promisify(execFile)

/**
 * The Mac's own speech, when Domo runs on one: Apple's voices through
 * AVSpeechSynthesizer, and Apple's on-device recogniser through
 * SpeechAnalyzer (macOS 26). Both are free, local and fast (measured on an
 * M1 Max: the first audio in 30-70 ms at about 30x real time, a 10 s clip
 * heard in about 0.4 s), and neither asks for a permission. The older
 * SFSpeechRecognizer does, through a GUI a server cannot show.
 *
 * Node cannot call those frameworks, so each direction is a small Swift
 * program, compiled here with `swiftc` on first use (the Xcode command line
 * tools) and kept running, one JSON request per line on stdin and one
 * answer per line on stdout. The sources are below rather than in files so
 * a build ships them without tracing.
 */

const SAY_SOURCE = String.raw`
import AVFoundation
import Foundation

struct Request: Decodable { let id: Int; let text: String?; let voice: String?; let language: String?; let list: Bool? }

let synth = AVSpeechSynthesizer()
let lock = NSLock()
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  lock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  lock.unlock()
}

/** The voice asked for, else the best one installed for the language. */
func voice(_ identifier: String?, _ language: String?) -> AVSpeechSynthesisVoice? {
  if let identifier, !identifier.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: identifier) { return chosen }
  let prefix = (language?.isEmpty == false ? language! : "en").lowercased()
  let candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.lowercased().hasPrefix(prefix) }
  return candidates.max { $0.quality.rawValue < $1.quality.rawValue }
}

func speak(_ request: Request) {
  // AVSpeechSynthesizer never calls back for blank text, which would block this loop forever.
  if (request.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    emit(["id": request.id, "done": true])
    return
  }
  let utterance = AVSpeechUtterance(string: request.text ?? "")
  utterance.voice = voice(request.voice, request.language)
  let done = DispatchSemaphore(value: 0)
  synth.write(utterance) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    let frames = Int(pcm.frameLength)
    if frames == 0 { done.signal(); return }
    var samples = [Int16](repeating: 0, count: frames)
    if let floats = pcm.floatChannelData?[0] {
      for i in 0..<frames { samples[i] = Int16(max(-1, min(1, floats[i])) * 32767) }
    } else if let ints = pcm.int16ChannelData?[0] {
      for i in 0..<frames { samples[i] = ints[i] }
    }
    let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
    emit(["id": request.id, "rate": pcm.format.sampleRate, "pcm": data.base64EncodedString()])
  }
  done.wait()
  emit(["id": request.id, "done": true])
}

DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else { continue }
    if request.list == true {
      let voices = AVSpeechSynthesisVoice.speechVoices().map {
        ["id": $0.identifier, "name": $0.name, "language": $0.language, "quality": $0.quality.rawValue] as [String: Any]
      }
      emit(["id": request.id, "voices": voices])
      continue
    }
    speak(request)
  }
  exit(0)
}
dispatchMain()
`

const HEAR_SOURCE = String.raw`
import AVFoundation
import Foundation
import Speech

struct Request: Decodable { let id: Int; let wav: String; let locale: String; let context: [String]; let dictation: Bool }

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func transcribe(_ request: Request) async throws -> String {
  let locale = Locale(identifier: request.locale)
  let analyzer: SpeechAnalyzer
  let collector: Task<String, Error>
  if request.dictation {
    let transcriber = DictationTranscriber(locale: locale, preset: .shortDictation)
    if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await install.downloadAndInstall() }
    analyzer = SpeechAnalyzer(modules: [transcriber])
    collector = Task { var text = ""; for try await result in transcriber.results { text += String(result.text.characters) }; return text }
  } else {
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
    if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await install.downloadAndInstall() }
    analyzer = SpeechAnalyzer(modules: [transcriber])
    collector = Task { var text = ""; for try await result in transcriber.results { text += String(result.text.characters) }; return text }
  }
  if !request.context.isEmpty {
    let context = AnalysisContext()
    context.contextualStrings[.general] = request.context
    try await analyzer.setContext(context)
  }
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: request.wav))
  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  return try await collector.value.trimmingCharacters(in: .whitespacesAndNewlines)
}

@main struct Main {
  static func main() async {
    while let line = readLine() {
      guard let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else { continue }
      do {
        emit(["id": request.id, "text": try await transcribe(request)])
      } catch {
        emit(["id": request.id, "error": "\(error)"])
      }
    }
  }
}
`

/** Apple's recognisers take a full locale; Settings stores the language alone. */
const LOCALES: Record<string, string> = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', ja: 'ja-JP', zh: 'zh-CN' }
/** SpeechAnalyzer takes contextual strings; a long list is truncated by the framework anyway. */
const CONTEXT_TERMS = 100
/**
 * Which of Apple's two recognisers. SpeechTranscriber: 16.9% word errors on
 * the benchmark's real speech, in a median 0.18 s. DictationTranscriber made
 * 39.3%, and 66% on a distant microphone. Neither changed with the
 * vocabulary, which is still sent in case a later macOS uses it.
 */
const USE_DICTATION = false

export function macSpeechUnavailable(): string | null {
  return process.platform === 'darwin' ? null : 'This Mac\'s speech needs Domo running on macOS.'
}

interface Waiter { onLine: (message: any) => void }

/** One compiled Swift program, kept running, answering one JSON line per request. */
class Helper {
  private process: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<ChildProcessWithoutNullStreams> | null = null
  private waiters = new Map<number, Waiter>()
  private nextId = 1

  /** `library`: the source has an @main entry point, not top-level code. */
  constructor(private readonly name: string, private readonly source: string, private readonly library: boolean) {}

  private async binary(): Promise<string> {
    const hash = createHash('sha256').update(this.source).digest('hex').slice(0, 12)
    const dir = join(dataDir(), 'mac-speech')
    const path = join(dir, `${this.name}-${hash}`)
    if (existsSync(path)) return path
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${this.name}-${hash}.swift`)
    await writeFile(file, this.source)
    console.log(`[agent-voice] compiling the Mac's ${this.name} helper (once)`)
    try {
      await run('swiftc', ['-O', ...this.library ? ['-parse-as-library'] : [], file, '-o', path], { timeout: 300_000 })
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error('This Mac\'s speech needs the Xcode command line tools: run xcode-select --install', { cause: error })
      throw new Error(`Could not build the Mac's ${this.name} helper: ${String(error?.stderr || error?.message || error).slice(0, 400)}`, { cause: error })
    }
    return path
  }

  private start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.process) return Promise.resolve(this.process)
    if (!this.starting) {
      this.starting = this.binary().then((path) => {
        const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] })
        createInterface({ input: child.stdout }).on('line', (line) => {
          let message: any
          try {
            message = JSON.parse(line)
          } catch {
            return
          }
          this.waiters.get(message.id)?.onLine(message)
        })
        child.stderr.on('data', (chunk) => {
          console.warn(`[agent-voice] mac ${this.name}: ${String(chunk).trim().slice(0, 300)}`)
        })
        child.on('exit', (code) => {
          this.process = null
          for (const waiter of this.waiters.values()) waiter.onLine({ error: `the Mac's ${this.name} helper stopped (${code})` })
          this.waiters.clear()
        })
        this.process = child
        return child
      }).finally(() => { this.starting = null })
    }
    return this.starting
  }

  /** Send a request; `onLine` sees every answer to it until it calls `done`. */
  async request(body: Record<string, unknown>, onLine: (message: any, done: () => void) => void): Promise<void> {
    const child = await this.start()
    const id = this.nextId++
    await new Promise<void>((resolve) => {
      const done = () => {
        this.waiters.delete(id)
        resolve()
      }
      this.waiters.set(id, { onLine: message => onLine(message, done) })
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`)
    })
  }
}

const say = new Helper('say', SAY_SOURCE, false)
const hear = new Helper('hear', HEAR_SOURCE, true)

export async function transcribeMac(
  samples: Int16Array,
  sampleRate: number,
  language: string,
  context: SpeechContext = EMPTY_SPEECH_CONTEXT
): Promise<string> {
  const unavailable = macSpeechUnavailable()
  if (unavailable) throw new Error(unavailable)
  const dir = join(dataDir(), 'mac-speech', 'turns')
  await mkdir(dir, { recursive: true })
  const wav = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
  await writeFile(wav, wavFromPcm16(samples, sampleRate))
  try {
    let text = ''
    let failure: string | null = null
    await hear.request(
      { wav, locale: LOCALES[language] ?? 'en-US', context: context.vocabulary.slice(0, CONTEXT_TERMS), dictation: USE_DICTATION },
      (message, done) => {
        if (message.error) failure = String(message.error)
        else text = String(message.text ?? '')
        done()
      }
    )
    if (failure) throw new Error(failure)
    return text.replace(/\s+/g, ' ').trim()
  } finally {
    await rm(wav, { force: true })
  }
}

export async function synthesizeMac(
  text: string,
  voice: string,
  language: string,
  onChunk: (chunk: SpeechChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  const unavailable = macSpeechUnavailable()
  if (unavailable) throw new Error(unavailable)
  if (!text.trim()) return
  let failure: string | null = null
  await say.request({ text, voice, language }, (message, done) => {
    if (message.error) {
      failure = String(message.error)
      done()
    } else if (message.done) {
      done()
    } else if (message.pcm && !signal?.aborted) {
      onChunk({ data: message.pcm, sampleRate: Number(message.rate) || 22050 })
    }
  })
  if (failure && !signal?.aborted) throw new Error(failure)
}

export interface MacVoice { id: string, name: string, language: string, quality: number }

/** The voices installed on this Mac. Quality is Apple's: 1 default, 2 enhanced, 3 premium. */
export async function macVoices(): Promise<MacVoice[]> {
  if (macSpeechUnavailable()) return []
  let voices: MacVoice[] = []
  await say.request({ list: true }, (message, done) => {
    voices = Array.isArray(message.voices) ? message.voices : []
    done()
  })
  return voices
}
