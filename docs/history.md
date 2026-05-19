# Domo — history & archive

Terse record of work that **shipped or was learned but is now being
superseded** by the architecture in `initial-design.md` (own SQLite
session engine + unified change-bus reactivity + devcontainer/DinD
environments). Kept so institutional memory survives the doc clean;
**not** load-bearing for current work. Newest first.

---

## The pivot (2026-05) — why the rest of this file is history

Testing the shipped product surfaced repeated **corrupted sessions
after restarts**. Root cause was structural, not a bug: the session
engine was **Electric Agents** (`@electric-ax/agents-server` +
`agents-runtime` + durable streams on Postgres), a stateful intermediary
whose in-memory state (pull-wake subscriptions, runner offsets) diverges
from durable state on every restart/blip. Each fix added another
band-aid (boot-relink patch, app-only restart, `reconcileStalePendingDiffs`,
a runner supervisor) without removing the failure class.

Decision: **replace Electric Agents with an in-process engine over the
existing SQLite** (`session_events` append-only log + single-flight
per-session process manager + `claude --resume`), and **replace Coast**
with devcontainers + rootless DinD + a `Domofile` and in-process
userland port forwarding. Reactivity unifies onto one change-bus +
`/api/live` SSE (ElectricSQL evaluated and rejected — single-writer /
thin-client / reads-through-procedures makes ~95% of it dead weight and
it would bypass the procedure auth boundary). Engine first, then
devcontainers. Full rationale: `initial-design.md` Decided list.

The Electric/Coast implementation below still runs the **last shipped
release**; it is being removed, not maintained.

