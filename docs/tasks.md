# Domo — Task tracker

> Keep in sync with `initial-design.md`. The pre-2026-05 Electric/Coast
> build (phases 0–4 + auth Part A) **shipped** and is recorded in
> [`history.md`](history.md) — not re-tracked here. This tracker covers
> the **new architecture** build (`initial-design.md` → Build sequence).
> Per-phase checklist files were retired into `history.md`.

Tick items as they land; add as discovered. Each landed step updates
`initial-design.md`/`project-context.md`/`CLAUDE.md` in the *same*
change (doc-sync is a prime directive).

## START HERE (fresh session)

**Step 1 (engine swap)** landed 2026-05-19 / -20, **Step 2 (reactivity
spine)** landed 2026-05-20, **Step 3a (devcontainer cutover, host-side
`claude`)** landed 2026-05-20. The session engine is the in-process
`server/lib/sessionEngine/*` over `session_events` + `pending_diffs` in
SQLite; the reactivity spine is one auth-gated `/api/live` SSE +
`server/lib/changeBus.ts`, with a tab-wide singleton browser client
(`app/composables/liveBus.ts`) multiplexing **three SSE event types**:
`session-event` (durable rows, replayed past `?since=` on connect,
lossless reconnect), `partial` (live-only coalesced assistant deltas —
NOT persisted), and `table-change` (coarse `{table,id,op}` notices from
every helper-layer write). The 4 s rail-poll is deleted — the rail is
push-live.

Step 3a swapped the Coast adapter for a devcontainer-driven env layer
(`server/lib/devcontainer/`): `@devcontainers/cli` for lifecycle,
`docker inspect` for status + published-port discovery, `docker exec`
for the terminal WS, `docker rm -f` + `git worktree remove` for env
delete, and a starter-`devcontainer.json` scaffolder on project add.
Coast is deleted (`server/lib/coast/`, `server/api/coast-events.ts`,
`useCoastEvents`, `server/procedures/coastSmoke.ts`, the project
build SSE + BuildProgress component, canonical-env / checkout — all
gone). The Electric/agents-server/Postgres infra + the `@durable-streams/*`
pkg.pr.new pins + the `_agents` proxy + the boot-relink patch + the
`agent-session-protocol` dep (IDE-bridge leftover) are all gone.
The engine owns the **long-lived per-session process** (multi-turn over
one stdin, demux by `result`, idle-reap ~15 min, `--resume` respawn).

**CLI argv + env now verified against the live VS Code 2.1.142
extension** (capture from `ps eww`, 2026-05-20): argv identical for a
fresh session in `manual` mode; four extension env vars added alongside
`CLAUDE_CODE_ENTRYPOINT=claude-vscode` (`MCP_CONNECTION_NONBLOCKING`,
`CLAUDE_CODE_ENABLE_TASKS=0`,
`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_AGENT_SDK_VERSION`).

`pnpm install` clean. `pnpm typecheck` + `pnpm lint` green.

**Next-up build order:**

1. **Step 3b** — `claude` spawn moves into the env container via a
   Domo-owned devcontainer Feature + shared `<DOMO_HOME>/claude-home/
   <userId>/` mount; path translation in diff/tool-call rendering.
