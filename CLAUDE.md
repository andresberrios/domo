# CLAUDE.md — orientation for future sessions

> Keep this file current in the *same* change that makes it stale.

## What this repo is

Domo: a self-hosted, single-user Nuxt app where you **talk** to a Gemini Live
agent that runs **Claude Code** sessions for you over ACP. Read `README.md`
first — it covers the product, the setup and the layout. This file records the
things that are easy to get wrong.

## Stack

- Nuxt 4 (SPA — `ssr: false`) + Nuxt UI 4, Tailwind 4 theme in
  `app/assets/css/main.css` + `app/app.config.ts`.
- Nitro server routes (`server/api`), plain `defineEventHandler` /
  `defineWebSocketHandler` (`nitro.experimental.websocket` is on).
- Postgres (docker compose) is the source of truth; ElectricSQL streams shapes;
  TanStack DB (`@tanstack/db` + `@tanstack/electric-db-collection` +
  `@tanstack/vue-db`) holds the client store and answers live queries.
- `@google/genai` for the Live API; `@agentclientprotocol/sdk` +
  `@agentclientprotocol/claude-agent-acp` for coding agents;
  `@modelcontextprotocol/sdk` for MCP clients.

## Architecture decisions that matter

- **The Gemini Live session lives on the server**, not the browser. The browser
  only ships microphone PCM up and plays PCM down over `/api/voice/ws`. That
  keeps the API key server-side, lets tools run in-process, makes persistence
  trivial, and means a reload doesn't kill the conversation.
- **Everything the UI renders is a table, including text that is still
  arriving.** `agent_events` (the ACP `session/update` log) and `voice_messages`
  are the two durable logs; `buildTranscript()` in `app/utils/agentTranscript.ts`
  folds events into a render model. Never render from an in-memory server cache:
  a browser that connects mid-turn has to see the half-written message, and the
  only thing it reads is Postgres through Electric.
- **`agent_events` is append-only except for streaming text.** Discrete updates
  (`user_message`, `tool_call`, `permission_request`, `turn_end`, …) are
  inserted once and never touched. A run of `agent_message_chunk` /
  `agent_thought_chunk` deltas is instead *one* row — type `agent_message` or
  `agent_thought`, payload `{ text, streaming }` — opened on the first delta and
  rewritten in place until the block ends. Deltas are transient; the message is
  what deserves to be durable.
- **One adapter process per coding agent session**, spawned lazily
  (`server/lib/acp/manager.ts`) and reattached with `session/load` when the
  session already has an `acp_session_id`.
- **Projects own dev environments; dev environments own isolation.** A managed
  environment is a long-lived privileged container with a copied checkout in a
  named volume and a private DinD daemon. Multiple agent sessions may share one
  environment. Their ACP adapters run through `docker exec`; legacy sessions
  without `dev_environment_id` still run directly on the host.
- **Permission requests are rows, not callbacks.** `onPermission` writes a
  pending `agent_permissions` row, then parks on a promise. The UI, the voice
  agent (`answer_permission`) and the auto-approve setting all resolve the same
  row through `acpManager.answerPermission`.
- **A new conversation is a new `voice_sessions` row, never a context reset.**
  Fresh context comes from having no resumption handle and no recap. When the
  voice agent calls `start_new_conversation`, the runtime waits for the sign-off
  turn to complete (8 s fallback), emits `session-changed`, and the browser
  follows with `switchSession()`, which swaps the socket but keeps the mic open.
- **The voice agent names its own conversations** with `set_conversation_title`;
  there is no background titling model. Titles have an owner (`title_source`):
  the tool writes only while it is `auto`, in the same `update … where` (a rename
  mid-call wins). A rename in the UI or via `rename_conversation` flips it to
  `user`. The titling guidance is appended in `systemInstruction()`, not the
  editable prompt, so the Settings switch still governs a customised prompt.
- **The voice agent is told about agent activity through the bus**, not through
  imports: `server/lib/bus.ts` carries `agent-event` / `permission-changed`, and
  the runtime injects a spoken note (`injectNote`) when
  `settings.proactiveNotifications` is on.

## Gotchas (learned the hard way)

- **Scrub the environment when spawning the ACP adapter.** `adapterEnv()` in
  `server/lib/acp/manager.ts` passes an allow-list only. Inheriting a parent
  Claude Code session's `CLAUDE_*` / `CLAUDECODE` variables makes the nested CLI
  adopt the parent's flags — the symptom was `session/new` failing with a bare
  "Internal error" (really `--dangerously-skip-permissions cannot be used with
  root/sudo privileges`).
- **Resolve the adapter entry from `process.cwd()`.** The production bundle runs
  from a virtual module path, so `createRequire(import.meta.url).resolve(...)`
  fails there. `adapterEntry()` tries cwd first, then `import.meta.url`, then
  gives a human error. `NUXT_CLAUDE_ACP_ENTRY` overrides it.
