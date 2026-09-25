import { bus } from '../bus'
import { getSettings } from '../settings'
import {
  appendVoiceMessage,
  countVoiceMessagesAfter,
  getVoiceSession,
  listAgentSessions,
  listVoiceMessages,
  setVoiceUsage,
  updateVoiceSession
} from '../repo'
import { CONTEXT_MESSAGE_LIMIT, compactConversation, ensureCompacted } from './compaction'
import { buildConversationContext } from './context'
import { GeminiBackend } from './gemini-backend'
import { OpenAiBackend } from './openai-backend'
import { voiceTools } from './tools'
import type {
  VoiceBackend,
  VoiceHost,
  VoiceNote,
  VoiceToolCall,
  VoiceToolResult,
  VoiceUsageReading
} from './backend'
import type { VoiceProvider, VoiceServerMessage, VoiceUsage } from '../../../shared/types'

/** The model waits on every tool response, so a hung handler must not silence it. */
const TOOL_TIMEOUT_MS = 30000
/**
 * How long after the last input transcription the user still counts as
 * speaking. Transcription arrives in bursts with gaps inside a single sentence,
 * so "silent" has to mean a gap longer than those — long enough not to cut in
 * mid-sentence, short enough that a note is not held for a noticeable beat.
 */
const USER_SILENCE_MS = 1500

/**
 * How often the conversation's context reading is written.
 *
 * `voice_sessions` is synced with `REPLICA IDENTITY FULL`, so each write
 * re-streams the whole row; a usage frame arrives with most server messages.
 * Same trade as the coding agents' own reading: often enough that the bar moves
 * while the model talks, rarely enough that it is not a write per packet.
 */
