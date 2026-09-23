# AGENTS.md — orientation for future sessions

> `CLAUDE.md` is a symlink to this file: one document, whichever name a tool
> looks for.

> **What belongs here, and it is a high bar.** Only what an agent has to know
> *before* it acts, because not knowing it costs a wrong turn — a decision that
> is load-bearing and invisible from the code, a constraint that fails silently,
> a result somebody measured so nobody has to measure it again. If reading the
> code answers the question, the code is the better answer and it cannot go
> stale. This is not an inventory of what exists, a changelog, or a second
> description of the thing you just built: most changes, including good ones,
> should add nothing here at all. When a change does make something here wrong,
> fix it in the *same* change — and prefer deleting a line to qualifying it.

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
- **The transcript has two passes: `buildTranscript` says what happened,
  `condenseTranscript` decides what to draw.** Both live in
  `app/utils/agentTranscript.ts`, and the second is pure and takes the first's
  output — it never reads an event, so there is one account of the log and no
  way for the two to disagree. Condensed mode (on by default, a `localStorage`
  switch on the agent page through `useCondensedTranscript()`) replaces every
  maximal run of `tool` / `thought` items with one `activity` row, because a
  working agent produces hundreds of tool cards and buries the text the user
  came for. Two rules are load-bearing. **Only `tool` and `thought` are ever
  absorbed** — a `permission` item in particular ends the run and renders on its
  own, or the thing the turn is *blocked on* would be hidden behind a click.
  And **the live tail stays open**: a trailing tool call that is `pending` or
  `in_progress`, or a trailing thought while the session is working (the
  caller's `live` option), is rendered normally below the group, so the user can
  always see what the agent is doing right now. The group's id is derived from
  the first item in the run, so it survives re-renders and a group the user
  expanded stays expanded while events stream in below it. `ActivityGroup.vue`
  expands to the ordinary cards through `TranscriptItemView.vue`, the one
  per-item renderer both it and `AgentTranscript.vue` use.

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
- **The way `session/load` restores a transcript is by replaying it at you**,
  as ordinary `session/update` notifications, inside the load request and
  before its response — claude-agent-acp's `replaySessionHistory`, codex-acp's
  `streamThreadHistory`, OpenCode's `replayMessage`; all three read out of
  their shipped bundles. Nothing on the wire marks one as history,
  so `onUpdate` appended the lot and every attach grew a second copy of the
  conversation. `AgentRuntime.restoring` is what stops it, and it stays set to
  the **end of `boot()`** rather than to the load response: nothing live can
  happen in the difference (the adapter has no turn, Domo has not prompted,
  and a prompt waits on `ensureStarted`), while ending it on the response
  would rest on how the SDK orders an already-read notification against the
  response line behind it. It is cleared before `drainInbox()`, because a
  queued message drains the moment an idle adapter attaches. The duplicate
  looked *partial* on screen for one reason worth knowing: the replayed user
  messages arrive as `user_message_chunk`, a type `buildTranscript` draws
  nothing for, so the copy showed the agent's side and none of the user's.
  `server/lib/db.ts` deletes the bursts an older install already holds,
  recognising one by a `user_message_chunk` carrying the session's own first
  prompt and taking it to the end of its run of replayable kinds.
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
- **A running session can change model, not just start on one.** `applyRequestedModel`
  only ever ran at boot; `AgentRuntime.setModel` is the same `session/set_config_option`
  call made live, against a `modelOption` cached off the last `session/new` /
  `session/load` response (or the switch's own response) so a live call needs no
  second probe. It resolves a preference the same fuzzy way boot does — an
  adapter id, a display name, or a substring either way — and, like `setMode`,
  believes what the adapter answers rather than what was asked for.
  **None of the three setters may start an adapter** (`liveConnection`, never
  `ensureStarted`): the pickers are always visible, so an `await
  this.ensureStarted()` at the top of one turns choosing a reasoning effort on
  a stopped session into a container starting work. With nothing running they
  write the row and stop — every one of them is re-applied from it on the next
  attach anyway — and the event they append is marked `pending`. The skip when
  the value is already the current one reads the *adapter's* report, never the
  row, or a drifted session could never be corrected.
- **Everything else an adapter can be configured with is a list, not a field.**
  ACP lets an agent publish its own `configOptions`, and the two installed
  adapters use it for things they do not agree on at all. Reasoning effort is
  the one they share and they do not share its *id*: Claude Code publishes
  `effort` ("Effort"), codex-acp `reasoning_effort` ("Reasoning effort"), both
  tagged `category: "thought_level"`; codex alone adds a `collaboration_mode`,
  and both add a fast-mode toggle only on models that support one. Worse, the
  set is **per model** — `buildEffortConfigOption` returns nothing at all on a
  model without effort levels — so it is not even a property of the adapter.
  So Domo names none of it. `server/lib/acp/config-options.ts` turns whatever
  arrives into `SessionConfigOptionInfo[]`, `agent_sessions.config` records
  what was *asked for* by id (re-applied on every attach, for the
  `session/load` reason above) and `agent_sessions.config_options` records what
  the adapter last said it offers, so the composer renders pickers with no
  probe. Every `session/set_config_option` answers with the whole list again,
  which is how a model change refreshes the effort levels under it — and why
  `setModel` writes `config_options` back in the same update. Only **selects**
  are kept: an option is a `boolean` instead when the client advertises that
  capability, Domo does not, and both adapters then fall back to a two-value
  select. A saved value the adapter does not offer this time is **skipped, not
  fatal** — an effort saved against Opus must not break a session since moved
  to a model with no effort levels — while a value that *is* offered but wrong
  throws, because that one is a typo somebody can fix. `findConfigOption`
  matches id, name, then category, then containment in either direction but
  only when exactly one option matches, so "reasoning effort" reaches both
  adapters and an ambiguous word reaches neither.
- **Renaming, mode, archiving and model are one endpoint and one tool on every
  surface, on purpose.** `PATCH /api/agents/[id]`, the voice tool
  `manage_agent_session` and the mesh tool of the same name all take any mix
  of `title` / `archived` / `modeId` / `model` / `config` in one call (the
  tools take one named `setting` and `settingValue` instead of a map, because
  a spoken instruction is "set the reasoning effort to high"), replacing what used
  to be a `PATCH` plus a dedicated `POST /mode` plus three separate voice tools
  (`set_agent_mode`, `rename_agent_session`, `archive_agent_session`) — and,
  on the mesh, nothing at all, since no mesh tool touched a session's own
  settings before this. This is a deliberate exception to "one tool, one job"
  elsewhere in the mesh and voice surfaces — every other mesh tool and every
  other voice tool still does exactly one thing: these four are read and
  written as a single settings panel in the UI, so a caller changing two of
  them (renaming while switching model, say) gets one round trip and one
  written-back session instead of two racing partial updates. `title`/
  `archived` are plain column writes; `modeId`/`model` are live adapter
  requests and can fail against a real process (unsupported mode, no matching
  model) in a way a rename cannot — the handler runs the live calls first and
  lets either throw before touching the row, so a rejected mode or model never
  lands alongside a title/archived write it never asked to guarantee. That
  four-field mutation — `applyAgentSessionPatch` in
  `server/lib/acp/session-settings.ts` — is the one piece actually shared
  between all three; each surface only does its own target resolution and
  hands the result to the same function. They stay separate on
  purpose: voice's `resolveAgent` takes an id or a fuzzy title match and
  defaults to the most recently active session, for an unrestricted
  human-facing surface with no caller identity, while the mesh handler
  defaults `agentId` to the caller's own session (like `export_branch`
  defaults its environment) and refuses `archived: true` against that same
  session — the same self-targeting hazard `retire_project` /
  `retire_dev_environment` already refuse, since stopping the adapter process
  handling this very tool call would leave its own response undelivered. A
  bearer-token-scoped caller identity has no equivalent on the voice side, so
  folding that resolution logic into the shared function would only replace
  two short, honest branches with one branch pretending to serve both.
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
  it definitely does not mean. **The queue drains as one turn**: one
  `claimInboxMessages` takes every waiting row in `seq` order and marks them all
  delivered in the same statement, and `combineInboxContent`
  (`server/lib/acp/inbox.ts`) hands them over as a single prompt — each message
  introduced by a line naming its origin (`[From Domo]`, `[From you]`,
  `[Message from agent <id>]`), a single row untouched. Everything that piled up
  during a turn is one thing to answer; a turn per row meant the second message
  arrived after the agent had already answered the first and read that answer as
  context nobody asked for. It drains when a turn ends (however it ends) and
  when an adapter attaches idle, so **a queued message survives a restart**.
  That is the point of Domo owning the queue rather than the adapter (see the
  gotcha below), and it is why the agent page can show what is waiting and take
  it back.
- **Cron wakes agents through that same delivery path.** `cron_jobs` stores a
  materialised `next_run_at` for either a five-field cron expression (with an
  IANA time zone) or a one-time instant; `cron_runs` is the durable claim and
  history for each firing. `server/lib/cron/scheduler.ts` atomically advances
  the due pointer before calling `AgentRuntime.deliver`, using Queue by default,
  so a busy agent exposes the prompt in its normal inbox and a stopped agent is
  attached normally. The HTTP API, voice tools, and mesh tools share the repo
  lifecycle and `normalizeCronJobInput`; mesh schedule tools are self-scoped by
  the bearer token, so an agent can create/list/update/delete only jobs targeting
  itself. If the server missed several recurring instants while it was down,
  the job runs once on recovery and advances past the missed times; it never
  replays them in a burst.
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
- **Usage is session state, not transcript.** The ACP `usage_update` carries
  context occupancy and the session's cost, and it arrives with every
  `message_delta` — several times a second on a long answer. It is handled in
  `onUpdate` **before** `takeStream()`, normalised (`server/lib/usage/normalize.ts`)
  and written to `agent_sessions.usage`; it appends no `agent_events` row and
  claims no `seq`. `voice_sessions.usage` is the same idea for a conversation,
  fed by the Live API's `usageMetadata`. Both are throttled (~5 s, trailing) and
  written on change only, because both tables are synced.
- **Plan limits are account-wide rows, fed by a poller.** They belong to the
  developer rather than to any session, so they have to be right on a dashboard
  nobody has run an agent on today: `usage_limits` (one row per provider per
  window) and `usage_providers` (whether each provider's poll works, so the UI
  can tell "not configured" from "failed" from "nothing yet"). `server/lib/usage/`
  holds the clients, the pure normalisers and the poller, which starts in
  `server/plugins/boot.ts` and stops on Nitro's `close`. **Nothing secret ever
  goes in those tables** — they stream to the browser through Electric.
- **Claude's limits come from response headers, not from the usage endpoint.**
  `GET /api/oauth/usage` is what Claude Code's own `/usage` reads and it answers
  far more (per-model weekly buckets, the credits balance) — but it needs the
  `user:profile` scope, and a `claude setup-token` token carries only
  `user:inference`. Measured: **403 `oauth_scope_insufficient`, `required_scopes:
  ["user:profile"]`**. So the endpoint is still tried hourly (an operator with a
  differently-scoped token gets the better answer) and the working source is a
  minimal `POST /v1/messages` read for its `anthropic-ratelimit-unified-*`
  headers, which needs only the inference scope. A third source is always on and
  free: `_meta["_claude/rateLimit"]` rides in on a `usage_update` whenever an
  agent works.
- **Codex limits come from a short-lived `codex app-server`.** The ACP adapter
  does not expose them — it spawns the bundled Codex CLI as a JSON-RPC server
  over stdio, calls `account/rateLimits/read`, and renders the answer as text in
  `/status`. Domo makes the same call directly rather than scraping that text.
  Newline-delimited JSON, `initialize` first, a 15 s cap, and the process is
  killed as soon as it has answered: nothing is kept resident for a number that
  moves on the scale of hours.
- **Permission requests are rows, not callbacks.** `onPermission` writes a
  pending `agent_permissions` row, then parks on a promise. The UI, the voice
  agent (`answer_permission`) and the auto-approve setting all resolve the same
  row through `acpManager.answerPermission`.
- **A new conversation is a new `voice_sessions` row, never a context reset.**
  Fresh context comes from having no resumption handle and no recap. When the
  voice agent calls `start_new_conversation`, the runtime waits for the sign-off
  turn to complete (8 s fallback), emits `session-changed`, and the browser
  follows with `switchSession()`, which swaps the socket but keeps the mic open.
- **A conversation is the row and its messages; the socket is disposable.**
  Every connect rebuilds the model's context from Postgres, and what it
  rebuilds is two halves that meet at `voice_sessions.summary_through_seq`: the
  rolling `summary` stands in for everything up to it, and everything after it
  is replayed verbatim, newest-first within a character budget
  (`server/lib/voice/context.ts`). No overlap, no hole — that is the whole of
  "seamless", and it is why the instruction looks the same after three turns
  and after three hundred. The decisions are pure (`context.ts`: what to
  render, what to fold, where to cut) and the I/O is not
  (`compaction.ts`: load, summarise, write back), because the half that is easy
  to get wrong is the half that is trivial to test. Before this the instruction
  carried the last **12** messages verbatim and nothing else, so every
  reconnect of a long conversation — and `goAway` alone makes that every few
  minutes — silently dropped everything before them.
- **The fold runs at a turn boundary and before a connect, and never blocks
  either for long.** `AgentRuntime`-style fire-and-forget after `turnComplete`
  (`scheduleCompaction`, deliberately not awaited), and `ensureCompacted` at
  the top of `connect()` — awaited, because a reconnect is exactly where an
  uncompacted middle would fall off the end of the budget, but capped at
  `COMPACT_CONNECT_TIMEOUT_MS` and never fatal. `compactConversation`
  de-duplicates by session, so the turn's fold and the connect's fold are one
  model call. The write is guarded (`where coalesce(summary_through_seq, 0) <
  $new`), so a summary can only move forward: two folds racing end on the
  further one instead of rewinding the row to cover fewer messages than it
  already did. And the most recent exchanges are never folded
  (`KEEP_VERBATIM_CHARS`) — the user says "do that again" about those, and a
  paraphrase is worse than the words.
- **A failed fold is told to the model, not hidden from it.** If the summariser
  is unreachable the row is left exactly as it was, the tail overflows its
  budget, and `buildConversationContext` puts the count of what it had to drop
  into the instruction. A conversation that quietly forgets is the failure that
  is impossible to debug from the outside; one that says "I have lost some of
  this" is merely annoying.
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
  nothing in the request body is trusted. A host agent may pass a running
  `devEnvironmentId` to `spawn_agent`; omission preserves the caller's own
  environment. `read_agent_transcript` is the bounded detailed view behind
  `list_agents`' one-line summary and shares `transcriptDigest()` with the
  voice agent's `get_agent_transcript` tool.
- **Project and environment lifecycle has one cascade, not three.** The voice
  agent, the agent mesh and the HTTP API can all create, rename and *retire*
  projects and dev environments, and retiring either one destroys the containers
  and keeps every row — the environment's, and the whole transcript of each
  agent that ran in it. That orchestration lives in `server/lib/projects.ts`,
  one layer above `dev-environments.ts` (pure Docker mechanics, no ACP import —
  importing `acpManager` there would cycle back through it) and `acp/manager.ts`
  (which already imports `dev-environments.ts`). All three callers share
  `retireProjectEnvironment` / `retireProjectCascade` / `createProjectFromPath`
  instead of repeating the sequence. The mesh's `retire_project` /
  `retire_dev_environment` refuse a target that contains the calling agent's own
  session — killing your own adapter process mid-tool-call leaves the response
  undelivered.
- **Whether a session can start is derived, and the guard cannot live in one
  place.** A session has one stored visibility state, `archived`; whether it can
  *run* is a question about the place it ran — is its environment retired, is
  its working directory still on disk — answered by `sessionStartability` in
  `shared/retention.ts` and never written down. The two are independent on
  purpose: retiring an environment archives nothing, so a session can be
  perfectly visible and simply not runnable. Enforcing "not runnable" means
  refusing on *every* path that can bring an adapter up, and there are more of
  them than there look: `AgentRuntime.deliver`, `runTurn`, `start`, `setMode` /
  `setModel` / `setConfigOption` (these three no longer boot an adapter, so the
  boot guard does not cover them), the cron scheduler, the mesh tools — a bearer
  token outlives the retirement for as long as the dying adapter holds it, so
  the *caller* is checked too — and `repo.enqueueInboxMessage`, which is the one
  that gets missed, because the subscription notifier writes that row
  **directly** rather than calling `deliver`, for the reason the bullet above it
  explains. The check that cannot be routed around is in `AgentRuntime.boot()`,
  immediately after the session is read and *before* `setStatus('starting')` and
  any `spawn`; the rest only buy a better error.
  `test/server/environment-retirement.spec.ts` stubs `spawn` to throw, so a
  guard that is moved or dropped fails loudly instead of quietly starting a
  process.
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
  (`test/server/git-sync.spec.ts`). `importBranch` is the same road the other
  way — one `git push` over the same URL, same fast-forward-only discipline.

- **The sidebar is the management surface; there is no Projects page.**
  `app/pages/projects.vue` is gone. `ProjectTree.vue` (mounted by the layout,
  and the only thing the layout knows about the tree) renders projects →
  environments → agents, and every row carries its own actions: one primary
  plus button inline and the rest behind an ellipsis `UDropdownMenu`. Details
  live on `app/pages/projects/[id].vue` and `app/pages/environments/[id].vue`.
  The rows are `SidebarProjectRow` / `SidebarEnvironmentRow` /
  `SidebarAgentRow` / `SidebarConversationRow` — plain flex rows built from
  primitives rather than `UCollapsible` wrapping a button, because that shape
  makes a row *either* a link or a disclosure and leaves nowhere for the
  actions to sit.
- **The mode, the model and the adapter's own settings live in the composer, as
  one card that opens a panel.** They are decisions about the message being
  written — "plan this one", "switch to Opus for this bit", "think harder about
  this" — so they sit under the box it is written in rather than in the page
  header, which is where the mode picker and a read-only model badge used to
  be. `AgentComposerSettings.vue` builds one uniform `Column` per setting —
  the model from a probe, one per entry in `session.configOptions`, then the
  mode from `session.modes` — and renders them side by side in a `UPopover`,
  all through the one `PATCH /api/agents/[id]`. A *panel* rather than the row
  of `USelectMenu`s it replaced, because a Codex session has four at once
  (model, reasoning effort, collaboration mode, permission mode) and four
  selects do not fit beside the attach button on a phone. **The adapter is not
  a column**: it is fixed when the session is created, so it heads the panel as
  a fact. Nothing holds the chosen value: every column reads the row, so a
  change the adapter refuses reverts on its own and one made by the voice agent
  arrives through Electric like any other. The panel deliberately stays open
  after a selection — the options are per model, so changing the model
  refreshes the effort levels under it and picking both is one errand. The
  model is the only one that costs a probe (an adapter reports its models in a
  `session/new` response and nowhere else), so it is fetched on the panel's
  first open rather than on mount — **opening an agent page must not spawn an
  adapter**. That probe is also *started* by the open rather than finished by
  it, which is why the scroll-the-choice-into-view pass watches the arriving
  model list as well as `open`: at first paint the model column holds one item.
- **The delivery mode is on the send button, not in that panel.** `steer` /
  `queue` / `interrupt` is a property of *this message* rather than of the
  session, so it is a `UDropdownMenu` hanging off the send button in a
  `UFieldGroup` — the control it modifies. It appears only while a turn is
  running: with nothing running all three mean the same thing (a prompt), so
  there is nothing to choose, and the placeholder says in words what the chosen
  one will do.
- **A setting's value is not always a phrase, and the card's summary line is
  where that shows.** Both adapters publish their fast-mode switch as a
  two-value select (Domo does not advertise the client capability that would
  make it a real boolean), so the summary read "Opus 5 · High · Off · Bypass
  permissions" — where "Off" says nothing and cost the width that truncated the
  permission mode away. An on/off value becomes the option's own *name* when it
  is on ("Fast mode") and nothing when it is off. **And nothing may flatten a
  model's provider prefix**, which is the `openai/*`-versus-`opencode/*` billing
  hazard again: the card carries the whole name because it has one line, while
  the column splits the prefix onto a dimmed second line because it does not —
  at a width that fits four columns on a laptop, `opencode-go/Kimi K3` truncates
  to `opencode-go/Ki…`, which is the prefix and nothing else. Filtering still
  matches the whole id, so typing `openai/` narrows to one provider.
- **A `NuxtLink` applies no active class unless you give it one.** There is no
  `router-link-active` fallback to hang a `has-[]` selector off, which is why
  each row's link carries `active-class="row-active"` — a bare marker with no
  styling of its own — and the *wrapper* does the work with
  `has-[a.row-active]:bg-elevated`. The highlight has to be on the wrapper
  rather than the link because the link is only part of the row now. Measured:
  with the marker removed the anchor's class list comes back with nothing added
  after a navigation that `matched` the route.
- **On a tree row the link and the chevron are separate controls.** The name is
  a `NuxtLink` and the whole accessible name of the row; the chevron is a real
  `<button>` with `aria-expanded` and an `aria-label` that only toggles. A
  button nested inside an anchor is invalid HTML and swallows the navigation,
  so **no row may ever put one there** — `ProjectTree.spec.ts` asserts
  `document.querySelectorAll('a button')` is empty, which is the cheapest way
  to keep it true. The open/closed state is the tree's own: a `Set` in
  `ProjectTree`, persisted to `localStorage` under `domo.sidebar.collapsed`. It
  stores what was **closed**, not what was opened — rows default to open, so an
  expanded-id set would start a fresh sidebar fully collapsed and would also
  collapse every project created after it was written.
- **Renaming a project or an environment is `PATCH`, and those two routes were
  added for the menus.** `server/api/projects/[id].patch.ts` and
  `server/api/dev-environments/[id]/index.patch.ts` are thin wrappers over the
  `updateProject` / `updateDevEnvironment` that `repo.ts` already had and that
  the voice agent and the mesh already called — the HTTP surface was simply
  missing. Only the display name is patchable: a project *is* its checkout, and
  an environment's container, workspace volume and DinD volume are all named
  from its id at creation and are never renamed with it.

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
- **OpenCode 2 is a different npm package, and the old name still publishes.**
  v2 is `@opencode/cli`; `opencode-ai` is v1 and its `latest` tag is still
  moving (1.18.32 at the time of writing), so "bump OpenCode to the newest
  version" against the old name silently keeps you on v1. The layout is
  otherwise identical — a stub package whose `postinstall` fetches a native
  `bin/opencode.exe` out of a per-platform optional dependency — so
  `adapterEntry()` still lands on a binary and `adapterLaunch()` still takes its
  non-`.js` branch. `pnpm` needs the package in `allowBuilds`, or that
  postinstall never runs and there is no binary at all.
- **OpenCode 2 keeps its logins in sqlite, and there is no way to hand one to a
  container.** v1 read `~/.local/share/opencode/auth.json` and honoured
  `OPENCODE_AUTH_CONTENT`; v2 has neither, and that variable is absent from its
  binary, so setting it is a **silent no-op**. The store is
  `~/.local/share/opencode/opencode.db`, and the one credential row sits beside
  `session_v2`, `session_message`, `permission` and `instruction_blob` — every
  conversation the developer has ever had with it — which is the same reason
  `seedClaudeHome()` is an allow-list and `~/.claude` is never mounted. A host
  session needs nothing: OpenCode reads that store out of `$HOME` itself. What
  is left for anything else is `OPENCODE_API_KEY`.
  **The file name depends on the release channel** (`Qb()` in the binary:
  `opencode.db` on `latest`/`dev`/`beta`/`next`/`prod`, `opencode-<channel>.db`
  otherwise), which is why the pinned npm build and a Homebrew install share one
  login rather than quietly having two.
- **Without an OpenCode credential nothing that costs anything can run**, and
  it is not an error and nothing says so. The provider transform sets
  `apiKey: "public"` and disables every model with a non-zero input cost unless
  `OPENCODE_API_KEY`, an active console connection or a configured key is
  present; a priced model then answers `provider.no-route` when prompted. So
  "OpenCode only offers me a handful of odd models", or "every model I pick
  refuses to run", is the symptom of *no credential* rather than of a model
  list that needs refreshing. **Do not read the length of the list as the
  signal** — see the verification note; it is not stable.
- **That login rotates, so it is read and never carried — a container gets a
  console key or nothing.** OpenCode's refresh call
  (`${server}/auth/device/token`, `grant_type=refresh_token`) writes the
  refresh token the server answers with back over the stored one, so two
  holders of one credential log each other out and the loser is the
  developer's machine: the rotation hazard `~/.claude` is never copied for, in
  a different file format. **Filtering the sqlite copy down to the credential
  rows does not fix it** — the rotating token *is* the thing being copied — so
  that design was considered and rejected rather than never thought of.
  `readOpenCodeLogin` opens the file read-only and answers one question, "does
  this host have a login", for the Settings card. It is not what anything
  authenticates with: measured, the console answers **401** to a device-flow
  access token on `/zen/go/v1/usage` and **200** to a service-account key.
  A container therefore gets `resolveOpenCodeApiKey` — `NUXT_OPENCODE_API_KEY`,
  then the `openCodeApiKey` Settings row — or it gets nothing, which is the
  same shape `claude setup-token` is for Claude Code and for the same reasons.
- **`OPENCODE_API_KEY` is the whole mechanism, and `OPENCODE_CONSOLE_TOKEN` is
  a red herring.** The second name is real — it is what the **console** puts in
  the provider definition it serves, resolved through the CLI's generic
  `{env:…}` substitution — but it appears nowhere in the binary and, measured,
  it does nothing at any stage. Three runs with a deliberately invalid key
  settle it: with nothing set a priced model answers `provider.no-route`, so it
  is not reachable at all; with `OPENCODE_API_KEY` set the same model answers
  `Authentication required`, so it became routable and the key is what is being
  checked; with `OPENCODE_CONSOLE_TOKEN` set instead the answer is byte-identical
  to setting nothing, and setting **both** is indistinguishable from setting
  `OPENCODE_API_KEY` alone. So `adapterEnv` passes one variable.
  `OPENCODE_API_KEY` also does something the console page does not suggest: it
  is what makes the **`opencode-go` provider appear in the model list at all**
  (30 models, absent without it — which is why a host session authenticated
  from the sqlite store sees none of them).
- **OpenCode has no permission mode, so the policy is a config block.** Its
  `mode` option offers `build` and `plan` and neither is one — Build's own
  description says it "executes tools based on configured permissions". Nothing
  may add an invented mode to the picker (the adapter is the authority), so
  `server/lib/acp/opencode-config.ts` puts `{"permission":"allow"}` into
  `OPENCODE_CONFIG_CONTENT` for **container sessions only**: a container
  works in a volume Domo can re-create, while a host session is the
  developer's real tree and silently turning every prompt off there is not a
  default to inherit from a version bump. The shape is out of the shipped
  validator — `"ask" | "allow" | "deny"`, or a map over `read`/`edit`/`bash`/…,
  and the loader expands a bare string to `{"*": action}`. It merges with
  `jsonc-parser`'s `modify`/`applyEdits` rather than reserialising, because the
  developer's config is JSONC and their comments are theirs, and a config that
  already names `permission` is returned **untouched** — somebody who
  deliberately denied `bash` keeps it.
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
- **OpenCode takes stdio MCP servers despite advertising `{http: true, sse:
  false}`, and names none of the tools it calls.** Both halves are measured
  against a purpose-built stdio MCP server handed to a real `session/new`: it
  spawned the process, sent `initialize`, `notifications/initialized`,
  `tools/list` and `tools/call`, and the result came back to the model. So
  `mcpCapabilities` is not the whole story for stdio, and the browser server —
  the only stdio one Domo ships — does work there. But **every MCP tool call
  arrives over ACP as `title: "execute"`, `kind: "other"`, `rawInput: {}`**,
  with the tool's own name nowhere in the payload; only the
  `tool_call_update` carries the result. Anything keying on a tool *name* —
  a test assertion, a transcript card, a UI that groups by tool — gets nothing
  useful out of an OpenCode session, and an assertion that looks for one fails
  however well the tool worked. That is what the browser test in `agents-live`
  hit, and why its name check is now per adapter while the behaviour checks
  either side of it are not.
- **The mesh is gated on `agentCapabilities.mcpCapabilities.http`**, read from
  the adapter's `initialize` response. An adapter that does not advertise it
  gets no `domo` server rather than one it would fail to connect to, and
  `warnNoHttpMcp()` says so once per adapter. Both installed adapters do
  advertise it (claude-agent-acp `{http: true, sse: true}`, codex-acp
  `{acp: false, http: true, sse: false}`), verified by sending `initialize` to
  each — no account needed for that call.
- **`usage_update` must never go through `takeStream()`.** It is state, and it
  arrives in the middle of the message the agent is still writing. Closing the
  open block around one splits the message in two on screen and puts a row
  nothing renders between the halves. `buildTranscript()` names it explicitly
  and draws nothing for it, because old installs still hold those rows (the
  schema deletes them once, idempotently).
- **Usage writes are throttled because the rows are synced.** `agent_sessions`
  and `voice_sessions` are `REPLICA IDENTITY FULL`, so every write re-streams the
  whole row to every browser. Both runtimes keep the latest reading, write it on
  a trailing ~5 s timer, skip a write that would change nothing, and flush at
  every turn boundary and on close — the same "remember what was last written"
  shape as `setStatus`. A usage write must not touch `last_activity_at`: the
  voice agent picks "the most recently active agent" off that column, and a
  reading is not activity.
- **`usage_limits.updated_at` and `usage_providers.checked_at` are the opposite
  of the rule above: they are written on every successful check even when the
  reading repeats, because they are what an "as of X ago" caption reads.**
  `writeUsageLimits` and `setUsageProviderState` used to skip the write when
  nothing about the value had moved, on the same `REPLICA IDENTITY FULL`
  reasoning as `agent_sessions.usage` — but a poll that lands a fresh, unchanged
  52% is still a poll that just happened, and skipping the write left the
  caption stuck on whenever the *previous different* reading arrived, sometimes
  hours earlier, right after a manual refresh had just confirmed the number.
  The difference from the rule above is frequency: a poll is floor-limited to
  once a minute per provider, so the round trip that write costs is not one
  worth trading the timestamp's honesty for. **There is no flag for the caller
  where frequency *does* matter — the frequency is fixed where it is created
  instead.** `AgentRuntime.noteUsage` rides `_claude/rateLimit` in on every
  `usage_update`, several times a second on a long answer, so it holds the
  newest reading and writes it on a trailing `PLAN_LIMIT_WRITE_MS` timer
  (5 s), flushed from `flushUsage` at every turn boundary and on close — the
  same shape as the context reading beside it, and the reason `flushUsage`
  drains both rather than there being a second set of call sites to drift out
  of step. `flushPlanLimits` also keeps a fingerprint of what it last wrote,
  because the windows move on the scale of minutes and most readings in a turn
  repeat the last one exactly. `writeUsageLimits` took a `touchUnchanged`
  option for this before; a debounce at the source is better because the
  storm's shape is the caller's business and its absence is not something the
  repo should have to be told about. Both functions still gate their own
  change-notification (the `usage-limits-changed` bus event, the row's other
  columns) on a genuine value change; only the timestamp write is
  unconditional.
- **Every source counts usage in its own units, and one of them is a trap.**
  Claude's usage endpoint answers percentages (0-100) and ISO timestamps; its
  `anthropic-ratelimit-unified-*` headers and its `rate_limit_event` both answer
  **fractions** (0-1) and epoch **seconds**; Codex answers percent and epoch
  seconds. A real response carried `5h-utilization: 0.41` for a window that was
  41% spent — read as a percentage that renders as "0%", which is the most
  reassuring possible way for this feature to be wrong. Everything is normalised
  on write to percent 0-100 and an ISO string, in `normalize.ts`, and the units
  are pinned by tests against captured payloads.
- **A window can refuse work below 100%**, so the colour follows
  `status: 'rejected'` and not the number. And a Claude response for an account
  with no extra usage carries `overage-status: rejected` with
  `overage-disabled-reason: out_of_credits` and *no* utilization — that means
  "you never bought any", not "you hit a limit", so no credits row is drawn.
- **The Live API never reports a context window, and `used` can go down.** The
  size comes from the models API's own `inputTokenLimit` (learned and cached in
  `server/lib/gemini.ts`, with a seeded table for an offline install); an unknown
  model is `null` and the UI then shows a token count with no bar, because a
  made-up denominator is worse than no percentage. `used` falling is normal:
  `contextWindowCompression: { slidingWindow: {} }` drops the oldest turns, and a
  fresh session after a fingerprint mismatch starts again at zero. The whole Live
  family is on **131,072** tokens, not the 1M the non-Live Gemini models get.
