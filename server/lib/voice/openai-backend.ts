import { updateVoiceSession } from '../repo'
import { getSettings } from '../settings'
import { resampleBase64Pcm16 } from './audio'
import { AgentDelegate, type DelegationUpdate } from './delegation'
import { connectVoiceMcpServers, mcpFunctionTools, type ConnectedMcp } from './mcp'
import {
  LIVE_SAMPLE_RATE,
  LiveConnection,
  liveErrorMessage,
  type LiveResponsesEvent,
  type LiveServerEvent,
  type LiveSessionConfig
} from './openai-live'
import { openAiToolsFromDeclarations, type OpenAiFunctionTool } from './tool-schema'
import { voiceToolDeclarations } from './tools'
import {
  CLIENT_INPUT_SAMPLE_RATE,
  type VoiceBackend,
  type VoiceHost,
  type VoiceNote,
  type VoiceToolCall,
  type VoiceUsageReading
} from './backend'
import type { AppSettings } from '../../../shared/types'

/**
 * How long the conversation has to be silent before what was said is stored.
 *
 * Long enough to sit through a pause mid-sentence — the same hazard
 * `USER_SILENCE_MS` exists for on the Gemini side, and transcript deltas
 * arrive in bursts here too — and short enough that a conversation the user
 * walks away from is on disk before they close the tab. Audio deltas reset it
 * as well as text, so a model that is speaking is never interrupted by it.
 */
const TRANSCRIPT_IDLE_MS = 2000

/**
 * What the live model is told on top of Domo's system instruction.
 *
 * That instruction is written for a model that holds the tools — "check with
 * your tools before saying anything about an agent" — and this one holds
 * none. Left unqualified it reads as an instruction to do something the model
 * cannot do, and the observed failure mode for that is a model that answers
 * from memory rather than delegating. The instruction itself is not rewritten
 * per provider: it is the operator's, it is editable in Settings, and the
 * *backend* is given the same text and can act on all of it.
 */
const LIVE_SUPPLEMENT: Record<'responses' | 'agent', string> = {
  responses: `
How the work gets done here: you run the conversation and you do not call tools
yourself. Everything above about checking with your tools is done by a backend
model that has all of them and shares this instruction. Delegate anything that
needs looking up or doing, keep talking while it works, and say what comes back
in your own words.`,
  agent: `
How the work gets done here: you run the conversation and you do not call tools
yourself. Everything above about checking with your tools is done by a coding
agent on the developer's own machine, which the application hands your requests
to. Delegate anything that needs looking up or doing. It is a coding agent, not
a lookup — it can take a minute or two, so say you are on it and carry on
talking rather than waiting in silence.`
}

/**
 * GPT-Live: a model that runs the conversation and delegates the thinking.
 *
 * The shape is genuinely different from Gemini's and the difference is the
 * whole feature. The live model holds **no tools** and does no reasoning — it
 * listens, speaks, handles interruptions, and when the conversation needs an
 * answer it emits `session.delegation.created` and carries on talking. Who
 * answers is `openaiDelegation.target`:
 *
 *   - `responses` — OpenAI calls a text model it hosts (Sol by default) with
 *     Domo's own voice tools registered on it, and streams the work back
 *     inside `response.event` envelopes. Domo runs the function calls, exactly
 *     the ones it runs for Gemini, and hands the results back. Setting this up
 *     costs one object in `session.start`.
 *   - `agent` — the delegation comes to Domo (`target: 'client'`) and is
 *     handed to a coding agent session, which answers minutes later through
 *     the bus. See `./delegation.ts`.
 *
 * Results never arrive as a turn: they are *appended context*, spoken
 * (`commentary`) or silent (`thinking`). That is also why this backend sets
 * `notesPreemptSpeech = false` — an append is designed to arrive while the
 * model is talking, so agent news needs none of the gate Gemini needs.
 */
export class OpenAiBackend implements VoiceBackend {
  readonly provider = 'openai' as const
  /**
   * False, and measured against the protocol rather than assumed: appends are
   * acknowledged "without guaranteeing exact wording or completed audio
   * playback" and are the documented way to put context into a running
   * conversation. Nothing here pre-empts generation, so a note goes out the
   * moment it is made.
   */
  readonly notesPreemptSpeech = false

  model = ''
  voice = ''

