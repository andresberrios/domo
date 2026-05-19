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

**Step 1 (engine swap) landed 2026-05-19 / -20.** The session engine is
now the in-process `server/lib/sessionEngine/*` over `session_events` +
`pending_diffs` in SQLite. The reactivity spine's chat fine path is
live (`/api/live` SSE + `server/lib/changeBus.ts`) on **two SSE event
types**: `session-event` for every durable row (replayed past `?since=`
on connect, lossless reconnect) and `partial` for **live-only**
streaming assistant deltas (NOT persisted — partials are transient by
design; the complete `assistant` row supersedes them in the adapter).
The Electric/agents-server/Postgres infra + the `@durable-streams/*`
pkg.pr.new pins + the `_agents` proxy + the boot-relink patch + the
`agent-session-protocol` dep (IDE-bridge leftover) are all deleted.
The billing-critical spawn argv / env scrub /
`cc_entrypoint=claude-vscode` / stdio permission / steering / coalescer
carried over verbatim into `server/lib/sessionEngine/claude.ts`; the
engine owns the **long-lived per-session process** (multi-turn over one
stdin, demux by `result`, idle-reap ~15 min, `--resume` respawn).
`pnpm install` clean. `pnpm typecheck` + `pnpm lint` green.

**Still pending:**
- **Step 7 (deadline-critical billing live-verify)** — never run against
  the new engine; must pass before ~2026-06-15.
- **CLI argv parity check** — user is sharing the official VS Code
  extension's actual spawn command for a diff against
  `sessionEngine/claude.ts`; pending their paste. (The current argv is
  the spike-proven set, but a fresh capture from the live extension is
  the canonical source.)
- **Step 2 remainder** — coarse `{table,id,op}` path on `/api/live` +
  `useLiveCall` + rail-poll deletion (the chat fine path landed early
  with step 1).
- **Steps 3–6** — devcontainers, port forwarding, collab, docs rewrite.

**Fresh-session order:**

1. Read `CLAUDE.md` (Where-we-are + gotchas) → `docs/initial-design.md`
   (design + Build sequence + Decisions) → `docs/history.md` (what was &
   why) → `BUGS.md`.
2. **First**: if the user pasted the official extension's spawn command
   in this session's opening turn, diff against
   `server/lib/sessionEngine/claude.ts` `buildArgs` + `buildEnv` and
   land any deltas before anything else (deadline-critical context).
3. **Then**: step 7's live-verify on isolated `DOMO_HOME` + dev port
   7576 — drive a real session through Playwright, confirm
   `apiKeySource:"none"` + `cc_entrypoint=claude-vscode` on the spawned
   process + multi-turn / `--resume` respawn / idle-reap behaviours.
4. Then step 2 remainder, then steps 3–6.
5. Doc-sync every landed step (prime directive).
6. Test on **isolated `DOMO_HOME` + dev port 7576** — prod is
   decommissioned until reinstall (step 6), but treat 7575 as
   off-limits regardless.

> **⚠️ Deadline-critical, deferred by the user to AFTER the engine
> migration:** live-verify subscription billing in a real Domo session
> (isolated `DOMO_HOME`/7576): a session must show
> `cc_entrypoint=claude-vscode` + `apiKeySource:none` on the spawned
> `claude`. The fix is merged + typecheck/lint-green + spike-proven, but
> **never confirmed in a live Domo session**. Anthropic billing change
> lands **~2026-06-15** (support 15036540) — this verification must pass
> on the new engine before that date. Tracked as step 1's final check
> **and** repeated as step 7 so it cannot be missed.

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

## 2 — Reactivity spine

The chat fine path + auth-gated `/api/live` + the durable-stream client
deletion landed with step 1 (the chat needed them to work). What remains
is the **coarse path** (`{table,id,op}` → procedure refetch) and the
singleton browser SSE client wrapper.

- [x] In-process change bus (`server/lib/changeBus.ts`) — two topics
      so far (durable session events + live-only partial frames);
      extend to `{table,id,op}` here.
- [x] `GET /api/live` SSE auth-gated (chat fine path only): emits two
      event types — `session-event` (durable rows past `?since=`, then
      tailed via the change bus) and `partial` (live-only streaming
      assistant deltas, not replayed on reconnect).
- [ ] Extend `/api/live` to also emit `{table,id,op}` notices from the
      coarse change-bus topic; single browser-side SSE singleton multi-
      plexes both shapes.
- [ ] `useLiveCall` (or generalize `useCoastEvents`); delete the 4 s
      rail poll (`LeftRailTree.vue`).
- [ ] Verify: rail/env/ports update push-live; chat tails incrementally;
      reconnect lossless; mobile scroll OK with a tall transcript.

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

## 7 — ⚠️ Deadline-critical: live-verify subscription billing

Deferred by the user to **after** the engine migration (step 1). Must
pass on the new engine before the Anthropic billing change
(**~2026-06-15**, support 15036540). The fix is merged + spike-proven
but **never confirmed in a live Domo session**.

- [ ] Isolated `DOMO_HOME` + dev port 7576 (NOT prod 7575): create a
      session, send a prompt, confirm the spawned `claude` emits
      `cc_entrypoint=claude-vscode` (outbound `x-anthropic-billing-header`)
      and `apiKeySource:none` in the `system` init event.
- [ ] Confirm long-lived per-session process behaves (multi-turn over
      one stdin, idle-reap, `--resume` respawn) — fidelity follow-up.
- [ ] If it regresses, `electric/claude.ts` is the lever; spikes
      `smoke/no-print-lifecycle-spike.mjs` + `persistent-session-spike.mjs`
      are the reusable A/B harness. Memory: `project-agent-sdk-billing`.

## Open questions

Tracked in `initial-design.md` → Decisions → Open (restart UX,
`Domofile` scaffold heuristics, rootless-DinD baseline, service-URL UX,
concurrent-edit signalling, no-remote projects, per-session ACLs).
