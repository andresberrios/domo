import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai'

import { bus } from '../bus'
import { getSettings } from '../settings'
import {
  appendVoiceMessage,
  getResumptionHandle,
  getVoiceSession,
  listAgentSessions,
  listVoiceMessages,
  updateVoiceSession
} from '../repo'
import { connectVoiceMcpServers, type ConnectedMcp } from './mcp'
import { voiceToolDeclarations, voiceTools } from './tools'
import type { VoiceServerMessage } from '../../../shared/types'

export const INPUT_SAMPLE_RATE = 16000
export const OUTPUT_SAMPLE_RATE = 24000
/** The model waits on every tool response, so a hung handler must not silence it. */
const TOOL_TIMEOUT_MS = 30000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s; it may still finish in the background`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

type Listener = (message: VoiceServerMessage) => void

/**
 * One live Gemini conversation, owned by the server so tool calls, persistence
 * and proactive notifications all happen in one place. Browsers attach and
 * detach freely; the conversation outlives any single tab.
 */
class VoiceRuntime {
  readonly voiceSessionId: string
  private ai: GoogleGenAI | null = null
  private session: Session | null = null
  private listeners = new Set<Listener>()
  private mcpConnections: ConnectedMcp[] = []
  private connecting: Promise<void> | null = null
  private closed = false
  private reconnectAttempts = 0
  /**
   * Bumped on every connect and close. Callbacks from an older Live socket
   * (one replaced after `goAway`, say) compare against it and bow out, so a late
   * `onclose` cannot null out the session that replaced it.
   */
  private generation = 0
  /** Tool calls the model is still waiting on, and notes held back until then. */
  private pendingToolCalls = 0
  private deferredNotes: Array<{ text: string, speak: boolean }> = []

  private userTranscript = ''
  private assistantTranscript = ''
  /**
   * Live messages are handled one at a time. `onmessage` fires without waiting
   * for the previous handler, so concurrent flushes would store transcript rows
   * out of order.
   */
  private inbox: Promise<void> = Promise.resolve()
  private unsubscribeBus: (() => void) | null = null
  private notifiedTurns = new Set<string>()
  /** A failed connect is remembered briefly: 8 audio chunks a second must not
   *  turn one misconfiguration into a storm of identical errors. */
  private connectError: { message: string, at: number } | null = null

  constructor(voiceSessionId: string) {
    this.voiceSessionId = voiceSessionId
  }

  get live() {
    return !!this.session
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
    if (this.session) return
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

  private async apiKey(): Promise<string> {
    const key = process.env.NUXT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    if (!key) {
      throw new Error(
        'No Gemini API key. Put NUXT_GEMINI_API_KEY=... in .env and restart the server.'
      )
    }
    return key
  }

  private async systemInstruction(): Promise<string> {
    const settings = await getSettings()
    const agents = await listAgentSessions()
    const roster = agents.length
      ? agents
          .map(agent => `- ${agent.title} (id: ${agent.id}, status: ${agent.status}, dir: ${agent.cwd})`)
          .join('\n')
      : '- (no coding agents yet)'

    const history = await listVoiceMessages(this.voiceSessionId, 12)
    const recap = history.length
      ? history
          .filter(message => message.role === 'user' || message.role === 'assistant')
          .map(message => `${message.role}: ${message.text}`)
          .join('\n')
      : ''

    return [
      settings.systemInstruction,
      '',
      'Coding agent sessions currently known to the system:',
      roster,
      '',
      'Default workspace directory: ' + settings.defaultCwd,
      recap ? `\nEarlier in this conversation:\n${recap}` : ''
    ].join('\n')
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation
    this.closed = false
    const settings = await getSettings()
    const session = await getVoiceSession(this.voiceSessionId)
    const apiKey = await this.apiKey()
    this.ai = new GoogleGenAI({ apiKey })

    const { tools: mcpTools, connections, errors } = await connectVoiceMcpServers()
    this.mcpConnections = connections
    for (const error of errors) {
      this.emit({ type: 'error', message: `MCP server "${error.name}" failed: ${error.message}` })
    }

    const handle = await getResumptionHandle(this.voiceSessionId)
    const model = session?.model || settings.liveModel
    const voiceName = session?.voice || settings.voiceName

    this.emit({ type: 'status', status: 'idle', detail: `connecting to ${model}` })

    const config: any = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: await this.systemInstruction(),
      speechConfig: {
        languageCode: settings.language,
        voiceConfig: { prebuiltVoiceConfig: { voiceName } }
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: handle ? { handle } : {},
      contextWindowCompression: { slidingWindow: {} },
      tools: [{ functionDeclarations: voiceToolDeclarations() }, ...mcpTools]
    }

    this.session = await this.ai.live.connect({
      model,
      config,
      callbacks: {
        onopen: () => {
          if (generation !== this.generation) return
          this.reconnectAttempts = 0
          this.emit({ type: 'status', status: 'live' })
          void updateVoiceSession(this.voiceSessionId, { status: 'live' })
        },
        onmessage: (message: LiveServerMessage) => {
          if (generation !== this.generation) return
          this.inbox = this.inbox
            .then(() => this.onMessage(message))
            .catch((error) => {
              console.error('[voice] message handling failed', error)
            })
        },
        onerror: (event: any) => {
          if (generation !== this.generation) return
          const message = event?.message || String(event?.error ?? event ?? 'unknown error')
          console.error(`[voice:${this.voiceSessionId}] live socket error: ${message}`)
          this.emit({ type: 'error', message })
          void updateVoiceSession(this.voiceSessionId, { status: 'error' })
        },
        onclose: (event: CloseEvent) => {
          if (generation !== this.generation) return
          this.session = null
          const reason = `${event?.code ?? '?'}${event?.reason ? `: ${event.reason}` : ''}`
          if (!this.closed) {
            console.warn(`[voice:${this.voiceSessionId}] live socket closed (${reason})`)
            void this.handleUnexpectedClose(reason)
          } else {
            this.emit({ type: 'status', status: 'idle' })
          }
        }
      }
    })

    this.subscribeToAgents()
  }

  private async handleUnexpectedClose(reason: string) {
    await updateVoiceSession(this.voiceSessionId, { status: 'idle' })
    this.emit({ type: 'status', status: 'idle', detail: `connection closed (${reason})` })
    if (!this.listeners.size || this.reconnectAttempts >= 3) return
    this.reconnectAttempts += 1
    const delay = 500 * this.reconnectAttempts
    setTimeout(() => {
      if (this.listeners.size && !this.session) {
        void this.ensureConnected().catch((error) => {
          this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        })
      }
    }, delay)
  }

  async close(): Promise<void> {
    this.closed = true
    this.generation += 1
    this.pendingToolCalls = 0
    this.deferredNotes = []
    this.unsubscribeBus?.()
    this.unsubscribeBus = null
    try {
      this.session?.close()
    } catch {
      /* ignore */
    }
    this.session = null
    for (const connection of this.mcpConnections) await connection.close()
    this.mcpConnections = []
    await updateVoiceSession(this.voiceSessionId, { status: 'idle' })
    this.emit({ type: 'status', status: 'idle' })
  }

  /* ---------------------------- input ---------------------------- */

  async sendAudioChunk(base64: string): Promise<void> {
    await this.ensureConnected()
    this.session?.sendRealtimeInput({
      audio: { data: base64, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` }
    })
  }

  async sendAudioStreamEnd(): Promise<void> {
    this.session?.sendRealtimeInput({ audioStreamEnd: true })
  }

  async sendText(text: string): Promise<void> {
    await this.ensureConnected()
    await appendVoiceMessage({ sessionId: this.voiceSessionId, role: 'user', text })
    this.session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true })
  }

  /** Inject a system note (agent progress, permission needed, …) into the conversation. */
  async injectNote(text: string, speak = true): Promise<void> {
    if (!this.session) return
    // Client content sent while the model waits on a tool response can leave the
    // turn stuck; hold the note until the response has gone out.
    if (this.pendingToolCalls > 0) {
      this.deferredNotes.push({ text, speak })
      return
    }
    await appendVoiceMessage({
      sessionId: this.voiceSessionId,
      role: 'system',
      text,
      meta: { source: 'agent-activity' }
    })
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: `[Domo system notice] ${text}` }] }],
      turnComplete: speak
    })
  }

  /* ---------------------------- output ---------------------------- */

  private async onMessage(message: LiveServerMessage) {
    if (message.setupComplete) {
      this.emit({ type: 'status', status: 'live' })
    }

    if (message.sessionResumptionUpdate?.newHandle) {
      await updateVoiceSession(this.voiceSessionId, {
        resumptionHandle: message.sessionResumptionUpdate.newHandle
      })
    }

    if (message.goAway) {
      console.info(`[voice:${this.voiceSessionId}] goAway (time left ${message.goAway.timeLeft ?? '?'}), reconnecting`)
      this.emit({ type: 'status', status: 'live', detail: 'server asked to reconnect' })
      try {
        this.session?.close()
      } catch {
        /* ignore */
      }
      this.session = null
      await this.ensureConnected()
      return
    }

    const content = message.serverContent
    if (content) {
      if (content.interrupted) {
        this.emit({ type: 'interrupted' })
        await this.flushAssistant()
      }

      // Interim text is a guess at the segment in progress, not a delta: show it
      // after what has been committed so far and never accumulate it.
      const interim = content.interimInputTranscription?.text
      if (interim) {
        this.emit({ type: 'transcript', role: 'user', text: this.userTranscript + interim, final: false })
      }

      if (content.inputTranscription?.text) {
        this.userTranscript += content.inputTranscription.text
        this.emit({ type: 'transcript', role: 'user', text: this.userTranscript, final: false })
      }

      if (content.outputTranscription?.text) {
        this.assistantTranscript += content.outputTranscription.text
        this.emit({ type: 'transcript', role: 'assistant', text: this.assistantTranscript, final: false })
      }

      for (const part of content.modelTurn?.parts ?? []) {
        const inline = part.inlineData
        if (inline?.data && (inline.mimeType ?? '').startsWith('audio/')) {
          this.emit({ type: 'audio', data: inline.data, sampleRate: OUTPUT_SAMPLE_RATE })
        }
        // With audio output the spoken words arrive via `outputTranscription`;
        // `thought` parts are the model's reasoning and must not be appended.
        if (part.text && !part.thought) {
          this.assistantTranscript += part.text
          this.emit({ type: 'transcript', role: 'assistant', text: this.assistantTranscript, final: false })
        }
      }

      if (content.turnComplete) {
        await this.flushUser()
        await this.flushAssistant()
        this.emit({ type: 'turn-complete' })
      }
    }

    if (message.toolCall?.functionCalls?.length) {
      // Store what was said so far first, so the rows read in order, then run
      // the tools off the inbox: audio and transcripts keep flowing meanwhile.
      await this.flushUser()
      await this.flushAssistant()
      void this.runToolCalls(message.toolCall.functionCalls).catch((error) => {
        console.error(`[voice:${this.voiceSessionId}] tool calls failed`, error)
      })
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

  private async runToolCalls(calls: any[]) {
    const generation = this.generation
    this.pendingToolCalls += 1
    const responses: any[] = []

    for (const call of calls) {
      const name: string = call.name
      const args = call.args ?? {}
      this.emit({ type: 'tool', name, args, phase: 'start' })

      const tool = voiceTools[name]
      let result: any
      if (!tool) {
        // MCP-backed tools are executed by the SDK itself; anything unknown here
        // is a genuine mistake worth surfacing to the model.
        result = { error: `Unknown tool: ${name}` }
      } else {
        try {
          result = await withTimeout(tool.handler(args, { voiceSessionId: this.voiceSessionId }), TOOL_TIMEOUT_MS, name)
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

      responses.push({
        id: call.id,
        name,
        response: result && typeof result === 'object' ? result : { output: result }
      })
    }

    // A `close()` while the tools ran already reset the counter and the notes.
    if (generation !== this.generation && this.closed) return
    this.session?.sendToolResponse({ functionResponses: responses })
    this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1)
    if (this.pendingToolCalls === 0) {
      const notes = this.deferredNotes.splice(0)
      for (const note of notes) await this.injectNote(note.text, note.speak)
    }
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
    if (!settings.proactiveNotifications || !this.session) return

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
      } else if (agentEvent.type === 'mesh_message') {
        await this.injectNote(
          `Agent "${agentEvent.payload?.from ?? 'unknown'}" says: ${agentEvent.payload?.message}. `
          + 'Relay this to the user.'
        )
      }
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
