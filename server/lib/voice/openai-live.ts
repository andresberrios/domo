import WebSocket from 'ws'

import { openAiApiKey, openAiLiveUrl } from '../openai'

/**
 * The GPT-Live wire protocol, and nothing above it.
 *
 * A thin typed client rather than an SDK object, for the reason the Codex
 * usage poller talks JSON-RPC to `codex app-server` directly: what Domo needs
 * is a socket that carries JSON events, and every line of translation between
 * an SDK's session object and Domo's own conversation is a line that can
 * disagree with the row. The protocol itself is small — start, append audio,
 * read deltas, append context, close.
 *
 * What is worth knowing before reading on: GPT-Live is **not** the Gemini Live
 * shape with different names. The model runs the conversation and holds no
 * tools at all; reasoning and tool use are *delegated*, either to a Responses
 * model the API manages or to this application (`delegation.type: 'client'`).
 * Results go back in as appended context — spoken (`commentary`), silent
 * (`thinking`) or as direction (`instructions`) — never as a turn.
 */

export const LIVE_SAMPLE_RATE = 24000

/* ----------------------------- wire types ----------------------------- */

export interface LiveResponsesDelegation {
  type: 'responses'
  responses: {
    model: string
    instructions?: string
    tools?: unknown[]
    tool_choice?: 'auto' | 'none' | 'required'
    parallel_tool_calls?: boolean
    reasoning?: { effort?: string, summary?: string }
  }
}

export interface LiveClientDelegation {
  type: 'client'
}

export interface LiveSessionConfig {
  model: string
  instructions?: string
  audio?: {
    format?: { type: 'audio/pcm', rate: 16000 | 24000 }
    output?: { voice?: string }
  }
  /** Text-only history the session starts with: at most 128 messages. */
  input?: Array<{
    type?: 'message'
    role: 'developer' | 'user' | 'assistant'
    content: Array<{ type: 'input_text' | 'output_text', text: string }>
  }>
  delegation?: LiveResponsesDelegation | LiveClientDelegation | null
}

/** Every server event Domo does something with; the rest are logged and dropped. */
export type LiveServerEvent =
  | { type: 'session.started', session: { id: string } }
  | { type: 'session.updated', session: unknown }
  | { type: 'session.closed', usage?: { seconds?: number } }
  | { type: 'session.output_audio.delta', delta: string }
  | { type: 'session.input_transcript.delta', delta: string, start_ms?: number, end_ms?: number }
  | { type: 'session.output_transcript.delta', delta: string, start_ms?: number, end_ms?: number }
  | {
    type: 'session.usage.updated'
    usage?: { seconds?: number }
    context_window?: { usage_ratio?: number }
  }
  | {
    type: 'session.delegation.created'
    delegation: { id: string, target: 'client' | 'responses', response_id?: string }
    offset_ms?: number
  }
  | { type: 'session.commentary.appended' | 'session.thinking.appended' | 'session.instructions.appended' }
  | { type: 'response.event', delegation_id?: string, event: LiveResponsesEvent }
  | { type: 'error', error: { message?: string, code?: string, type?: string, client_event_id?: string } }
  | { type: string, [key: string]: unknown }

/** The nested Responses lifecycle events, of which Domo reads the function calls. */
export interface LiveResponsesEvent {
  type: string
  response?: { id?: string }
  item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
  }
  delta?: string
  [key: string]: unknown
}

export type LiveClientEvent =
  | { type: 'session.start', session: LiveSessionConfig, event_id?: string }
  | { type: 'session.update', session: { delegation?: unknown }, event_id?: string }
  | { type: 'session.input_audio.append', audio: string }
  | { type: 'session.input_audio.mute' | 'session.input_audio.unmute', event_id?: string }
  | {
    type: 'session.commentary.append' | 'session.thinking.append' | 'session.instructions.append'
    content: string
    delegation_id: string | null
    event_id?: string
  }
  | { type: 'response.item.create', item: unknown, event_id?: string }
  | { type: 'response.create', event_id?: string }
  | { type: 'session.close', event_id?: string }

/* ------------------------------ connection ------------------------------ */

/**
 * How long a connect waits for `session.started`. The handshake is one round
 * trip; a socket that has not answered by now is not going to, and the caller
 * has a microphone open while it waits.
 */
const START_TIMEOUT_MS = 20000

/**
 * How long `close()` waits for `session.closed` after asking.
 *
 * The final event carries the conversation's billed audio duration, which is
 * the one number that cannot be recomputed afterwards — so it is worth
 * waiting for, and not worth waiting long: the connection is already going.
 */
const CLOSE_TIMEOUT_MS = 5000

export interface LiveConnectionOptions {
  session: LiveSessionConfig
  onEvent: (event: LiveServerEvent) => void
  /** The socket went away. `expected` is true when `close()` asked for it. */
  onClose: (reason: string, expected: boolean) => void
  onError: (message: string) => void
}

/**
 * The little of `ws` this module uses. Narrow on purpose: the test suite
 * replaces the module (as it replaces `@google/genai` for the other provider)
 * and a fake that only has to satisfy this is a dozen lines.
 */