- **The usage endpoint is rate-limited to about one call an hour** even when the
  token *can* use it: the second call inside the window answers 429 with
  `retry-after: 3591`. `Retry-After` is honoured and a 429 is not an error
  state — the last good rows stay on screen with their own timestamp, and the UI
  says how old they are. The header probe spends real quota (one token in, one
  out) so it runs in minutes, not seconds.
- **Never read or refresh the developer's own Claude login for polling.** The
  poller uses `claudeOauthToken()` — `NUXT_CLAUDE_CODE_OAUTH_TOKEN` /
  `CLAUDE_CODE_OAUTH_TOKEN` and nothing else, the same resolver the adapter
  uses. Reading the Keychain prompts on macOS, and refreshing that token would
  race the developer's own CLI over a refresh token Anthropic rotates on every
  use — the same hazard `home-overlay.ts` refuses to mount `~/.claude` for.
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
- **`last_error` is history, `status` is state, and the banner keys on the
  state.** A failed boot or a failed turn writes both, but only `status ===
  'error'` still means "this session is broken and you have to do something".
  So a turn starting clears the field (`runTurn`'s first
  `setStatus('thinking', { touch: true, lastError: null })`, which is the only
  place that does — a boot already clears it at `starting`), and
  `AgentErrorBanner.vue` renders on the status rather than on the field. The
  error itself is not lost: `buildTranscript()` renders the `error` event as an
  error-toned notice at the `seq` it was appended at, which is where a past
  failure belongs. Keyed on `lastError`, the banner outlived what it described
  — a Claude "You've hit your session limit · resets 11pm (UTC)" sat at the top
  of the agent page long after the limit had reset, through every later turn of
  the conversation, because nothing but `boot()` ever cleared the column.
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
  files: 22.8 s vs 0.65 s), which is why the volume exists at all. It copies the
  **working tree**, so `reconcileWorkingTree()` makes the copy agree with the
  HEAD beside it before anything else in the container sees it — without that an
  agent's `git add -A` sweeps the host's uncommitted work into its own branch
  and `exportBranch()` carries it home as the agent's, which is how a superseded
  colour palette nearly got merged back over its replacement. Ignored files are
  kept in both modes and that is the line rather than a convenience: an ignored
  file cannot reach a commit without being force-added, so `git clean` there
  must never grow an `-x` — it is what keeps `node_modules` and a gitignored
  `.env` in place.
