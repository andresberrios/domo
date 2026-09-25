# The voice agent

Read before changing `server/lib/voice/`, either provider, or anything about
delegation, transcripts or voice usage.

## Two providers, one conversation

`voiceProvider` in Settings picks Gemini Live or OpenAI GPT-Live. The split is
composition, not a class per vendor: `runtime.ts` owns everything the
*conversation* is made of — transcript rows, the note gate and its single
drain, the throttled usage write, the tool log, the hand-over — and a
`VoiceBackend` (`voice/backend.ts`) is the translation to one vendor's socket.

**The provider is read at connect, never at construction.** A conversation is
rebuilt from `voice_messages` at every connect anyway, so changing the setting
and reconnecting continues the *same* conversation on the other vendor's model,
with the same id and the same open microphone. Every callback a backend makes
goes through a host bound to the generation it connected at, so a late event
from a replaced socket cannot write to the conversation that replaced it.

The summariser follows the provider too: an install running GPT-Live may hold
no Gemini key, and a conversation whose folds all fail is one that quietly
forgets.

## GPT-Live is not Gemini Live with different names

- **The live model holds no tools and does no reasoning.** It runs the spoken
  conversation and *delegates* (`session.delegation.created`), either to a
  Responses model OpenAI manages or to Domo itself (`delegation.type: 'client'`).
- **Results go back as appended context, never as a turn** —
  `session.commentary.append` to say aloud, `session.thinking.append` to know
  quietly, `session.instructions.append` to redirect. This is why
  `notesPreemptSpeech` is false for it: an append is designed to arrive
  mid-sentence, while Gemini's client content truncates what is being said.
- **Nothing on the wire ends a turn.** Its own reference says the transcript
  deltas "do not define complete turns". So Domo defines one:
  `TRANSCRIPT_IDLE_MS` (2 s) after the last delta of *either* side, audio
  included. Shorten it and a pause mid-sentence becomes two messages; remove it
  and a user who never stops talking is never written to `voice_messages` at
  all.
- **A rejected `session.start` must fail the connect.** A bad model id or voice
  arrives as an ordinary `error` event, which would otherwise be reported into
  a conversation that never began. There is no resumption handle in this
  protocol: the history a socket starts with is the instruction.

## Delegation

`responses` is one object in `session.start`: OpenAI calls the model with
Domo's own voice tool declarations converted into its dialect
(`voice/tool-schema.ts`), and Domo runs the function calls through the same
`runToolCalls` Gemini uses. `agent` is client delegation — `voice/delegation.ts`
builds a request from the same `buildConversationContext` a reconnect uses (the
delegation event carries **no task text**), steers it into a coding agent, and
follows that agent on the bus for its `turn_end`.

- **A pending function call is keyed by the envelope's `delegation_id`, never
  by a nested response id.** Measured: only `response.created`,
  `response.in_progress` and `response.completed` carry a nested `response`
  object. The item events carry none, so keying on `event.response?.id` files
  the call under one key and looks it up under another — every delegated tool
  call was collected and silently dropped, and the conversation stalled with no
  error anywhere.
- **The `agent` target gives up the conversation-only tools**
  (`set_conversation_title`, `start_new_conversation`, `answer_permission`):
  they live on the delegation backend and a coding agent is not one. The
  Settings card says so rather than leaving it to be discovered.
- **The live model is told it holds no tools; the backend is not.** Domo's
  system instruction is the operator's and is written for a model that calls
  tools, so `LIVE_SUPPLEMENT` is appended to the live model's copy only.

## Typed input

**GPT-Live stays silent on typed input unless it is instructed to speak.**
Measured: appending the text as `thinking` plus `response.item.create` /
`response.create` is what OpenAI's guide prescribes, and the backend does run
and answer — but with no audio turn to attach speech to, the live model takes
the result in silently, and a close in that state returns
`context_injection_incomplete`. `session.instructions.append` is what makes it
act.

So typed input carries a `speak` flag from the browser (`useSpokenReplies()`, a
`localStorage` switch beside the text box) through to
`VoiceBackend.sendUserText`, and the two providers need **opposite** handling
to honour it: Gemini answers a turn unless `turnComplete: false` says not to;
GPT-Live says nothing unless instructed.

## Audio and usage

- **The browser's rates are fixed** — capture at 16 kHz, playback built at
  24 kHz regardless of the rate a chunk is labelled with. Gemini wants exactly
  that pair. GPT-Live takes one rate for both directions, so the session is
  configured at 24 kHz and the microphone is resampled in `voice/audio.ts`. The
  tab keeps one code path whichever provider is configured, which it must,
  since the provider can change under a live conversation.
- **The two providers count usage in different currencies.** Gemini reports
  tokens and Domo supplies the denominator; GPT-Live reports
  `context_window.usage_ratio` and **no token counts at all**, plus a
  cumulative audio duration. So `VoiceUsage.context` has a `percent`, and where
  it is set `used` is zero meaning "not reported" — anything drawing a bar must
  prefer `percent` and must not print the token count beside it.
- **The final audio total arrives in `session.closed`**, after the runtime has
  stopped accepting callbacks from that socket, which is why
  `VoiceBackend.close()` returns a reading instead of pushing one.

## Testing it

`pnpm test:voice` is the only layer that can execute `useVoiceChannel` at all —
happy-dom has no `AudioContext` and no `AudioWorklet`. It is opt-in, uses a
real browser with a WAV for a microphone and a real GPT-Live session, and it
bills. See `test/AGENTS.md`.

**Not verified against a real account**: the `agent` delegation target end to
end (the live layer exercises `responses`), whether 2 s is the right idle gap
against long real pauses, and how the 16→24 kHz resample sounds to a person.