  private connection: LiveConnection | null = null
  private mcpConnections: ConnectedMcp[] = []
  private delegate: AgentDelegate | null = null
  private closed = false
  /**
   * Nothing in GPT-Live marks the end of a turn — it is full duplex, and its
   * own reference says the transcript deltas "do not define complete turns or
   * include a transcript-done event". So Domo defines one: a gap. The timer is
   * reset by every delta in either direction (audio included, which is what
   * keeps a pause mid-sentence from committing half a message), and when it
   * finally fires the transcripts are stored, the fold is scheduled and
   * anything held is released — the same things a Gemini `turnComplete` does.
   */
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Function calls the Responses backend has produced but not yet been given
   * results for, keyed by the response they belong to. A response's calls are
   * only complete when its lifecycle says so — an arguments-done event alone
   * does not identify the call.
   */
  private pendingCalls = new Map<string, VoiceToolCall[]>()

  constructor(private readonly host: VoiceHost) {}

  async connect(): Promise<void> {
    const settings = await getSettings()
    this.model = settings.openaiLiveModel
    this.voice = settings.openaiVoiceName
    // Built once and used twice: the live model and the managed backend are
    // given the same instruction, and it costs a handful of queries.
    const instruction = await this.host.instruction()

    const delegation = settings.openaiDelegation
    const session: LiveSessionConfig = {
      model: this.model,
      instructions: instruction + LIVE_SUPPLEMENT[delegation.target],
      audio: {
        // One rate for both directions, and 24 kHz because that is the rate
        // the browser plays at — see `./audio.ts` for why the microphone's
        // 16 kHz is resampled here rather than in the tab.
        format: { type: 'audio/pcm', rate: LIVE_SAMPLE_RATE },
        output: { voice: this.voice }
      },
      delegation: delegation.target === 'responses'
        ? { type: 'responses', responses: await this.responsesConfig(settings, instruction) }
        : { type: 'client' }
    }

    if (delegation.target === 'agent') {
      this.delegate = new AgentDelegate({
        voiceSessionId: this.host.voiceSessionId,
        onUpdate: update => this.appendUpdate(update),
        onNote: text => this.host.systemNote(text)
      })
    }

    this.host.emit({ type: 'status', status: 'idle', detail: `connecting to ${this.model}` })

    this.connection = await LiveConnection.connect({
      session,
      onEvent: event => this.onEvent(event),
      onClose: (reason, expected) => {
        this.host.emit({ type: 'status', status: 'idle', detail: `connection closed (${reason})` })
        if (!expected && !this.closed) void this.host.reconnect()
      },
      onError: message => this.host.error(message)
    })

    this.host.emit({ type: 'status', status: 'live' })
    void updateVoiceSession(this.host.voiceSessionId, { status: 'live' })

    // The Live API reports occupancy as a ratio and never a token count, so a
    // conversation that has just connected has no reading at all until the
    // first `session.usage.updated`. Saying "0%" up front is the same promise
    // Gemini's fresh-session reading makes, and it is true here for the same
    // reason: this socket starts with whatever history was handed to it.
    this.host.usage({ used: 0, size: null, percent: 0 })
  }

  /**
   * The managed backend's configuration: the model, the voice agent's own
   * instruction as the *backend* prompt, and every tool Domo has.
   *
   * The instruction is shared with the live model deliberately. OpenAI's guide
   * splits them — conversation style in front, business rules behind — but
   * Domo's system instruction is mostly the second kind ("check with your
   * tools before saying anything about an agent"), and a backend that could
   * not see it would call tools with none of the judgement the prompt exists
   * to supply. The live model gets the same text and takes the speaking half
   * of it, which is the half it can act on.
   */
  private async responsesConfig(settings: AppSettings, instruction: string) {
    const declarations = voiceToolDeclarations({ autoTitle: settings.autoTitle })
    const tools: OpenAiFunctionTool[] = openAiToolsFromDeclarations(declarations)

    // MCP servers reach Gemini as clients its SDK calls itself; here they are
    // declarations Domo dispatches. Same servers, same scope filter.
    const { connections, errors } = await connectVoiceMcpServers()
    this.mcpConnections = connections
    for (const error of errors) {
      this.host.emit({ type: 'error', message: `MCP server "${error.name}" failed: ${error.message}` })
    }
    const mcp = await mcpFunctionTools(connections)
    this.host.useExtraTools(mcp.handlers)

    const effort = settings.openaiDelegation.reasoningEffort
    return {
      model: settings.openaiDelegation.responsesModel,
      instructions: instruction,
      tools: [...tools, ...mcp.tools],
      tool_choice: 'auto' as const,
      parallel_tool_calls: false,
      ...(effort ? { reasoning: { effort } } : {})
    }
  }

  /* ------------------------------ input ------------------------------ */