- **An import into a branch the agent is not on is inert, which is why
  `branch-import.ts` exists.** Nothing in a container tells an agent that some
  other branch moved, so it never merges what it never hears about — and the
  two safe-looking designs (refuse the checked-out branch; refuse a dirty tree)
  each produce an import that does nothing in exactly the case it is most
  wanted, because an agent in the middle of something *has* uncommitted files.
  So the order is the safety, and it is the same principle as the workspace
  reconcile above: **the only work that can be lost is work git cannot see.**
  Commit whatever is uncommitted as a Domo-authored WIP commit *first* —
  nothing stashed, nothing discarded, so everything after it is recoverable —
  then **merge for real**, because once there is a commit the branch has
  genuinely diverged and `--ff-only` is the wrong tool. A conflict is
  **aborted**, never left half-merged: a running agent reads conflict markers
  as its own work. The imported commits always land on `domo-import/<branch>`
  first, because a branch with a working tree attached is not something a push
  can move, and that ref is what a conflict leaves behind to merge by hand. An
  agent **mid-turn** skips all of it and keeps the side branch, since
  committing under a turn that is about to write more files is its own way of
  losing work. `branch-import.ts` sits *above* `dev-env/` for the reason
  `projects.ts` does: it needs `acpManager`, which is the layer that imports
  `dev-env/`.