const USAGE_WRITE_MS = 5000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s; it may still finish in the background`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

type Listener = (message: VoiceServerMessage) => void

/**
 * One live conversation, owned by the server so tool calls, persistence and
 * proactive notifications all happen in one place. Browsers attach and detach
 * freely; the conversation outlives any single tab.
 *
 * Provider-agnostic on purpose. Which live model is speaking is read from
 * Settings at every connect and turned into a `VoiceBackend` (`./backend.ts`),
 * so a conversation is not tied to the vendor it started on: change the
 * setting, reconnect, and the same history is handed to the other model. What
 * stays here is everything the *conversation* is made of — the transcript
 * rows, the fold, the note gate and its single drain, the throttled usage
 * write, the tool log, the hand-over to a fresh conversation.
 */
class VoiceRuntime {
  readonly voiceSessionId: string
  private backend: VoiceBackend | null = null
  private listeners = new Set<Listener>()
  private connecting: Promise<void> | null = null
  private closed = false
  private reconnectAttempts = 0
  /**
   * Bumped on every connect and close. A host handed to an older socket (one
   * replaced after a `goAway`, say) compares against it and bows out, so a late
   * callback cannot write to the conversation that replaced it.
   */
  private generation = 0
  /** Tool calls the model is still waiting on. */
  private pendingToolCalls = 0
  /**
   * Notes written to the transcript but not yet handed to the model, oldest
   * first. The row is stored when the note is made, so the UI shows it at once;
   * only the *delivery* waits. See `injectNote`.
   */
  private deferredNotes: VoiceNote[] = []
  /** True between the first sign of a model turn and the end of it. */
  private modelSpeaking = false
  /** When input transcription was last seen, i.e. when the user was last heard. */
  private lastUserSpeechAt = 0
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * A conversation that `start_new_conversation` replaced. Listeners follow it
   * once the sign-off turn is over, so the goodbye isn't cut off mid-word.
   */
  private handOverTo: string | null = null
  private handOverTimer: ReturnType<typeof setTimeout> | null = null
  private handedOver = false

  private userTranscript = ''
  private assistantTranscript = ''
  /** The latest context reading, and what the row already holds. */
  private usage: VoiceUsage | null = null
  private writtenUsage: VoiceUsage | null = null
  private usageTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Provider events are handled one at a time. They arrive without waiting for
   * the previous handler, so concurrent flushes would store transcript rows out
   * of order.
   */
  private inbox: Promise<void> = Promise.resolve()
  private unsubscribeBus: (() => void) | null = null
  private notifiedTurns = new Set<string>()
  /**
   * Tools the current backend resolves itself — MCP servers it connected on
   * its own. Cleared with the socket, because they belong to it.
   */
  private extraTools: Record<string, (args: any) => Promise<unknown>> = {}
  /** A failed connect is remembered briefly: 8 audio chunks a second must not
   *  turn one misconfiguration into a storm of identical errors. */
  private connectError: { message: string, at: number } | null = null

  constructor(voiceSessionId: string) {
    this.voiceSessionId = voiceSessionId
  }

  get live() {
    return !!this.backend
  }

  /** Which live model this conversation is currently talking through. */
  get provider(): VoiceProvider | null {
    return this.backend?.provider ?? null
  }

  addListener(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get listenerCount() {
    return this.listeners.size
  }

  private emit(message: VoiceServerMessage) {
    for (const listener of this.listeners) {
      try {
        listener(message)
      } catch {
        /* a dead socket must not break the others */
      }
    }
  }

  /* ---------------------------- lifecycle ---------------------------- */

  async ensureConnected(): Promise<void> {
    if (this.backend) return
    if (this.connectError && Date.now() - this.connectError.at < 10000) {
      throw new Error(this.connectError.message)
    }
    if (!this.connecting) {
      this.connecting = this.connect()
        .then(() => {
          this.connectError = null
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.connectError = { message, at: Date.now() }
          throw error
        })
        .finally(() => {
          this.connecting = null
        })
    }
    return this.connecting
  }

  private async systemInstruction(): Promise<string> {
    const settings = await getSettings()
    const agents = await listAgentSessions()
    const roster = agents.length
      ? agents
          .map(agent => `- ${agent.title} (id: ${agent.id}, status: ${agent.status}, dir: ${agent.cwd})`)
          .join('\n')
      : '- (no coding agents yet)'

    // The conversation is the row and its messages, not the socket: whatever
    // this connect is (a first one, a `goAway` reconnect, a fresh session after
    // a tool change, a server restart, a switch to the other provider), the
    // model is handed the same thing — the durable summary of everything folded
    // away so far, then the tail since it, verbatim and within a budget. See
    // `./context.ts`.
    const session = await getVoiceSession(this.voiceSessionId)
    const history = await listVoiceMessages(this.voiceSessionId, CONTEXT_MESSAGE_LIMIT)
    const context = buildConversationContext({
      summary: session?.summary,
      summaryThroughSeq: session?.summaryThroughSeq,
      messages: history,
      // The window above holds the newest messages; this is how many there
      // really are, so a backlog the window cannot show is still counted as
      // lost rather than passed over in silence.
      uncoveredTotal: await countVoiceMessagesAfter(this.voiceSessionId, session?.summaryThroughSeq ?? 0)
    })

    // Appended rather than left to the editable prompt, so the Settings switch
    // governs it even for a customised instruction.
    const naming = !settings.autoTitle || !session
      ? ''
      : session.titleSource === 'user'
        ? `\nThis conversation is titled "${session.title}". The user chose that title, so keep it unless they ask for a new one.`
        : `\nThis conversation is currently titled "${session.title}". Keep the title accurate with set_conversation_title, silently: set it once the topic is clear and update it when the work changes.`

    return [
      settings.systemInstruction,
      naming,
      '',
      'Coding agent sessions currently known to the system:',
      roster,
      '',
      'Default workspace directory: ' + settings.defaultCwd,
      context.text ? `\n${context.text}` : ''
    ].join('\n')
  }

  /**
   * The conversation as this socket may touch it.
   *
   * Every method checks the generation it was made at, so a callback from a
   * socket that has already been replaced is silently dropped rather than
   * writing a transcript row into a conversation that has moved on.
   */
  private hostFor(generation: number): VoiceHost {
    const live = () => generation === this.generation
    return {
      voiceSessionId: this.voiceSessionId,
      instruction: () => this.systemInstruction(),
      emit: (message) => {
        if (live()) this.emit(message)
      },
      audio: (data, sampleRate) => {
        if (live()) this.emit({ type: 'audio', data, sampleRate })
      },
      userInterim: (text) => {
        if (!live()) return
        this.lastUserSpeechAt = Date.now()
        this.emit({ type: 'transcript', role: 'user', text: this.userTranscript + text, final: false })
      },
      userDelta: (text) => {
        if (!live()) return
        this.lastUserSpeechAt = Date.now()
        this.userTranscript += text
        this.emit({ type: 'transcript', role: 'user', text: this.userTranscript, final: false })
      },
      assistantDelta: (text) => {
        if (!live()) return
        this.modelSpeaking = true
        this.assistantTranscript += text
        this.emit({ type: 'transcript', role: 'assistant', text: this.assistantTranscript, final: false })
      },
      speaking: (value) => {
        if (!live()) return
        this.modelSpeaking = value
        // Stopping is a release point: `generationComplete` is the model
        // putting its pen down, and `turnComplete` then waits on playback.
        if (!value) this.drainNotes()
      },
      interrupted: () => (live() ? this.onInterrupted() : Promise.resolve()),
      turnComplete: () => (live() ? this.onTurnComplete() : Promise.resolve()),
      usage: (reading) => {
        if (live()) this.noteUsage(reading)
      },
      runTools: calls => (live() ? this.runToolCalls(calls) : Promise.resolve([])),
      useExtraTools: (handlers) => {
        if (live()) this.extraTools = handlers
      },
      systemNote: (text) => {
        if (live()) void this.recordSystemNote(text)
      },
      error: (message) => {
        if (!live()) return
        console.error(`[voice:${this.voiceSessionId}] live socket error: ${message}`)
        this.emit({ type: 'error', message })
        void updateVoiceSession(this.voiceSessionId, { status: 'error' })
      },
      reconnect: () => (live() ? this.reconnect() : Promise.resolve())
    }
  }

  /**
   * Which backend runs this connect.
   *
   * Read from Settings here rather than fixed when the runtime was made, so a
   * provider change reaches a conversation the next time its socket comes up —
   * which, given `goAway` and Nitro restarts, is usually within minutes and is
   * always what a reload does.
   */
  private async makeBackend(host: VoiceHost): Promise<VoiceBackend> {
    const settings = await getSettings()
    return settings.voiceProvider === 'openai' ? new OpenAiBackend(host) : new GeminiBackend(host)
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation
    this.closed = false
    // A new socket is a new turn state; whatever the old one was mid-way
    // through is gone, and a stale `modelSpeaking` would hold notes forever.
    this.modelSpeaking = false
    this.lastUserSpeechAt = 0
    this.extraTools = {}
    // Fold before the instruction is built, not after: a reconnect is exactly
    // where an uncompacted middle would fall off the end of the budget, and the
    // summary written here is what stops it. Capped, and never fatal.
    await ensureCompacted(this.voiceSessionId)

    const host = this.hostFor(generation)
    const backend = await this.makeBackend(host)
    await backend.connect()
    // A `close()` while the socket was opening already moved the generation on.
    if (generation !== this.generation) {
      await backend.close()
      return
    }
    this.backend = backend
    this.reconnectAttempts = 0

    // What the conversation last actually used, for the sidebar and the row.
    // Always written from the backend rather than from Settings: the backend
    // is the thing that knows what it connected with.
    const session = await getVoiceSession(this.voiceSessionId)
    if (session && (session.model !== backend.model || session.voice !== backend.voice)) {
      void updateVoiceSession(this.voiceSessionId, { model: backend.model, voice: backend.voice })
    }

    this.subscribeToAgents()
  }

  /** Drop the current socket and open another, keeping the conversation. */
  private async reconnect(): Promise<void> {
    const backend = this.backend
    this.backend = null
    await backend?.close().catch(() => {})
    if (this.closed) return
    await updateVoiceSession(this.voiceSessionId, { status: 'idle' })
    if (!this.listeners.size || this.reconnectAttempts >= 3) {
      this.emit({ type: 'status', status: 'idle' })
      return
    }
    this.reconnectAttempts += 1
    // A short, growing pause: the common cause is the server asking us to
    // reconnect (Gemini's `goAway` arrives every few minutes and succeeds on
    // the first try, which resets the count), and the uncommon one is a
    // failure that reconnecting immediately would only repeat.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500 * this.reconnectAttempts)
      timer.unref?.()
    })
    if (this.closed || this.backend || !this.listeners.size) return
    try {
      await this.ensureConnected()
    } catch (error) {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.generation += 1
    this.pendingToolCalls = 0
    this.deferredNotes = []
    this.modelSpeaking = false
    this.lastUserSpeechAt = 0
    this.extraTools = {}
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = null
    if (this.handOverTimer) clearTimeout(this.handOverTimer)
    this.handOverTimer = null
    this.handOverTo = null
    this.handedOver = false
    this.unsubscribeBus?.()
    this.unsubscribeBus = null
    // Whatever was being said when the socket went is still the conversation.
    // It matters more on a provider with no turn boundary of its own, where
    // the only other thing that would have stored this is an idle timer that
    // is about to be thrown away with the backend.
    await this.serial(async () => {
      await this.flushUser()
      await this.flushAssistant()
    })
    const backend = this.backend
    this.backend = null
    // The socket is shut down *before* the final write, because the last thing
    // some sockets say is a usage figure: GPT-Live confirms the conversation's
    // billed speech duration in `session.closed` and nowhere else. It comes
    // back from `close()` rather than through the host, which has already
    // stopped accepting callbacks from this generation.
    const final = await backend?.close().catch(() => undefined)
    if (final) this.noteUsage(final)
    // Whatever is sitting in the trailing timer is the conversation's final
    // reading; it would otherwise go with the process.
    await this.flushUsage()
    await updateVoiceSession(this.voiceSessionId, { status: 'idle' })
    this.emit({ type: 'status', status: 'idle' })
  }

  /* ---------------------------- input ---------------------------- */

  async sendAudioChunk(base64: string): Promise<void> {
    await this.ensureConnected()
    this.backend?.sendAudio(base64)
  }

  async sendAudioStreamEnd(): Promise<void> {
    this.backend?.endAudioStream()
  }

  async sendText(text: string, speak = true): Promise<void> {
    await this.ensureConnected()
    await appendVoiceMessage({ sessionId: this.voiceSessionId, role: 'user', text })
    this.backend?.sendUserText(text, speak)
  }

  /**
   * Is this a moment at which putting text in would cut the conversation off?
   *
   * Only ever asked of a provider whose text input pre-empts generation —
   * Gemini's client content does, and a note sent mid-sentence truncates it,
   * which is the agent audibly interrupting itself. A note sent while the
   * model waits on a tool response can leave that turn stuck. And one sent
   * while the user is still talking answers a question they have not finished
   * asking. GPT-Live's appends have none of these properties, so its backend
   * reports `notesPreemptSpeech: false` and nothing is ever held.
   */
  private busy(): boolean {
    if (this.backend && !this.backend.notesPreemptSpeech) return false
    return this.pendingToolCalls > 0
      || this.modelSpeaking
      || Date.now() - this.lastUserSpeechAt < USER_SILENCE_MS
  }

  /**
   * Inject a system note (agent progress, permission needed, …) into the
   * conversation.
   *
   * The transcript row is written now and the delivery may be held: the screen
   * should show agent news the moment it happens, and only the *speaking* has
   * to wait for a gap. `speak` false means "context, don't answer it".
   */
  async injectNote(text: string, speak = true): Promise<void> {
    // Agent news belongs to the conversation the user is moving to.
    if (!this.backend || this.handOverTo) return
    await appendVoiceMessage({
      sessionId: this.voiceSessionId,
      role: 'system',
      text,
      meta: { source: 'agent-activity' }
    })
    if (this.busy()) {
      this.deferredNotes.push({ text, speak })
      // Nothing else reports the end of a user's turn, so a note that only the
      // user's voice is holding up needs its own alarm clock.
      this.scheduleSilenceDrain()
      return
    }
    this.send([{ text, speak }])
  }

  /** A line about what Domo did, for the transcript only. See `VoiceHost.systemNote`. */
  private async recordSystemNote(text: string): Promise<void> {
    try {
      const stored = await appendVoiceMessage({
        sessionId: this.voiceSessionId,
        role: 'system',
        text,
        meta: { source: 'delegation' }
      })
      this.emit({ type: 'message', message: stored })
    } catch (error) {
      console.error(`[voice:${this.voiceSessionId}] could not record a note`, error)
    }
  }

  /**
   * Hand a batch of notes to the model. Coalesced into one delivery: three
   * agents finishing while the model spoke is one thing to say, not three
   * turns racing each other. How the batch is rendered — one message, two
   * appends — is the backend's business.
   */
  private send(notes: VoiceNote[]) {
    if (!this.backend || !notes.length) return
    this.backend.sendNotes(notes)
  }

  /**
   * Hand over every note that was held, as one message.
   *
   * The rows were written when the notes were made, so nothing is stored here.
   * Called from every point at which the conversation might have gone quiet.
   */
  private drainNotes(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    if (!this.deferredNotes.length) return
    if (this.busy()) {
      // Still not a gap. Whoever unblocks next drains; if that is the user
      // falling silent, nothing but the timer will say so.
      this.scheduleSilenceDrain()
      return
    }
    this.send(this.deferredNotes.splice(0))
  }

  /** Wake up once the user has been quiet long enough, and try again then. */
  private scheduleSilenceDrain(): void {
    if (this.silenceTimer) return
    const quietIn = USER_SILENCE_MS - (Date.now() - this.lastUserSpeechAt)
    if (quietIn <= 0) return
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null
      this.drainNotes()
    }, quietIn)
    // Waiting for a gap in the conversation is no reason to hold the process open.
    this.silenceTimer.unref?.()
  }

  /* ---------------------------- output ---------------------------- */

  /** The model stopped generating, so there is nothing left to cut off. */
  private onInterrupted(): Promise<void> {
    this.modelSpeaking = false
    this.emit({ type: 'interrupted' })
    return this.serial(async () => {
      await this.flushAssistant()
      this.drainNotes()
    })
  }

  /**
   * The exchange is over: store what was said, write the reading, fold, and
   * release whatever was held back.
   */
  private onTurnComplete(): Promise<void> {
    return this.serial(async () => {
      // Whatever the user said has now been asked and answered, so the silence
      // window is over however recently the transcription arrived.
      this.lastUserSpeechAt = 0
      await this.flushUser()
      await this.flushAssistant()
      await this.flushUsage()
      this.emit({ type: 'turn-complete' })
      this.scheduleCompaction()
      if (this.handOverTo && this.handOverTimer) this.completeHandOver()
      this.drainNotes()
    })
  }

  /**
   * Run something against the conversation one at a time. Provider callbacks
   * arrive without waiting for the previous handler, so two flushes racing
   * would store transcript rows out of order.
   */
  private serial(work: () => Promise<void>): Promise<void> {
    this.inbox = this.inbox
      .then(work)
      .catch((error) => {
        console.error('[voice] message handling failed', error)
      })
    return this.inbox
  }

  /**
   * Fold the conversation in the background, now that a turn has ended.
   *
   * A turn boundary is the one moment nothing is mid-sentence, and the answer
   * is usually "not needed" after a single query. Deliberately not awaited:
   * the next turn must not wait on a summariser, and `compactConversation`
   * de-duplicates the fold with whatever the next connect asks for.
   */
  private scheduleCompaction(): void {
    if (this.closed) return
    void compactConversation(this.voiceSessionId).catch((error) => {
      console.warn(`[voice:${this.voiceSessionId}] background compaction failed`, error)
    })
  }

  /* ---------------------------- context ---------------------------- */

  /**
   * Take in a context reading from whichever provider is speaking.
   *
   * Merged into the last one rather than replacing it, because the two
   * providers report different halves at different moments: Gemini's window
   * size arrives from the models API after the first token count does, and
   * GPT-Live reports an occupancy ratio on one event and its billed audio
   * total on another.
   */
  private noteUsage(reading: VoiceUsageReading): void {
    const previous = this.usage
    // A reading that only refines the *denominator* — Gemini's window size,
    // which arrives from the models API after the socket is already up — says
    // nothing on its own. Writing one before the model has reported any
    // occupancy would claim an empty window for a conversation that resumed a
    // full one.
    if (!previous && reading.used === undefined && reading.percent === undefined) return
    const context = {
      used: reading.used ?? previous?.context.used ?? 0,
      size: reading.size !== undefined ? reading.size : previous?.context.size ?? null,
      percent: reading.percent !== undefined ? reading.percent : previous?.context.percent ?? null
    }
    if (!Number.isFinite(context.used) || context.used < 0) return
    this.usage = {
      context,
      audioSeconds: reading.audioSeconds ?? previous?.audioSeconds ?? null,
      updatedAt: new Date().toISOString()
    }
    this.scheduleUsageWrite()
  }

  private scheduleUsageWrite(): void {
    if (this.usageTimer) return
    const timer = setTimeout(() => {
      this.usageTimer = null
      void this.flushUsage()
    }, USAGE_WRITE_MS)
    timer.unref?.()
    this.usageTimer = timer
  }

  /**
   * Write the reading, if it says anything new.
   *
   * Goes through `setVoiceUsage`, which touches the `usage` column and nothing
   * else: `updated_at`, `title_source` and `last_activity_at` all stay put, so
   * a conversation nobody is speaking in does not climb the sidebar because its
   * token count moved.
   */
  private async flushUsage(): Promise<void> {
    if (this.usageTimer) {
      clearTimeout(this.usageTimer)
      this.usageTimer = null
    }
    const usage = this.usage
    if (!usage) return
    if (this.writtenUsage
      && this.writtenUsage.context.used === usage.context.used
      && this.writtenUsage.context.size === usage.context.size
      && this.writtenUsage.context.percent === usage.context.percent
      && this.writtenUsage.audioSeconds === usage.audioSeconds) return
    this.writtenUsage = usage
    try {
      await setVoiceUsage(this.voiceSessionId, usage)
    } catch (error) {
      console.error(`[voice:${this.voiceSessionId}] could not record usage`, error)
    }
  }

  private async flushUser() {
    const text = this.userTranscript.trim()
    this.userTranscript = ''
    if (!text) return
    const stored = await appendVoiceMessage({ sessionId: this.voiceSessionId, role: 'user', text })
    this.emit({ type: 'transcript', role: 'user', text, final: true })
    this.emit({ type: 'message', message: stored })
  }

  private async flushAssistant() {
    const text = this.assistantTranscript.trim()
    this.assistantTranscript = ''
    if (!text) return
    const stored = await appendVoiceMessage({ sessionId: this.voiceSessionId, role: 'assistant', text })
    this.emit({ type: 'transcript', role: 'assistant', text, final: true })
    this.emit({ type: 'message', message: stored })
  }

  /**
   * Run a batch of tool calls and log each to the transcript.
   *
   * Which side of the wire asked is the backend's business — Gemini's model
   * calls tools itself, OpenAI's delegated Responses backend does — and what a
   * tool *is* is the same either way, so this is shared. Results come back in
   * the order they were asked for.
   */
  private async runToolCalls(calls: VoiceToolCall[]): Promise<VoiceToolResult[]> {
    const generation = this.generation
    this.pendingToolCalls += 1
    const results: VoiceToolResult[] = []

    // Store what was said so far first, so the rows read in order.
    await this.serial(async () => {
      await this.flushUser()
      await this.flushAssistant()
    })

    try {
      for (const call of calls) {
        const { name, args } = call
        this.emit({ type: 'tool', name, args, phase: 'start' })

        const tool = voiceTools[name]
        const extra = this.extraTools[name]
        let result: any
        if (!tool && !extra) {
          result = { error: `Unknown tool: ${name}` }
        } else {
          try {
            const running = tool
              ? tool.handler(args, {
                  voiceSessionId: this.voiceSessionId,
                  handOver: (id) => {
                    this.handOverTo = id
                  }
                })
              : extra!(args)
            result = await withTimeout(running, TOOL_TIMEOUT_MS, name)
          } catch (error) {
            result = { error: error instanceof Error ? error.message : String(error) }
          }
        }

        this.emit({ type: 'tool', name, args, result, phase: 'end' })
        try {
          const stored = await appendVoiceMessage({
            sessionId: this.voiceSessionId,
            role: 'tool',
            text: typeof result === 'string' ? result : JSON.stringify(result),
            toolName: name,
            meta: { args }
          })
          this.emit({ type: 'message', message: stored })
        } catch (error) {
          // The model still needs its answer even if the log row is lost.
          console.error(`[voice:${this.voiceSessionId}] storing ${name} result failed`, error)
        }

        results.push({ call, result })
      }
    } finally {
      this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1)
    }

    // A `close()` while the tools ran already reset the counter and the notes.
    if (generation !== this.generation && this.closed) return []
    if (this.handOverTo && !this.handOverTimer && !this.handedOver) {
      // The sign-off ends with the turn; don't wait forever if it never comes.
      this.handOverTimer = setTimeout(() => this.completeHandOver(), 8000)
    }
    if (this.pendingToolCalls === 0) this.drainNotes()
    return results
  }

  private completeHandOver() {
    const target = this.handOverTo
    if (this.handOverTimer) clearTimeout(this.handOverTimer)
    this.handOverTimer = null
    if (!target || this.handedOver) return
    this.handedOver = true
    console.info(`[voice:${this.voiceSessionId}] handing over to ${target}`)
    this.emit({ type: 'session-changed', sessionId: target })
    // Browsers that followed detach and the socket handler closes this runtime;
    // one nobody was listening to would otherwise stay open and billed.
    setTimeout(() => {
      if (!this.listenerCount) void voiceManager.close(this.voiceSessionId)
    }, 5000)
  }

  /* ------------------- proactive agent notifications ------------------- */

  private subscribeToAgents() {
    if (this.unsubscribeBus) return
    this.unsubscribeBus = bus.subscribe((event) => {
      void this.onBusEvent(event).catch(() => {})
    })
  }

  private async onBusEvent(event: any) {
    const settings = await getSettings()
    if (!settings.proactiveNotifications || !this.backend) return

    if (event.type === 'agent-event') {
      const { agentSessionId, event: agentEvent } = event
      if (agentEvent.type === 'turn_end') {
        const key = `${agentSessionId}:${agentEvent.seq}`
        if (this.notifiedTurns.has(key)) return
        this.notifiedTurns.add(key)
        const agents = await listAgentSessions(true)
        const agent = agents.find(a => a.id === agentSessionId)
        if (!agent) return
        await this.injectNote(
          `Agent "${agent.title}" (${agent.id}) finished its turn (${agentEvent.payload?.stopReason ?? 'end_turn'}). `
          + `Latest output: ${(agent.summary ?? '').replace(/\s+/g, ' ').slice(0, 500) || '(no text output)'}. `
          + 'Tell the user what happened in one or two sentences.'
        )
      }
      // Not `mesh_message`: `notifyHuman` injects that note itself, whatever
      // the proactive setting, since the agent addressed the human directly.
      // Relaying it here as well had the supervisor say it twice.
    }

    if (event.type === 'permission-changed') {
      const permission = event.permission
      if (permission.resolvedAt) return
      const agents = await listAgentSessions(true)
      const agent = agents.find(a => a.id === permission.agentSessionId)
      await this.injectNote(
        `Agent "${agent?.title ?? permission.agentSessionId}" needs a decision: ${permission.title}. `
        + `Options: ${permission.options.map((option: any) => `${option.name} (optionId ${option.optionId})`).join(', ')}. `
        + `Ask the user, then call answer_permission with permissionId ${permission.id}.`
      )
    }
  }
}

class VoiceManager {
  private runtimes = new Map<string, VoiceRuntime>()

  get(voiceSessionId: string): VoiceRuntime {
    let runtime = this.runtimes.get(voiceSessionId)
    if (!runtime) {
      runtime = new VoiceRuntime(voiceSessionId)
      this.runtimes.set(voiceSessionId, runtime)
    }
    return runtime
  }

  peek(voiceSessionId: string): VoiceRuntime | undefined {
    return this.runtimes.get(voiceSessionId)
  }

  /** The runtime a background notification should go to: the newest live one. */
  active(): VoiceRuntime | undefined {
    return [...this.runtimes.values()].find(runtime => runtime.live)
  }

  async close(voiceSessionId: string) {
    const runtime = this.runtimes.get(voiceSessionId)
    if (!runtime) return
    await runtime.close()
    this.runtimes.delete(voiceSessionId)
  }

  async shutdown() {
    for (const id of [...this.runtimes.keys()]) await this.close(id)
  }
}

const globalKey = '__domo_voice_manager__'
const g = globalThis as any
export const voiceManager: VoiceManager = g[globalKey] ?? (g[globalKey] = new VoiceManager())
export type { VoiceRuntime }