  sendAudio(base64: string): void {
    if (!this.connection?.open) return
    this.connection.send({
      type: 'session.input_audio.append',
      audio: resampleBase64Pcm16(base64, CLIENT_INPUT_SAMPLE_RATE, LIVE_SAMPLE_RATE)
    })
  }

  /**
   * Nothing to do: GPT-Live decides when the user has stopped talking from the
   * audio itself, and there is no "end of input" command to send. A muted
   * microphone is `session.input_audio.mute`, which is a different question —
   * the browser stops sending instead.
   */
  endAudioStream(): void {}

  /**
   * Something the user typed.
   *
   * There is no "user text" event in this protocol — the only inputs are audio
   * and appended context — so typed input is two separate errands: tell the
   * *backend* so it can answer, and tell the *live model* so it knows what was
   * said and does not ask for it again.
   *
   * `speak` decides how the second half is done, and the difference is the
   * whole reason the toggle exists. **Measured: appending typed input as
   * `thinking` gets no spoken reply at all.** The backend runs and answers, but
   * the live model has no audio turn to attach speech to, takes the result in
   * silently, and a close in that state comes back
   * `context_injection_incomplete`. So being *asked* is what produces speech:
   * `session.instructions.append` is the documented lever for redirecting the
   * conversation, and it is the only one of the three appends that reliably
   * makes the model act rather than merely know. `thinking` is still exactly
   * right for the quiet case — it is what "take this in, answer on screen"
   * means.
   */
  sendUserText(text: string, speak: boolean): void {
    if (!this.connection?.open) return
    this.connection.send(speak
      ? {
          type: 'session.instructions.append',
          delegation_id: null,
          content: `The developer typed this rather than saying it: "${text}". `
            + 'Answer them out loud, in your own words.'
        }
      : {
          type: 'session.thinking.append',
          delegation_id: null,
          content: `The developer typed this rather than saying it: "${text}". `
            + 'They are reading, not listening — do not answer out loud unless they speak.'
        })

    if (this.delegate) {
      void this.delegate.ask(null, text)
      return
    }
    this.connection.send({
      type: 'response.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
    this.connection.send({ type: 'response.create' })
  }

  /**
   * Agent news. `speak` picks the event, and that is the whole difference:
   * `commentary` is text the model paraphrases out loud, `thinking` is text it
   * knows and mentions only if it becomes relevant.
   *
   * A mixed batch becomes two appends rather than one, and that is the point
   * of keeping the batch: folding the silent notes into the spoken one would
   * have the model read out the things that were explicitly marked as not
   * worth saying. Neither append is a turn, so two cost nothing.
   */
  sendNotes(notes: VoiceNote[]): void {
    if (!this.connection?.open) return
    for (const speak of [false, true]) {
      const batch = notes.filter(note => note.speak === speak)
      if (!batch.length) continue
      this.connection.send({
        type: speak ? 'session.commentary.append' : 'session.thinking.append',
        delegation_id: null,
        content: batch.map(note => note.text).join('\n\n')
      })
    }
  }

  private appendUpdate(update: DelegationUpdate): void {
    if (!this.connection?.open) return
    this.connection.send({
      type: update.kind === 'commentary' ? 'session.commentary.append' : 'session.thinking.append',
      delegation_id: update.delegationId,
      content: update.text
    })
  }

  async close(): Promise<VoiceUsageReading | null> {
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.delegate?.close()
    this.delegate = null
    const audioSeconds = await this.connection?.close()
    this.connection = null
    for (const connection of this.mcpConnections) await connection.close()
    this.mcpConnections = []
    return typeof audioSeconds === 'number' ? { audioSeconds } : null
  }

  /* ------------------------------ output ------------------------------ */

  /**
   * Something arrived, so the conversation is not idle. Restarts the clock
   * that decides where one exchange ends and the next begins.
   */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const timer = setTimeout(() => {
      this.idleTimer = null
      this.settle()
    }, TRANSCRIPT_IDLE_MS)
    timer.unref?.()
    this.idleTimer = timer
  }

  /** The conversation has gone quiet: store what was said and fold it in. */
  private settle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.host.speaking(false)
    void this.host.turnComplete().catch((error) => {
      console.error(`[voice:${this.host.voiceSessionId}] could not store the exchange`, error)
    })
  }

