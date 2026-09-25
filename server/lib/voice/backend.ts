import type { VoiceProvider, VoiceServerMessage } from '../../../shared/types'

/**
 * What a live voice model has to do, and what it may ask the conversation for.
 *
 * Two providers now sit behind one `VoiceRuntime`: a conversation is the
 * `voice_sessions` row and its messages, and the socket is disposable — so the
 * provider is the disposable half. Everything that has to be true whoever is
 * speaking stays in the runtime: the transcript rows, the note gate and its
 * single drain, the throttled usage write, the tool log, the proactive
 * subscription to agent activity, the hand-over to a fresh conversation. A
 * backend is the translation between one vendor's socket and the calls below,
 * and it holds no state the row cares about.
 *
 * Composition rather than a subclass per provider, because the provider is
 * read from Settings at **connect** time and not at construction: a
 * conversation whose provider changed under it reconnects onto the other
 * model, with the same id, the same history and the same open microphone.
 */

/**
 * What the browser captures at and what it plays at, both fixed in
 * `useVoiceChannel.ts` — playback in particular builds every `AudioBuffer` at
 * 24 kHz and ignores the rate a chunk is labelled with. A backend takes audio
 * in at the first and must emit it at the second, resampling if its provider
 * insists on something else.
 */
export const CLIENT_INPUT_SAMPLE_RATE = 16000
export const CLIENT_OUTPUT_SAMPLE_RATE = 24000

export interface VoiceToolCall {
  /** The provider's own id for this call, quoted back in the result. */
  id: string
  name: string
  args: Record<string, unknown>
}

/** One line of context from Domo. `speak` means it is worth saying out loud now. */
export interface VoiceNote {
  text: string
  speak: boolean
}

export interface VoiceToolResult {
  call: VoiceToolCall
  result: unknown
}

/** A context-window reading, in whichever currency the provider counts in. */
export interface VoiceUsageReading {
  used?: number
  size?: number | null
  /** Occupancy the provider reported directly, 0-100. See `VoiceUsage`. */
  percent?: number | null
  audioSeconds?: number | null
}

/**
 * The conversation, as its current socket may touch it.
 *
 * Every method is a no-op once the socket that was handed this host has been
 * replaced — a `goAway` reconnect, a provider switch, a `close()` — so a late
 * callback from a socket nobody is listening to can neither write a transcript
 * row nor resurrect a session that has gone.
 */
export interface VoiceHost {
  readonly voiceSessionId: string
  /** The instruction the model is started with: prompt, roster and context. */
  instruction(): Promise<string>
  emit(message: VoiceServerMessage): void
  /** Speech to play, at the rate it is encoded in. */
  audio(base64: string, sampleRate: number): void
  /** A guess at the user's current phrase; replaced, never accumulated. */
  userInterim(text: string): void
  userDelta(text: string): void
  assistantDelta(text: string): void
  /**
   * The model has started or stopped producing a turn. Stopping is also a
   * release point for held notes — on Gemini `generationComplete` arrives
   * before `turnComplete` waits out playback, and a note held until the second
   * one would sit there for the length of the answer being spoken.
   */
  speaking(value: boolean): void
  interrupted(): Promise<void>
  /** The exchange is over: store what was said, fold, and release held notes. */
  turnComplete(): Promise<void>
  usage(reading: VoiceUsageReading): void
  /** Run these calls in order, log each to the transcript, hand back the results. */
  runTools(calls: VoiceToolCall[]): Promise<VoiceToolResult[]>
  /**
   * Tools the backend itself resolves — MCP servers it connected on its own.
   * Consulted only for a name `./tools.ts` does not define.
   */
  useExtraTools(handlers: Record<string, (args: any) => Promise<unknown>>): void
  /**
   * Write a line into the conversation's own transcript without telling the
   * model anything. For what Domo did rather than what was said — which agent
   * a delegation went to, say. `VoiceRuntime.injectNote` is the other half of
   * this: a row *and* a delivery.
   */
  systemNote(text: string): void
  error(message: string): void
  /** Drop this socket and open another, keeping the conversation. */
  reconnect(): Promise<void>
}

export interface VoiceBackend {
  readonly provider: VoiceProvider
  /** What this socket actually connected with, recorded on the row. */
  readonly model: string
  readonly voice: string
  /**
   * Whether putting text into the conversation cuts off what the model is
   * saying. Gemini's `sendClientContent` pre-empts generation, which is what
   * made the voice agent interrupt itself mid-sentence when an agent finished;
   * GPT-Live's appends are designed to arrive at any moment and do not. The
   * runtime holds notes for a gap only when this is true.
   */
  readonly notesPreemptSpeech: boolean
  connect(): Promise<void>
  /** Base64 PCM16 at `CLIENT_INPUT_SAMPLE_RATE`; the backend resamples if it must. */
  sendAudio(base64: string): void
  endAudioStream(): void
  /**
   * Something the user typed rather than said. `speak` asks for the answer out
   * loud, and the providers need opposite handling to honour it: Gemini
   * answers a turn unless told not to, while GPT-Live says nothing unless it
   * is asked to. Neither can be left to its default and still match the user's
   * choice.
   */
  sendUserText(text: string, speak: boolean): void
  /**
   * Context from Domo rather than from the user: agent activity, a permission
   * that needs a decision. Always a batch, because what was held while the
   * model spoke is delivered in one go — three agents finishing is one thing
   * to say, not three. How a batch is rendered is the provider's business.
   */
  sendNotes(notes: VoiceNote[]): void
  /**
   * Shut the socket down, and hand back anything it only says on the way out.
   *
   * GPT-Live confirms the conversation's billed speech duration in
   * `session.closed` and nowhere else — after the runtime has stopped
   * accepting callbacks from this socket, which is exactly the point of
   * returning it rather than pushing it.
   */
  close(): Promise<VoiceUsageReading | null>
}