- **Container ACP file callbacks must stay in the container.** Read/write ACP
  requests are proxied through Docker; never use the host filesystem for an
  environment-backed session. The built-in mesh server is copied to
  `/opt/domo/agent-mesh.mjs` in the environment image and reaches the host via
  `host.docker.internal`.
- **`UChatMessages` skips messages whose `parts` array is empty.** Rich items
  ride in `metadata` and render through the `#content` slot, but each message
  still needs a plain-text part (see `AgentTranscript.vue`).
- **Nuxt Icon falls back to the remote Iconify API when `ssr: false`.** The
  config pins `icon.provider: 'server'` + `clientBundle.scan`, so a local,
  offline install still has icons. Don't drop it.
- **Sequence columns are `bigserial`, not `max(seq)+1`.** Concurrent event
  appends collided and produced duplicate `seq` values within a session.
- **Open the streaming row on the first delta, and close it before anything
  else is appended.** The row's `seq` is what fixes its place in the transcript,
  so it has to be claimed when the text starts, not when it is flushed —
  otherwise a tool call that arrives mid-message takes a lower `seq` and the
  text jumps below it. `takeStream()` detaches the open block *synchronously*,
  and the close plus the next append happen in one `serial()` step.
- **The flush interval grows with the block.** An in-place update re-streams the
  whole row (`REPLICA IDENTITY FULL`), so a fixed 150 ms interval costs
  O(length²/interval) bytes: fine for the couple of kilobytes a message usually
  is, wasteful for a very long one. `flushDelay()` stretches to 2 s as the block
  passes a few kilobytes.
- **Session status is written on a transition, not on every delta.**
  `AgentRuntime.setStatus` remembers what it last wrote; `agent_sessions` is
  synced too, so a per-chunk `{ status: 'thinking' }` used to re-stream the whole
  session row several times a second and say nothing new. `touch: true` still
  always writes — refreshing `last_activity_at` is the point of asking.
- **`last_activity_at` is a correctness signal, not decoration.**
  `list_agent_sessions` reports it to the voice agent, which is told to pick
  "the most recently active agent" for a vague instruction, so an agent that
  streams for twenty minutes without a status change must not look like the
  stalest one. `touchIfStale()` refreshes it at most once every
  `ACTIVITY_TOUCH_MS` (30 s), from the flush timer and from the events that
  punctuate a turn — never from the per-delta path.
- **Old installs hold one row per delta.** The schema folds each run into the
  single row the app writes now (head row keeps its id, `seq` and timestamp), and
  `buildTranscript()` still merges runs of `…_chunk` rows, for anything that
  arrives from a version that predates the change.
- **Electric needs `REPLICA IDENTITY FULL`** on every synced table (set in the
  schema) or updates arrive without the unchanged columns.
- **The shape proxy (`server/api/shape.get.ts`) must forward Electric's protocol
  params and drop `content-encoding`/`content-length`** after `fetch` has
  already decompressed the body, or the browser client cannot decode the stream.
  `replica` is neither a protocol param nor part of the shape definition, so a
  client-supplied one is dropped and every request goes out as `replica=full`.
- **A failed Live connect is cached for 10 s** (`connectError` in the runtime):
  the mic sends ~8 chunks a second and would otherwise turn one bad key into an
  error storm. The client stops the mic on the first fatal error.

- **Editing `server/` under `pnpm dev` kills every coding agent.** Nitro reloads,
  its `close` hook runs `acpManager.shutdown()`, and each adapter logs
  `ACP connection closed` + `adapter-exit` (code 0) — including the agent that
  made the edit. The Live socket drops too, and any tool call in flight never
  gets its response. When Domo works on itself, stage `server/` edits outside
  the tree (a worktree or a patch) and apply them when no turn is running.
- **A resumed Live session keeps its original tools.** Sending new
  `functionDeclarations` with a `sessionResumption.handle` is silently ignored:
  after `set_conversation_title` shipped, a resumed conversation said it had no
  such tool. The runtime stores a fingerprint of model + tools next to the handle
  (`resumption_fingerprint`) and starts fresh when it differs.
- **Voice tool calls run off the message inbox with a timeout.** The model waits
  on every tool response, so a hung handler (e.g. an adapter that never answers
  `session/new`) used to leave the voice agent silent; agent notes are held until
  the response has gone out.

