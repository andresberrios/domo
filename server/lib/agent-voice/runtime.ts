import { bus } from '../bus'
import { acpManager } from '../acp/manager'
import { getAgentSession, listRecentUserMessages } from '../repo'
import { pcm16FromBase64 } from '../voice/audio'
import { CLIENT_INPUT_SAMPLE_RATE } from '../voice/backend'
import { needsFullInstructions, spokenContent } from './prompt'
import { joinUtterance, parseSpokenTurn, plainForSpeech, takeClause, takeSentences } from './utterance'
import { concatPcm16, isSilent, synthesize, transcribe } from './speech'
import { COMPLETE_THRESHOLD, endOfTurn } from './turn'
import { endOfTurnKyutai } from './kyutai-speech'
import { EMPTY_SPEECH_CONTEXT, speechContext, type SpeechContext } from './context'
import { getSettings } from '../settings'
import type { AgentEvent, AgentVoiceServerMessage, StreamEvent } from '../../../shared/types'

/**
 * Talking to a coding agent.
 *
 * One of these per agent session that has a voice bar open. It is a cascade
 * rather than a live model: the browser records, the recording is transcribed,
 * the transcript is delivered to the agent as a spoken turn, and whatever the
 * agent writes back is read out sentence by sentence as it streams. The agent
 * is the only thing that thinks. Nothing here decides what to say; it decides
 * only when the developer has finished talking and how to make the agent's
 * text audible.
 *
 * Three rules shape it:
 *
 * **The transcript row is the agent's, not this runtime's.** A spoken turn is
 * a `user_message` like any other, delivered through `acpManager.deliver` with
 * `origin: 'voice'`, and the agent's answer is the `agent_message` block it
 * writes anyway. Closing the voice bar loses nothing; the conversation is in
 * `agent_events`. Speech follows those rows on the bus, the same way a
 * subscriber agent does.
 *
 * **Interrupting speech never interrupts work.** `hush` drops the queue and
 * aborts the sentence being synthesised, and marks the rest of the current
 * answer as not worth reading; the agent's turn runs on. Only `cancel` stops
 * the turn.
 *
 * **Hands-free asks the turn model, never the clock.** A pause is not the end
 * of a thought. When the browser reports one, the whole turn's audio so far
 * goes to Smart Turn (`./turn.ts`); a complete phrase is transcribed and
 * sent, an incomplete one is held for the next segment. Only words end a held
 * turn: the model's verdict on the next pause, a sign-off ("over", "that's
 * it"), a `send`, or a spoken command. What a long silence gets instead is a
 * word from this side, "yes?", the way a listener shows they are still there.
 * Click-to-record has no such ambiguity: the click ends the turn.
 */

type Listener = (message: AgentVoiceServerMessage) => void

/** Shorter than this and it was a click, not a sentence. */
const MIN_SEGMENT_SECONDS = 0.3
/** Sentences waiting together go out as one speech request, up to this much text. */
const MAX_SPEECH_REQUEST_CHARS = 400
/** Hands-free: a held turn nobody adds to for this long gets a "yes?". */
const PROMPT_AFTER_MS = 2500
/** And once more, later, before falling silent. */
const PROMPT_AGAIN_MS = 8000
/** What a listener says to show they are still listening. Picked at random. */
const PROMPTS = ['Yes?', 'Mm-hm.', 'Go on.', 'You were saying?', 'I\'m listening.']
/** A segment this long is worth a quick look for a sign-off before holding it. */
const SIGN_OFF_CHECK_SECONDS = 0.6
/** Hands-free: a turn this long is sent whatever the model thinks. */
const MAX_TURN_SECONDS = 60
/** The speech context is made again after this long even if nothing was said. */
const CONTEXT_TTL_MS = 60_000

interface Block {
  /** How much of the row's text has been seen. */
  seen: number
  /** Seen text not yet cut into a sentence. */
  pending: string
}

export class AgentVoiceRuntime {
  private listeners = new Set<Listener>()
  private closed = false
  private readonly unsubscribe: () => void

