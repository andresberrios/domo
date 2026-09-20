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
  environment is a long-lived privileged container whose checkout lives in a
  named Docker volume (`domo-dev-<id>-workspace`, derived from the id, so no
  column) and a private DinD daemon. There is no host copy. Legacy environments
  keep their bind-mounted `hostWorkspacePath`, and delete still removes it. Multiple agent sessions may share one
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
- **The agent mesh is an HTTP MCP server Domo hosts itself**, at
  `/api/internal/mcp` — `server/lib/mesh/` holds the tools (`tools.ts`), the
  stateless Streamable-HTTP transport (`server.ts`) and the auth (`token.ts`).
  There is no stdio shim to ship or copy into a container, and one code path
  serves host and environment sessions: only the hostname differs
  (`internalBaseUrl`). The caller is whoever their bearer token says they are;
  nothing in the request body is trusted.

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
  environment-backed session. The built-in mesh server is not a file the
  container needs at all: it is Domo's own HTTP endpoint, reached at
  `host.docker.internal` from inside an environment (`internalBaseUrl(true)`).
- **The mesh token secret lives in memory and must stay there.** It is
  `randomBytes(32)` at module scope in `server/lib/mesh/token.ts`, and a token
  never needs to outlive the process: Nitro's `close` hook kills every adapter,
  and each spawn gets fresh `mcpServers` (both `session/new` and
  `session/load`). Do not put the token on `agent_sessions` either — that table
  is streamed to the browser through Electric.
- **The mesh is gated on `agentCapabilities.mcpCapabilities.http`**, read from
  the adapter's `initialize` response. An adapter that does not advertise it
  gets no `domo` server rather than one it would fail to connect to, and
  `warnNoHttpMcp()` says so once per adapter. Both installed adapters do
  advertise it (claude-agent-acp `{http: true, sse: true}`, codex-acp
  `{acp: false, http: true, sse: false}`), verified by sending `initialize` to
  each — no account needed for that call.
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
- **The checkout goes into its volume as a `tar` pipe, not a bind mount.**
  `populateWorkspaceVolume()` streams host `tar` into `tar -x` in a throwaway
  busybox container (`COPYFILE_DISABLE=1`, or macOS adds `._*` files). It leaves
  out the Domo data dir when `NUXT_DATA_DIR` sits inside the project. Bind
  mounts on Docker Desktop cost 15–35x on metadata-heavy work (`git add` on 20k
  files: 22.8 s vs 0.65 s), which is why the volume exists at all.
- **A voice session's `model` / `voice` columns are a record, not an input.** The
  runtime reads `liveModel` / `voiceName` from Settings on every connect and
  writes them back to the row. Preferring the row froze whatever default was
  current when the conversation was created, so a Settings change never applied.
- **Reka select items cannot have `value: ''`** (it throws when the menu opens).
  Use a named sentinel for "none" — see `LOCAL` in `NewAgentModal.vue`.

- **`devcontainer up` needs `--no-lockfile`, and its `--workspace-folder` is a
  scratch dir.** The CLI writes a Feature lockfile beside the config it thinks it
  is using; with `--override-config` that is `<workspace>/.devcontainer/`, which
  does not exist for a project without a definition, so every one of them died
  with `ENOENT … devcontainer-lock.json`. The scratch folder (deleted afterwards)
  is what keeps the CLI's `vsc-<folder>-<hash>` image tag unique per environment;
  the checkout is not in it. Consequence: `${localWorkspaceFolder}` in a project's
  own config resolves to that scratch dir.
- **Launch is two phases:** `up --skip-post-create`, `chown` the volume to the
  remote user (tar leaves it root-owned), then `run-user-commands`. Otherwise
  `postCreateCommand` runs as the remote user against files it does not own.
- **Build contexts, Dockerfiles and compose files are read from the project's own
  checkout**, made absolute by `absoluteSourcePaths()`; the volume is not on the
  host. A compose file that binds `..` is rewritten by `composeWorkspaceOverride()`
  (an extra compose file, found with `docker compose config`) to mount the volume
  at the same target; sub-directory binds become `subpath` mounts (Engine 26+).
- **`docker rm --volumes` does not remove the Docker-in-Docker volume.** The
  Feature names it (`dind-var-lib-docker-<id>`, `<project>_dind-…` under compose),
  so `removeContainer()` reads the container's named volumes first and removes
  exactly those, plus `compose down` for a compose project. Not other named
  volumes: a project's own mounts may be shared.