- **Every session is *told*; exactly one is *asked*.** Every session in an
  environment shares the one workspace volume — one checkout, one working tree
  — so two agents resolving the same merge are editing the same files at once
  and the second finds the first's half-finished work. The one asked is the
  **most recently active**, which is this codebase's existing answer to "which
  agent did the user mean" (`last_activity_at`, the same column the voice agent
  picks on). And the message is phrased so **nothing ever has to follow it
  up**: it says the commits are on `domo-import/<branch>`, whether they
  conflict, and that *this* session has been **asked** to merge them. "It is
  being handled" would be a claim about the future — something would then have
  to detect when the merge actually finished, and an agent ending its turn does
  not mean it resolved anything. "Has been asked" is true when sent and stays
  true whoever ends up doing it, so there is no completion tracking anywhere.
  A **dedicated resolver agent is not the answer** here and the reason inverts
  the intuition: it would be another actor in the *same* tree, adding the
  contention it was meant to avoid. (It is not built for the no-sessions case
  either — see the verification note.)
- **The import is planned before it is run, and the modal renders the plan.**
  `planImport()` in `branch-import.ts` is pure: observed state in, a structured
  description of what would be done out. The executor carries that out instead
  of deciding again and `POST /api/dev-environments/[id]/import-plan` hands the
  same structure to the UI, so the button cannot promise something different
  from what the server does — the same reason `home-overlay.ts` is written as a
  pure function. That agreement is *observed* rather than merely structural:
  `test/server/branch-import.spec.ts` runs the preview and the import against
  the same environment and compares them, down to which files the plan said it
  would commit. The outcome depends on live state (is a turn running, is the
  tree dirty), which is exactly when an unpredictable button stops being
  pressed. **The plan is never handed back in to execute**: the import
  re-observes and re-plans, because acting on what is true when the button is
  pressed is the honest thing and a stale plan is a promise nobody can keep.
