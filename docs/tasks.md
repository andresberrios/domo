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

The pivot is **designed, not built**. Code is still the Electric/Coast
implementation; the merged billing/streaming rescue lives in
`electric/claude.ts`/`entity.ts` and is reused by the new engine.

1. Read `CLAUDE.md` (Where-we-are + gotchas) → `docs/initial-design.md`
   (design + Build sequence + Decisions) → `docs/history.md` (what was &
   why) → `BUGS.md`.
2. Build in order below. **Step 1 first** (kills the corruption class).
3. Test on an **isolated `DOMO_HOME` + dev port 7576** — never the
   user's live prod at `localhost:7575`.
4. Doc-sync every landed step (prime directive).

> **⚠️ Deadline-critical, deferred by the user to AFTER the engine
> migration:** live-verify subscription billing in a real Domo session
> (isolated `DOMO_HOME`/7576): a session must show
> `cc_entrypoint=claude-vscode` + `apiKeySource:none` on the spawned
> `claude`. The fix is merged + typecheck/lint-green + spike-proven, but
> **never confirmed in a live Domo session**. Anthropic billing change
> lands **~2026-06-15** (support 15036540) — this verification must pass
> on the new engine before that date. Tracked as step 1's final check
> **and** repeated as step 7 so it cannot be missed.

## 1 — Session engine swap

Rescued from `dev` (merged, `8e63794`) and reused as-is: the billing
spawn (no `-p`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, exact VS Code
argv), stdio-permission, steering, and the partial-stream coalescer all
already live in `electric/claude.ts`/`entity.ts` — the engine just takes
over the process lifecycle.

- [ ] `server/lib/sessionEngine`: single-flight per-session manager;
      **long-lived per-session process** (one process, multi-turn over
      one stdin, demux by `result`, idle-reap ~15 min → `--resume`
      respawn; spike `smoke/persistent-session-spike.mjs`). Reuse
      `electric/claude.ts` verbatim.
- [ ] `session_events(session_id,seq,type,payload,created_at)` SQLite
      table + append/read (incl. updatable `assistant_partial` rows for
      the live coalescer); `sessions` row keeps `nativeSessionId`,
      status, approval mode.
- [ ] Re-point `sessions.*` procedures off the entity/driver client onto
      the engine; diff-decision + steer hit the live process directly.
- [ ] Boot reconcile pass: `running`→`interrupted`, auto-reject orphan
      `pending` diffs; next prompt `--resume`s.
- [ ] Delete `server/lib/electric/*` (keep `claude.ts` logic),
      `/_agents` proxy, agents-server compose + boot-relink patch,
      `apply-patches.sh`, pkg.pr.new `@durable-streams/*` pins +
      `pnpm.overrides`.
- [ ] **Release/CLI cleanup (tied to the deleted infra):** slim
      `bin/domo` (no compose; `up`/`down`/`restart` = the Nitro
      process), `install.sh` prereqs, `build-release.sh`/`release.yml`
      (drop the agents-server image build), `local-update.sh`.
- [ ] Verify e2e on isolated `DOMO_HOME` + dev port: create→prompt→tool→
      assistant streaming live; kill mid-turn → restart → no corruption,
      resumes; `apiKeySource:none` + `cc_entrypoint=claude-vscode`.

## 2 — Reactivity spine

- [ ] In-process change bus; single post-write chokepoint emits
      `{table,id,op}`.
- [ ] `GET /api/live` SSE (auth-gated, singleton client); coarse
      `{table}`→procedure refetch; chat fine path `{session_id,seq}`→
      append past `lastSeq`; reconnect `?since=`.
- [ ] `useLiveCall` (or generalize `useCoastEvents`); delete the 4 s rail
      poll + the browser durable-stream client.
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
