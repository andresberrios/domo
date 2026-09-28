# Handoff: talking to coding agents by voice

Written 2026-09-28 by the agent that built this, for a successor with no
access to the transcript. The environment it ran in is being retired.

## The ask

The user (Andres, Domo's author and only user) wants to talk to *regular
coding sessions* (Claude Code, Codex, OpenCode over ACP) by voice, cheaply,
with open models where possible, instead of only through the Gemini/GPT-Live
voice agent. The original ask, in order of arrival:

1. Make coding sessions usable as voice conversations. Cheap STT and TTS,
   smart turn detection, an explicit "over" sign-off for hands-free, a
   click-to-record mode, interruptions that stop speech but not the agent's
   work, and read the agent's text out loud if it follows a voice-style
   instruction. Gemini models for the first prototype.
2. Keep it one session, not a separate "voice session" kind; instructions
   must not change how typed sessions behave.
3. Replace the "over" convention with a real turn model; play a sound when a
   turn is delivered; make it work from a phone through a tunnel.
4. Never auto-send on a timer; have the assistant say "yes?" instead.
   Repeating "working" sound; a tool-call sound. All engine choices in
   Settings (DB), not env vars. Add Kyutai/Unmute as an engine. Add an
   end-of-turn detector setting (Smart Turn / Kyutai / silence).
5. Research open full-duplex models and prototype the open path.
6. Fix echo on a Galaxy A36 speaker; keep listening while the agent talks
   (the user explicitly rejected gating the mic and a barge-in toggle); make
   the bar work on a phone.

## What exists now (all on this branch, uncommitted before the handoff commit)

Server, `server/lib/agent-voice/`:

- `runtime.ts`: per-agent-session cascade. Browser sends 16 kHz PCM16 base64
  over `/api/agent-voice/ws?agentSessionId=`. Click mode: `segment-end
  final:true` transcribes and delivers. Hands-free: `segment-end final:false`
  appends to the held turn, asks the turn detector, transcribes the last
  segment for a sign-off, holds or sends. Held turns get a spoken "Yes?" /
  "Mm-hm." after 2.5 s, again after 8 s, then silence; never a timed send
  (except the `silence` detector, and a 60 s cap). Follows the bus:
  `agent_message` rows are split into sentences (`takeSentences`) and spoken
  as they stream; `tool_call` emits a `tool` message; `permission_request`
  is spoken. `hush` drops speech and marks the rest of the answer unspoken
  until the next turn; `cancel` stops the agent's turn. Spoken turns go to
  `acpManager.deliver(..., { delivery: 'steer', origin: 'voice' })`.
- `prompt.ts`: the spoken-channel instructions ride on the *message* as a
  second text block starting with `[Spoken over voice]` (hidden in the
  transcript, shown as a "Spoken" badge). Full text on the first spoken
  message of an episode, one-line reminder after; `needsFullInstructions`
  repeats the full text after a typed message, 30 min, or 12 messages. The
  earlier system-prompt append for Claude Code was removed on the user's
  request (it would alter typed sessions).
- `speech.ts`: `transcribe()` / `synthesize()` dispatch on
  `settings.agentVoice.transcriber` / `.speaker`: `gemini`
  (`gemini-3.5-transcribe`, `gemini-3.8-flash-lite-tts` streamed, voice from
  `settings.voiceName`), `openai` (`openai-speech.ts`, REST
  `/audio/transcriptions` + `/audio/speech` pcm stream), `local`
  (`local-speech.ts`: Moonshine via transformers.js + Kokoro via kokoro-js,
  CPU, weights cached in `dataDir()/models/hf`), `kyutai`
  (`kyutai-speech.ts`, moshi-server msgpack websocket, **never run against a
  server**).
- `turn.ts`: Smart Turn v3.2 (pipecat-ai/smart-turn, BSD-2) through
  onnxruntime-node, with Whisper log-mel features reimplemented in Node and
  verified identical to transformers.js's extractor. Model auto-downloads
  from Hugging Face to `dataDir()/models/`, or `NUXT_SMART_TURN_MODEL`.
- `utterance.ts`: sign-offs ("over" after punctuation, "message over", "over
  and out", "that's it/all/everything", "end of message", "go ahead";
  `lenient` also takes a bare trailing "over"), commands ("stop" = hush,
  "cancel"/"never mind" = cancel), sentence splitting, Markdown stripping.
- `server/api/agent-voice/ws.ts`: the socket. Runtime closes 5 s after the
  last listener leaves.
- `server/lib/acp/manager.ts`: unchanged in the end (an earlier `_meta.systemPrompt`
  append was added and then removed).
- `server/lib/repo.ts`: `listRecentUserMessages`. `server/lib/settings.ts`:
  `agentVoice` defaults + `storedAgentVoice` validation.

Browser:

- `app/composables/useAgentVoice.ts`: mic capture (AudioWorklet from
  `app/utils/pcm.ts`, shared with `useVoiceChannel`), energy VAD with an
  adaptive noise floor, 500 ms pause = segment, 15 s max segment, 400 ms
  barge-in guard while the agent speaks, pre-roll of 2 frames, playback
  through a `MediaStreamAudioDestinationNode` + hidden `<audio>` element (so
  Chrome's AEC on Android sees it), chimes (sent, nothing-heard, record,
  working blip every 2.5 s while awaiting a reply, key-click noise for tool
  calls), input device picker, all audio contexts resumed inside taps (iOS).
- `app/components/AgentVoiceBar.vue`: two-row layout, phone-checked at 390 px.
  `useAgentVoiceOpen.ts` remembers the bar being open. Navbar mic button in
  `app/pages/agents/[id].vue`.
- `app/components/AgentVoiceSettings.vue` on the General settings page:
  transcriber, speaker, end-of-turn detector (+ silence seconds), per-engine
  model ids and voices (Kokoro voice list, OpenAI speech voices).

Shared: `shared/agent-voice.ts` (catalogues, defaults), `shared/types`
(`AgentVoiceSettings`, `AgentVoiceClientMessage`, `AgentVoiceServerMessage`,
`SpeechEngine`, `TurnDetector`).

Dependencies added: `onnxruntime-node` (pinned exactly to 1.21.0, the version
transformers.js 3.8.1 uses; two versions in one process fail at dlopen),
`@huggingface/transformers@3.8.1` (same version kokoro-js pins),
`kokoro-js`, `@msgpack/msgpack`. `nuxt.config.ts` lists the first three as
Nitro externals. `pnpm-workspace.yaml` changed only by pnpm's build-script
bookkeeping; check the diff.

Docs: `docs/voice.md` has a "Talking to a coding agent" section with the
non-obvious facts. `scripts/agent-voice-probes/` holds the scratch scripts
(see its README); delete when done.

## Verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test` (1806 tests) pass as of the last
  run. `pnpm build` passed before the local-engine dependencies were added
  and was NOT rerun after (it would rebuild under the running dev server).
  **Run `pnpm build` first thing.**
- End to end against a real Claude Code (haiku) session with the WS client
  and TTS-made fixtures: click turn (transcript, agent ack, spoken answer),
  hands-free hold + "yes?" prompt + sign-off, spoken "stop", the silence
  detector, and all of gemini/openai/local engines via the settings endpoint.
- Smart Turn features match transformers.js to 0.0000; fixtures score as
  expected (fragment 0.006, complete question 0.98).
- Local timings on an arm64 container: Moonshine 0.26 s for a 6 s clip,
  Kokoro first sentence ~1.5 s warm.
- UI rendered in headless Chromium (no mic there): agent page, bar, settings
  card, phone width.

## Not verified

- Real microphone on a phone through the tunnel: the user tested on a Galaxy
  A36 and AirPods; noisy-metro transcription was poor, and the loudspeaker
  echo came back as their own speech. The media-element playback routing was
  added for that and has not been confirmed by the user yet.
- iOS: the on-mount microphone bug was fixed by reasoning (contexts created
  outside a tap stay suspended); not confirmed on a device.
- The Kyutai engine and Kyutai turn detector: written from the reference
  scripts in kyutai-labs/delayed-streams-modeling, never run. Needs a GPU.
- `pnpm build` after the dependency changes (see above).

## Gotchas

- Under `pnpm dev`, every `server/` edit reloads Nitro into a new worker and
  the native onnxruntime binding cannot load twice ("Module did not
  self-register"): the turn model and local engines then fail until the dev
  server is restarted. Production never reloads.
- `pkill -f 'nuxt dev'` kills the shell that runs it; use `pkill -f 'nuxt [d]ev'`.
- In this environment there was no Caddy, so the server ran as
  `pnpm exec nuxt dev --port 3667 --tunnel` (Cloudflare quick tunnel, random
  URL per start, no auth). Nuxt binds `localhost`/`::1`, not 127.0.0.1.
- `python3` here lacks numpy/json; validation of the Whisper features used
  transformers.js in Node instead (`scripts/agent-voice-probes/compare-whisper-features.mjs`).
- Gemini TTS lite sometimes drifts in timbre mid-answer; measured pitch was
  consistently male on Puck, so it is the model, not the config. The user
  said not to chase it; they intend to use open models.
- Claude Code in "Manual" mode auto-allows read-only shell commands (`ls`,
  `wc`); Write does prompt. That is Claude Code's behaviour, not Domo's.
- The "Spoken" note text must start with `SPOKEN_NOTE_PREFIX` and the full
  note must equal `FULL_NOTE` exactly for `spokenNoteKind` to classify it.

## Research (September 2026) on open full-duplex models

No open full-duplex model accepts an external "brain": Kyutai Moshi /
PersonaPlex, MiniCPM-o 4.5 and NVIDIA NemotronLabs VoiceChat-11B all own
their LLM; only VoiceChat has native tool calling and it needs a data-centre
GPU. The open path around an external LLM is Kyutai Unmute (MIT): Kyutai STT
(semantic VAD built in) + any text LLM + Kyutai TTS over a Realtime-style
socket, ~16 GB VRAM. Best all-CPU cascade: Silero VAD → Moonshine →
Smart Turn → Kokoro or Kyutai Pocket TTS. That is what `local` implements
(minus Silero; the browser's energy VAD stands in).

## Open questions and pending decisions for the user

1. **Default engines.** `agentVoice` defaults to gemini/gemini. The user
   said they will probably use open models. Recommendation: keep gemini as
   the shipped default (no 300 MB download on upgrade) and let them switch
   in Settings; the dev environment's DB was set to local/local for testing.
2. **Echo on Android.** If the media-element routing does not hold up on the
   Galaxy, the remaining options are a Silero-style VAD in the browser plus
   playback-level-aware gating, or a stronger barge-in criterion. The user
   rejected muting the mic while the agent speaks and rejected a toggle;
   the mic button is the mute.
3. **Noisy environments / AirPods.** Bluetooth headset mics send narrowband
   audio. Suggest testing the phone's built-in mic via the picker (iOS may
   ignore the choice; Android honours it).
4. **Kyutai engine.** Untested. Recommendation: mark it experimental in the
   settings copy until someone runs a moshi-server, or drop it if no GPU is
   coming.
5. **Kyutai turn detection while transcribing with Kyutai** could reuse one
   streaming socket instead of opening a second; not done.
6. **Streaming transcription** (Kyutai STT / whisper streaming) would cut the
   turn-to-delivery latency further; currently every engine transcribes a
   whole turn at once.
7. **Voice answering permissions** ("yes"/"no" to a permission prompt) is
   not implemented; the bar only speaks that a permission is needed.
8. **The scratch probe scripts** in `scripts/agent-voice-probes/` and the
   test session "Voice bar test" in `/tmp/voice-scratch` can be deleted.

## Exact next steps

1. `pnpm install && pnpm build && pnpm test` on a fresh checkout.
2. Ask the user to re-test on the Galaxy with hands-free: does the agent's
   voice still come back as their own turn? The server log prints one line
   per segment (`[agent-voice:<id>] segment of Ns (rms …) transcribed in …:
   "…"`) and one per pause verdict.
3. If yes, commit properly (this branch is a single WIP commit); consider
   squashing into a few commits: shared types/settings, server cascade,
   turn model, engines, browser bar, docs.

## State outside git in the retired environment (nothing to keep)

- Dev server + Cloudflare tunnel were running from `/workspaces/speech-system`
  on port 3667 with the compose stack (`docker compose up -d`) of that
  environment; last tunnel URL was https://internship-held-amd-dealing.trycloudflare.com.
- Test agent session `ag_b4e64955195a4f8b92f3` ("Voice bar test") in that
  environment's `domo` database, cwd `/tmp/voice-scratch`.
- Downloaded models in `.data/models/` (gitignored) and `/tmp/domo-data`.
- `.env` holds NUXT_GEMINI_API_KEY, NUXT_OPENAI_API_KEY, NUXT_CLAUDE_CODE_OAUTH_TOKEN,
  NUXT_OPENCODE_API_KEY (secrets, not committed).