- **A working agent is told with `steer` only if its adapter advertises
  steering, and `queue` otherwise — never `interrupt`.** `steer` falls back to
  `interrupt`, and cancelling a running turn to hand over a branch is far
  blunter than the news deserves. Measured by sending `initialize` to each:
  claude-agent-acp answers `_meta.steering.supported: true`, **opencode 2.0.14
  sends no top-level `_meta` at all**. `acpManager.supportsSteering()` asks the
  connection rather than a list of adapter names, so an adapter that gains steering is
  steered with nothing here changing. An **idle** session gets the
  `agent_inbox` row written directly instead, for the reason
  `subscriptions.ts` does it that way: `deliver()` starts the adapter it
  delivers to, and a branch notice must not spawn a process per stopped session.
- **`protocol.ext.allow=always` is passed with `-c` on the one `git fetch` that
  needs it, and written to no config, ever.** The `ext::` transport runs an
  arbitrary command, and git disables it by default for exactly that reason; a
  `git config --global` would hand every repository on the machine a transport
  that executes whatever a URL says. One invocation, one repository, one fetch.
- **The `ext::` command is split on whitespace and `%`-expanded, so every part
  of it has to be a bare word.** There is no quoting: a workspace path with a
  space in it would become two arguments to the service. All the inputs are
  words already (`safeEnvironmentName()`, a hex container id, a unix user
  name), and `environmentTransport()` still refuses one that is not, because
  the failure mode is a command that quietly means something else. The one `%`
  the command is *meant* to contain is the service substitution, which is how a
  single URL serves both a fetch and a push — and the two forms are not
  interchangeable. **`%S` is the long name (`git-upload-pack` /
  `git-receive-pack`), which is what the executables are called; `%s` is the
  short one, which is what `git` takes as a subcommand.** This execs the
  binary, so it is `%S`. Mismatch them and `docker exec` finds no such
  executable, and what surfaces is `fatal: protocol error: bad line length
  character: OCI` — an hour of looking in the wrong place. `--receive-pack` is
  not a way round it either: measured, the `ext::` transport ignores it.
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
- **The schema in `server/lib/db.ts` is a template literal, so a backtick in a
  SQL comment ends it.** Writing `` -- the summary of `x` `` there does not
  fail as SQL; it fails as *TypeScript*, several lines later, with
  `TS1005: ',' expected`. Name columns in prose, unquoted, inside `SCHEMA`.
- **The summariser is `gemini-flash-lite-latest`, and that is a measured
  choice.** Against a real key on a 6.6 kB transcript (the size a fold actually
  hands over, since `COMPACT_AFTER_CHARS` is 6000): lite answered in
  **1.1–1.2 s** across four runs with no failures, while `gemini-flash-latest`
  took **4.0–4.6 s** and `gemini-3.8-flash` 5.1 s, and both of those returned
  `503 UNAVAILABLE` ("high demand") on two of three attempts in the same
  window. The summaries were equally usable — ids, branch, file name and the
  outstanding commitment all survived — so the slower models buy nothing here.
  Latency is what matters because `connect()` waits on a fold; at ~1.2 s the
  6 s cap is slack, at 4.6 s it would not have been. A 503 costs nothing but
  the fold: the next turn's fold retries, and the tail is still replayed
  verbatim meanwhile.
- **The summariser call sets no `maxOutputTokens`.** A thinking model can spend
  the whole cap on thinking and answer with empty text, which would look like a
  summariser that silently stopped working. The length is bounded on the way
  into the row instead (`SUMMARY_CHARS`), where it cannot fail open.
- **A fold reads forward from the boundary; a connect reads back from the
  end.** `listVoiceMessagesAfter(seq)` for compaction, `listVoiceMessages`
  (newest N) for the context, and they are not interchangeable: fold the
  *newest* N of a long backlog and `summary_through_seq` advances past
  messages nothing ever read — a hole the summary silently claims to cover.
  From the boundary, a backlog is simply folded a chunk per turn until it is
  caught up. The connect side has the mirror-image hazard, so it passes
  `countVoiceMessagesAfter` as `uncoveredTotal`: a backlog older than the
  window is then counted as lost instead of being invisible.
- **A voice session's `model` / `voice` columns are a record, not an input.** The
  runtime reads `liveModel` / `voiceName` from Settings on every connect and
  writes them back to the row. Preferring the row froze whatever default was
  current when the conversation was created, so a Settings change never applied.
- **Reka select items cannot have `value: ''`** (it throws when the menu opens).
  Use a named sentinel for "none" — see `LOCAL` and `ADAPTER_DEFAULT` in
  `NewAgentModal.vue`.

