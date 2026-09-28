# Agent voice probes

Throwaway scripts used while building the voice bar (`server/lib/agent-voice/`).
None is part of the app or the test suite. Delete the directory when the
feature settles.

- `make-fixture.mjs <gemini-key> <out.pcm> "<text>"`: a 16 kHz PCM16 "microphone"
  fixture, spoken by Gemini TTS.
- `ws-client.mjs <origin> <agentSessionId> say=<pcm> end=final|partial wait=<ms> send|discard|hush|cancel`:
  drives `/api/agent-voice/ws` the way the browser does and prints every server
  message. Needs Node 22 (built-in WebSocket).
- `turn-probe.mjs <pcm...>` and `turn-probe-joined.mjs`: Smart Turn scores for
  fixtures. Run with vite-node from the repo root:
  `node node_modules/.pnpm/vite-node@*/node_modules/vite-node/dist/cli.mjs scripts/agent-voice-probes/turn-probe.mjs /tmp/x.pcm`
  with `NUXT_SMART_TURN_MODEL` pointing at the ONNX file.
- `compare-whisper-features.mjs`: checks `logMelFeatures` against
  transformers.js's `WhisperFeatureExtractor` (matched to 0.0000 on 2026-09-27).
- `local-bench.mjs`: CPU timings for Kokoro and Moonshine/Whisper. Run from the
  repo root so packages resolve.
