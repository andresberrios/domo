# AGENTS.md — orientation for future sessions

> `CLAUDE.md` is a symlink to this file: one document, whichever name a tool
> looks for.

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
  session already has an `acp_session_id`. **`session/load` restores the
  *adapter's* transcript, not Domo's choices**: it comes back in whatever mode
  and model it defaults to, so both are re-applied from the row on every attach
  (`applySessionMode` / `applyRequestedModel`). This is not a rare path — under
  `pnpm dev` every edit to `server/` restarts Nitro and reattaches every
  session — and the symptom of missing it was a Claude Code agent quietly
  asking for permissions again minutes after being told not to.
- **Projects own dev environments; dev environments own isolation.** A managed
  environment is a long-lived container whose checkout lives in a named Docker
  volume (`domo-dev-<id>-workspace`, derived from the id, so no column). There is
  no host copy. It is described by the project's own `.domo.json`
  (`server/lib/dev-env/config.ts`) — nothing else is read — and `docker: true`
  gives it a private DinD daemon. Multiple agent sessions may share one
  environment. Their ACP adapters run through `docker exec`; legacy sessions
  without `dev_environment_id` still run directly on the host.
- **An environment is a namespace, not a security boundary, so the host user's
  login state is shared with it.** An agent in a container has to be able to
  `git push`, open a PR and reach whatever cloud the developer is already logged
  into, and the container runs on the same machine, for the same person. The
  *home overlay* (`server/lib/dev-env/home-overlay.ts`) bind-mounts a
  configurable list of paths under the host home into the container user's home
  — `.ssh`, `.gitconfig`, `.config/gh`, `.config/gcloud`, `.aws`, `.kube` by
  default, read-write because gh and gcloud refresh their tokens in place — and
  forwards the SSH agent. It is written as a pure
  `{ sourceHome, containerHome, paths, present, sshAgent } -> { mounts, env,
  parentDirectories, gitconfig }` on purpose: the one thing a multi-user Domo
  would have to change is *whose* home it reads, so that is an input rather than
  a `process.env.HOME` read in the middle of `createEnvironment`. The setting
  (`homeMounts`) is validated at save time; `.claude`, `.claude.json` and
  `.codex` are refused outright. Mounts are fixed at `docker run`, so a change
  applies to environments created afterwards.
- **The Dev Container CLI builds the image and nothing else.** `devcontainer
  build` is how a Feature gets baked in, and that is all it is used for
  (`server/lib/dev-env/image.ts`); Domo composes `docker run` itself
  (`container.ts`) and owns the lifecycle (`server/lib/dev-environments.ts`).
  We were not following the spec faithfully before and have stopped pretending
  to: `.devcontainer/devcontainer.json`, compose definitions, `mounts`,
  `runArgs` and the rest of the lifecycle commands are simply not supported, and
  an unknown key in `.domo.json` is an error rather than something ignored.
- **The mode is a row, and `mode_changed` means somebody changed it.** The row
  is the authority on what was asked for and the adapter on what is, so what
  the adapter answers with is what gets written back — including a
  `current_mode_update` the agent sent itself, which updates `mode_id` and not
  only the event log, or the next attach would undo it. Re-applying the row's
  mode at start appends no event: a restart is not a mode change, and a "Mode
  set to …" line per restart would bury the turn it sits in. The event comes
  from `setMode` (the user or the voice agent) and from `current_mode_update`
  (the agent) only. The whole reconciliation returns a patch rather than
  writing one, so a start is still **one** `agent_sessions` update.
- **Messages to an agent go through an inbox that is rows.** The prompt
  endpoint, the voice tool, the mesh tool and a subscription note all end in
  `AgentRuntime.deliver` (`server/lib/acp/manager.ts`), which is the one place
  that decides what happens to a message arriving mid-turn. Three modes, one
  enum (`MessageDelivery`): **`steer`** injects it into the running turn through
  the adapter's `_session/steering` extension, **`queue`** parks it in
  `agent_inbox` until the turn ends, **`interrupt`** cancels the turn, waits for
  it to settle, then prompts. With nothing running all three are the same thing
  — a prompt — so the mode only ever decides what happens to a message that
  arrives mid-turn. Humans default to `steer` (the composer, the voice tool),
  agents to `queue` (the mesh tool, and system notes): a person is talking to
  Domo *now*, while a peer has no idea what it is cutting across. **`steer` on
  an adapter that does not advertise steering falls back to `interrupt`**, never
  to `queue` — the intent is "change course now", and waiting is the one thing
  it definitely does not mean. The queue drains one row at a time in `seq`
  order, when a turn ends (however it ends) and when an adapter attaches idle,
  so **a queued message survives a restart**. That is the point of Domo owning
  the queue rather than the adapter (see the gotcha below), and it is why the
  agent page can show what is waiting and take it back.