- **The model is per session, and the adapter is the authority on it.** It is a
  column on `agent_sessions`, not a setting, because two agents may run on
  different models at once; the per-adapter `defaultAgentModels` setting is
  only the default for a row that names none, and a value neither can honour
  is an `error` event and a corrected row, never a failed start. There is **no `session/set_model`** in
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
- **An inexact model preference that fits two models resolves to neither, and
  the reason is a bill.** An authenticated OpenCode lists **130 models across
  two providers at once**, measured: `openai/*` (55), which bills the
  developer's own ChatGPT login, and `opencode/*` (75), which is OpenCode
  console inference metered per token. **18 bare names are in both** —
  `gpt-5`, `gpt-5.1`, `gpt-5.4`, `gpt-5.3-codex` and the rest of that family —
  so "gpt-5.4" names two models on two separate billing relationships.
  `resolveModel` used `.find()` and silently took whichever the adapter listed
  first; it now refuses anything below an exact id that matches more than one,
  and `ambiguousModelMatches` phrases the error so the reader sees both
  candidates rather than "the adapter does not offer that". **Nothing may
  flatten the provider prefix out of a model id** for the same reason — the
  prefix is the only thing on screen that says which is about to be spent.
  This is the `ANTHROPIC_API_KEY` hazard in a second costume.
  The collision is **not** between `opencode` and `opencode-go`, which is what
  it looks like it ought to be: `opencode-go/*` is absent from the list unless
  `OPENCODE_API_KEY` is set, so a session authenticated from the sqlite store
  alone never sees it and never collides with it. **The adapter's own default
  follows the credential**, which is why the key is worth having rather than
  merely sufficient: with no key it is `opencode/claude-opus-5-5`, metered per
  token, so "it works now" and "it costs per token now" would arrive together;
  with `OPENCODE_API_KEY` set the Go provider appears (measured: 130 models
  becomes 160) and the default moves to `opencode-go/mimo-v2.6-pro`, which the
  subscription covers. So `defaultAgentModels` is right to stay empty — pinning
  an id here would freeze a catalogue that moves, and OpenCode already picks
  from the cheaper side once it can see it.
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
- **The bundled browser needs a newer glibc than the bundled Node, so an image
  can pass the preflight and still have no browser.** The libraries in
  `/opt/domo-browser` are taken from `RUNTIME_IMAGE` (bookworm, glibc 2.36) and
  will not load below it; Node is built for an older floor and runs on
  `ubuntu:22.04` (glibc 2.35) quite happily. Measured: that image passes
  `preflight()`, and the browser dies with `GLIBC_2.36' not found`. Debian is a
  build-time detail only — `fedora:41` runs the same volume fine.
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
  is refused. **From inside a dev environment the address is
  `https://host.docker.internal:3666`** — the Caddyfile names it as a second
  site address for exactly this reason. Before it did, a container could reach
  only the plain-HTTP port, and the blank-tab failure above was measured in
  there rather than assumed. Nothing in a container trusts Caddy's CA and
  nothing needs to: tell the browser to ignore certificate errors.
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
- **A settings value equal to its code default is never written to the
  `settings` table**, for `systemInstruction` specifically
  (`patchSettings` in `server/lib/settings.ts`). The Settings page saves the
  whole form on every submit, so `systemInstruction` arrives back pre-filled
  from whatever `getSettings()` last answered even when the user only touched
  the voice or a switch; writing it unconditionally would freeze a fresh
  install's prompt at whatever `DEFAULT_SYSTEM_INSTRUCTION` happened to read on
  the day of that save, and every later improvement to it would reach nobody
  who hadn't explicitly customised it. So a submitted value equal to the
  current default is skipped, and an existing row is `delete`d rather than
  overwritten if it now matches — the only way a past customisation can start
  tracking the default again. This used to be patched over with
  `PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS`, a list of every default that had ever
  shipped that `getSettings()` treated as "not customised"; that was removing
  the symptom on every release instead of fixing the write that caused it, and
  is gone.

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

- **`UDashboardPanel`'s default slot *replaces* `#header` and `#body`.** Its
  template is `<slot><slot name="header"/>…<slot name="body"/>…</slot>`, so
  anything written as a plain child of the panel — a `UModal`, a
  `ConfirmModal` — becomes the default slot and the page renders **blank**, with
  no error beyond a bare "Unhandled error during execution of component update".
  Modals belong *inside* `#body`. Both detail pages were written the wrong way
  first and their specs caught it as an empty `document.body.textContent`.
- **Row actions reveal with `pointer-coarse:`, not with JavaScript.** Tailwind 4
  has the variant, so the ellipsis and plus buttons are
  `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100
  pointer-coarse:opacity-100` (`ROW_ACTIONS_CLASS` in `app/utils/sidebar.ts`).
  `opacity-0` rather than `hidden` on purpose: the buttons keep their place in
  the tab order, so tabbing into a row is what makes them visible. The count
  badge takes the matching `ROW_BADGE_CLASS` and yields to the actions, which is
  what keeps a row from overflowing in the mobile drawer at 390px.
- **On a touch screen Enter must not send.** `UChatPrompt`'s `submitOnEnter`
  defaults to true, and on a phone the keyboard's return key is the *only* way
  to type a line break — so a multi-line message was impossible and every
  newline sent the message instead. `AgentComposer` binds
  `:submit-on-enter="!isTouch"` off `useIsTouch()`
  (`matchMedia('(pointer: coarse)')`, evaluated in `onMounted` because Domo is
  SPA-only). Desktop is unchanged: Enter sends, Shift+Enter breaks. The voice
  page's typed input is a single-line `UInput` and needs none of this.
  That rule is also why the composer carries its own send button while the
  agent is working: `UChatPromptSubmit` at `status: 'streaming'` is a stop
  button and nothing else, so removing it as redundant leaves a phone with no
  way to send mid-turn at all.
- **A clipboard with a file on it did not necessarily mean "attach a file".**
  A spreadsheet range, a rich-text selection and several editors put an
  `image/png` rendering *beside* the text, so `clipboardData.files` is not
  empty for an ordinary paste. `pastedFiles()` (`app/utils/paste.ts`) therefore
  takes the files only when the clipboard has no `text/plain` worth pasting:
  attaching a picture of what was about to paste correctly is the worse of the
  two failures. Verified in Chromium as well as in happy-dom, because a
  synthetic `DataTransfer` is exactly the thing that can be built wrong.
  The same pass gives a clipboard image a name — one arrives with none at all,
  and the name is both what the badge shows and what the agent is told the
  resource link is, so `uploadName()` dates one and it goes to the server as
  `FormData.append`'s third argument.
- **`UChatPrompt` will not emit `submit` while its textarea is empty**, which
  makes a message that is *only* an attachment — pasting a screenshot and
  pressing Enter — impossible through either of its send paths. `AgentComposer`
  catches both on the wrapper in the **capture** phase (`@keydown.capture` on
  the textarea only, `@submit.capture` for the form) and calls its own submit,
  but *only* in the case the component drops: an empty textarea with something
  attached. Everything else still goes through `UChatPrompt` itself, including
  its IME guard and its touch rule, which the keydown path has to mirror.
- **Reka's dropdown opens on `pointerdown`, but its select menu opens on
  `click`.** `UDropdownMenu` is a Menu and `USelectMenu` a Combobox, and they
  do not take the same event: measured in happy-dom, a `pointerdown` on a
  `USelectMenu` trigger leaves zero `[role="option"]` nodes in the document and
  a `click` leaves all of them — the exact opposite of the dropdown. A
  component test that only calls `.click()` on a *dropdown* trigger waits
  forever for `[role="menu"]`. Dispatch
  `new MouseEvent('pointerdown', { bubbles: true, button: 0 })` first — see
  `openMenu()` in `test/nuxt/ProjectTree.spec.ts`. **A `UPopover` takes
  neither**: Reka opens it on a pointer sequence happy-dom does not synthesise
  at all, so drive its own `update:open` instead — `openSettings()` in
  `AgentComposer.spec.ts` and the same move in `UsageSidebarSummary.spec.ts`. And scope the search for
  a dialog's submit button to the dialog: the menu that opened it is still in
  the DOM and usually has an item with the same word on it.

## Theme

- **`domo` is a deep pine green that drifts warmer as it lightens, `bark` is
  the neutral, and both are full 50–950 scales in `app/assets/css/main.css`.**
  The palette name `domo` was kept so nothing else had to change;
  `ui.colors.neutral` is `bark` rather than `zinc`. 600 (`#0a6141`) carries
  white text at 7.50:1 and is otherwise unused by the app chrome. The scale
  went through several passes before the two working stops (below) settled:
  an earlier, greyer green (500 `#3d7d4e`) read as desaturated, so it was
  pushed for chroma (500 `#1c8049`) — but that read as *pastel*, not deep,
  because the extra saturation landed at too high a lightness.
  500-and-darker keeps the hue cooler (toward teal, H~150→163 across
  600–950, pine/spruce rather than lawn) with lightness kept low, so the
  high saturation (S~55–82% through 500–700) reads as depth instead of a
  fluorescent highlighter. **400-and-lighter carries a separate, warmer hue
  instead (H~129→145, a yellow-green cast)** — a flat hue across the whole
  ramp is what made the light end read as washed out even after 400 was
  fixed for lightness: a tint is a colour diluted toward white, and unless
  the hue itself moves too, the eye reads that dilution as greyness rather
  than as light on a leaf. The two families meet at the 400/500 boundary on
  purpose, because that boundary is also where the two rendered modes split
  (below) — light mode's deep and dark mode's alive are two different moods,
  not two lightness steps of one hue.
