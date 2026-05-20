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

**Step 1 (engine swap) landed 2026-05-19 / -20** and **Step 2
(reactivity spine) landed 2026-05-20.** The session engine is the
in-process `server/lib/sessionEngine/*` over `session_events` +
`pending_diffs` in SQLite; the reactivity spine is one auth-gated
`/api/live` SSE + `server/lib/changeBus.ts`, with a tab-wide
singleton browser client (`app/composables/liveBus.ts`) multiplexing
**three SSE event types**: `session-event` (durable rows, replayed past
`?since=` on connect, lossless reconnect), `partial` (live-only
coalesced assistant deltas — NOT persisted, the complete `assistant`
row supersedes them in the adapter), and `table-change` (coarse
`{table,id,op}` notices fired from every helper-layer write to
`projects`/`envs`/`sessions`; browser `useLiveRefresh` debounces and
calls `useCall.refresh()` on a match). The 4 s rail-poll is deleted —
the rail's session status dot + new-output dot are now push-live.
The Electric/agents-server/Postgres infra + the `@durable-streams/*`
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

1. **Step 3** — devcontainer + rootless-DinD environments, `Domofile`,
   terminal → `docker exec`, Coast adapter removed.
2. **Step 4** — port forwarding (HTTP reverse-proxy + TCP listeners,
   canonical env binding, SQLite forward table).
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

## 3 — Devcontainer environment engine

- [ ] `@devcontainers/cli` lifecycle (`up`/`exec`); rootless DinD
      baseline chosen + documented.
- [ ] `Domofile` parse (container source + named ports); project-add &
      env-create reworked (scaffold heuristics).
- [ ] `WS /api/terminal` → `docker exec`/`devcontainer exec`; remove the
      Coast adapter (`server/lib/coast/*`) + `useCoastEvents` Coast bits.
- [ ] Verify e2e: create env from a real devcontainer, inner `docker
      compose` up, terminal works.

## 4 — Port forwarding

- [ ] HTTP reverse-proxy (Host/path → `envContainerIP:innerPort`) + raw
      TCP on-demand listeners; SQLite forward table = source of truth.
- [ ] `envs.ports` (expose/unexpose), `envs.setCanonical`; env-screen
      toggles; rebuild forwarders from the table on boot.
- [ ] Verify: toggle exposes/unexposes with no container recreate;
      canonical rebinds; restart-safe.

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
`Domofile` scaffold heuristics, rootless-DinD baseline, service-URL UX,
concurrent-edit signalling, no-remote projects, per-session ACLs).