export interface LiveSocket {
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: any[]) => void): unknown
  send(data: string): void
  close(): void
}

export class LiveConnection {
  /** The Live session id, once it has started. Needed for forking and recordings. */
  sessionId: string | null = null
  /**
   * The conversation's billed speech duration, as `session.closed` reported
   * it. Nothing else reports the final figure, and it arrives *after* the
   * conversation has been told to shut down — so it is kept here and handed
   * back by `close()` rather than pushed at a runtime that has stopped
   * listening.
   */
  finalAudioSeconds: number | null = null
  private socket: LiveSocket | null = null
  private closing = false
  private closed = false
  private closedResolve: (() => void) | null = null

  private constructor(private readonly options: LiveConnectionOptions) {}

  /**
   * Open a socket, start a session on it, and resolve once the server has
   * confirmed the resolved configuration.
   *
   * Events are delivered to `onEvent` from the moment the socket opens — the
   * handshake is not a quiet period, and a delegation can arrive in the same
   * breath as `session.started` if the session was given history.
   */
  static connect(options: LiveConnectionOptions): Promise<LiveConnection> {
    const connection = new LiveConnection(options)
    return connection.start().then(() => connection)
  }

  private start(): Promise<void> {
    const apiKey = openAiApiKey()
    if (!apiKey) {
      return Promise.reject(new Error(
        'No OpenAI API key. Add one in Settings → General, or NUXT_OPENAI_API_KEY in .env.'
      ))
    }

    const socket = new WebSocket(
      openAiLiveUrl(),
      { headers: { Authorization: `Bearer ${apiKey}` } }
    ) as unknown as LiveSocket
    this.socket = socket

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.hardClose()
        reject(new Error(`The OpenAI Live API did not start a session within ${START_TIMEOUT_MS / 1000}s`))
      }, START_TIMEOUT_MS)
      timer.unref?.()

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }

      socket.on('open', () => {
        this.send({ type: 'session.start', event_id: 'domo_start', session: this.options.session })
      })

      socket.on('message', (data: unknown) => {
        let event: LiveServerEvent
        try {
          event = JSON.parse(String(data)) as LiveServerEvent
        } catch {
          return
        }
        if (event.type === 'session.started') {
          this.sessionId = (event as any).session?.id ?? null
          finish()
        }
        // A rejected `session.start` is the one error that has to fail the
        // connect rather than being reported into a conversation that never
        // began: a bad model id or an unknown voice arrives this way.
        if (event.type === 'error' && !settled) {
          finish(new Error(liveErrorMessage(event)))
          this.hardClose()
          return
        }
        if (event.type === 'session.closed') {
          this.closed = true
          const seconds = (event as any).usage?.seconds
          if (typeof seconds === 'number' && Number.isFinite(seconds)) this.finalAudioSeconds = seconds
          this.closedResolve?.()
        }
        try {
          this.options.onEvent(event)
        } catch (error) {
          console.error('[voice:openai] event handling failed', error)
        }
      })

      socket.on('error', (error: any) => {
        const message = error?.message ? String(error.message) : String(error ?? 'unknown socket error')
        finish(new Error(message))
        this.options.onError(message)
      })

      socket.on('close', (code: number, reason: unknown) => {
        const detail = `${code ?? '?'}${reason ? `: ${String(reason)}` : ''}`
        finish(new Error(`The OpenAI Live socket closed before the session started (${detail})`))
        this.socket = null
        this.closedResolve?.()
        this.options.onClose(detail, this.closing)
      })
    })
  }

  get open(): boolean {
    return !!this.socket && !this.closing
  }

  send(event: LiveClientEvent): void {
    if (!this.socket) return
    try {
      this.socket.send(JSON.stringify(event))
    } catch (error) {
      console.error('[voice:openai] could not send an event', error)
    }
  }

  /**
   * Ask the session to end, wait briefly for its final usage, then let go.
   *
   * `session.closed` is the only place the conversation's total billed audio
   * duration is confirmed, so the wait exists for that and for nothing else.
   */
  async close(): Promise<number | null> {
    if (!this.socket || this.closing) {
      this.hardClose()
      return this.finalAudioSeconds
    }
    this.closing = true
    this.send({ type: 'session.close', event_id: 'domo_close' })
    if (!this.closed) {
      await new Promise<void>((resolve) => {
        this.closedResolve = resolve
        const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
        timer.unref?.()
      })
    }
    this.hardClose()
    return this.finalAudioSeconds
  }

  private hardClose(): void {
    const socket = this.socket
    this.socket = null
    this.closing = true
    try {
      socket?.close()
    } catch {
      /* already gone */
    }
  }
}

export function liveErrorMessage(event: LiveServerEvent): string {
  const error = (event as any).error ?? {}
  const parts = [error.message, error.code && `(${error.code})`].filter(Boolean)
  return parts.length ? parts.join(' ') : 'The OpenAI Live API reported an error'
}