- **500 and 400 are the only two stops that ever render as `--ui-primary`,
  which makes this one pair of lines the single place "the green" is
  configured for each mode — there is no per-component override anywhere in
  the app.** Nuxt UI's own light/dark mapping picks 500 (`--color-domo-500`)
  under `:root` and 400 under `.dark`, on every solid button, icon, link and
  progress fill at once — light mode's text on top of it is white,
  dark mode's is `text-inverted`, which resolves to `bark-900` (`#261e18`,
  not pure black). `grep -rnE "domo-[0-9]" app server shared` (outside this
  file) returns nothing: a button that looks wrong belongs to one of these
  two lines, not to a class added on that button.

  500's floor is in HSL: white text on top means it must stay **under** ~L30%
  or drops below 4.5:1, and it sits right at that edge, `#118657` (L29.5%,
  4.60:1 with white).

  400's floor pulls the other way — `bark-900` text on top means *it* must
  stay light enough. Two passes tuned it within the cool pine hue family
  (raising HSL lightness, then HSV brightness) and both still read as washed
  rather than vivid, because the hue itself was the problem, not the
  lightness curve — see above. 400 is now `#02ab49` (H145° S98% L34%),
  a colour dialled in by hand and pasted in directly rather than derived: on
  the warm side of the hue split, at much higher saturation than the cool
  family ever used. Checked rather than assumed: 5.57:1 against `bark-900`
  text, more margin than the `#28a873` (H155° S76% V66%, 5.41:1) it
  replaced, so no darkening or lightening was needed on top of the hue
  change. 300 and lighter were re-hued the same direction (H141→129 down to
  50) for a ramp that's coherent even though nothing outside 400 currently
  renders them — `grep -rnE "domo-[0-9]" app server shared` (outside this
  file) still returns nothing. Recompute the contrast pair by hand before
  moving 400 again, and keep it in the warm family — sliding it back toward
  H155+ reintroduces the washed-out problem this was written to avoid.
  `bark` was olive-grey and is now
  a wood-toned brown (500 `#7d5f42`, hue ~30° instead of ~110°) — timber next
  to the forest green rather than stone. Its derived tokens were checked by
  hand: `text-muted` is 5.85:1 on white (500 `#7d5f42`) and 4.74:1 on the dark
  background (400 `#a3855f` on 900 `#261e18`), and the 800 border sits 1.17:1
  off the 900 background — close to the subtle separation zinc gave.
- **The font is Schibsted Grotesk, self-hosted, and `@nuxt/fonts` is already
  there.** Nuxt UI lists it as a `moduleDependency` and registers it with
  weights 400–700, so it must **not** be added to `modules` or to
  `package.json` — it is active already, and Figtree (then Inter) were
  self-hosted the same way before it. Schibsted Grotesk over Figtree for
  wider apertures and more distinctive letterforms — Figtree's tight,
  geometric skeleton read as condensed at the 11–13px this dashboard is
  mostly made of. The module picks the family up straight out of the
  Tailwind `@theme` block, which is worth knowing because it is not a
  `font-family` declaration. Verified on a production build: 16 `.woff2`
  under `.output/public/_fonts/`, 64 `/_fonts/` references in the entry CSS,
  both Schibsted Grotesk and JetBrains Mono, and **no `fonts.gstatic.com` or
  `fonts.googleapis.com` anywhere in the output**. `font-src 'self'` in
  `server/lib/csp.ts` already covered it, so the CSP was not touched.

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

Context compaction is covered without an account at three levels: the pure
decisions in `test/unit/voice-context.spec.ts` (including the invariant that
the fold and the replay partition the log exactly), the fold against real
Postgres with a stubbed summariser in `test/server/voice-compaction.spec.ts`,
and what a connect is actually told in
`test/server/voice-runtime-context.spec.ts`, where the real runtime meets a
recorder for `live.connect` and a stub for `models.generateContent`.

**Nothing in the suite may reach a real account**, and blanking the keys is not
enough for the usage poller any more than it was for the adapters: it starts
with the server. The `e2e` and `electric` layers therefore blank
`NUXT_CLAUDE_CODE_OAUTH_TOKEN` (which makes the Claude poll answer
`unconfigured` before any request is made), point `NUXT_ANTHROPIC_API_BASE` at
an unreachable address, and point `NUXT_CODEX_ENTRY` at the same dead stub the
ACP adapters get.

What is deliberately *not* tested: a real Gemini Live session and
`useVoiceChannel` (a real browser and a real Live session; what the runtime
*sends* is covered with the SDK faked — the model and voice in
`test/server/voice-runtime-model.spec.ts`, when a proactive note is allowed
out in `test/unit/voice-runtime-notes.spec.ts`, and what it records about its
context window in `test/unit/voice-runtime-usage.spec.ts`). **Spawning ACP adapters is now
covered** — `pnpm test:agents` runs both, for real, inside a real environment.
Everything above that boundary is still covered without an account:
`test/server/acp-stream.spec.ts` mocks `spawn` with a pair of pipes and puts the
SDK's own agent side on the far end, so `onUpdate` runs against real Postgres,
and permissions are end to end because a permission is a row.

## Verification notes

- **The active-row highlight is browser-only.** `test/nuxt` cannot see it: the
  links `mountSuspended` renders do not observe navigation pushed through the
  wrapper's own `$router`, so a test asserting the active class fails whether
  the code is right or wrong. It was removed rather than left as a false
  negative; the mechanism (`active-class` → `has-[a.row-active]`) is Vue
  Router's own and has to be confirmed by looking at it.
- **The theme was *not* checked in a rendered browser.** The palette, the font
  and the sidebar's hover/touch behaviour have been verified only by their
  contrast arithmetic, by the built CSS and by component tests. The a11y tree will not
  tell you whether a forest green reads as organic or as swamp, and it will not
  tell you whether the row actions fit at 390px. **The host still has to look at
  it** — light and dark, desktop and mobile, over the Caddy HTTPS address.