  // hearing
  private audio: Int16Array[] = []
  private audioSamples = 0
  /** Hands-free words waiting for the end phrase. */
  private held = ''
  /** Hands-free: the whole turn's audio so far, across pauses the model judged incomplete. */
  private turnAudio: Int16Array[] = []
  private turnSamples = 0
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  /** How many times the held turn has been prompted with a "yes?". */
  private prompted = 0
  private transcribing = 0
  /** Segments are heard in the order they were spoken, however long each takes to transcribe. */
  private hearing: Promise<void> = Promise.resolve()
  /** Words the device's own recogniser heard, not yet taken into a turn. */
  private dictated = ''
  /** What the recogniser is told; made again once the conversation has moved on. */
  private context: { at: number, value: Promise<SpeechContext> } | null = null

  // speaking
  private speak = true
  private queue: string[] = []
  private pumping = false
  private current: AbortController | null = null
  private speakingText: string | null = null
  /** Set by `hush`; the rest of this answer is not read. Cleared by a new turn. */
  private hushed = false
  private blocks = new Map<string, Block>()
  /** Something of the current answer has been said, so the rest waits for whole sentences. */
  private replyStarted = false

  constructor(readonly agentSessionId: string) {
    this.unsubscribe = bus.subscribe((event) => {
      this.onBusEvent(event)
    })
  }

  get listenerCount() {
    return this.listeners.size
  }