- **`pnpm dev` is `scripts/dev.mjs`**: Nuxt on `DOMO_DEV_PORT` (pinned, so the
  proxy target can't drift) plus Caddy on `DOMO_HTTPS_ADDRESS`. The Caddyfile
  sets `admin off` (no clash with another Caddy on :2019) and
  `skip_install_trust` (no sudo prompt mid-startup — run `caddy trust` once).
  A non-`localhost` address may also need Vite `server.allowedHosts`.

- **Changing `DEFAULT_SYSTEM_INSTRUCTION`? Append the old text to
  `PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS`.** The settings page saves the whole
  form, so most installs store the default verbatim and would never see the new
  one. Every default that ever shipped belongs in the list, byte for byte —
  editing one in place (as the Codex change did) creates another variant.

## Tests

**`test/CLAUDE.md` is the authoritative guide** — layout, the database
lifecycle, and the Electric rules. This is the summary.

**`docker compose up -d` is a precondition of `pnpm test`, not a branch in it.**
The run takes ~30 s. One Vitest project per *runtime*: a project earns its own
entry only when it needs a different environment, a different setup file, or a
dependency that must stay out of the default run. Everything else is a directory
inside a project.

| project | where | what it is |
| --- | --- | --- |
| `unit` | `test/unit`, `test/docker` | pure logic and the argv handed to `docker`. Node, no services, instant. |
| `nuxt` | `test/nuxt` | components and composables in a real Nuxt runtime (happy-dom) via `mountSuspended` / `registerEndpoint`. |
| `integration` | `test/server`, `test/e2e`, `test/helpers` | real Postgres: `repo.ts` and the schema directly, plus a production Nitro build driven over HTTP. |
| `electric` | `test/electric` | the full loop without a browser — a page mounted in happy-dom drives the real server, which writes to real Postgres, which a real ElectricSQL streams back into the mounted page. |
| `docker-live` | `test/docker/*.live.spec.ts` | the few things needing a real daemon. Opt in: `pnpm test:docker`. |

`pnpm test` runs the first four projects; `test:unit` / `test:nuxt` /
`test:integration` / `test:electric` pick one layer; `test:watch` is unit + nuxt.

- **An unreachable service fails the run, and there is no opt-out.** Each
  service-backed project checks what it needs in a `globalSetup` and throws
  before any test reports, naming the layers that did not run. The layers used
  to `skipIf` themselves instead, so a machine without Postgres printed a green
  summary for a third of the suite it never ran; the skip and the opt-out that
  preserved it are both gone. Do not reintroduce either.
- **`test/e2e` and `test/electric` share one production build**
  (`.nuxt/test/app`, built once per run by `test/helpers/app-build.ts` from
  whichever `globalSetup` runs first). They differ only in the environment their
  server starts with, and two builds cost ~15 s for nothing.
- **One test database, `domo_test`**, emptied before each file with `drop schema
  public cascade` and re-bootstrapped by `server/lib/db.ts`. `fileParallelism` is
  off for `integration` only — parallel files were the only reason the old
  per-file-database machinery existed, and the suite is far too small to need it.
  `unit` and `nuxt` stay parallel.
- **The `electric` layer has its own database and its own Electric instance**
  (`domo_e2e`, port 30001). Not negotiable: the `integration` reset empties a
  publication out from under a live instance and leaves it replicating nothing,
  with no error anywhere. See `test/CLAUDE.md`.
- **`DATABASE_URL` is always rewritten to a non-`domo` name**, even when Postgres
  is down (to an unreachable host), so anything that runs anyway fails to
  connect instead of writing to the developer's own database. This is not
  theoretical: an early version of the harness emptied it. A refused connection
  arrives as an `AggregateError` with an *empty* message, so "could not reach
  the database" must not be derived from `error.message` alone.

What is deliberately *not* tested: the Gemini Live runtime and `useVoiceChannel`
(a real browser and a real Live session), and *spawning* ACP adapters (a real
Claude Code / Codex account). Everything above that boundary is covered —
`test/server/acp-stream.spec.ts` mocks `spawn` with a pair of pipes and puts the
SDK's own agent side on the far end, so `onUpdate` runs against real Postgres,
and permissions are end to end because a permission is a row.

## Verification notes

- `pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm test` all run clean;
  keep them that way.
- The ACP path was verified end to end against a real Claude Code account:
  `session/new` with the agent-mesh MCP server attached, streaming
  `agent_message_chunk`s, `tool_call` / `tool_call_update` for Bash, Read and
  Write, a pending permission request, and `stopReason: end_turn`.
- The browser audio path was verified with a fake capture device: the worklet
  produces ~8 PCM16 chunks/second at 16 kHz and they arrive over the WebSocket.
- UI was checked with real rendered screenshots (desktop + mobile, light +
  dark) — the a11y tree alone will not tell you whether the CSS loaded.

## Conventions

- Components live flat in `app/components` with plain names; pages under
  `app/pages`; the dashboard shell is `app/layouts/default.vue`.
- Prefer Nuxt UI components (`UDashboard*`, `UChat*`, `UModal`, `UAlert`, …)
  over bespoke markup. Always give `UModal` both `title` and `description`.
- Server helpers go in `server/lib/<area>/`; anything that writes to the
  database goes through `server/lib/repo.ts` so the bus stays informed.
- Shared types are in `shared/types/index.ts` and imported as `~~/shared/types`.
- Keep environment lifecycle operations in `server/lib/dev-environments.ts`;
  invoke Docker with argument arrays, never interpolated shell commands.