- The CSP was verified in Chromium against the production build: dashboard,
  settings, projects, a conversation and an agent transcript, light and dark,
  desktop and mobile, zero violations. The agent page rendered byte-identically
  with the header enforced and with it stripped.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm test` all run clean;
  keep them that way.
- **The composer's settings panel was opened in Chromium, and two of its rules
  come from what that showed rather than from reasoning.** Against the running
  dev server over the Caddy HTTPS address, on a real Claude Code session
  (five models, effort, fast mode, five permission modes) and a real OpenCode
  one (130 models across two providers), light and dark, 1440px and 390px: the
  bare `Off` on the summary line and the truncated `opencode-go/Ki…` in the
  model column were both *seen*, not predicted, and the on/off and
  provider-split rules above are the fixes. So was the selected permission mode
  sitting below the fold of its own scrolled column, which is why the panel
  scrolls the choice into view. A `PATCH` round trip was exercised harmlessly
  by re-selecting the value already current — no toast, panel stayed open, row
  unchanged — and the console was clean throughout. **Not** exercised against a
  live adapter: a change that the adapter *refuses*, which is the path the
  "nothing holds the chosen value" design exists for.
  `test/nuxt/AgentComposer.spec.ts` covers the rest in happy-dom — the card's
  two lines, a column per setting with `aria-selected` on the chosen one, that
  a reasoning-effort change leaves as `{ config: { effort: 'high' } }`, that
  the adapter is named and not offered, that a provider prefix survives in both
  places, and that no model probe is spawned until the panel is opened;
  `test/server/acp-stream.spec.ts` covers the server half against a fake
  adapter that publishes an `effort` option (recorded on the row, re-applied
  after a reattach, skipped when the adapter stops offering it).
  What no component test reaches is the delivery dropdown's *menu*: Reka will
  not open one under happy-dom, so the test takes the items `UDropdownMenu` was
  handed and invokes the one a user would have clicked. The menu itself was
  opened in Chromium instead.
- **The reasoning-effort payloads were read out of both adapters' shipped
  bundles, not assumed.** `buildEffortConfigOption` in claude-agent-acp's
  `session-effort.js` (id `effort`, and `undefined` when the model has no
  levels) and `createReasoningEffortConfigOption` in codex-acp's `index.js`
  (id `reasoning_effort`, pushed only when `supportedReasoningEfforts` is
  non-empty); both `category: "thought_level"`. `SetSessionConfigOptionResponse`
  in the SDK is documented as "the full set of configuration options and their
  current values", which is what the refresh-on-every-set design rests on.
  The fixtures in `test/unit/acp-config-options.spec.ts` are those payloads.
  **Not** verified against a live account: whether an effort actually changes
  how either model behaves, and the fast-mode and collaboration-mode options,
  which no test has ever seen an adapter emit.
- **The condensed transcript was covered in happy-dom, not in a browser.**
  `test/nuxt/ActivityGroup.spec.ts` and the `condensed` block of
  `test/nuxt/AgentTranscript.spec.ts` assert the label, the breakdown, the
  failed count, that a click expands to the real `ToolCallCard`s and collapses
  again, and that a pending permission and the running call stay outside the
  group; `test/unit/condenseTranscript.spec.ts` pins the pass itself. No
  screenshot: how the row *looks* beside the cards around it, and how it wraps
  at mobile widths, is still worth a real rendered pass.
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
- **Pasting into the composer was verified in Chromium against the running dev
  server**, not only in happy-dom, because a synthetic `DataTransfer` is
  precisely the part a component test cannot vouch for. Over the Caddy HTTPS
  address, on an idle agent: a nameless `image/png` pasted into the textarea
  was prevented, uploaded, and rendered as a `pasted-20260922-155005.png`
  badge; Enter with an empty textarea sent
  `content: [{ type: 'resource_link', … }]` and cleared the badge (the prompt
  request was intercepted in the page, so no real turn was started); and a
  `text/plain` paste, with and without an `image/png` beside it, was left to
  the textarea with nothing uploaded. What is still unexercised is a *real*
  system clipboard — whether macOS Chrome offers `text/plain` beside a Finder
  file copy is assumed, not measured.
- The dev-environment path was verified against a real Docker daemon by
  `pnpm test:docker`, including an ACP `initialize` answered by
  `/opt/domo/bin/claude-agent-acp` inside a `debian:bookworm-slim` image with no
  Node of its own, and an Alpine image failing the preflight and cleaning up.
- **The branch import was verified against a real container**: `git-receive-pack`
  is reachable inside the image, and the whole commit-then-merge sequence runs
  through `docker exec` against a checkout owned by another user — an
  environment holding an uncommitted file had it committed, the host's branch
  merged in, and ended with `git status` clean and both files present. The
  sequence itself, including **an aborted conflicting merge leaving the working
  tree byte-identical**, is covered against real git with no Docker in
  `test/server/branch-import.spec.ts`; the decisions above it — side branch,
  steer, queue, inbox, who is asked — in `test/unit/branch-import.spec.ts`.
  **Not** verified: a real agent mid-turn receiving a steered branch notice and
  acting on it, what an agent makes of finding a WIP commit it did not write,
  and whether the asked session actually resolves rather than the others racing
  it. **No throwaway resolver agent is spawned for an environment with no
  sessions**, deliberately: the conflict is not unnoticed there, because the
  import returns it synchronously to whoever asked and the modal shows it, and
  an agent resolving a merge in a container nobody is working in produces a
  resolution nobody reviews.
- **The dirty-checkout fix was verified against a real daemon**, `pnpm
  test:docker` green (5 files, 67 tests, 851 s cold). Both directions were
  asserted end to end from a dirty fixture: a `discard` environment whose
  exported branch diffs to exactly the one file the agent wrote, and a `carry`
  environment whose HEAD is the labelled commit holding exactly the tracked and
  untracked host changes and nothing ignored. The `git clean -fd` behaviour
  under it was measured separately (git 2.51.1): untracked-but-not-ignored
  files go, ignored files stay, a directory holding only ignored content stays.
- **OpenCode 2.0.14 was measured over ACP, not assumed to match v1.** A real
  `initialize` and `session/new` against the pinned binary: `mcpCapabilities.http`
  is still `true` (so the mesh gate still passes), the modes are still the
  `configOptions` entry with `category: "mode"` and still `build` / `plan` with
  no top-level `modes` object, and the model ids are still provider-prefixed.
  **How many models an unauthenticated session lists is not stable, so do not
  assert on it.** The same container with an empty `credential` table answered
  7 on the first run after install and 71 on every run since, and a warm home
  answers 75 — the free-tier diagnosis rests on the user's own symptom, on
  `opencode models` run against both binaries, and on the `cost.input > 0`
  transform read out of the source, not on this number. What *is* reproducible
  is that a priced model is unusable without a key (`provider.no-route`).
  A real service-account key has since been exercised: `pnpm test:agents` ran
  20/20 on the host against one, so a key does complete turns, and **the org id
  never had to be supplied** — the key alone reaches inference and the console
  serves the org id inside `/api/config` anyway.
- **What makes OpenCode ask is a path outside `cwd`, and nothing else did.**
  Driven over real ACP on a free model with the client capabilities Domo
  advertises, on 2.0.14. Reading `/etc/hosts` with the `read` tool raises one
  `session/request_permission`, titled with the path and `kind: "read"`;
  `{"permission":"allow"}` and `{"permission":{"external_directory":"allow"}}`
  each suppress it. An in-`cwd` edit never asks whatever the policy says,
  because OpenCode delegates it to the client as `fs/write_text_file` — exactly
  as Claude Code does.
  **What prompts is inconsistent, and the two versions disagree.** On 2.0.14
  ten bash commands raised nothing — `cat /etc/hosts`, `cat /etc/passwd`,
  `head`, two `ls`, a `touch` and an `rm` *outside* `cwd`, a `>>` redirect and a
  `curl` — every one of them verified to have actually run, while the `read`
  tool on the same `/etc/hosts` prompted. On **1.18.28** `cat /etc/hosts`
  through bash *did* prompt and `ls /usr/local` did not. Ten commands is not
  exhaustive and neither is two. So the honest statement is that the prompt
  fires on the tidy file tools and unpredictably on shell commands, which makes
  `external_directory` a guardrail against *accidental* drift — worth keeping,
  because an agent is not trying to evade it — and **not something to document
  or rely on as containment**.
- **`agents-live` now runs all three adapters, and gates on an OpenCode console
  key to do it.** It used to run `codex` and `claude-code` only, while `MODELS`
  and `ASKS` carried `opencode` keys purely because they are
  `Record<AgentAdapter, …>` — coverage that looked present and was not. The
  layer's `globalSetup` therefore asks for `NUXT_OPENCODE_API_KEY` alongside
  the Claude token and the Codex login, and **`pnpm test:agents` fails without
  one**: there is no fallback, because a container cannot use a host
  `opencode auth login` and a priced model without a key answers
  `provider.no-route`.
  Two things in there are load-bearing. `beforeAll` pins
  `openCodePermission` to `ask` on both surfaces, so every test describes the
  *adapter* rather than whatever Domo's default happens to be — the default for
  an environment is `allow`, which would suppress the very prompt the shared
  permission test asserts. And the OpenCode model is pinned as an **exact** id
  (`opencode-go/glm-5.3-flash`), because with a key set the adapter lists
  `opencode/*` and `opencode-go/*` together and a bare name is refused as
  ambiguous rather than guessed at.
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
- **Both usage sources were verified against real accounts**, and the answers
  are why the design is shaped the way it is. The Claude OAuth usage endpoint
  refused a real `claude setup-token` token with 403
  `{"required_scopes":["user:profile"],"error_code":"oauth_scope_insufficient"}`;
  a minimal `POST /v1/messages` with the same token answered 200 carrying
  `anthropic-ratelimit-unified-5h-utilization: 0.41`,
  `7d-utilization: 0.67` and both resets as epoch seconds. Running the
  production build against the real database then wrote, from the live poller:
  Claude `5-hour limit 50%` / `Weekly · all models 67%` (source `headers`) and
  Codex `5h limit 49%` / `Weekly limit 24%` / `Credits` (source `app-server`),
  with both providers `ok`. The per-model weekly buckets and the credits row the
  endpoint would add are therefore **not** exercised against a live account.
- The CSP needed no change and was checked rather than assumed: `connect-src`
  is still `'self'` plus the dev WebSocket, no built client asset names
  `api.anthropic.com`, `api.openai.com` or `generativelanguage.googleapis.com`,
  and only the server bundle does. Every outbound call is server-side.
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
  `app/pages`; the dashboard shell is `app/layouts/default.vue`, which mounts
  `ProjectTree.vue` and otherwise knows nothing about the tree.
- Prefer Nuxt UI components (`UDashboard*`, `UChat*`, `UModal`, `UAlert`, …)
  over bespoke markup. Always give `UModal` both `title` and `description`.
- Server helpers go in `server/lib/<area>/`; anything that writes to the
  database goes through `server/lib/repo.ts` so the bus stays informed.
- Shared types are in `shared/types/index.ts` and imported as `~~/shared/types`.
- Keep environment lifecycle operations in `server/lib/dev-environments.ts`;
  invoke Docker with argument arrays, never interpolated shell commands.
