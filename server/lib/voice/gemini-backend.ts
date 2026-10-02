import { createHash } from 'node:crypto'
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai'

import { ensureLiveContextWindows, geminiApiKey, liveContextWindow } from '../gemini'
import { getResumptionHandle, updateVoiceSession } from '../repo'
import { getSettings } from '../settings'
import { connectVoiceMcpServers, type ConnectedMcp } from './mcp'
import { voiceToolDeclarations } from './tools'
import {
  CLIENT_INPUT_SAMPLE_RATE,
  CLIENT_OUTPUT_SAMPLE_RATE,
  type VoiceBackend,
  type VoiceHost,
  type VoiceNote
} from './backend'

/**
 * Gemini Live: one model that listens, thinks, calls Domo's tools and speaks.
 *
 * This is the code that used to *be* the voice runtime, lifted out whole when
 * a second provider arrived. Nothing about its behaviour changed; what changed
 * is that the parts of it that were about the conversation rather than about
 * Google — the transcript rows, the note gate, the usage throttle — stayed
 * behind in `runtime.ts`, and what is left here is the socket.
 */
export class GeminiBackend implements VoiceBackend {
  readonly provider = 'gemini' as const
  /**
   * True, and it is the reason `VoiceRuntime.busy()` exists at all: client
   * content pre-empts whatever the model is generating, so a note sent
   * mid-sentence truncates it — the agent audibly interrupting itself.
   */
  readonly notesPreemptSpeech = true

  model = ''
  voice = ''

  private ai: GoogleGenAI | null = null
  private session: Session | null = null
  private mcpConnections: ConnectedMcp[] = []
  /** Fingerprint of the model + tools this socket was set up with. */
  private setupFingerprint: string | null = null
  private closed = false

  constructor(private readonly host: VoiceHost) {}

