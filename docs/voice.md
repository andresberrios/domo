# Talking to a coding agent

Read this before you change `server/lib/agent-voice/`, its speech engines or
turn detection.

The voice bar (the composer's voice mode, `AgentVoiceBar` in `AgentComposer`;
server side `server/lib/agent-voice/`) is a cascade, not
a live model: the browser records, an engine transcribes, the transcript is
delivered to the agent as an ordinary spoken turn, and the agent's streamed
text is read out sentence by sentence by an engine. The agent is the only
thing that thinks. Engines are chosen in Settings (`AgentVoiceSettings`),
separately for hearing and speaking: Gemini, OpenAI, open models on the CPU
(Moonshine or Whisper, and Kokoro, through transformers.js), Pocket TTS, macOS,
a Kyutai moshi-server, or the device's own dictation for hearing. An installed
Domo fetches the models Settings chose at boot (`warm.ts`); `pnpm dev` fetches
them on first use.

- **Hearing the agent is separate from talking to it.** The composer's
  speaker (`useAgentVoiceListen`) opens the socket in text mode too, so
  replies, permission requests, notes and sounds are heard while typing;
  voice mode turns it on. The runtime is per session, so two tabs on one
  session share its "speak" setting.
- **Each turn is heard with context** (`agent-voice/context.ts`): the last
  few messages, and a vocabulary from the conversation, the tool calls' file
  names and the project's docs and file names. Engines take it as a prompt;
  the device takes it as phrases. `gemini-3.5-transcribe` ignores any prompt
  (identical output with or without), so context only helps the other
  engines.
- **A primed transcript that comes back empty or looping is heard again
  cold** (`looksHallucinated`). Whisper copies its prompt's style and loops on
  it. People stutter too, so a single word has to repeat eight times to count.
- **The language is pinned in Settings** (English by default). Left to guess,
  OpenAI's models turned noisy English into Danish, Russian and Korean.
- **Misheard terms are fixed by the agent, not by a pass in between.** The
  spoken note tells it the message was transcribed and to read odd words as
  the project terms they sound like. A fuzzy spelling pass and an LLM
  correction pass were both measured on real speech; neither helped.
- **"This device" transcribes in the browser** (Web Speech: Google's service
  in Chrome, Apple's dictation in Safari). The words are sent ahead of the
  `segment-end` they belong to, which waits for the recogniser to finalise;
  the audio still goes up, because the turn detector listens to it. Words
  heard outside a segment are dropped, so the agent's own voice is not a turn.
- **Every voice is the server's, played through the page.** The device's
  own voices (`speechSynthesis`) were dropped: they never pass through the
  page, so with `echoCancellation: true` the agent heard itself. A speaker
  that cannot speak here (no key on a new install) gives way to the closest
  free one (`freeSpeaker`: macOS, then Pocket, then Kokoro), and the bar
  says so once.
- **The "macOS" engine is two Swift helpers** (`agent-voice/mac-speech.ts`),
  compiled with `swiftc` into the data directory on first use and kept
  running: AVSpeechSynthesizer for speech, SpeechAnalyzer's SpeechTranscriber
  for hearing. Only on macOS 26 with the Xcode command line tools. Neither
  asks for a permission; SFSpeechRecognizer would, through a GUI a server
  cannot show, which is why it is not used. Apple's recogniser ignores the
  vocabulary, and its DictationTranscriber was far worse on real speech.
- **Pocket TTS is Kyutai's CPU voice model, run by Domo** (`pocket-speech.ts`):
  `uvx pocket-tts serve` on a free port, started on first use (a few minutes
  the first time) and kept running, or a server at `pocketUrl`. Voice
  cloning needs the weights Kyutai gates behind its terms on Hugging Face;
  Domo starts Pocket with a config of its own that fetches them from a
  mirror on Domo's GitHub releases (`pocket-tts-weights-…`, CC BY 4.0,
  attributed there), so no user needs a Hugging Face account. A failed
  download falls back to the open weights and the built-in voices. Pocket
  fails a clone with a bare 500; the reason is only in its log, which Domo
  reads for its own server.
- **Cloned voices are files, never rows** (`agent-voice/voice-store.ts`,
  `<data>/voices`): a synced table would stream the user's voice to every
  tab. Pocket gets a clone as a `voice_url` on a loopback server of Domo's
  own, because it caches a voice's state per URL (an LRU of two): 2.2 s to
  first audio once, then 0.18 s, level with a built-in voice. An upload
  (`voice_wav`) is encoded again on every request (2.2 s each), so only a
  Pocket that cannot reach the loopback gets one. A `pocket-tts
  export-voice` file by URL also skips the encoding, but costs a second
  model load (7 s) per voice.