**Concurrent `dev`-branch work was rescued into the pivot line** (merge
`8e63794`): a **deadline-critical subscription-billing fix** (post-
2026-06-15 the `-p`/`sdk-cli` path drops off the full subscription;
Domo now spawns `claude` like the official VS Code 2.1.142 extension —
no `-p`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`), **live partial
streaming**, and a **build-progress checklist**. These live in
`electric/claude.ts`/`entity.ts`, reconciled with main's per-session
approval modes, and carry forward unchanged — `claude.ts` is the file
the new engine keeps. This finding is **forward-active**, not history —
see `initial-design.md` Decided #3 + the CLAUDE.md billing gotcha + the
`project-agent-sdk-billing` memory. The HANDOFF.md/spikes from that work
proved the long-lived-per-session-process model the new engine adopts.

---

## Build history (phases 0–5A, all shipped on the Electric/Coast stack)

- **Phase 0–2** — Nuxt 4 SPA skeleton; SQLite metadata DB; typed coastd
  HTTP/SSE/WS client (`server/lib/coast`); project-add flow (git/Coastfile
  init, discriminated-union procedure); env create + env screen;
  host-side workspace (file tree/editor/markdown, CodeMirror), terminal
  (xterm ↔ coastd exec WS), git changes pane (host `git`).
- **Phase 3 — sessions on Electric Agents** (steps 8a–11):
  - 8a: docker-compose Postgres + agents-server; `claude-code-cli`
    entity registered; in-process runtime via **pull-wake** (not the
    push webhook).
  - 8b: host-side `claude` stream-json spawn (`electric/claude.ts`),
    `ANTHROPIC_API_KEY` scrubbed, `session_id` captured for `--resume`.
  - 8c: standalone per-session IDE-bridge WS server
    (`electric/bridge.ts`, hand-rolled RFC 6455) — later went **dormant**
    when stdio-permission superseded `openDiff`.
  - 8d: `sessions.*` procedures + driver client; **fix**:
    `startElectricRuntime()` must `runtime.registerTypes()` on boot
    (`registry.define` is in-process only); explicit per-entity runner
    dispatch policy (no type default).
  - 9: chat surface — browser subscribes the durable stream through the
    same-origin `/_agents` reverse proxy, adapter folds native
    stream-json → AI SDK `UIMessage[]`.
  - 10: slash-command + `@`-mention popups (server-side expansion in the
    entity at execution time, raw text in the transcript); edit-and-resend;
    session-lifecycle UI (status dot, per-device new-output dot, kebab,
    show-done); rail liveness on a 4 s tick.
  - 11: **diff approval** via `--permission-prompt-tool stdio
    --permission-mode default` (the official VS Code mechanism; headless
    `claude -p` does **not** use the IDE-bridge `openDiff`). Non-edit
    tools auto-allow; edit-family → durable `pendingDiffs` row + approval
    card resolved in-process; restart-resume via
    `reconcileStalePendingDiffs` + prompt re-run.
- **Phase 4 — polish:** dark mode, error/loading scaffolding, onboarding;
  aborts; `defineShortcuts`; responsive (terminal as a center route,
  workspace inline-panel↔slideover, left rail as the Nuxt UI mobile
  drawer).
- **Post-Phase-4:** mid-turn **steering** (in-process side-channel +
  `--replay-user-messages`); **distribution** (host installer + `domo`
  CLI + compose'd infra + CI release matrix, up to **v0.3.0**);
  **multi-user auth Part A** (`nuxt-auth-utils`, first-run admin,
  admin-approval, identity-only cookie, one Nitro middleware — shipped);
  **approval modes** (`manual`/`auto`/`passthrough`); **restart-resume**
  (app-only `domo restart` + vendored agents-server boot-relink patch).
- Part B (group-chat collaboration) was designed, never built — the
  design survives in `initial-design.md` (still valid against the new
  engine).

## Release saga

- v0.1.0–v0.1.3 deleted: v0.1.2/v0.1.3 release runs hung forever because
  `release.yml`'s `darwin-x64` leg targeted `macos-13`, **retired
  2025-12-04** — a job on a dead runner label sits `queued` indefinitely
  rather than failing, and `release` was `needs: build`. Fix: →
  `macos-15-intel` (GitHub's last x86_64 macOS image, until **2027-08**;
  after that drop `darwin-x64` or cross-build). Bumped 5 Node-20
  actions. A tag-triggered run uses the workflow from the tagged commit,
  so the fix needed a fresh tag (v0.1.4 — first green matrix).
- v0.1.4 → v0.2.x → **v0.3.0** (Robo theme + branding, signup
  inline-validation, layout fixes). Tarballs per `{linux,darwin}-{x64,arm64}`,
  bundled Node, infra as host UID, all data under `$DOMO_HOME`. Only
  linux-x64 locally verified; rest CI-produced.

## Key resolved gotchas / findings (Electric/Coast era — archived)

- **agents-server keeps pull-wake subscriptions in memory and never
  rebuilds them on its own boot** — the corruption root cause. Mitigated
  by app-only `domo restart` (don't recreate agents-server on
  app update) + a vendored `release/agents-server-0.4.2-boot-relink.patch`
  (re-link persisted entities' dispatch subs on boot), applied by
  `scripts/apply-patches.sh` + the release Dockerfile (pnpm 11 won't
  apply `patchedDependencies`; the release image installs with npm). A
  host-side claim/boot sweep cannot work (claim 404s when the
  subscription is gone). The new engine deletes this entire class.
- **Never import the full `@electric-ax/agents-runtime` entry
  client-side** — drags `model-runner` → `node:os/path/fs`, breaks
  `pnpm build`. Browser used only the `/client` entry; stream path
  resolved server-side via `sessions.streamInfo`.
- **`--permission-prompt-tool stdio`** is the headless edit-approval
  mechanism (hidden flag, built-in `stdio` value, not an MCP). CLI emits
  `control_request{can_use_tool}` on stdout; host answers
  `control_response` on stdin; stdin stays open until `result`; on allow
  the **CLI writes the file** (Domo never writes in the live path).
  IDE-bridge `openDiff` is never called in `-p` mode → `bridge.ts` went
  dormant. Wire shapes mirrored `../claude-code/src/cli/structuredIO.ts`.
- **Subscription billing confirmed** via `apiKeySource:"none"` in the
  `system` init event when `ANTHROPIC_API_KEY` is scrubbed. (Still
  governs — see `initial-design.md`.)
- **Mid-turn steering: the CLI `--replay-user-messages` echo is a
  *consumption* ack, not a receipt ack** — a stdin user message mid-turn
  is queued and consumed at the next step/tool boundary; latency =
  in-flight tool's remaining time.
- **`creationArgsSchema` bumps break entities persisted in agents-server
  Postgres before the bump** — a reason dev streams weren't durable
  across schema changes (moot without agents-server).
- **`@durable-streams/*` were pkg.pr.new URL deps pinned to build 350**,
  hoisted to top-level deps + `pnpm.overrides` so pnpm 11's
  `block-exotic-subdeps` guard stayed on. Removed with the Electric
  stack.
- **agents-server requires Postgres** (`DATABASE_URL`, throws without
  it) — hence the compose stack. Durable streams ran embedded.
- **`event.payload` had to be `z.looseObject({})`** — `z.record` emits
  JSON-Schema `propertyNames`, which agents-server's validator rejected.
- **No implicit "route to any local runner"** in agents-server — every
  session spawned with an explicit per-entity runner dispatch policy; no
  type-level default (kept the type servable by other runtimes).
- Phase 0 nested-`claude` IDE-bridge connection didn't fire; validated
  later from a standalone Nuxt process.
- **Nuxt UI v4 needs an app CSS entry** (`@import "tailwindcss"; @import
  "@nuxt/ui";` in `main.css`, listed in `nuxt.config.css`) or the whole
  app is unstyled — and the a11y tree looks identical with/without CSS,
  so every "verified live" through Phase 4-firsthalf missed it. *Lesson
  (still applies): UI work must be confirmed with a real rendered check
  (screenshot / `getComputedStyle` is `oklch`), not just the a11y
  snapshot.* (Promoted to a live gotcha in CLAUDE.md.)
- **`UChatMessages` scrolls the nearest `overflow-y:auto` ancestor**,
  not itself — the transcript wrapper must be `overflow-y-auto`; a short
  "PONG" smoke never exercised it. *Lesson (still applies): scroll
  behaviour must be smoke-tested with a transcript taller than the
  viewport at a mobile breakpoint.*
- **`nuxt-auth-utils` auto-writes a dev `.env` secret**, which masks the
  production session-secret path even in *local* `pnpm build`. v0.2.0
  shipped a plugin that crashed on Nitro's read-only prod
  `runtimeConfig`; fix sets `process.env.NUXT_SESSION_PASSWORD` instead.
  Verify changes to that plugin with `.env` moved aside. (Still relevant
  while auth code is unchanged — condensed in CLAUDE.md.)
- **The auth middleware must not gate the broad `/api/` prefix**
  (framework `/api/_auth/`, `/api/_nuxt_icon/` live there). (Still
  governs — in CLAUDE.md.)
- **Logout must null `me` (unmount the shell) before `clear()`** or a
  still-mounted shell child refetches a now-gated procedure and the 401
  is an uncatchable console error. (Still governs — in CLAUDE.md.)
- Misc resolved: `UTabs` v-model keys off `value` not `id`;
  `UDashboardSidebar` collapse floors at 64px (true-hide via `:ui`
  while collapsed); a static `<img src="/public-asset">` build-resolves
  (asset must be committed); `defineShortcuts` needs `usingInput:true`
  for ⌘S/⌘↵; `DomoDiffView` split≥md / inline below; `DomoDirectoryPicker`
  must drive `fs.browse` imperatively (`useCall` is keyed on serialized
  input, `refresh()` re-sends the original args); procedure inputs
  reject empty strings (guard `useCall` ids).

## Decisions that were superseded

- ~~Electric Agents owns the durable session stream~~ → own SQLite
  `session_events` engine.
- ~~agents-server requires Postgres / runs via docker-compose~~ → no
  Postgres, no agents-server.
- ~~Pull-wake vs push webhook~~ → no wake model at all (in-process
  manager).
- ~~IDE bridge is the approval channel (`openDiff`, 8 bridge tools,
  standalone RFC 6455 server)~~ → `--permission-prompt-tool stdio`
  (kept); the bridge is dead, not dormant.
- ~~Explicit per-entity runner dispatch policy / `registerTypes()` on
  boot~~ → no entities, no dispatch.
- ~~Restart-resume = app-only restart + vendored boot-relink patch~~ →
  the engine has no external stateful service to relink; restart
  semantics are a single SQLite reconcile pass.
- ~~Coast owns env isolation / coastd HTTP contract / ts-rs bindings /
  `coast checkout` canonical ports~~ → devcontainers + rootless DinD +
  `Domofile` + in-process userland port forwarding.
- ~~Distribution ships a Postgres + agents-server compose stack~~ → the
  app is a host install with no engine infra; DinD is per-env, managed
  by the app.

## Reference projects no longer central

`../electric-source/` (Electric Agents source — was the `claude-code-cli`
entity reference), `../claudecode.nvim/` (IDE-bridge protocol — bridge is
dead), `../coasts/` (coastd contract). `../claude-code/` stays useful for
CLI protocol interop (`structuredIO.ts` = the stdio-permission wire).
`../nuxt-chat-template/`, `../claude-code-chat*/` stay for chat-UI
patterns.
