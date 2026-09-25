# The voice agent

Read this before you change `server/lib/voice/`, either provider, or anything
about delegation, transcripts or voice usage.

## Two providers, one conversation

- `voiceProvider` in Settings picks Gemini Live or OpenAI GPT-Live.
  `runtime.ts` owns the conversation: transcript rows, notes, usage, tools and
  the hand-over. A `VoiceBackend` (`voice/backend.ts`) translates to one
  vendor's socket.
- **The provider is read at connect, never at construction.** Every connect
  rebuilds the conversation from `voice_messages`, so switching providers and
  reconnecting continues the same conversation. Backend callbacks are bound to
  the generation they connected at, so a late event from a replaced socket
  cannot write to the new one.
- The summarizer follows the provider, because an install on GPT-Live may have
  no Gemini key.

## GPT-Live differs from Gemini Live

- **The live model holds no tools and does no reasoning.** It delegates,
  either to a Responses model managed by OpenAI or to Domo
  (`delegation.type: 'client'`).
- **Results go back as appended context, never as a turn**
  (`session.commentary.append`, `session.thinking.append`,
  `session.instructions.append`). That is why `notesPreemptSpeech` is false for
  it. Gemini's client content cuts off what is being said.
- **Nothing on the wire ends a turn.** Domo ends one `TRANSCRIPT_IDLE_MS`
  (2 s) after the last delta from either side. Without it, a user who never
  stops talking is never written to `voice_messages`.
- **A rejected `session.start` must fail the connect.** A bad model id or voice
  arrives as an ordinary `error` event.
- **Key a pending function call by the envelope's `delegation_id`, never by a
  nested response id.** Only three event types carry a nested `response`.
  Keyed the other way, every delegated tool call is dropped without an error.
- **The `agent` delegation target loses the conversation-only tools**
  (`set_conversation_title`, `start_new_conversation`, `answer_permission`).
  They live on the delegation backend, and a coding agent is not one.
- **Typed input needs opposite handling on the two providers.** Gemini answers
  a turn unless `turnComplete: false` stops it. GPT-Live stays silent unless
  `session.instructions.append` tells it to speak. The browser sends a `speak`
  flag (`useSpokenReplies()`) through `VoiceBackend.sendUserText`.

## Audio and usage

- **The browser's rates are fixed**: capture at 16 kHz, playback at 24 kHz.
  GPT-Live uses one rate for both, so the session runs at 24 kHz and
  `voice/audio.ts` resamples the microphone. The browser keeps one code path,
  because the provider can change during a conversation.
- **GPT-Live reports a context `percent` and no token counts.** When `percent`
  is set, `used` is zero and means "not reported". UI must prefer `percent`.
- **GPT-Live's final audio total arrives in `session.closed`**, after the
  runtime stops accepting callbacks. That is why `VoiceBackend.close()` returns
  a reading.

## Testing

`pnpm test:voice` is the only layer that runs `useVoiceChannel`, because
happy-dom has no `AudioContext`. It uses a real browser and a real GPT-Live
session. See `test/AGENTS.md`.