- **Subscriptions are how one agent hears about another.** An agent cannot wait
  for a peer — its own turn ends long before the peer's does — so
  `agent_subscriptions(subscriber_id, target_id)` records who wants to be told,
  and `subscribe_to_agent` / `unsubscribe_from_agent` / `spawn_agent`'s
  `notifyWhenDone` (default **true**, because the caller is an agent by
  definition) write it. `server/lib/acp/subscriptions.ts` listens on the **bus**
  — not by being imported into the runtime, which would cycle straight back
  through `acpManager` — and on the target's `turn_end`, a pending permission,
  or an adapter error/exit composes one message ("Agent <title> (<id>) … Latest
  output: …") and writes it to the subscriber's inbox with origin `system`. It
  writes the **row** rather than calling `deliver`, because `deliver` starts the
  adapter it delivers to and `adapter-exit` is one of the things it reports —
  `acpManager.shutdown()` raises one per session on Nitro's `close`, so a note
  that started adapters would spawn one per subscriber as the server went down.
  It keeps the set of followed agents in memory so an agent nobody follows costs
  no query per turn. Both ends cascade with the session; a mutual pair is
  refused, because each finished turn would be a message and each message a turn.
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
- **Project and environment lifecycle has one cascade, not three.** The voice
  agent, the agent mesh and the HTTP API can all create, rename and delete
  projects and dev environments, and deleting either one has to stop and
  delete the coding-agent sessions running inside it before the container
  goes away. That orchestration lives in `server/lib/projects.ts`, one layer
  above `dev-environments.ts` (pure Docker mechanics, no ACP import — importing
  `acpManager` there would cycle back through it) and `acp/manager.ts` (which
  already imports `dev-environments.ts`). All three callers share
  `removeProjectEnvironment` / `removeProjectCascade` / `createProjectFromPath`
  instead of repeating the stop-agents-then-remove-container sequence. The
  mesh's `delete_project` / `delete_dev_environment` refuse a target that
  contains the calling agent's own session — killing your own adapter process
  mid-tool-call leaves the response undelivered.
- **A branch leaves an environment by `git fetch`, not by a copy.**
  `server/lib/dev-env/git-sync.ts` builds an `ext::docker exec … git-upload-pack
  <workspace>` URL and the *host* repository fetches through it: a real fetch
  with real negotiation, where only the missing objects cross, and no bundle, no
  temp file and no bind mount anywhere. It lands in
  `refs/remotes/domo-env/<env>/<branch>` — a remote-tracking namespace, forced
  like any remote's — and only then, if a local branch was named, is that branch
  **fast-forwarded**: `merge --ff-only` when it is the checked-out one (refused
  outright if the working tree is dirty), `update-ref` when it is not, creation
  when it does not exist. Nothing is ever forced, merged, rebased or stashed;
  a diverged branch comes back as `not-merged` with the reason and the ref to
  look at. One function serves the API, the mesh's `export_branch` and the voice
  tool of the same name, and the transport is an injected parameter so the whole
  thing is tested against two temp repos with no Docker
  (`test/server/git-sync.spec.ts`).

## Gotchas (learned the hard way)

- **Scrub the environment when spawning the ACP adapter.** `adapterEnv()` in
  `server/lib/acp/adapter-process.ts` passes an allow-list only. Inheriting a
  parent Claude Code session's `CLAUDE_*` / `CLAUDECODE` variables makes the
  nested CLI adopt the parent's flags — the symptom was `session/new` failing
  with a bare "Internal error" (really `--dangerously-skip-permissions cannot be
  used with root/sudo privileges`).
- **The allow-list is still too much for a container: `HOST_ONLY_ENV` is
  subtracted again.** A variable that describes *this machine* means something
  else inside an environment. `TMPDIR` is the one that bites — on macOS it is a
  per-user `/var/folders/…/T/` that does not exist in the container, and Claude
  Code exits 1 with `EACCES: permission denied, mkdir '/var/folders'`, which the
  adapter reports as (again) a bare **"Internal error"** with nothing else in the
  log. `PATH`, `SHELL`, `XDG_*`, `SSL_CERT_FILE` and the Windows variables go the
  same way; `docker exec` supplies the image's own `PATH`, and `boot()` sets
  `HOME`/`USER`/`LOGNAME` explicitly. Measured: identical session, clean env
  succeeds, host `TMPDIR` fails, host `PATH` alone is harmless.

- **The container's `~/.gitconfig` *includes* the host's; it is never the
  host's.** The host file is mounted read-only at `~/.gitconfig-host` and Domo
  writes `~/.gitconfig` itself at creation (replacing the old `git config
  --global --add safe.directory` exec, which is now a `[safe]` section in it).
  Three reasons, all load-bearing. The host names credential helpers the
  container does not have (`osxkeychain`, or VS Code's own helper script), so
  the multi-value list is reset with an empty `helper =` and replaced with
  `!gh auth git-credential`. **VS Code's "attach to running container" writes
  its own helper and identity into the container's global config** — if that
  file were the host's, the host would inherit a helper pointing at a path
  inside a container. And the signing keys are not in there, so `commit.gpgsign`
  / `tag.gpgsign` are off. Identity comes through the include, so a rename on
  the host reaches an existing environment; nothing is copied.
- **The container's `~/.ssh` is Domo's own directory too, for a harder reason.**
  A macOS `~/.ssh/config` says `UseKeychain yes`, and that keyword exists only
  in Apple's OpenSSH. Linux OpenSSH treats an unknown option as **fatal**:
  measured on the ubuntu-24.04 base (OpenSSH 9.6), every `ssh` died with
  `/home/vscode/.ssh/config: line 10: Bad configuration option: usekeychain`
  before connecting, and `git push` reported it as "Please make sure you have
  the correct access rights" — the forwarded agent was never even consulted.
  `IgnoreUnknown UseKeychain` fixes it, but **only if ssh reads it before the
  unknown option**, and `/etc/ssh/ssh_config` is read *after* the user's file,
  so no system-wide setting can do it: the user's own file has to open with it.
  So the host directory is mounted read-write at `~/.ssh-host` (read-write
  because ssh appends to `known_hosts`), Domo writes `~/.ssh/config` with
  `IgnoreUnknown` then `Include ~/.ssh-host/config`, and every other entry of
  the host directory is symlinked into `~/.ssh` — an
  `IdentityFile ~/.ssh/id_ed25519` in the host's config, and ssh's own default
  identity and `known_hosts` paths, all name `~/.ssh`. The directory is 700 and
  the config 600, or ssh refuses to read either. A path a user lists *under*
  `.ssh` (`.ssh/known_hosts`) stays an ordinary mount; only the exact `.ssh`
  entry is treated this way.
- **`.docker` is deliberately not a default home mount.** Docker Desktop writes
  `"credsStore": "desktop"` into `~/.docker/config.json` and the helper binary
  is on the host only: with the file mounted, every `docker pull` inside the
  environment dies with `docker-credential-desktop: executable file not found`.
  A VS Code dev container does the same thing with its own helper name, and it
  is just as broken outside the editor's own terminal — which is why
  `pnpm test:docker` in one needs `DOCKER_CONFIG` pointed at a scratch
  `{}` config.
- **`GH_TOKEN` is passed to container sessions, because the mounted `.config/gh`
  may carry no token at all.** On macOS `gh` keeps it in the Keychain, so
  `hosts.yml` names the account and has no `oauth_token`: the environment's `gh`
  would be half logged in and `gh auth git-credential` — the credential helper
  in the generated git config — would answer nothing. `adapterEnv()` takes
  `NUXT_GH_TOKEN` / `GH_TOKEN`, else asks the host's own `gh auth token` (5 s
  timeout, cached 5 minutes, any failure means "no token" and warns once). The
  lookup is an injected parameter: nothing in `test/unit` may spawn `gh`.
- **The SSH agent is forwarded at a fixed path, and Docker Desktop is a special
  case.** Keys in a keychain, in 1Password or behind a passphrase are only
  usable through the agent. On Docker Desktop the daemon is in a VM and the
  host's own `SSH_AUTH_SOCK` path is not mountable, so what gets mounted is
  Docker Desktop's *own* forwarded copy, `/run/host-services/ssh-auth.sock`;
  everywhere else it is the Domo process's `SSH_AUTH_SOCK`. Both land at
  `/run/host-services/ssh-auth.sock` inside and are named by `docker run --env`
  so every `docker exec` inherits it (`SSH_AUTH_SOCK` is in `HOST_ONLY_ENV`, so
  `adapterEnv` never overwrites it with a host path). **Docker Desktop hands the
  socket over owned by root**, so `keepAliveScript()` chmods it before the
  entrypoints — in the container's command, because it has to happen on every
  `docker start`, not only at creation.
- **On Linux, the symlinked keys are only usable if the uids match.** `ssh`
  refuses a key file it does not own with `Bad owner or permissions`, and it
  follows the symlink to the host's file — whose uid (`vscode` is usually 1000,
  but an image may differ) is not necessarily the container user's. The agent
  socket still works, which is the main path; the linked files are then only
  good for `config` and `known_hosts`.