  async connect(): Promise<void> {
    const apiKey = geminiApiKey()
    if (!apiKey) {
      throw new Error('No Gemini API key. Add one in Settings → General, or NUXT_GEMINI_API_KEY in .env.')
    }
    const settings = await getSettings()
    this.ai = new GoogleGenAI({ apiKey })

    const { tools: mcpTools, connections, errors } = await connectVoiceMcpServers()
    this.mcpConnections = connections
    for (const error of errors) {
      this.host.emit({ type: 'error', message: `MCP server "${error.name}" failed: ${error.message}` })
    }

    // Always the current Settings: the copy on the session row is only a record
    // of what the conversation last used, and honouring it made a saved change
    // (or a fixed default) silently not apply to existing conversations.
    this.model = settings.liveModel
    this.voice = settings.voiceName
    const functionDeclarations = voiceToolDeclarations({ autoTitle: settings.autoTitle })

    // A resumed session keeps the tools it was created with and ignores the ones
    // sent now, so the agent would miss any tool added since (verified against
    // the Live API). Resume only when the setup is unchanged; otherwise start a
    // fresh session, which still gets the recent recap in its instruction.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({
        model: this.model,
        functionDeclarations,
        mcp: connections.map(connection => [connection.server.id, connection.server.updatedAt])
      }))
      .digest('hex')
    this.setupFingerprint = fingerprint
    const stored = await getResumptionHandle(this.host.voiceSessionId)
    const handle = stored.fingerprint === fingerprint ? stored.handle : null
    if (stored.handle && !handle) {
      console.info(
        `[voice:${this.host.voiceSessionId}] model or tools changed since the last session; `
        + 'starting fresh instead of resuming'
      )
    }

    // The denominator for the context bar. Best effort and not awaited on the
    // hot path: a conversation starts whether or not the models API answers.
    void ensureLiveContextWindows().then(() => this.reportWindow())
    // Resuming keeps the model's context; starting fresh does not. A fresh
    // connect is therefore an empty window, and saying so at once beats leaving
    // the previous conversation's number on screen until the first reading.
    if (!handle) this.host.usage({ used: 0, size: liveContextWindow(this.model) })

    this.host.emit({ type: 'status', status: 'idle', detail: `connecting to ${this.model}` })

    const config: any = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: await this.host.instruction(),
      speechConfig: {
        languageCode: settings.language,
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } }
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: handle ? { handle } : {},
      contextWindowCompression: { slidingWindow: {} },
      tools: [{ functionDeclarations }, ...mcpTools]
    }

    this.session = await this.ai.live.connect({
      model: this.model,
      config,
      callbacks: {
        onopen: () => {
          this.host.emit({ type: 'status', status: 'live' })
          void updateVoiceSession(this.host.voiceSessionId, { status: 'live' })
        },
        onmessage: (message: LiveServerMessage) => {
          void this.onMessage(message).catch((error) => {
            console.error('[voice] message handling failed', error)
          })
        },
        onerror: (event: any) => {
          const message = event?.message || String(event?.error ?? event ?? 'unknown error')
          this.host.error(message)
        },
        onclose: (event: CloseEvent) => {
          this.session = null
          const reason = `${event?.code ?? '?'}${event?.reason ? `: ${event.reason}` : ''}`
          this.host.emit({ type: 'status', status: 'idle', detail: `connection closed (${reason})` })
          if (!this.closed) void this.host.reconnect()
        }
      }
    })
  }

  private reportWindow(): void {
    const size = liveContextWindow(this.model)
    if (size) this.host.usage({ size })
  }

  sendAudio(base64: string): void {
    this.session?.sendRealtimeInput({
      audio: { data: base64, mimeType: `audio/pcm;rate=${CLIENT_INPUT_SAMPLE_RATE}` }
    })
  }

  endAudioStream(): void {
    this.session?.sendRealtimeInput({ audioStreamEnd: true })
  }

  sendUserText(text: string, speak: boolean): void {
    // `turnComplete` is what asks for an answer at all — the same lever
    // `sendNotes` uses for a context-only note. False leaves the message in
    // the conversation with no reply, which is what "don't speak" means here.
    if (speak) this.host.speaking(true)
    this.session?.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: speak
    })
  }

  /**
   * One client-content message per batch. `turnComplete` is true unless *every*
   * note in it was context-only: a batch that contains something worth saying
   * is worth answering once.
   */
  sendNotes(notes: VoiceNote[]): void {
    if (!this.session || !notes.length) return
    const speak = notes.some(note => note.speak)
    // A delivery that asks for an answer starts a model turn, so the next note
    // along waits for it rather than cutting the reply to this one in half.
    if (speak) this.host.speaking(true)
    this.session.sendClientContent({
      turns: [{
        role: 'user',
        parts: [{ text: notes.map(note => `[Domo system notice] ${note.text}`).join('\n\n') }]
      }],
      turnComplete: speak
    })
  }

  /** Nothing final to report: every reading has already arrived on a frame. */
  async close(): Promise<null> {
    this.closed = true
    try {
      this.session?.close()
    } catch {
      /* ignore */
    }
    this.session = null
    for (const connection of this.mcpConnections) await connection.close()
    this.mcpConnections = []
    return null
  }

  /* ---------------------------- output ---------------------------- */

  private async onMessage(message: LiveServerMessage) {
    if (message.setupComplete) this.host.emit({ type: 'status', status: 'live' })

    this.noteUsage(message.usageMetadata)

    if (message.sessionResumptionUpdate?.newHandle) {
      await updateVoiceSession(this.host.voiceSessionId, {
        resumptionHandle: message.sessionResumptionUpdate.newHandle,
        resumptionFingerprint: this.setupFingerprint
      })
    }

    if (message.goAway) {
      console.info(
        `[voice:${this.host.voiceSessionId}] goAway (time left ${message.goAway.timeLeft ?? '?'}), reconnecting`
      )
      this.host.emit({ type: 'status', status: 'live', detail: 'server asked to reconnect' })
      this.closed = true
      try {
        this.session?.close()
      } catch {
        /* ignore */
      }
      this.session = null
      await this.host.reconnect()
      return
    }

    const content = message.serverContent
    if (content) {
      if (content.interrupted) await this.host.interrupted()

      // Interim text is a guess at the segment in progress, not a delta: show it
      // after what has been committed so far and never accumulate it.
      if (content.interimInputTranscription?.text) {
        this.host.userInterim(content.interimInputTranscription.text)
      }
      if (content.inputTranscription?.text) this.host.userDelta(content.inputTranscription.text)
      if (content.outputTranscription?.text) this.host.assistantDelta(content.outputTranscription.text)

      if (content.modelTurn?.parts?.length) this.host.speaking(true)
      // `generationComplete` is the model putting its pen down; `turnComplete`
      // then waits on playback. Either one ends the window in which client
      // content would truncate what is being said.
      if (content.generationComplete || content.turnComplete) this.host.speaking(false)

      for (const part of content.modelTurn?.parts ?? []) {
        const inline = part.inlineData
        if (inline?.data && (inline.mimeType ?? '').startsWith('audio/')) {
          this.host.audio(inline.data, CLIENT_OUTPUT_SAMPLE_RATE)
        }
        // With audio output the spoken words arrive via `outputTranscription`;
        // `thought` parts are the model's reasoning and must not be appended.
        if (part.text && !part.thought) this.host.assistantDelta(part.text)
      }

      if (content.turnComplete) await this.host.turnComplete()
    }

    if (message.toolCall?.functionCalls?.length) {
      const calls = message.toolCall.functionCalls.map((call: any) => ({
        id: call.id,
        name: call.name as string,
        args: (call.args ?? {}) as Record<string, unknown>
      }))
      void this.host.runTools(calls)
        .then((results) => {
          this.session?.sendToolResponse({
            functionResponses: results.map(({ call, result }) => ({
              id: call.id,
              name: call.name,
              response: result && typeof result === 'object'
                ? result as Record<string, unknown>
                : { output: result }
            }))
          })
        })
        .catch((error) => {
          console.error(`[voice:${this.host.voiceSessionId}] tool calls failed`, error)
        })
    }
  }

  /**
   * Take in a `usageMetadata` frame.
   *
   * The Live API reports what the conversation has spent and never how big the
   * window is, so the size comes from the models API (see `liveContextWindow`)
   * and is null for a model Domo has not been told about.
   *
   * `used` going **down** is normal and must not be smoothed away: the session
   * runs with `contextWindowCompression: { slidingWindow: {} }`, so the oldest
   * turns are dropped once the window fills, and a conversation that starts
   * fresh after a fingerprint mismatch begins again at zero.
   */
  private noteUsage(usageMetadata: LiveServerMessage['usageMetadata']): void {
    if (!usageMetadata) return
    // `totalTokenCount` is the whole exchange; `promptTokenCount` is what was
    // sent, which is the conversation so far. Either answers "how full", and
    // the second is what a frame carrying no total still has.
    const used = usageMetadata.totalTokenCount ?? usageMetadata.promptTokenCount
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return
    this.host.usage({ used, size: liveContextWindow(this.model) })
  }
}