- **The "Open in VS Code" URL is a hex-encoded JSON authority.**
  `app/utils/vscodeUri.ts` builds
  `vscode://vscode-remote/attached-container+<hex>/<path>` from
  `{"containerName":"/<name>"}`. The leading slash is Docker's own name for the
  container and is widely attested; the `settings.host` key that points the
  extension at a remote daemon over SSH (the `vscodeSshHost` setting) is *not*
  in Microsoft's docs — third-party write-ups only. Navigating to it needs no
  CSP change: a link is a navigation, and the policy has no `navigate-to`.
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
- **The ports are 3666 (Caddy, the one you open) and 3667 (Nuxt, behind it),
  and the script dials the Nuxt one before starting.**
  Binding is not a usable test for "is this port free": a server holding the
  wildcard address (`*:3667`) does not stop Nuxt from binding the one address
  left over (`[::1]:3667`), so both listen and Caddy — dialling `localhost` —
  reaches whichever the resolver returns. The symptom is not a crash but a
  storm of `aborting with incomplete response` / `connection reset by peer` in
  the Caddy log and `Failed to fetch dynamically imported module` in the
  browser, with the app half-loading. Hence the port away from the crowded 3000
  range *and* the connect-probe on both `127.0.0.1` and `::1`.
- **`scripts/dev.mjs` sets `PORT`, and that is load-bearing.**
  `internalBaseUrl()` (`server/lib/acp/manager.ts`) reads it to build the
  `DOMO_INTERNAL_URL` the agent-mesh MCP server calls Domo back on. `nuxt dev
  --port` does not set it, so before this the mesh dialled 3000 no matter what
  port the dev server was really on.

- **Changing `DEFAULT_SYSTEM_INSTRUCTION`? Append the old text to
  `PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS`.** The settings page saves the whole
  form, so most installs store the default verbatim and would never see the new
  one. Every default that ever shipped belongs in the list, byte for byte —
  editing one in place (as the Codex change did) creates another variant.

- **The CSP is nonce-based, and Nuxt's own inline scripts depend on it.**
  `server/plugins/csp.ts` sets the header on every response and stamps a
  per-request nonce onto the SPA shell's inline scripts through the
  `render:html` hook — the importmap, the colour-mode preamble and
  `window.__NUXT__.config` are all inline and all CSP-checked. If that hook
  stops matching, the app dies with `Refused to execute inline script`.
  Production only: `pnpm dev` skips it, because Vite needs inline script,
  `eval` and its own HMR socket.
- **`style-src` needs `'unsafe-inline'` and cannot be tightened.** Nuxt UI
  injects its whole colour palette as `<style id="nuxt-ui-colors">` at runtime,
  Vaul injects the drawer rules, and Shiki's dual-theme output arrives as
  `style` attributes through `v-html`. Blocked, the app renders black and white
  with no icons. Hashing the two `<style>` bodies was considered and rejected: a
  hash drifts on a dependency bump and then fails silently and colourless.
  `script-src` is where the teeth are — never add `'unsafe-inline'` there.
- **An AudioWorklet module is governed by `script-src`, not `worker-src`.**
  Measured in Chromium: `worker-src 'self' blob:` alone makes
  `audioWorklet.addModule(blobUrl)` fail with a bare `AbortError` and no console
  violation. That is why `script-src` carries `blob:` and `worker-src` is pinned
  to `'self'`.
- **happy-dom does not enforce CSP.** No test layer can tell you the policy still
  lets the app render; `test/unit/csp.spec.ts` only guards the properties (no
  `'unsafe-inline'` / `'unsafe-eval'` in `script-src`, no directive injection
  through the `Host` header). Changing the policy means loading the production
  build in a real browser and reading the console.

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

What is deliberately *not* tested: a real Gemini Live session and `useVoiceChannel`
(a real browser and a real Live session; the model/voice the runtime sends is
covered with the SDK faked), and *spawning* ACP adapters (a real
Claude Code / Codex account). Everything above that boundary is covered —
`test/server/acp-stream.spec.ts` mocks `spawn` with a pair of pipes and puts the
SDK's own agent side on the far end, so `onUpdate` runs against real Postgres,
and permissions are end to end because a permission is a row.

## Verification notes

- The CSP was verified in Chromium against the production build: dashboard,
  settings, projects, a conversation and an agent transcript, light and dark,
  desktop and mobile, zero violations. The agent page rendered byte-identically
  with the header enforced and with it stripped.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm test` all run clean;
  keep them that way.
- The ACP path was verified end to end against a real Claude Code account:
  `session/new` with the agent-mesh MCP server attached (then a stdio shim,
  now the HTTP endpoint), streaming
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
