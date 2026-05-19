# Domo — Task tracker

> Keep in sync with `initial-design.md`. The pre-2026-05 Electric/Coast
> build (phases 0–4 + auth Part A) **shipped** and is recorded in
> [`history.md`](history.md) — not re-tracked here. This tracker covers
> the **new architecture** build (`initial-design.md` → Build sequence).
> Per-phase checklist files were retired into `history.md`.

Tick items as they land; add as discovered. Each landed step updates
`initial-design.md`/`project-context.md`/`CLAUDE.md` in the *same*
change (doc-sync is a prime directive).

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

## 5 — Collaboration (Decided #21)

- [ ] Durable `chat` event `{text,author:{userId,userName}}`; engine
      records every chat msg, runs a turn only on `@agent`/`trigger`,
      folds un-consumed backlog; mid-turn `@agent` via steering.
- [ ] Adapter + UI: authored human bubbles distinct from the agent;
      "Send to agent ▶" + `@agent` autocomplete.
- [ ] Verify e2e: multi-user chat without turns; trigger sees backlog;
      restart-safe.

## 6 — Re-polish + docs/site rewrite

- [ ] Sweep aborts/shortcuts/responsive against the new engine.
- [ ] Rewrite `docs/site/*` (getting-started, securing, releasing) to
      the devcontainer/own-engine model; cut a new release line.

## Open questions

Tracked in `initial-design.md` → Decisions → Open (restart UX,
`Domofile` scaffold heuristics, rootless-DinD baseline, service-URL UX,
concurrent-edit signalling, no-remote projects, per-session ACLs).