- **A mount target's missing parent is created by Docker as root.** Mount only
  `~/.config/gh` and `~/.config` belongs to root, after which gcloud cannot
  write its own directory beside it. `createEnvironment` chowns each ancestor
  (non-recursively — the mounted content is the host's) after `docker run`.
- **Never copy a Claude login into a container, and never mount `~/.claude`.**
  Anthropic rotates the OAuth refresh token on every refresh and the old one
  stops working, so two Claude Codes on one credential log each other out — and
  the loser would be the developer's own Mac, recoverable only by an interactive
  `/login`. Undocumented by Anthropic but very well attested
  (anthropics/claude-code#88583 has an instrumented 3-day log; #48786, #78020).
  The supported path for a headless agent is `claude setup-token` →
  `NUXT_CLAUDE_CODE_OAUTH_TOKEN`: one year, subscription-billed, no chain to
  fork. `seedClaudeHome()` copies only `CLAUDE.md`, `settings.json`, `skills/`,
  `commands/`, `agents/` — an allow-list, because the same directory holds
  `.credentials.json` and every transcript the developer has. A **file** bind
  mount would not have worked anyway: Claude Code deletes and recreates
  `.credentials.json` on refresh (#18443), so the container would hold a
  dangling inode.
- **`ANTHROPIC_API_KEY` outranks every OAuth path inside Claude Code**, and in
  non-interactive mode it is used with no approval prompt. Passing it alongside
  a subscription login silently moves the work onto API billing, so `adapterEnv`
  passes it *only* when there is no token and (on the host) no login —
  `hasClaudeSubscriptionLogin()` asks the Keychain **without `-w`**, which
  answers the question without triggering a GUI prompt.
- **`~/.claude.json` lives in `$HOME`, beside `~/.claude` and not inside it**, so
  copying the directory misses it; it holds onboarding state and per-project
  trust. `seedClaudeOnboarding()` writes it if absent, with the CLI version read
  out of the runtime volume (the SDK package version is a different number:
  0.3.270 ships CLI 2.1.270). Measured on 2.1.270: the reported silent
  `exit 0` first-run gate (#95217, #46259) does **not** reproduce — with and
  without the file the CLI fails identically on auth and writes its own
  `.claude.json`. The seed is kept as cheap insurance, not as a fix for an
  observed failure.
- **Resolve the adapter entry from `process.cwd()`.** The production bundle runs
  from a virtual module path, so `createRequire(import.meta.url).resolve(...)`
  fails there. `adapterEntry()` tries cwd first, then `import.meta.url`, then
  gives a human error. `NUXT_CLAUDE_ACP_ENTRY` overrides it.
- **Container ACP file callbacks must stay in the container.** Read/write ACP
  requests are proxied through Docker; never use the host filesystem for an
  environment-backed session. The built-in mesh server is not a file the
  container needs at all: it is Domo's own HTTP endpoint, reached at
  `host.docker.internal` from inside an environment (`internalBaseUrl(true)`),
  which is why every environment gets
  `--add-host host.docker.internal:host-gateway`.
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
- **Never send a second `session/prompt` while a turn is running.** It does not
  fail, which is the problem: the Claude adapter queues it in its own
  `turnQueue` (`node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`,
  in `prompt`), and codex-acp's `startNewTurnFromExternalPrompt` awaits the
  previous prompt the same way. Nothing in Domo can see that queue, nothing
  renders it, and it dies with the adapter process — which under `pnpm dev` is
  every edit to `server/`. That is the whole reason `agent_inbox` exists, and
  why `AgentRuntime.prompt` claims `this.turn` **synchronously**, before its
  first `await`: an async gap there would let a delivery read a turn that is
  already Domo's as idle and prompt into it.
- **Steering is an extension method advertised in `_meta`, not an ACP
  capability.** `_session/steering` is absent from `acp.methods` and from
  `agentCapabilities`; what says it is there is the `initialize` response's
  *top-level* `_meta.steering.supported === true`, a sibling of
  `agentCapabilities` and not inside it. Both installed adapters set it
  (verified in their dist bundles). Send it through the SDK's string overload,
  `connection.agent.request(method, params)` — the same one
  `session/set_config_option` uses.
- **`idleBehavior: 'promptRequired'` is what stops a steer becoming a turn Domo
  cannot see.** Without the opt-in, an idle `_session/steering` makes the
  adapter start a *detached* turn: its output streams through `session/update`,
  but no `session/prompt` is ever resolved, so Domo never writes a `turn_end`
  and never drains the inbox behind it. With it, the Claude adapter answers
  `{ outcome: 'promptRequired' }` and leaves the content with the host.
  **codex-acp accepts the `_meta` and ignores it** (`parseSessionSteerParams`
  reads only `sessionId` and `prompt`) and will happily start that detached
  turn — so the opt-in is a backstop, not the mechanism. The mechanism is that
  Domo decides from its own `this.turn` and only ever steers when it has a turn
  in flight. A `promptRequired` or `failed` answer means the turn settled in the
  gap, and the message is queued rather than prompted: the turn that is still
  unwinding is what drains it a moment later.
- **A failed start is an `error`, and the adapter exiting must not downgrade
  it.** An adapter that cannot start exits, so the `exit` handler's
  `setStatus('stopped')` and `ensureStarted`'s `setStatus('error', …)` race for
  the same row. The exit handler yields to an `error` already recorded, because
  that one carries the `lastError` the UI offers a retry on. Left racing, the
  status after a failed spawn was a coin toss.
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
- **`protocol.ext.allow=always` is passed with `-c` on the one `git fetch` that
  needs it, and written to no config, ever.** The `ext::` transport runs an
  arbitrary command, and git disables it by default for exactly that reason; a
  `git config --global` would hand every repository on the machine a transport
  that executes whatever a URL says. One invocation, one repository, one fetch.
- **The `ext::` command is split on whitespace and `%`-expanded, so every part
  of it has to be a bare word.** There is no quoting: a workspace path with a
  space in it would become two arguments to `git-upload-pack`. All the inputs
  are words already (`safeEnvironmentName()`, a hex container id, a unix user
  name), and `uploadPackTransport()` still refuses one that is not, because the
  failure mode is a command that quietly means something else.
- **The exec has to run as the environment's remote user, with `HOME` set.**
  Without `-u` git finds the checkout owned by another uid and refuses it as
  "dubious ownership"; without `HOME` it never reads the `~/.gitconfig` Domo
  generated, which is where the `safe.directory` that answers that lives. Both
  or neither — one alone still fails.
- **`docker cp` cannot read a container's tmpfs, which is why the export is a
  fetch and not a bundle.** The obvious design — `git bundle create /tmp/x` in
  the container, `docker cp` it out — dies on the copy: measured on Docker
  29.8.1, a file written to a `--tmpfs /tmp` is there in `docker exec ls` and
  `docker cp` answers `Could not find the file /tmp/f.txt in container`. Writing
  the bundle into the workspace volume instead would dirty the agent's own
  checkout. The `ext::` fetch needs no intermediate file at all, and it
  negotiates: only the objects the host is missing cross.
- **A voice session's `model` / `voice` columns are a record, not an input.** The
  runtime reads `liveModel` / `voiceName` from Settings on every connect and
  writes them back to the row. Preferring the row froze whatever default was
  current when the conversation was created, so a Settings change never applied.
- **Reka select items cannot have `value: ''`** (it throws when the menu opens).
  Use a named sentinel for "none" — see `LOCAL` and `ADAPTER_DEFAULT` in
  `NewAgentModal.vue`.

- **The model is per session, and the adapter is the authority on it.** It is a
  column on `agent_sessions`, not a setting, because two agents may run on
  different models at once; `NUXT_CLAUDE_MODEL` / `NUXT_CODEX_MODEL` are only
  the default for a row that names none. There is **no `session/set_model`** in
  `@agentclientprotocol/sdk` ^1.4 — the mechanism is `session/set_config_option`
  against the `configOptions` entry whose `category` is `model`, and both
  adapters speak it (codex-acp keeps `session/set_model` only as a legacy
  alias). What the adapter answers with is written back to the row, so it
  records the truth rather than the request. Claude Code *also* honours
  `ANTHROPIC_MODEL` at the top of its own priority list, but the ACP call is one
  mechanism for both adapters, so that is the one used.
- **An adapter only lists its models *and its permission modes* in a
  `session/new` response**, which is why both pickers are backed by
  `server/lib/acp/models.ts` spawning a throwaway session (cached an hour,
  de-duplicated, timeout-capped). One probe answers both — they arrive in the
  same response, so asking separately would cost a second spawn for nothing —
  and `listAdapterModels` returns `{ models, current, modes, currentMode }`.
  The ids are not what you would guess: Claude Code lists `default` / `sonnet` /
  `opus` / `haiku`, **not** `claude-haiku-4-5`, and codex-acp lists
  `gpt-6-astra` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5`
  with **no `*-mini` or `*-nano` at all**. `resolveModel()` therefore accepts an
  exact id, a display name or a containment match either way, and fails the
  session rather than guessing.
- **The two adapters share not one permission-mode id, so nothing may hard-code
  a list and the default is per adapter.** Claude Code answers `default`
  ("Manual") / `acceptEdits` / `plan` / `auto` / `bypassPermissions` — the last
  only when bypass is allowed, and `auto` falls back to `acceptEdits` on a model
  that does not support it. codex-acp answers `read-only` ("Ask for approval") /
  `agent` ("Approve for me", its own default) / `agent-full-access`. Both read
  off the adapters' own sources (`SessionModeManager.buildAvailableModes`,
  `AgentMode.all()`) and pinned in `test/unit/acp-model-options.spec.ts`. The
  setting is therefore `defaultAgentModes: { 'claude-code', codex }`, each
  defaulting to that adapter's own starting mode; `getSettings()` reads an
  install's old single `defaultAgentMode` string as the claude-code value, so a
  choice made before the split survives. The Settings page used to hard-code
  `default`/`acceptEdits`/`plan`/`bypassPermissions` — missing `auto` and wrong
  for Codex in every entry — and `manager.ts` then wrote an impossible id onto
  every Codex row.
- **`modes` is ACP's own object, not a `configOptions` select.** An adapter
  publishes the mode both ways, but `session/set_mode` acts on
  `modes.currentModeId`, so `server/lib/acp/mode.ts` reads
  `modes.availableModes` / `modes.currentModeId` and nothing else. (Models are
  the other way round: there is no `models` object, only the `configOptions`
  entry whose `category` is `model`.)
- **That endpoint is `/api/adapters/models`, not `/api/agents/models`.** A
  literal segment beside `/api/agents/[id]` collapses the typed route for every
  agent call to the methods the literal one supports, and
  `$fetch('/api/agents/' + id, { method: 'PATCH' })` stops type-checking. It
  serves the modes too, under that name: a rename would cost every caller for a
  word.

- **`devcontainer build` gets a scratch `.devcontainer/` all to itself.** The CLI
  writes its Feature lockfile *beside the config it was given*, so the generated
  config lives in `mkdtemp()/.devcontainer/devcontainer.json` and the directory is
  deleted afterwards. The user's checkout is only ever read from (Dockerfile,
  build context, both made absolute — the CLI runs from the scratch folder, so a
  relative path would resolve against that).
- **The `devcontainer.metadata` label is an allow-list, not a config.** An image
  built by the CLI carries a JSON array contributed by the base image, each
  Feature and the config; `mergeImageMetadata()` honours only `entrypoint`,
  `privileged`, `init`, `capAdd`, `securityOpt`, `containerEnv`, volume `mounts`
  and `remoteUser`/`containerUser`. **Bind mounts are dropped with a warning** —
  a Feature that mounts a host path (the docker-*outside*-of-docker one mounts
  `/var/run/docker.sock`) would put the host filesystem back inside an
  environment whose whole point is not having it. `${devcontainerId}` in a mount
  source is substituted with the environment id.
- **`--privileged` comes from the metadata, never from Domo.** In practice that
  means the docker-in-docker Feature, which is injected only for
  `"docker": true`. A `"docker": false` environment runs unprivileged, and
  `test/unit/dev-env-container.spec.ts` asserts it.
- **Feature entrypoints run on every `docker start`, so they live in the
  container's command.** `keepAliveScript()` mirrors what the CLI composes:
  `echo Container started` / `trap "exit 0" 15` / each entrypoint / `exec "$@"` /
  `while sleep 1 & wait $!; do :; done`, behind `--entrypoint /bin/sh` with
  `-c <script> -`. DinD's `/usr/local/share/docker-init.sh` is one of those
  entrypoints; run it once at creation instead and a stopped environment comes
  back with no `dockerd`.
- **Node and both ACP adapters live in one shared, read-only volume**
  (`server/lib/dev-env/runtime-volume.ts`, mounted at `/opt/domo`), not installed
  per environment. The volume's name is a hash of the pinned helper image, both
  adapter versions and the daemon's architecture, so a pin bump builds a new one
  and a running environment keeps the one it mounted. `.ready` is written **last**
  so an interrupted build is redone, and the wrappers are `chmod 0755`'d by name:
  `chmod -R a+rX` leaves a file that had no execute bit non-executable, and the
  symptom is a bare `permission denied` from `runc`.
- **Nothing is added to PATH, and nothing needs to be.** `claude-agent-acp`
  resolves Claude Code as a *native binary* from an optional dependency of
  `@anthropic-ai/claude-agent-sdk` and spawns it directly; `codex-acp` spawns
  `process.execPath` (which is Domo's own absolute node, because the wrapper
  `exec`s it) with the bundled `@openai/codex/bin/codex.js`. So the wrappers
  hard-code `/opt/domo/node/bin/node` — npm's own shims say `#!/usr/bin/env
  node`, which finds nothing in an image without node — and the project's own
  node version still wins in the agent's shell.
- **The preflight is where an unusable image is caught.** `git` missing, the
  bundled node failing to exec (Alpine/musl: `exec … no such file or directory`),
  or `docker info` not answering within 30 s each fail creation with a sentence
  that says what to do. It runs **before** the `chown` and `git config
  safe.directory`, because those are themselves things a missing `git` turns into
  a bare `exit 127`.
- **`docker rm --volumes` does not remove the Docker-in-Docker volume.** The
  Feature names it (`dind-var-lib-docker-<id>`), so `removeContainer()` reads the
  container's named volumes first and removes exactly those. Not other named
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
- **Client content pre-empts generation, so a proactive note has one gate and
  one drain.** Sending `sendClientContent` while the model is speaking *cancels*
  that generation — the symptom was the voice agent cutting itself off
  mid-sentence whenever an agent finished a turn. `injectNote()` therefore holds
  a note while a tool call is pending (a note mid-tool-call can leave the turn
  stuck), while the model is mid-turn (`modelTurn` parts or `outputTranscription`
  seen, cleared by `generationComplete` / `turnComplete` / `interrupted`), or
  while the user is still talking (input transcription within
  `USER_SILENCE_MS`, 1.5 s — transcription arrives in bursts, so a shorter gap
  is a pause mid-sentence, and a completed turn ends the window outright).
  Every release point calls the same `drainNotes()`, and what was held goes out
  **coalesced into one** client-content message: three agents finishing while
  the model spoke is one thing to say, not three turns racing each other. The
  `voice_messages` row is written when the note is *made*, not when it is
  delivered — the screen should show agent news at once, and only the speaking
  waits — so the drain stores nothing. `turnComplete` on a batch is true unless
  every note in it was `speak: false`.

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
- **Never open the app over plain HTTP, not even to take a screenshot.** Use
  the Caddy HTTPS address only — `https://localhost:3666` by default
  (`DOMO_HTTPS_ADDRESS`); `http://127.0.0.1:3667` is the Nuxt dev server and
  exists solely as Caddy's upstream. Over HTTP/1.1 a browser allows ~6
  connections per origin and Electric's shape long-polls hold most of them: the
  first tab works, every further tab on that origin renders blank and its
  navigation times out, with nothing to show for it but a one-line Electric
  warning in the first tab's console. HTTPS means HTTP/2, one multiplexed
  connection, no limit. That applies to a screenshot pass, a DevTools or
  Playwright session and any scripted browser alike — on plain HTTP the second
  page you open tells you nothing. Run `caddy trust` once if the certificate
  is refused.
- **`scripts/dev.mjs` sets `PORT`, and that is load-bearing.**
  `internalBaseUrl()` (`server/lib/internal-url.ts`) reads it to build the URL
  of the agent-mesh MCP endpoint handed to every adapter. `nuxt dev --port`
  does not set it, so before this agents dialled 3000 no matter what port the
  dev server was really on.
- **`pnpm dev` runs Nuxt with `--public` (all interfaces), not `localhost`.**
  Measured on Docker Desktop: a container reaches a host listener on `127.0.0.1`
  through `host.docker.internal`, and gets `connection refused` from one bound to
  `[::1]` only — which is what `nuxt dev` does when left to resolve `localhost`.
  `--public` binds the wildcard address, which covers that and the Linux
  `host-gateway` (bridge address) case; the cost is that the dev server is
  reachable from the LAN. The Caddyfile still dials `127.0.0.1`.
- **The internal URL is never derived from a request's `Host` header.** A
  middleware used to cache the first one into `NUXT_INTERNAL_URL`; behind
  `pnpm dev` that is Caddy's HTTPS port spoken to as plain HTTP, and from inside
  an environment `localhost` is the container itself. An operator-set
  `NUXT_INTERNAL_URL` still wins, but a loopback host in it is rewritten to
  `host.docker.internal` for container sessions.

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
| `agents-live` | `test/agents/*.live.spec.ts` | both coding agents for real, in a real environment, on real accounts. Opt in: `pnpm test:agents`. |

`pnpm test` runs the first four projects; `test:unit` / `test:nuxt` /
`test:integration` / `test:electric` pick one layer; `test:watch` is unit + nuxt.

- **`pnpm test` must never start a real coding agent.** `test/e2e` drives the
  real `POST /api/agents`, which really spawns an adapter, and blanking
  `NUXT_ANTHROPIC_API_KEY` does **not** prevent it: on macOS Claude Code reads
  its login straight out of the Keychain and a billable session started inside
  the default suite. Both adapter entries are pointed at
  `test/helpers/dead-adapter.mjs`. For the same reason nothing in `unit` may call
  `security find-generic-password` — the first read opens a GUI prompt and the
  run blocks on it.

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

What is deliberately *not* tested: a real Gemini Live session and
`useVoiceChannel` (a real browser and a real Live session; what the runtime
*sends* is covered with the SDK faked — the model and voice in
`test/server/voice-runtime-model.spec.ts`, and when a proactive note is allowed
out in `test/unit/voice-runtime-notes.spec.ts`). **Spawning ACP adapters is now
covered** — `pnpm test:agents` runs both, for real, inside a real environment.
Everything above that boundary is still covered without an account:
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
- **Steering was read out of both adapters' shipped bundles, not assumed.**
  `STEER_METHOD = "_session/steering"` and `_meta: { steering: { supported:
  true } }` in claude-agent-acp's `acp-agent.js`; `SESSION_STEERING_METHOD` and
  the same `_meta` in codex-acp's `index.js`. So is the asymmetry that matters:
  the Claude adapter validates `_meta.steering.idleBehavior` and honours
  `promptRequired`, while codex-acp's `parseSessionSteerParams` reads only
  `sessionId` and `prompt` and starts a detached turn regardless. The delivery
  path is written so that difference cannot bite, and the fake agent in
  `test/server/acp-stream.spec.ts` mirrors the Claude behaviour.
- The inbox UI was covered by component tests (`test/nuxt/AgentInbox.spec.ts`,
  `AgentComposer.spec.ts`), **not** by a rendered screenshot. The a11y tree does
  not tell you whether the panel and the composer's picker sit right above each
  other correctly at mobile widths; that is still worth a real browser pass.
- The dev-environment path was verified against a real Docker daemon by
  `pnpm test:docker`, including an ACP `initialize` answered by
  `/opt/domo/bin/claude-agent-acp` inside a `debian:bookworm-slim` image with no
  Node of its own, and an Alpine image failing the preflight and cleaning up.
- **Both agents were verified end to end inside a real environment**
  (`pnpm test:agents`, 11 tests, ~85 s warm): `session/new` through `docker exec`
  for Claude Code and Codex in one shared environment, each pinned to its cheap
  model and asserted to have landed on it; a prompt that writes `hello.txt` into
  the workspace volume and reads it back, streamed as coalesced `agent_message`
  rows plus `tool_call`s and `turn_end`; a permission raised as a row and
  answered through `acpManager.answerPermission`; and a `list_agents` call
  arriving at Domo's own mesh endpoint from inside the container with a bearer
  that verifies back to the calling session. The same prompt also runs as a host
  session per adapter, so a regression can be attributed to "container" or
  "adapter".
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
