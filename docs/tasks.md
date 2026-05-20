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
spine)** landed 2026-05-20, **Step 3a (devcontainer cutover)** landed
2026-05-20, **Step 3b (claude into the env container via `docker exec`,
shared `~/.claude` across the install)** landed 2026-05-20, **Step 4
(TCP-only "expose externally" port forwarding)** landed 2026-05-20.
**Step 5 (group-chat collab) is deferred** — single-user v1 ships
without it; design lives on in Decided #13. The session engine is the in-process
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

**Next-up build order (2026-05-20 update):**

The 2026-05-20 verify pass **landed** all the deferred per-step
checks (1, 2, 3a, 3b, 4) + step 7 in a single live run. Bugs found
and fixed in the same change: BUGS.md #5–#16. The remaining work
before the user can `domo update` against prod:

1. **Cut `v0.4.0+`** — `release.yml` builds the matrix; the engine
   spawn + scaffold-postCreate carry every fix the verify pass
   shook out.
2. **Domo-owned claude devcontainer Feature publish — DEFERRED
   post-v1.** v1 ships the scaffolder's `apt-get install -y
   bubblewrap && curl https://claude.ai/install.sh | bash` (landed
   in step 3b + the verify pass). The published Feature image is a
   v1.x release-engineering follow-up; bake `bubblewrap` into it.
3. **Prod reinstall — DEFERRED until after the release tag.**
   The don't-touch-7575 caution stays suspended until then.

Docs/site rewrite already landed (`a61a620`).

**Fresh-session rules:**

- Read `CLAUDE.md` (Where-we-are + gotchas) → `docs/initial-design.md`
  (design + Build sequence + Decisions) → `docs/history.md` (what was
  & why) → `BUGS.md`.
- Doc-sync every landed step in the same change (prime directive).
- Test on **isolated `DOMO_HOME` + dev port 7576** — prod is
  decommissioned until reinstall (step 6), but treat 7575 as
  off-limits regardless.