  addListener(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.status())
    void this.dictationConfig().then((message) => {
      if (this.listeners.has(listener)) listener(message)
    })
    return () => this.listeners.delete(listener)
  }

  /** Tells the browser whether to transcribe on the device, and with which words. */
  private async dictationConfig(): Promise<AgentVoiceServerMessage> {
    const { agentVoice } = await getSettings()
    const enabled = agentVoice.transcriber === 'browser'
    const phrases = enabled ? (await this.speechContext()).vocabulary : []
    return { type: 'dictation', enabled, language: agentVoice.language, phrases }
  }

  /** The conversation moved on: a new context, and the browser's recogniser told. */
  private refreshContext() {
    this.context = null
    if (!this.listeners.size) return
    void this.dictationConfig().then(message => this.emit(message)).catch(() => {})
  }

  private emit(message: AgentVoiceServerMessage) {
    for (const listener of this.listeners) listener(message)
  }

  private status(): AgentVoiceServerMessage {
    return {
      type: 'status',
      transcribing: this.transcribing > 0,
      speaking: this.speakingText !== null,
      speak: this.speak
    }
  }

  /* ------------------------------ hearing ------------------------------ */

  addDictation(text: string) {
    if (this.closed || !text.trim()) return
    this.clearHold()
    this.prompted = 0
    this.dictated = joinUtterance(this.dictated, text.trim())
    this.emit({ type: 'utterance', text: joinUtterance(this.held, this.dictated) })
  }

  addAudio(base64: string) {
    if (this.closed) return
    // Speech again, so the held turn is not over after all, and the next
    // silence deserves a fresh "yes?".
    this.clearHold()
    this.prompted = 0
    const samples = pcm16FromBase64(base64)
    this.audio.push(samples)
    this.audioSamples += samples.length
  }

  /**
   * The browser stopped hearing speech. What was recorded is transcribed, and
   * the words are either sent (a click ended the turn, or an end phrase did)
   * or held for the next segment.
   */
  segmentEnd(final: boolean): Promise<void> {
    const chunks = this.audio
    const total = this.audioSamples
    this.audio = []
    this.audioSamples = 0
    this.hearing = this.hearing
      .then(() => final ? this.hear(chunks, total, true, false) : this.judge(chunks, total))
      .catch(error => this.emit({ type: 'error', message: describe(error) }))
    return this.hearing
  }

  /**
   * Hands-free: a pause. The segment joins the turn, and the turn model says
   * whether the turn is over. Segments too short or too quiet to be words
   * still count, because a pause inside a sentence is not nothing.
   */
  private async judge(chunks: Int16Array[], total: number): Promise<void> {
    if (total < MIN_SEGMENT_SECONDS * CLIENT_INPUT_SAMPLE_RATE && !this.turnSamples) return
    this.turnAudio.push(...chunks)
    this.turnSamples += total
    const seconds = Math.round((this.turnSamples / CLIENT_INPUT_SAMPLE_RATE) * 10) / 10

    const { agentVoice } = await getSettings()
    const probability = await this.pauseVerdict(agentVoice.turnDetector, agentVoice.kyutaiUrl)
    // With no model to ask, "complete" waits for the silence to run out below.
    let complete = probability !== null && probability >= COMPLETE_THRESHOLD
    // The model hears intonation, not conventions. A sign-off said after a
    // pause it judged incomplete is still a sign-off, so the last segment
    // gets a quick look of its own.
    if (!complete && agentVoice.transcriber === 'browser') {
      if (parseSpokenTurn(this.dictated, { lenient: true }).kind === 'send') complete = true
    } else if (!complete && total >= SIGN_OFF_CHECK_SECONDS * CLIENT_INPUT_SAMPLE_RATE) {
      const tail = await transcribe(concatPcm16(chunks), CLIENT_INPUT_SAMPLE_RATE, { context: await this.speechContext() }).catch(() => '')
      if (parseSpokenTurn(tail, { lenient: true }).kind === 'send') complete = true
    }
    console.log(`[agent-voice:${this.agentSessionId}] pause at ${seconds}s: p(complete)=${probability?.toFixed(3) ?? 'n/a'}${complete ? ', sending' : ', holding'}`)
    this.emit({ type: 'turn', complete, probability, seconds })
    if (complete) {
      await this.finishTurn()
      return
    }
    if (probability === null) this.scheduleSilenceEnd(agentVoice.silenceSeconds)
    else this.scheduleHoldPrompt(PROMPT_AFTER_MS)
  }

  /**
   * What the chosen detector makes of the turn so far: a probability, or
   * `null` for "no opinion", which is what the silence detector always says
   * and what a model that cannot be reached says.
   */
  private async pauseVerdict(detector: 'smart-turn' | 'kyutai' | 'silence', kyutaiUrl: string): Promise<number | null> {
    if (this.turnSamples >= MAX_TURN_SECONDS * CLIENT_INPUT_SAMPLE_RATE) return 1
    switch (detector) {
      case 'silence':
        return null
      case 'kyutai':
        return endOfTurnKyutai(concatPcm16(this.turnAudio), CLIENT_INPUT_SAMPLE_RATE, kyutaiUrl).catch((error) => {
          console.warn(`[agent-voice:${this.agentSessionId}] the Kyutai turn detector failed, waiting for silence instead: ${describe(error)}`)
          return null
        })
      default:
        return endOfTurn(concatPcm16(this.turnAudio))
    }
  }

  /**
   * The conversation and vocabulary a turn is heard with. Kept for a while,
   * since a turn is heard in pieces, and dropped when either side has said
   * something new.
   */
  private speechContext(): Promise<SpeechContext> {
    if (!this.context || Date.now() - this.context.at > CONTEXT_TTL_MS) {
      this.context = {
        at: Date.now(),
        value: speechContext(this.agentSessionId).catch((error) => {
          console.warn(`[agent-voice:${this.agentSessionId}] no speech context: ${describe(error)}`)
          return EMPTY_SPEECH_CONTEXT
        })
      }
    }
    return this.context.value
  }

  /** The silence detector: the turn is over once nothing more has been said for this long. */
  private scheduleSilenceEnd(seconds: number) {
    this.clearHold()
    // The browser already waited half a second before reporting the pause.
    const delay = Math.max(0, seconds * 1000 - 500)
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      this.hearing = this.hearing.then(() => this.finishTurn()).catch(() => {})
    }, delay)
  }

  /** After a while of nothing, a word from this side; then once more; then quiet. */
  private scheduleHoldPrompt(delay: number) {
    this.clearHold()
    if (this.prompted >= 2) return
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      if (!this.turnSamples || this.closed) return
      this.prompted += 1
      this.say(PROMPTS[Math.floor(Math.random() * PROMPTS.length)]!, { aside: true })
      this.scheduleHoldPrompt(PROMPT_AGAIN_MS)
    }, delay)
  }

  private clearHold() {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
  }

  /** The held turn is over: transcribe it whole and deliver it. */
  private async finishTurn(): Promise<void> {
    this.clearHold()
    const chunks = this.turnAudio
    const total = this.turnSamples
    this.turnAudio = []
    this.turnSamples = 0
    this.prompted = 0
    if (!total) return
    await this.hear(chunks, total, true, true)
  }

  /** `lenient` is for a held hands-free turn, where a trailing bare "over" is the sign-off. */
  private async hear(chunks: Int16Array[], total: number, final: boolean, lenient = true): Promise<void> {
    const seconds = Math.round((total / CLIENT_INPUT_SAMPLE_RATE) * 10) / 10
    const tag = `[agent-voice:${this.agentSessionId}]`
    const { agentVoice } = await getSettings()
    if (agentVoice.transcriber === 'browser') {
      // The device already heard it; the words came ahead of this segment's end.
      const text = this.dictated
      this.dictated = ''
      console.log(`${tag} segment of ${seconds}s dictated on the device: ${JSON.stringify(text)}`)
      if (!text.trim()) this.emit({ type: 'nothing-heard', reason: 'no-speech', seconds })
      await this.heard(text, final, lenient)
      return
    }
    if (total < MIN_SEGMENT_SECONDS * CLIENT_INPUT_SAMPLE_RATE) {
      console.log(`${tag} segment of ${seconds}s: too short`)
      this.emit({ type: 'nothing-heard', reason: 'too-short', seconds })
      if (final) await this.sendHeld()
      return
    }
    const samples = concatPcm16(chunks)
    if (isSilent(samples)) {
      console.log(`${tag} segment of ${seconds}s: silent`)
      this.emit({ type: 'nothing-heard', reason: 'silent', seconds })
      if (final) await this.sendHeld()
      return
    }

    let text = ''
    this.transcribing += 1
    this.emit(this.status())
    const started = Date.now()
    try {
      text = await transcribe(samples, CLIENT_INPUT_SAMPLE_RATE, { context: await this.speechContext() })
    } catch (error) {
      console.warn(`${tag} could not transcribe: ${describe(error)}`)
      this.emit({ type: 'error', message: `Could not transcribe: ${describe(error)}` })
    } finally {
      this.transcribing -= 1
      this.emit(this.status())
    }
    // One line per segment, because "it did not hear me" is only debuggable
    // with the numbers: how long, how loud, how long it took, what came back.
    console.log(`${tag} segment of ${seconds}s (rms ${rms(samples)}) transcribed in ${Date.now() - started}ms: ${JSON.stringify(text)}`)
    if (this.closed) return
    if (!text.trim()) this.emit({ type: 'nothing-heard', reason: 'no-speech', seconds })
    await this.heard(text, final, lenient)
  }

  private async heard(text: string, final: boolean, lenient = false): Promise<void> {
    const turn = parseSpokenTurn(text, { lenient })
    switch (turn.kind) {
      case 'hush':
        this.hush()
        this.emit({ type: 'command', name: 'hush' })
        return
      case 'cancel':
        await this.cancel()
        this.emit({ type: 'command', name: 'cancel' })
        return
      case 'send':
        this.held = joinUtterance(this.held, turn.text)
        this.emit({ type: 'command', name: 'send' })
        await this.sendHeld()
        return
      case 'partial':
        this.held = joinUtterance(this.held, turn.text)
        if (final) await this.sendHeld()
        else this.emit({ type: 'utterance', text: this.held })
        return
      case 'empty':
        if (final) await this.sendHeld()
    }
  }

  /** Hands-free: what has been held so far is the turn. */
  async send(): Promise<void> {
    await this.finishTurn()
    await this.sendHeld()
  }

  discard() {
    this.clearHold()
    this.held = ''
    this.dictated = ''
    this.audio = []
    this.audioSamples = 0
    this.turnAudio = []
    this.turnSamples = 0
    this.prompted = 0
    this.emit({ type: 'utterance', text: '' })
  }

  private async sendHeld(): Promise<void> {
    const text = this.held.trim()
    this.held = ''
    this.emit({ type: 'utterance', text: '' })
    if (!text || this.closed) return

    const session = await getAgentSession(this.agentSessionId)
    if (!session) {
      this.emit({ type: 'error', message: 'This agent session no longer exists' })
      return
    }

    // The developer has spoken again, so whatever was still being read out
    // is stale, and the answer to *this* is wanted out loud even if they had
    // said "stop" before.
    this.dropSpeech()
    this.hushed = false
    this.replyStarted = false
    this.refreshContext()
    this.emit({ type: 'sent', text })
    try {
      const full = needsFullInstructions(await listRecentUserMessages(session.id))
      await acpManager.deliver(session.id, {
        content: spokenContent(text, { full }),
        delivery: 'steer',
        origin: 'voice'
      })
    } catch (error) {
      this.emit({ type: 'error', message: `The agent could not take that: ${describe(error)}` })
    }
  }

  /* ------------------------------ speaking ----------------------------- */

  setSpeak(enabled: boolean) {
    this.speak = enabled
    if (!enabled) this.dropSpeech()
    this.emit(this.status())
  }

  /** Be quiet for the rest of this answer. The agent keeps working. */
  hush() {
    this.hushed = true
    for (const block of this.blocks.values()) block.pending = ''
    this.dropSpeech()
  }

  /** Stop the agent's turn, and the speech with it. */
  async cancel(): Promise<void> {
    this.dropSpeech()
    try {
      await acpManager.cancel(this.agentSessionId)
    } catch (error) {
      this.emit({ type: 'error', message: `Could not cancel: ${describe(error)}` })
    }
  }

  private dropSpeech() {
    this.queue = []
    this.current?.abort()
    this.current = null
    this.emit({ type: 'hushed' })
  }

  /** An `aside` is this side's own word ("yes?"), and is said even after a hush. */
  private say(text: string, options: { aside?: boolean } = {}) {
    if (this.closed || !this.speak || (this.hushed && !options.aside)) return
    const clean = plainForSpeech(text)
    if (!clean) return
    this.queue.push(clean)
    void this.pump()
  }

  /**
   * One synthesis at a time, in order, each streamed to the browser as it
   * arrives. Sentences that piled up while the previous one was being made go
   * out together: the speech model charges a request's latency per call, and
   * the browser plays whatever it is given back to back either way.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length && !this.closed) {
        const { agentVoice } = await getSettings()
        if (agentVoice.speaker === 'browser') {
          // The device says it, as each piece arrives; there is nothing to make here.
          const text = this.queue.shift()!
          this.emit({ type: 'speaking', text })
          this.emit({ type: 'say', text })
          continue
        }
        let text = this.queue.shift()!
        while (this.queue.length && text.length + this.queue[0]!.length < MAX_SPEECH_REQUEST_CHARS) {
          text += ` ${this.queue.shift()!}`
        }
        const controller = new AbortController()
        this.current = controller
        this.speakingText = text
        this.emit({ type: 'speaking', text })
        this.emit(this.status())
        try {
          await synthesize(text, (chunk) => {
            if (!controller.signal.aborted) this.emit({ type: 'audio', ...chunk })
          }, controller.signal)
        } catch (error) {
          if (!controller.signal.aborted) {
            console.warn(`[agent-voice:${this.agentSessionId}] could not speak: ${describe(error)}`)
            this.emit({ type: 'error', message: `Could not speak: ${describe(error)}` })
          }
        }
        if (this.current === controller) this.current = null
      }
    } finally {
      this.pumping = false
      this.speakingText = null
      this.emit({ type: 'speaking', text: null })
      this.emit(this.status())
    }
  }

  /* ------------------------------ following ---------------------------- */

  private onBusEvent(event: StreamEvent) {
    if (this.closed) return
    // A change in Settings reaches an open bar at once: the browser starts or
    // stops its own recogniser without a reconnect.
    if (event.type === 'settings-changed') {
      if (this.listeners.size) void this.dictationConfig().then(message => this.emit(message)).catch(() => {})
      return
    }
    if (event.type !== 'agent-event' || event.agentSessionId !== this.agentSessionId) return
    const { event: row } = event
    switch (row.type) {
      case 'agent_message':
        this.onMessage(row)
        return
      case 'turn_end':
        this.flushBlocks()
        this.hushed = false
        this.replyStarted = false
        this.refreshContext()
        return
      case 'tool_call':
        this.emit({ type: 'tool', title: String(row.payload?.title ?? 'a tool') })
        return
      case 'permission_request':
        this.say(`It needs permission: ${String(row.payload?.toolCall?.title ?? row.payload?.title ?? 'a tool call')}. Answer on screen.`)
        return
      case 'error':
        this.flushBlocks()
        this.say('The turn failed. The error is on screen.')
    }
  }

  /** A streaming row grew, or closed. Speak the sentences that are now complete. */
  private onMessage(row: AgentEvent) {
    const text: string = row.payload?.text ?? ''
    const streaming = row.payload?.streaming === true
    let block = this.blocks.get(row.id)
    if (!block) {
      block = { seen: 0, pending: '' }
      this.blocks.set(row.id, block)
    }
    if (text.length > block.seen) {
      block.pending += text.slice(block.seen)
      block.seen = text.length
    }
    const { sentences, rest } = takeSentences(block.pending)
    block.pending = rest
    for (const sentence of sentences) this.say(sentence)
    // Nothing said yet in this answer: the first clause goes without waiting
    // for its sentence to end.
    if (!this.replyStarted && !sentences.length && streaming) {
      const first = takeClause(block.pending)
      if (first) {
        block.pending = first.rest
        this.say(first.clause)
        this.replyStarted = true
      }
    }
    if (sentences.length) this.replyStarted = true
    if (!streaming) {
      if (block.pending.trim()) this.say(block.pending)
      this.blocks.delete(row.id)
    }
  }

  private flushBlocks() {
    for (const [id, block] of this.blocks) {
      if (block.pending.trim()) this.say(block.pending)
      this.blocks.delete(id)
    }
  }

  close() {
    this.closed = true
    this.clearHold()
    this.unsubscribe()
    this.queue = []
    this.current?.abort()
    this.current = null
    this.listeners.clear()
  }
}

function rms(samples: Int16Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i += 4) sum += samples[i]! * samples[i]!
  return Math.round(Math.sqrt(sum / Math.ceil(samples.length / 4)))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error)
}

class AgentVoiceManager {
  private runtimes = new Map<string, AgentVoiceRuntime>()

  get(agentSessionId: string): AgentVoiceRuntime {
    let runtime = this.runtimes.get(agentSessionId)
    if (!runtime) {
      runtime = new AgentVoiceRuntime(agentSessionId)
      this.runtimes.set(agentSessionId, runtime)
    }
    return runtime
  }

  peek(agentSessionId: string): AgentVoiceRuntime | undefined {
    return this.runtimes.get(agentSessionId)
  }

  close(agentSessionId: string) {
    this.runtimes.get(agentSessionId)?.close()
    this.runtimes.delete(agentSessionId)
  }
}

const globalKey = '__domo_agent_voice_manager__'
const g = globalThis as any
export const agentVoiceManager: AgentVoiceManager = g[globalKey] ?? (g[globalKey] = new AgentVoiceManager())