  private onEvent(event: LiveServerEvent): void {
    switch (event.type) {
      case 'session.output_audio.delta':
        this.host.audio((event as any).delta, LIVE_SAMPLE_RATE)
        // Audio arriving *is* the model speaking; there is no separate "turn
        // started". Gemini's `modelTurn` has no counterpart here.
        this.host.speaking(true)
        this.touch()
        return

      case 'session.input_transcript.delta':
        this.host.userDelta((event as any).delta ?? '')
        this.touch()
        return

      case 'session.output_transcript.delta':
        this.host.assistantDelta((event as any).delta ?? '')
        this.touch()
        return

      case 'session.usage.updated': {
        const usage = event as Extract<LiveServerEvent, { type: 'session.usage.updated' }>
        const ratio = usage.context_window?.usage_ratio
        this.host.usage({
          // A ratio and no token counts: `used` stays zero and `percent` is
          // what anything drawing a bar must read. See `VoiceUsage`.
          ...(typeof ratio === 'number' && Number.isFinite(ratio)
            ? { percent: Math.max(0, Math.min(100, Math.round(ratio * 100))) }
            : {}),
          ...(typeof usage.usage?.seconds === 'number' ? { audioSeconds: usage.usage.seconds } : {})
        })
        return
      }

      case 'session.delegation.created': {
        const delegation = (event as any).delegation ?? {}
        if (delegation.target !== 'client') return
        if (!this.delegate) {
          // Configured for Responses and asked to answer anyway. Say so rather
          // than leaving the live model waiting on nothing.
          console.warn(`[voice:${this.host.voiceSessionId}] a client delegation arrived with no client backend`)
          return
        }
        void this.delegate.ask(delegation.id ?? null).catch((error) => {
          console.error(`[voice:${this.host.voiceSessionId}] delegation failed`, error)
        })
        return
      }

      case 'response.event':
        this.onResponsesEvent((event as any).event as LiveResponsesEvent, (event as any).delegation_id)
        return

      case 'session.closed':
        // The final, authoritative audio total. Nothing else reports it.
        if (typeof (event as any).usage?.seconds === 'number') {
          this.host.usage({ audioSeconds: (event as any).usage.seconds })
        }
        this.settle()
        return

      case 'error':
        this.host.error(liveErrorMessage(event))
        return
    }
  }

  /**
   * The managed backend's own lifecycle, nested inside `response.event`.
   *
   * Only two things in it matter to Domo. A finished function-call item is a
   * tool to run — and it has to be read from `response.output_item.done`,
   * because the forwarded `response.completed` carries an empty `output` array
   * even when calls are waiting for results. And the end of a response is when
   * those results are submitted and the backend is told to continue.
   *
   * **The two are keyed by the envelope's `delegation_id`, not by a response
   * id**, and that is measured rather than tidy-looking: only
   * `response.created`, `response.in_progress` and `response.completed` carry
   * a nested `response` object. The item events — `output_item.added`,
   * `output_item.done` and the argument deltas — carry none, so keying on
   * `event.response?.id` files the pending call under one key and looks it up
   * under another. The calls were collected and then silently dropped, which
   * on a voice surface is a model that hears you and never answers.
   */
  private onResponsesEvent(event: LiveResponsesEvent, delegationId?: string): void {
    if (!event?.type) return
    const responseId = delegationId ?? event.response?.id ?? 'current'

    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const call: VoiceToolCall = {
        id: event.item.call_id ?? event.item.id ?? '',
        name: event.item.name ?? '',
        args: parseArguments(event.item.arguments)
      }
      if (!call.name || !call.id) return
      const pending = this.pendingCalls.get(responseId) ?? []
      pending.push(call)
      this.pendingCalls.set(responseId, pending)
      return
    }

    if (event.type === 'response.completed' || event.type === 'response.done') {
      const pending = this.pendingCalls.get(responseId) ?? []
      this.pendingCalls.delete(responseId)
      if (!pending.length) {
        // A response that called nothing has finished thinking; whatever it
        // concluded has already gone to the live model, which will speak it
        // and reset the idle timer along the way.
        this.touch()
        return
      }
      void this.runPending(pending)
      return
    }

    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      this.pendingCalls.delete(responseId)
      this.host.error('The delegated backend did not finish its response')
    }
  }

  private async runPending(calls: VoiceToolCall[]): Promise<void> {
    let results: Awaited<ReturnType<VoiceHost['runTools']>>
    try {
      results = await this.host.runTools(calls)
    } catch (error) {
      console.error(`[voice:${this.host.voiceSessionId}] tool calls failed`, error)
      return
    }
    if (!this.connection?.open) return
    // Every pending call needs a result before the backend may continue, so
    // they all go out and then exactly one `response.create` does.
    for (const { call, result } of results) {
      this.connection.send({
        type: 'response.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.id,
          output: typeof result === 'string' ? result : JSON.stringify(result ?? {})
        }
      })
    }
    this.connection.send({ type: 'response.create' })
  }
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