> **Billing live-verify (step 7).** **NOW ACTIVE (2026-05-20).** Per
> the latest user direction, the Feature publish and prod reinstall
> are deferred past step 7 (Feature: post-v1; reinstall: after the
> verify pass + new release tag). The verify happens in dev (pnpm dev
> on 7576, isolated `DOMO_HOME`) and gates the `v0.4.0+` tag.
> Anthropic's billing change lands ~2026-06-15 (support 15036540); the
> verify must pass *before that date*.

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
- [x] **Live-verify e2e (2026-05-20 verify pass):** isolated
      `DOMO_HOME` + dev port 7576. create→prompt→assistant streaming
      live ✅; kill Nitro mid-session → restart → no corruption,
      transcript replays losslessly, next prompt carries
      `--resume <nativeClaudeSessionId>` and claude correctly recalls
      prior turns ✅; `apiKeySource:'none'` +
      `CLAUDE_CODE_ENTRYPOINT=claude-vscode` confirmed in spawn argv
      and the `system` init event. Bugs found and fixed in the same
      change: BUGS.md #5–#14.

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
- [x] **Live e2e verify (2026-05-20 verify pass):** rail's session
      status flipped live during a turn (Working ↔ Waiting) with no
      4 s poll; chat tails the streaming assistant response live;
      SSE reconnect after a Nitro kill replayed the entire transcript
      from `session_events` ✅; mobile breakpoint (390×844) with the
      count-to-30 list — bounded `flex-1 min-h-0 overflow-y-auto`
      container scrolls cleanly (scrollHeight 1324, clientHeight 607,
      full range traversed).

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
- [x] **Verify e2e (2026-05-20 verify pass):** created an env from a
      scaffolded `devcontainer.json` (ubuntu-22.04 + DinD feature +
      curl-installer postCreate); `docker run` plumbing confirmed via
      `docker inspect` — labels `domo.envId` / `domo.projectId`,
      published port `127.0.0.1:0:3000/tcp`, claude-home + project
      `.git` bind mounts. Terminal WS now works (BUGS.md #9 fix:
      drop `-t` host-side, wrap shell with `script -qfc` for an
      in-container PTY, add `-u <remoteUser>` + `-w
      /workspaces/<envName>`); restart-safe — container survives a
      Nitro bounce; bugs found and fixed in the same change: BUGS.md
      #5 (worktree branch model), #6 (CLI resolve in pure-ESM), #7
      (override-config doesn't deep-merge), #8 (stale Coast copy),
      #12 (project `.git` bind mount), #16 (workaround docs).

## 3b — `claude` inside the env container — LANDED

- [ ] **DEFERRED post-v1 (2026-05-20).** Publish a Domo-owned
      devcontainer Feature (`ghcr.io/<us>/devcontainer-features/
      claude`) that installs the claude CLI inside any container;
      version pinned to `CLAUDE_AGENT_SDK_VERSION` (literal Domo ships
      against; bump when re-matching an upstream extension capture).
      v1 ships the scaffolder's `postCreateCommand: curl
      https://claude.ai/install.sh | bash` — landed and verified in
      step 3b. The Feature image is a v1.x release-engineering
      follow-up.
- [x] Scaffolder writes
      `postCreateCommand: "curl -fsSL https://claude.ai/install.sh | bash"`
      + `remoteUser: "vscode"` + the Docker-in-Docker feature. The
      installer is platform-detecting and needs no Node feature.
      Domo claude Feature reference is left as a TODO comment for
      the publishing step.
- [x] `server/lib/sessionEngine/claude.ts` SpawnOpts always uses
      `docker exec -i -w <containerCwd> --env K=V … <containerId>
      claude …argv`. Argv unchanged. The 5 pinned env vars +
      `ANTHROPIC_API_KEY` scrub + `<domoHome>/config.json`
      `claude.env`/`extraPath` merge land in the `--env` flags. No
      host-side fallback — a session without an `env.containerId`
      errors out (`provision it first (Run / Up)`).
- [x] Installation-wide shared `~/.claude`: bind-mount
      `<DOMO_HOME>/claude-home/` (mode 0700) into every env
      container's `/home/<remoteUser>/.claude`. `remoteUser` read
      from the parsed devcontainer.json (default `vscode`). Run
      `claude /login` once from any env terminal; OAuth + slash-
      commands + MCP definitions propagate to every env across the
      install. (Single-user v1 — multi-user mounts are part of the
      deferred Decided #13 collab work.)
- [x] Path translation: `/workspaces/<envName>/…` (what in-container
      claude emits) ↔ host worktree path (what `pending_diffs`
      stores + what `readFile` reads on the host). `toHostPath()`
      helper in `engine.ts` translates before file reads; the
      pending_diff row's `path` stays worktree-relative.
- [x] Custom-workspaceFolder warning: when devcontainer.json sets
      a non-default `workspaceFolder`, `api/envs/run.post.ts`
      emits a `warn` progress SSE frame at run time so the operator
      sees that path translation may show absolute container paths
      in diff cards / tool-call rendering.
- [x] **Verify e2e (2026-05-20 verify pass):** claude-in-container
      working end-to-end. Seeded the shared `~/.claude/.credentials.
      json` (operationally: `claude /login` from a fresh env's
      terminal does the same once the terminal fix landed — BUGS.md
      #9). Prompt → assistant reply received; `apiKeySource:'none'`
      + `cwd:'/workspaces/verify-1'` confirmed in the durable
      `system` init event; spawn argv carries `--env CLAUDE_CODE_
      ENTRYPOINT=claude-vscode` + the 4 ancillary env vars +
      absolute `/home/vscode/.local/bin/claude`. Bugs found and
      fixed in the same change: BUGS.md #10 (engine HOME / user /
      claude path), #11 (bubblewrap requirement → scaffold update).

## 4 — Port forwarding — LANDED

- [x] At `devcontainer up`, inject `runArgs: ["-p",
      "127.0.0.1:0:<inner>", …]` for each `forwardPorts` entry
      (already done in step 3a foundation `client.ts`); discover
      assigned host ports via `docker port` / the `inspect()`
      read.
- [x] `envs.ports.expose({envId, innerPort, externalPort})` /
      `envs.ports.unexpose({envId, innerPort})` spawn/kill a Node
      `net` listener on `0.0.0.0:<externalPort>` piping to
      `127.0.0.1:<host_port>`. No container recreate.
- [x] SQLite `env_external_ports` table = single source of truth.
      `server/plugins/portForwarder.ts` rebuilds every persisted
      listener on boot; `api/envs/run.post.ts` calls `rebindForEnv`
      after a successful `up` (container recreate may reassign the
      random host port; the external port stays stable to users).
- [x] Env-screen UI: each port row gets an Expose toggle (popup
      prompts for the public port; on = green badge showing
      `0.0.0.0:<chosen>`).
- [ ] **Deferred:** userland forwarders for ad-hoc/runtime ports
      that aren't in `forwardPorts`. Users must declare ports in
      `devcontainer.json` for v1. Auto-detection (`ss -tlnp` inside
      the container) is a v1.5 idea.
- [x] **Verify (2026-05-20 verify pass; Linux):** declared port 3000
      published as `127.0.0.1:32770` and reachable
      end-to-end with curl ✅. `envs.ports.expose({innerPort:3000,
      externalPort:18080})` spawned the Node `net.Server` on
      `0.0.0.0:18080` → forwarded to the container's 3000 ✅;
      restart-safe — killed Nitro, dev port disappeared, listener
      came back on the same external port at startup via
      `portForwarder` plugin rebuild, traffic still flowed.
      macOS Docker Desktop coverage deferred to a follow-up cross-
      platform pass.

## 5 — Collaboration (Decided #13) — DEFERRED (not in v1)

Designed in `initial-design.md` Decided #13, but **not implemented**
for v1. Authoring is single-user; sessions are private to the
operator. The `chat` event type, `sessions.chat` procedure, backlog
fold, `@agent` trigger detection, authored bubbles, "Chat only"
input button — none of it is built. Revisit when a multi-user need
surfaces.

## 6 — Re-polish + docs/site rewrite + prod reinstall

Prod was **decommissioned 2026-05-19** (app stopped, all Coast envs
`coast rm`'d, prod/dev/Electric docker stacks down, `~/.domo` wiped).
Per the 2026-05-20 user direction the **reinstall is deferred past
step 7** — the verify pass runs against `pnpm dev` on 7576 / isolated
`DOMO_HOME`, then the user reinstalls from the new `v0.4.0+` tag.
The don't-touch-7575 caution stays suspended until reinstall.

- [x] Rewrite `docs/site/*` (getting-started, securing, releasing) +
      `README.md` to the devcontainer / in-process-engine / TCP-only
      port-forward / group-chat model. References to Coast,
      `Coastfile`, `agents-server`, the compose stack — all replaced.
- [ ] Sweep aborts / keyboard shortcuts / responsive against the
      new engine. Folded into the step 7 verify pass.
- [ ] **DEFERRED post-v1 (2026-05-20).** Publish the Domo-owned
      claude devcontainer Feature
      (`ghcr.io/<org>/devcontainer-features/claude`) and update the
      scaffolder + `releasing.md` to reference it instead of the curl
      installer postCreateCommand. v1.x release-engineering follow-up.
- [ ] Cut the new release tag (`v0.4.0+`) **after step 7 passes** —
      `release.yml` already builds + attaches the tarballs.
- [ ] User reinstalls prod from that new tag (deferred until after
      the verify pass + tag).

## 7 — Live-verify subscription billing on the new engine — LANDED (2026-05-20)

Verified end-to-end against `pnpm dev` on 7576 / isolated
`DOMO_HOME=$HOME/domo-verify`. Feature publish + prod reinstall stay
deferred (step 6). Anthropic's billing change lands ~2026-06-15
(support 15036540) — the release tag + prod reinstall need to land
before that.

- [x] Isolated `DOMO_HOME` + dev port 7576: created a session, sent a
      prompt, the spawned `docker exec … /home/vscode/.local/bin/
      claude …` carried `--env CLAUDE_CODE_ENTRYPOINT=claude-vscode`
      (verified via `ps eww`) and the `system` init durable event
      had `apiKeySource:'none'` ✅. The captured `rate_limit_event`
      payload showed `rateLimitType:'five_hour'` — the subscription
      billing channel. Outbound `x-anthropic-billing-header` capture
      against a live request is the only sub-step deferred (would
      require a host-side mitmproxy interposition; folded into a
      cross-platform follow-up rather than blocking the verify
      pass).
- [x] Long-lived per-session process behaved end-to-end on multi-turn
      ("4" + "Count to 30" + "What was the last number?" — three
      turns over one `docker exec` stdin); kill mid-session +
      restart → next prompt argv carries `--resume
      <nativeClaudeSessionId>` and claude correctly recalled the
      prior list (answered "30"). Idle-reap respawn loop is the
      shape proven by `smoke/persistent-session-spike.mjs`; live
      idle-reap timing is deferred to a follow-up smoke run.
- [ ] If it regresses, `server/lib/sessionEngine/claude.ts` is the
      lever; spikes `smoke/no-print-lifecycle-spike.mjs` +
      `persistent-session-spike.mjs` are the reusable A/B harness.
      Memory: `project-agent-sdk-billing`.

## Open questions

Tracked in `initial-design.md` → Decisions → Open (restart UX,
compose-based devcontainer.json scaffold details, runtime-port auto-
detection, concurrent-edit signalling, no-remote projects, per-session
ACLs, canonical-env / stable-host-port UX deferred from v1).