2. **Step 4** — port forwarding (TCP-only, cross-platform: published
   random host ports + userland forwarders for ad-hoc + "expose
   externally" toggle; SQLite forward table). No HTTP proxy, no
   canonical env in v1.
3. **Step 5** — group-chat collaboration (`chat` events + trigger
   detection).
4. **Step 6** — re-polish + docs/site rewrite + prod reinstall.
5. **Step 7** — billing live-verify (single end-of-build check; runs
   AFTER 1–6 land; see the note at the top of this file — don't
   surface as next-actionable while earlier steps are in flight).

**Fresh-session rules:**

- Read `CLAUDE.md` (Where-we-are + gotchas) → `docs/initial-design.md`
  (design + Build sequence + Decisions) → `docs/history.md` (what was
  & why) → `BUGS.md`.
- Doc-sync every landed step in the same change (prime directive).
- Test on **isolated `DOMO_HOME` + dev port 7576** — prod is
  decommissioned until reinstall (step 6), but treat 7575 as
  off-limits regardless.

> **Billing live-verify (step 7).** Deferred by the user to **after all
> the build steps land — including the devcontainer swap (step 3) and
> the release re-cut (step 6).** It is a single end-of-build check, not
> a recurring milestone. Don't surface it as next-actionable while
> steps 2–6 are still in flight. Anthropic's billing change lands
> ~2026-06-15 (support 15036540); the verify must pass *before that
> date*, so the entire build (1→6) needs to land in time.

## 1 — Session engine swap — LANDED

Rescued from `dev` (merged, `8e63794`) and reused as-is: the billing
spawn (no `-p`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, exact VS Code
argv), stdio-permission, steering, and the partial-stream coalescer all
moved verbatim from `electric/claude.ts` into
`server/lib/sessionEngine/claude.ts`; the engine owns the **long-lived
per-session process**.

- [x] `server/lib/sessionEngine`: single-flight per-session manager
      (`engine.ts`); **long-lived per-session process** (one process,
      multi-turn over one stdin, demux by `result`, idle-reap ~15 min →
      `--resume` respawn; spike `smoke/persistent-session-spike.mjs`).
      Claude spawn moved into `sessionEngine/claude.ts`.
- [x] `session_events(session_id,seq,type,payload,message_id,created_at)`
      SQLite table + append/read (every row an INSERT, monotonic `seq`).
      Streaming deltas are NOT persisted — partials live on the change
      bus / SSE only; the complete `assistant` envelope is its own
      durable row. `pending_diffs` table backs the cross-device card.
      `sessions` row keeps `nativeClaudeSessionId`, status, approval
      mode. `message_id` column + `entity_id`/`durable_stream_url`
      columns linger as harmless NULLs (SQLite DROP COLUMN is awkward;
      nothing reads them).
- [x] Re-pointed `sessions.create/prompt/abort/diffDecision/pendingDiff/
      delete` onto the engine; `streamInfo` deleted (replaced by the
      `/api/live` snapshot+tail); `get/list/rename/done/setApprovalMode/
      markViewed/commands/mentions` unchanged.
- [x] Boot reconcile pass (`server/plugins/sessionEngine.ts`):
      `active`/`pending-approval`→`waiting`, orphan `pending` diffs
      auto-reject + record `diff_decision { reason:'runtime restarted' }`
      so cards clear cross-device; next prompt `--resume`s.
- [x] Minimal `/api/live` chat seq-tail SSE (server/api/live.ts) +
      `server/lib/changeBus.ts`; `useSessionStream` rewritten to
      consume it; durable-stream browser client deleted (the chat fine
      path of step 2's spine landed here because the chat is unusable
      without it — the coarse path / `useLiveCall` / rail-poll deletion
      stays as step 2 proper). Two SSE event types: `session-event`
      for durable rows (replayed past `?since=` on connect, lossless
      reconnect) and `partial` for **live-only** coalesced streaming
      deltas (NOT persisted — the complete `assistant` row supersedes
      them in the adapter; `sessionMessages.ts` takes `(events, partial)`
      and renders the streaming bubble keyed on Anthropic `message.id`).
- [x] Deleted `server/lib/electric/*`, `/_agents` proxy
      (`server/routes/_agents/`), `server/plugins/electric.ts`,
      `server/procedures/electricSmoke.ts`, `docker-compose.yml`,
      `release/*` (compose + Dockerfile + boot-relink patch), and
      `scripts/apply-patches.sh`; dropped the `@electric-ax/*` +
      `@durable-streams/*` deps + the `pnpm.overrides` URL pins +
      `blockExoticSubdeps`; dropped the unused `agent-session-protocol`
      dep (IDE-bridge leftover); pruned `agentsServerUrl` runtimeConfig
      + `DOMO_AGENTS_*` env vars.
- [x] **Release/CLI cleanup:** `bin/domo` collapsed to managing the
      Nitro app (`up`/`down`/`restart`/`status`/`logs`/`update`,
      no Docker compose). `install.sh` dropped the agents-server
      prereqs. `build-release.sh` / `local-update.sh` drop the
      `release/` infra copies + manifest no longer carries
      `infra.agentsServer`. `release.yml` is unchanged (it just calls
      `scripts/build-release.sh`).
- [ ] **DEFERRED to step 7 by the user:** live-verify e2e on isolated
      `DOMO_HOME` + dev port: create→prompt→tool→assistant streaming
      live; kill mid-turn → restart → no corruption, resumes;
      `apiKeySource:none` + `cc_entrypoint=claude-vscode`. The first
      browser-driven session against the new engine has not happened
      yet — see "⚠️ Deadline-critical" above + step 7.

## 2 — Reactivity spine — LANDED

The chat fine path + auth-gated `/api/live` + the durable-stream client
deletion landed with step 1 (the chat needed them to work). Step 2
adds the coarse path (`{table,id,op}` → procedure refetch), unifies
the browser client on a tab-wide singleton, and deletes the 4 s
rail-poll.

- [x] In-process change bus (`server/lib/changeBus.ts`) — three topics:
      durable session events, live-only partial frames, and coarse
      `{table,id,op}` (`projects`/`envs`/`sessions`). The helper-layer
      writes in `lib/{sessions,envs,projects}.ts` fire the coarse
      notice from every insert/update/delete chokepoint (including the
      engine's per-turn `updateSession` for status + lastEventAt).
- [x] `GET /api/live` SSE auth-gated, **`sessionId` now optional**:
      with `sessionId` the connection carries `session-event` +
      `partial` (chat fine path) plus `table-change` (always on);
      without `sessionId` it carries `table-change` only — used on
      pages that don't show a chat. Snapshot replay only emits past
      `?since=` for session-events; `table-change` has no replay (the
      consumer's `useCall` data is the snapshot, refetch is the catch-up).
- [x] `app/composables/liveBus.ts` — tab-wide singleton, lazy-opens on
      first subscriber, closes on last unsubscribe. `focusSession(id)`
      restarts the SSE on a new sessionId; `releaseFocusIf(id)` is a
      CAS so a chat unmount doesn't clobber the next chat's mount
      (Nuxt page transitions can mount-before-unmount).
- [x] `app/composables/useLiveRefresh.ts` — binds a `useCall.refresh()`
      (or any imperative refresh fn) to coarse `table-change` notices,
      with a 150 ms trailing debounce so a turn's flurry of
      `updateSession` writes collapses into one SELECT.
- [x] `useSessionStream` refactored onto the singleton (no more
      per-component EventSource). Behaviour preserved: snapshot
      replay → live tail → resume-on-error from high-water.
- [x] `LeftRailTree`/`LeftRailEnvList`/`LeftRailSessionList`: 4 s
      `sessionTick` setInterval deleted; `useLiveRefresh` drives each
      `useCall.refresh()`. Coast events still drive the env runtime
      overlay (liveStatus/checkout) until step 3 swaps Coast out.
      Env overview page + project page wired the same way.
- [x] `pnpm typecheck` + `pnpm lint` green.
- [ ] Live e2e verify on dev port 7576 (rail dot status push-live,
      chat tails incrementally, reconnect lossless, mobile scroll OK
      with a tall transcript). Tied to the step 7 end-of-build
      browser-driven session check — same isolated `DOMO_HOME` run.

## 3a — Devcontainer environment engine (container lifecycle) — LANDED

- [x] `@devcontainers/cli` lifecycle (`up` via subprocess +
      `--override-config` overlay for Domo's `runArgs`); `docker
      inspect`/`start`/`stop`/`rm -f` for the rest of the lifecycle.
      Rootless-DinD selection: sysbox-runc when registered, else
      rootless-dind, else privileged-with-warning (operator opt-in);
      selected at runtime per-host (`server/lib/devcontainer/runtime.ts`),
      not install.
- [x] **No Domofile.** Reads `devcontainer.json` directly
      (`forwardPorts`, `portsAttributes`, `runArgs`, etc.). Project-add
      scaffolder writes a starter `.devcontainer/devcontainer.json` if
      absent — sensible base image (ubuntu-22.04) + Docker-in-Docker
      feature + a TODO comment for the Domo claude Feature (lands step
      3b). Compose-aware variant of the scaffold deferred.
- [x] `WS /api/terminal` → `docker exec -i -t bash -l` against the env
      container. Removed Coast (`server/lib/coast/*`, `useCoastEvents`,
      `server/api/coast-events.ts`, `coastSmoke`, project-level build
      SSE, `BuildProgress.vue`, checkout procedure, `coastApiUrl`
      runtimeConfig). Terminal resize is dropped for v1 (a follow-up
      can wire dockerode for `POST /containers/<id>/exec/<exec_id>/resize`).
- [x] `install.sh` checks: docker present, kernel userns + cgroup v2
      + subuid/subgid + fuse-overlayfs (Linux, warn-on-missing), sysbox
      detection (informational), macOS-supported note.
- [ ] Verify e2e: create env from a real devcontainer, inner `docker
      compose` up, terminal works, restart-safe. Tied to the step 7
      end-of-build live-verify run.

## 3b — `claude` inside the env container

- [ ] Publish a Domo-owned devcontainer Feature
      (`ghcr.io/<us>/devcontainer-features/claude`) that installs the
      claude CLI inside any container; version pinned to
      `CLAUDE_AGENT_SDK_VERSION` (literal Domo ships against; bump
      when re-matching an upstream extension capture).
- [ ] Scaffolder adds the Feature to scaffolded `devcontainer.json`s;
      user-supplied devcontainers must include it themselves (the
      env-create flow warns if absent).
- [ ] `server/lib/sessionEngine/claude.ts`: spawn site changes from
      host `spawn('claude', argv, { env, cwd })` to `spawn('docker',
      ['exec', '-i', '-w', '/workspace', '--env', …, '<envContainerId>',
      'claude', …argv])`. Argv unchanged. The 5 pinned env vars +
      `ANTHROPIC_API_KEY` scrub + `<domoHome>/config.json`
      `claude.env`/`extraPath` merge move into the `--env` flags.
- [ ] Shared `~/.claude` per Domo user: bind-mount
      `<DOMO_HOME>/claude-home/<userId>/` (created on first env open
      for that user, mode 0700) into every env container's
      `/home/<containerUser>/.claude`. Used for OAuth credentials,
      slash-command discovery, MCP definitions. User runs
      `claude /login` once from any env terminal.
- [ ] Path translation: `/workspace/…` (what claude emits) ↔
      worktree-relative (what UI renders, what `pending_diffs` stores).
      Adapter in `app/utils/sessionMessages.ts` + the diff card path
      label; store worktree-relative in SQLite.
- [ ] Drop the host-side claude path entirely (no fallback). Update
      `CLAUDE.md` billing gotcha to reflect the spawn-site move.
- [ ] Verify e2e: fresh env, `claude /login` from terminal, send a
      prompt, confirm `apiKeySource:"none"` + `cc_entrypoint=
      claude-vscode` in the spawned process (folded into step 7's
      single end-of-build live-verify).

## 4 — Port forwarding

- [ ] At `devcontainer up`, inject `runArgs: ["-p",
      "127.0.0.1:0:<inner>", …]` for each `forwardPorts` entry;
      discover assigned host ports via `docker port <container>
      <inner>` and persist to a SQLite forward table
      `{env_id, name, inner_port, protocol, host_port, mode:
      'published'|'userland', external_port|null}`.
- [ ] Userland forwarder for ad-hoc/runtime ports: Node net listener
      on `127.0.0.1:<chosen>` piping to `docker exec <container>
      socat - TCP:localhost:<inner>` (same mechanism VS Code uses);
      `envs.ports.addAdHoc(envId, innerPort)`.
- [ ] `envs.ports.expose(forwardId, externalPort)` /
      `envs.ports.unexpose(forwardId)` spawn/kill a TCP forwarder
      listening on `0.0.0.0:<externalPort>` piping to
      `127.0.0.1:<host_port>`. No container recreate.
- [ ] Env-screen UI: list each port with label (from
      `portsAttributes`) + `localhost:<host_port>` + an "expose
      externally" toggle (when on, show `0.0.0.0:<externalPort>`).
- [ ] Rebuild userland forwarders + external listeners from the SQLite
      forward table on boot (published ports survive container restart
      via Docker; userland + external need the listener respawned).
- [ ] Verify: declared ports work cross-platform (Linux + macOS Docker
      Desktop); expose/unexpose toggles with no recreate; ad-hoc port
      add works; restart-safe.

## 5 — Collaboration (Decided #13)

- [ ] Durable `chat` event `{text,author:{userId,userName}}`; engine
      records every chat msg, runs a turn only on `@agent`/`trigger`,
      folds un-consumed backlog; mid-turn `@agent` via steering.
- [ ] Adapter + UI: authored human bubbles distinct from the agent;
      "Send to agent ▶" + `@agent` autocomplete.
- [ ] Verify e2e: multi-user chat without turns; trigger sees backlog;
      restart-safe.

## 6 — Re-polish + docs/site rewrite + prod reinstall

Prod was **decommissioned 2026-05-19** (app stopped, all Coast envs
`coast rm`'d, prod/dev/Electric docker stacks down, `~/.domo` wiped).
The user will **reinstall prod after the pivot is implemented**, from
the new release line — there is no live prod until then (the
don't-touch-7575 caution is suspended until reinstall).

- [ ] Sweep aborts/shortcuts/responsive against the new engine.
- [ ] Rewrite `docs/site/*` (getting-started, securing, releasing) to
      the devcontainer/own-engine model; cut the new release line
      (no agents-server image; per Build-seq step 1's release/CLI
      cleanup).
- [ ] User reinstalls prod from the new release; then run step 7's
      billing check against it too (the deadline check must pass on the
      reinstalled prod).

## 7 — Live-verify subscription billing on the new engine

Single end-of-build check, **not** a recurring milestone. Run this
**after all of steps 1–6 have landed** (in particular the devcontainer
swap and the release re-cut) — the user has explicitly scoped it that
way. Anthropic's billing change lands ~2026-06-15 (support 15036540),
so the entire build needs to land in time; don't surface this step as
next-actionable while earlier steps are in flight.

- [ ] Isolated `DOMO_HOME` + dev port 7576: create a session, send a
      prompt, confirm the spawned `claude` shows
      `apiKeySource:"none"` in the `system` init event and the
      outbound `x-anthropic-billing-header` carries
      `cc_entrypoint=claude-vscode`.
- [ ] Confirm the long-lived per-session process behaves end-to-end:
      multi-turn over one stdin, idle-reap closes stdin → exit, next
      prompt respawns with `--resume`.
- [ ] If it regresses, `server/lib/sessionEngine/claude.ts` is the
      lever; spikes `smoke/no-print-lifecycle-spike.mjs` +
      `persistent-session-spike.mjs` are the reusable A/B harness.
      Memory: `project-agent-sdk-billing`.

## Open questions

Tracked in `initial-design.md` → Decisions → Open (restart UX,
compose-based devcontainer.json scaffold details, runtime-port auto-
detection, concurrent-edit signalling, no-remote projects, per-session
ACLs, canonical-env / stable-host-port UX deferred from v1).