- **An assistant can have its own voice** (`agent-voice/assistant-voice.ts`):
  an engine and one of its voices, used for its replies and for its notes on
  any bar. It wins over Settings when that engine can speak here (a key, a
  Mac, Kyutai only when Settings use it; `speakerUnavailable` says why not,
  and the assistant form shows it); otherwise, or when a piece fails in it,
  the bar's own voice speaks, and the bar says so once. `create_voice` turns any WAV into a Pocket sample
  itself (`agent-voice/sample.ts`) and other formats only through `ffmpeg`.
  Cloned voices are only ever spoken by the voice bar; nothing exports audio.
- **Kokoro speaks every piece with one style row** (`KOKORO_OPTIONS`).
  kokoro-js picks a voice's style by the length of what it is asked to say, so
  sentence-by-sentence synthesis changed the voice at every sentence.
- **Gemini's voice wanders within a long answer** by about as much as a
  change of model, on a speaker verification model, whatever the request
  size, the model or a seed. Nothing here fixes it.
- **Every speaker gets plain sentences, never Markdown**
  (`plainForSpeech`, on `marked`'s tokens): each list item, heading and
  paragraph ends as a sentence, code blocks and tables are named, bare URLs
  are their site. Measured October 2026: without the full stops, Kokoro made
  no pause between list items and read them as one sentence; raw Markdown,
  it says "hash" and "asterisk". Paths and ids are still read as written.
- **Speech starts at the first clause**: an answer's first words go at its
  first comma or dash (`takeClause`), not at the end of the first sentence.
- **`scripts/stt-bench` measures transcribers on real people**: Earnings-22
  calls (accents, names) and AMI meetings on a distant microphone (noise,
  crosstalk), each clip with the utterances before it as context. Run it
  before changing an engine, a default or the context.
- **An open bar is the human's ear for all of Domo.** It reads out
  permission requests and `notify_supervisor` notes, its own agent's and, on
  the bar used last, every other agent's except the ones its agent spawned
  (that agent hears of those itself). A reply that is only "allow" or "deny"
  answers the request last read out; a bare yes or no counts only for the
  bar's own agent, which is blocked on it.
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
  directory (see `warm.ts` for when), or read from `NUXT_SMART_TURN_MODEL`; without it a
  pause ends the turn. The `kyutai` detector reads the Kyutai transcriber's
  two-second pause head instead, and `silence` waits `silenceSeconds`.
- **The agent never starts talking over the person** (`midTurn` in
  `runtime.ts`). While a segment is coming in, a hands-free turn is judged or
  heard, or a turn is held as unfinished, speech is made but held in order. A
  click or Send releases it at once. Hands-free waits until the turn is
  heard, because Smart Turn calls a sentence's pause "complete" mid-thought:
  released at the verdict, the reply started just as the person went on, and
  barge-in hushed it. A turn being sent does not drop held speech (it was
  never heard), and it takes the place of a held turn's "yes?". A "stop"
  stops it like any speech. What was already playing is barge-in's.
- **The echo canceller is the browser's, and it is told everything.** The
  microphone asks for `echoCancellation: true` on desktop, like call apps,
  and `"all"` on Android (`micEchoCancellation`). On desktop `"all"` delays
  the microphone, and in Dia gives only silence. The agent's voice reaches the speaker through a WebRTC loopback inside the page,
  because audio received over a peer connection is what Chrome's canceller
  reliably subtracts; a media element was not enough, and a phone's
  loudspeaker made the agent interrupt itself. The bar logs what the
  microphone was granted (`device: microphone: …`). What still leaks is the
  barge-in guard's: while the bar plays anything, its chimes and tool sound
  included, a sound must hold 400 ms to be the person. Some Chromium builds
  (Dia) leak the low chimes, and an empty blip gets no "nothing" chime, or the
  two fed each other.
- **On Android the speaker opens after the microphone.** Opening the
  microphone puts the phone in call mode, and Chrome fixes an output's
  channel when it opens: one opened first stays on the media channel, where
  the phone's echo canceller cannot see it and the volume keys (now on call
  volume) cannot reach it. The bar reopens its output once the microphone is
  up, and again when it closes.
- **Every audio graph is resumed inside a tap.** iOS creates them suspended
  outside a gesture and refuses to resume them from anywhere else, which is
  why the microphone is opened by the button and never on mount.
- **`onnxruntime-node` is pinned to the version transformers.js depends on.**
  Two versions in one process fail at `dlopen` with a symbol-version error,
  because the second binding finds the first shared library already loaded.
- **The ONNX models run in a child process of their own**
  (`agent-voice/local-models-host.ts`), held by the dev process's main thread
  under `pnpm dev`, so a Nitro reload keeps them loaded.
- **The Kyutai engine was written from the reference clients and has not run
  against a server.** A moshi-server needs a GPU. Its key is
  `NUXT_KYUTAI_API_KEY`, an environment variable only: an engine that has
  never run has earned no Settings field.
- **No open full-duplex model takes an external brain** (researched September
  2026: Moshi, PersonaPlex, MiniCPM-o, NemotronLabs VoiceChat all own their
  LLM). Kyutai Unmute is the open path to a Realtime-style socket around an
  external LLM, and needs a GPU. This cascade is the CPU answer.
