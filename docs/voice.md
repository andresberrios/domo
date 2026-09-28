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

## Talking to a coding agent

The voice bar on an agent's page (`server/lib/agent-voice/`) is a cascade, not
a live model: the browser records, an engine transcribes, the transcript is
delivered to the agent as an ordinary spoken turn, and the agent's streamed
text is read out sentence by sentence by an engine. The agent is the only
thing that thinks. Engines are chosen in Settings (`AgentVoiceSettings`),
separately for hearing and speaking: Gemini, OpenAI, open models on the CPU
(Moonshine and Kokoro through transformers.js, about 300 MB fetched on first
use), or a Kyutai moshi-server.

- **The spoken-channel instructions ride on the message, never on the
  session.** ACP has no portable system prompt (only the Claude Code adapter
  reads one from session metadata), and a system prompt would change typed
  sessions too. The full text goes with the first spoken message of an
  episode and a one-line reminder with the rest; `needsFullInstructions`
  in `agent-voice/prompt.ts` is the rule. A typed message is answered as
  text.
- **Hands-free ends a turn with words, never with a clock**, unless the
  `silence` detector is chosen in Settings. By default, at each pause
  the whole turn so far is scored by `pipecat-ai/smart-turn` v3.2 (BSD-2,
  8 MB ONNX, about 150 ms on the CPU including the feature extraction in
  `agent-voice/turn.ts`, which matches transformers.js's Whisper extractor
  exactly). An incomplete turn is held; after a silence the bar says "yes?",
  twice at most, and waits. Only a complete-sounding pause, a sign-off
  ("over" after punctuation, "that's it", "go ahead"), a Send, or a spoken
  command ends it. The model file is fetched from Hugging Face into the data
  directory on first use, or read from `NUXT_SMART_TURN_MODEL`; without it a
  pause ends the turn. The `kyutai` detector reads the Kyutai transcriber's
  two-second pause head instead, and `silence` waits `silenceSeconds`.
- **Speech leaves the browser through a media element, not
  `AudioContext.destination`.** Chrome's echo canceller only subtracts what
  it knows is playing, and on Android that is media elements and WebRTC. On
  a Galaxy phone's loudspeaker the agent's voice came straight back in as
  the developer's, until this.
- **Every audio graph is resumed inside a tap.** iOS creates them suspended
  outside a gesture and refuses to resume them from anywhere else, which is
  why the microphone is opened by the button and never on mount.
- **`onnxruntime-node` is pinned to the version transformers.js depends on.**
  Two versions in one process fail at `dlopen` with a symbol-version error,
  because the second binding finds the first shared library already loaded.
- **Under `pnpm dev`, a `server/` edit breaks every ONNX model until the dev
  server is restarted.** Nitro reloads into a new worker, and the native
  binding cannot load twice in one process ("Module did not self-register").
  The turn model then reports itself unavailable and the local engines fail.
  A production process never reloads, so it is a dev-only cost.
- **The Kyutai engine was written from the reference clients and has not run
  against a server.** A moshi-server needs a GPU. Its key is
  `NUXT_KYUTAI_API_KEY`, the one environment variable here, because the
  settings table is streamed to the browser.
- **No open full-duplex model takes an external brain** (researched September
  2026: Moshi, PersonaPlex, MiniCPM-o, NemotronLabs VoiceChat all own their
  LLM). Kyutai Unmute is the open path to a Realtime-style socket around an
  external LLM, and needs a GPU. This cascade is the CPU answer.
