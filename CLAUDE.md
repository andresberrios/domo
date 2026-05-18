# CLAUDE.md — orientation for future Claude Code sessions

> **Living document.** Update this in the same change as the code/docs whenever
> something here goes stale — new commands, new conventions, new gotchas,
> phase transitions. The rule from `docs/initial-design.md` applies: keep
> design ↔ tasks ↔ this file in sync.

## What this repo is

Domo — a self-hosted Nuxt app that runs parallel Claude Code agents over
Coast environments. Three documents define it:

- `docs/project-context.md` — what Domo is and isn't (high level)
- `docs/initial-design.md` — full design (~700 lines, authoritative)
- `docs/tasks.md` + `docs/tasks/phase-*.md` — work tracker, organized by phase

**Read those first.** This file is just a pointer set.

**Licensing.** Domo is source-available under **FSL-1.1-ALv2** (`LICENSE.md`)
— use/modify/self-host freely, no Competing Use; each release auto-converts
to Apache-2.0 after 2 years. Contributions require a **DCO sign-off**
(`git commit -s`) + the inbound/relicensing grant in `CONTRIBUTING.md`. When
landing contributed work, keep commits signed off.

## Where we are

Phase 0 + 1 + 2 + 3 done. **Phase 4 (polish) complete — both halves**
(`docs/tasks/phase-4-polish.md`); production `pnpm build` fixed
(cross-cutting #11). Phase 3 narrative below is kept as history.
Step **8a landed & verified end-to-end** (typecheck clean; `docker compose
up` → agents-server healthy; `electricSmoke` → runner `liveness: online`):
Electric Agents control plane wired (docker-compose Postgres + agents-server,
durable streams embedded), `claude-code-cli` entity registered with locked
row schemas, in-process runtime connected via **pull-wake** (not the push
webhook — see `initial-design.md` Decided #11–14). Step **8b landed**:
real host-side `claude` stream-json spawn in
`server/lib/electric/claude.ts` (ANTHROPIC_API_KEY + nested-claude vars
scrubbed, `session_id` captured for `--resume`), wired into the entity.
Step **8c landed**: standalone per-session IDE-bridge WS server
(`server/lib/electric/bridge.ts`, hand-rolled RFC 6455 — design Decided
#15), 8 tools + `getDiagnostics`, `~/.claude/ide/<port>.lock` lifecycle,
booted per turn with `CLAUDE_CODE_SSE_PORT`/`ENABLE_IDE_INTEGRATION` set;
`openDiff` uses an interim resolver (persist + log) — the durable
park/inbox approval round-trip is **step 11**. Step **8d landed &
verified live end-to-end**: `sessions.*` procedures
(`create`/`list`/`get`/`prompt`/`diffDecision`/`abort`/`rename`/`done`/
`delete`) over `server/lib/sessions.ts` (DB) + `server/lib/electric/
client.ts` (the *driver* side — `createRuntimeServerClient`
spawn/send/delete). **Key fix:** `startElectricRuntime()` now calls
`runtime.registerTypes()` on boot (was missing — `registry.define` is
in-process only; without the control-plane POST `spawnEntity` 404s, so
8a's "entity registered" was local-only). Sessions spawn with an
**explicit per-entity runner dispatch policy** (design Decided #16). The
bundled live check (carried since 8b/8c) **passed** against live
agents-server (isolated `DOMO_HOME`, throwaway worktree, no Coast
container needed): `sessions.create` → entity on agents-server carries
`dispatch_policy {runner: domo-runtime}`; `sessions.prompt` → wake →
pull-wake runner → handler → host `claude` → `system`/`assistant`/
`result` mirrored into the durable stream; `apiKeySource: none`
(subscription billing), `session_id` captured into
`sessionMeta.nativeSessionId`, IDE bridge booted (`bridgePort`),
`assistant: "PONG"`; `delete` → entity `stopped` on agents-server + DB
row gone. Step **9 core landed & verified live end-to-end**: the chat
surface is online — browser subscribes to the entity's durable stream
through the same-origin `/_agents` reverse proxy, projects it to AI SDK
`UIMessage[]` (**Decided #17**: UI transcript standardized on
`UIMessage`; each backend is an adapter; `ai` is a types-only devDep)
and renders with `UChatMessages` + per-tool cards. Step-9 smoke (isolated
`DOMO_HOME`, throwaway worktree, no Coast container): created a session
from the left rail, sent a prompt, browser rendered *user prompt →
`Read` tool card → assistant "PONG"*, 0 console errors. **Step 9
remainder + Step 10 landed & verified live end-to-end** (isolated
`DOMO_HOME`, throwaway worktree, no Coast container; 0 console errors):
left-rail **New session auto-navigate** fixed (`navigateTo`, navigate
before refresh — a `useRouter()` captured after an async-setup `await`
no-ops); **slash-command popup** (16 builtins ∪ custom commands scanned
host-side from `<worktree>/.claude/commands/*.md` + user
`<claudeConfigDir>/commands/*.md`, project precedence,
`# heading`→description) and **`@`-mention popup** (worktree file/folder
index via `git ls-files`, `@git-changes`, recent commits) with shared
keyboard-nav `DomoChatAutocomplete` (Arrow/Tab/Enter/Esc intercepted at
keydown-**capture** so they never reach `UChatPrompt`'s own
Enter→submit/Esc→blur); **server-side expansion at execution time** —
`expandInWorktree` (custom-command `$ARGUMENTS` substitution + `@`-token
→ file/dir/diff/commit content) runs in the *entity*, not
`sessions.prompt`, so the durable inbox/transcript keeps the **raw**
text the user typed (smoke: typed `/greet Bob`, transcript showed
`/greet Bob`, assistant greeted "Bob"); **tool-card** long-output
show-more + copy; **edit-and-resend** (pragmatic — pulls a past user
message back into the prompt; same session, claude `--resume` keeps
context — true durable-stream *fork* deferred, see `initial-design.md`
"Reconciling Claude's session file with the durable stream"). **Step 10
session-lifecycle UI:** the in-process entity mirrors live status +
`lastEventAt` into the Domo `sessions` row (`creationArgsSchema` /
`sessionMetaRowSchema` now carry `sessionId`), so the rail status dot is
live; per-device new-output dot (`useDeviceId` + `sessions.markViewed`,
suppressed for the open session); per-row kebab (rename inline / mark
done / delete); show-done toggle (pre-existing). Rail liveness is a
single 4 s tick in `DomoLeftRailTree` (paused when the tab is hidden) —
sessions have no coast-style browser event channel. Step **11 — diff
approval: landed & verified live end-to-end** (accept, reject, **and
server-restart resume**; 0 console errors). The trigger is the
**official VS Code extension mechanism**: `claude` is spawned with
`--permission-prompt-tool stdio --permission-mode default`; each tool
the CLI wants emits a `control_request{can_use_tool}` NDJSON line on
stdout and we answer a `control_response` on stdin (stdin stays open
until `result`). The earlier finding stands — headless `-p` does NOT
use the IDE-bridge `openDiff` — so **`server/lib/electric/bridge.ts` is
now dormant** (not booted per turn; kept for future editor-context
tools). `claude.ts` carries the protocol + `onPermissionRequest`/
`onPermissionCancel`; `entity.ts` `executeClaudeTurn.onPermissionRequest`
is the policy — **non-edit tools auto-allow** (Bash/Read frictionless,
like the old `acceptEdits`), **edit-family** tools become a durable
`pendingDiffs` row + `DomoDiffApprovalCard`. On *allow* the **CLI itself
writes the file** (Domo never writes in the live path). Decision is
resolved **in-process** (`sessionControl` — the single-flight runner
would deadlock on a `diff_decision` wake behind the parked turn).
**Restart-resume:** the `pendingDiffs` row is durable so the card
replays after a server restart; `reconcileStalePendingDiffs` (top of
every handler invocation; safe by the single-flight invariant)
auto-rejects orphaned `pending` rows from a dead turn, and the
interrupted prompt re-runs and re-proposes a fresh, actionable card —
verified by killing the server mid-park, restarting, and accepting the
re-proposed card → file written, turn continued. `DomoDiffApprovalCard`
(sticky in `DomoChat`, sourced from the durable collection) +
`?diff=pending` workspace view + abort/turn-end cleanup
(`runClaudeTurn` takes an `AbortSignal`). The approval card reuses the
workspace surface's `DomoDiffView` (`@codemirror/merge`). **Phase 3
complete.**

**Phase 4 (polish) — COMPLETE** (`docs/tasks/phase-4-polish.md`).
*First half:* dark-mode toggle, global error/loading scaffolding
(`app/error.vue`, `<NuxtErrorBoundary>` + `<NuxtLoadingIndicator>`,
`DomoEmptyState`, `USkeleton`, `UAlert`), first-run onboarding.
*Second half:* **aborts** (build Cancel pre-existed; `DomoAddEnvModal`
gained a real Cancel = abort stream + `envs.delete`, vs "Run in
background"; short coastd RPCs intentionally have none); **keyboard
shortcuts** via `defineShortcuts` (⌘B workspace, ⌘1/⌘2 tabs, ⌘I focus
prompt, ⌘S save, ⌘↵ commit); **responsive** — terminal moved off a
"bottom panel" to a center route, workspace panel does an inline-panel
↔ slideover swap via `useBreakpoints`, left rail is the Nuxt UI
built-in mobile drawer. Verified live desktop + mobile.

**Mid-turn steering — shipped & verified live e2e** (design Decided #18,
post-Phase-4). Sending while a turn runs injects the message into the
live `claude` (queued, consumed at the next step boundary — the agent
redirects, the turn continues; *not* an interrupt, *not*
end-of-turn-only). `--replay-user-messages` echoes it on stdout as a
consumption ack; `sessions.prompt` routes a send to `steerSession()`
(in-process side-channel in `sessionControl`, same lane as
diff-decisions) when a turn is live; the live handler appends a durable
`steer_sent` event and the adapter matches the CLI `isReplay` echo by
`uuid` to flip the bubble queued→delivered. Best-effort (event-stream
durable, not a durable inbox queue); steered text is not `@`/slash
expanded in v1. Spike kept at `smoke/steering-spike.mjs`.

**Distribution shipped (post-Phase-4, Decided #19).** A real host
installer (`scripts/install.sh`, curl|sh) + `domo` CLI (`bin/domo`) +
compose'd infra (`release/`) + CI release matrix
(`.github/workflows/release.yml`) are **built and released** — current
**v0.1.4** (the only published release; v0.1.0–v0.1.3 tags/releases were
deleted — v0.1.4 is the first release whose CI is actually green):
multi-platform tarballs (`{linux,darwin}-{x64,arm64}`, WSL=linux),
**bundled Node** (no system Node req), infra runs as the host UID, all
data under `$DOMO_HOME` (one dir to back up / wipe). All four v0.1.4
tarballs built CI-green (incl. `darwin-x64` on **`macos-15-intel`** —
`macos-13`, the old Intel runner, was retired 2025-12-04; see the
"retired GitHub runner" gotcha). The whole installer→`domo up`→runtime
path is verified e2e on linux-x64 (`electricSmoke` all-true on the
freshly-built agents-server image); darwin/linux-arm64 are CI-produced,
not locally verified. Details: the
"Distribution" block under *Running it* + `docs/site/getting-started.md`
+ `initial-design.md` Decided #19.

**Multi-user auth — Part A shipped & verified e2e (Decided #20).**
Email+password (`nuxt-auth-utils`, sealed cookie, scrypt) — **no email is
ever sent**. First app open → `/setup` creates the **admin**
(`role=admin, status=active`, logged straight in); later signups →
`/register` create `role=member, status=pending` and park on `/pending`
until the admin approves them at `/admin/users`. The sealed cookie holds
**identity only** — `role`/`status` are re-read from the `users` table
in every server guard, so an approve/reject lands on the user's next
request with no re-login. **The real boundary is `server/middleware/
auth.ts`** (gates `/procedures/**`, Domo's SSE/WS endpoints, and the
`/_agents/**` durable-stream proxy; allow-lists only
bootstrap/setup/register/login/me); the SPA route guard is cosmetic.
Verified e2e (isolated `DOMO_HOME`): first-run→admin→app, reload
persistence, logout, register→pending (gated 403), admin approve→member
gains access, member blocked from admin procs (403), unauth API→401,
0 console errors, CSS rendered (oklch). **Part B (group-chat
collaboration: a chat message does NOT trigger the agent; only an
`@agent` mention or a "Send to agent" button does) is designed but NOT
built** — see `initial-design.md` Decided #21 +
`docs/tasks/phase-5-collab.md`.

## Running it

```bash
pnpm install        # pnpm 11; native builds in pnpm-workspace.yaml; @durable-streams/*
                    # pinned to pkg.pr.new build 350 in package.json (deps + pnpm.overrides)
docker compose up -d  # Postgres + agents-server (Phase 3 session runtime; not needed for P0–2)
pnpm dev            # http://localhost:7575
pnpm typecheck      # vue-tsc
pnpm lint           # eslint
pnpm build          # production build (works since cross-cutting #11 fix)
bash scripts/build-release.sh [ver]   # → dist/ tarball + install.sh + SHA256SUMS
```

**Distribution (Decided #19; built, current release v0.1.4).**
Domo ships as a host-installed app + compose'd infra, NOT
docker-compose-only (the app is a host-side orchestrator). Pieces:
`scripts/install.sh` (curl|sh, OS/arch-detecting, checksum-verified,
`DOMO_LOCAL_TARBALL` for offline/test), `bin/domo` (CLI:
`up`/`down`/`status`/`logs`/`update`/`version`),
`release/docker-compose.yml` + `release/Dockerfile.agents-server`
(Postgres + an agents-server image **built at first `domo up`** from
pinned versions — no registry; the dev root `docker-compose.yml` still
bind-mounts the repo and is dev-only), `scripts/build-release.sh`,
`.github/workflows/release.yml` (tag `v*` → **matrix** build + attach).
Tarballs are per `os-arch` (`{linux,darwin}-{x64,arm64}`; native
`better-sqlite3` bundled into `.output`; **WSL = linux**); only
`linux-x64` is locally buildable/verifiable here, the rest are
CI-produced. **Postgres is not host-published** (agents-server reaches
it over the compose net; the app never touches PG — Decided #14 — so no
host-port clash). **All data under `$DOMO_HOME`**: `state.db`,
`app/<ver>`+`current`, `run/`, and Postgres + streams as bind mounts
under `$DOMO_HOME/data` (compose `${DOMO_DATA_DIR:?}`, set by the CLI;
no Docker named volumes — one dir to back up / wipe). **Infra
containers run as the host UID** (compose `user:${DOMO_UID}:${DOMO_GID}`
+ `chmod 0777 /app` in the agents image so non-root can `mkdir
/app/logs`) so that bind-mounted data stays host-owned. **Node is
bundled** (`runtime/bin/node`, pinned v22 LTS, checksum-verified at
build; `bin/domo` runs the app with it) → tarball ≈50 MB; remaining
host reqs are Docker Compose + Coast + git + the `claude` CLI (git/
claude can't be bundled — Decided #11). Canonical port **7575**;
`bin/domo` binds it to **`127.0.0.1` by default** (no auth + full host
control = localhost-only; `DOMO_BIND=0.0.0.0` to widen, opt-in only) —
sets `HOST`/`NITRO_HOST` on the lone nohup launch (Nitro's default is
all-interfaces, so this must be explicit). agents-server `127.0.0.1`-only
in `release/docker-compose.yml`; Postgres not host-published. Operator
guidance: `docs/site/securing-your-install.md`. Keep the pins in
`release/Dockerfile.agents-server` in sync with `package.json`. The whole installer→`domo up`→runtime path is verified
e2e on linux-x64 (electricSmoke all-true on the freshly-built image);
darwin/arm are CI-only.

## Browser testing

The **Playwright MCP** is available — use `mcp__playwright__browser_*`
tools to drive http://localhost:7575 in a real browser (snapshot the
DOM, click, type, evaluate JS, watch console / network). Prefer this
over curl when validating UI flows: the project-add wizard, env
lifecycle buttons, build/run SSE streams, and `apiClient.*` calls
all execute client-side, so an SPA mode app needs a browser context
to exercise end-to-end. Start `pnpm dev` first, then navigate the
browser at `http://localhost:7575/`.

Smoke procedures (kept for the lifetime of the project — useful when wiring
a new env):

- `health` — SQLite + `DOMO_HOME` resolution
- `coastSmoke` — coastd reachability + Zod-validated `/ls`
- `electricSmoke` — agents-server reachability + pull-wake runner state
  (also lazily (re)starts the runtime, so call it after `docker compose up -d`)

Call from the browser console: `await apiClient.health.call()`.

Workspace + git are host-side, so you can exercise the file tree / editor
/ git pane **without provisioning a Coast container**: seed a `projects`
row + an `envs` row whose `worktree_path` points at any on-disk git repo
(set `status='running'`), then visit `/p/<proj>/e/<env>`. Only the
terminal needs a live container (it degrades gracefully otherwise).
Clean up seeded rows afterward — they pollute the real `~/.domo/state.db`.

`DOMO_HOME` env var overrides the data dir (default `~/.domo`, XDG-aware
fallback to `$XDG_DATA_HOME/domo` when set).
`DOMO_PROJECTS_ROOT` controls the directory picker's initial path (default `$HOME`).

## Layout + conventions

- **Nuxt 4 app at the repo root.** `app/` holds Vue code, `server/` holds Nitro
  routes + libs, `docs/` and `smoke/` are siblings.
- **SPA rendering.** `nuxt.config.ts` sets `routeRules: { '/**': { ssr: false } }`
  so HTML is rendered client-side; Nitro still serves procedures + SSE/WS.
  (We don't use top-level `ssr: false` because Nuxt 4.4's vite-builder
  errors with "No entry found in rollupOptions.input" in that mode.) This
  means `useRequestURL` is unnecessary — components can use `location`
  directly.
- **Components** live under `app/components/Domo/` with a `Domo` prefix
  (auto-import yields `<DomoLeftRail />` etc.). Use **UDashboard primitives**
  (`UDashboardGroup`, `UDashboardSidebar`, `UDashboardPanel`, `UDashboardNavbar`,
  `UDashboardToolbar`) for shell pieces — they handle resize/persist/mobile.
- **Backend API uses `nuxt-procedures`.** Every request/response endpoint
  is a file under `server/procedures/` exporting `defineProcedure({ input, output, handler })`.
  Files map to the auto-imported `apiClient` (e.g. `server/procedures/projects/add.ts`
  → `apiClient.projects.add.call(...)` / `.useCall(...)`). Both input AND output
  are Zod-validated; superjson handles serialization (Date, Map, etc. just work).
  Use **discriminated-union outputs** for multi-step flows (see `projects.add`).
  A `defineProcedure` `handler` receives `{ input, event }` — the H3
  `event` is how procedures call `requireUserSession`/`requireAdmin`
  (auth procedures + admin procedures use it; most procedures don't need
  it because `server/middleware/auth.ts` already gated the request).
- **Auth = `nuxt-auth-utils` + a central Nitro middleware (Decided #20).**
  `server/plugins/00.session-secret.ts` fills the sealed-cookie secret
  from an auto-generated, persisted `$DOMO_HOME/session-secret` (so the
  operator sets nothing; `NUXT_SESSION_PASSWORD` overrides). Procedures
  live under `server/procedures/auth/**` (`bootstrap`/`setup`/`register`/
  `login`/`me` + `auth/admin/{listUsers,approveUser,deleteUser}`).
  `server/middleware/auth.ts` is the enforcement point — it gates
  `/procedures/**`, Domo's own `/api/*` SSE/WS endpoints, and `/_agents/
  **`, allow-listing only the five auth procedures (it must NOT gate the
  broad `/api/` prefix — see Gotchas). SPA side: `useAuth()` composable
  (wraps `useUserSession` + DB-fresh `me`), `app/middleware/
  auth.global.ts` (redirects to `/setup`|`/login`|`/pending`), the bare
  auth pages, and **`DomoAppShell`** (the dashboard chrome, extracted
  from `app.vue`) which mounts ONLY for a signed-in active user so its
  data procedures never fire pre-auth. Session augmentation:
  `shared/types/auth.d.ts` (`#auth-utils` `User` = `{id,email,name}`).
- **Streaming endpoints stay classic.** `nuxt-procedures` is request/response
  only. SSE proxies (`/api/projects/build`, `/api/envs/run`) and WS pass-throughs
  (`/api/coast-events`) live under `server/api/` as `defineEventHandler` /
  `defineWebSocketHandler`. The procedure layer kicks off / orchestrates them.
- **Server libs** under `server/lib/`:
  - `paths.ts` — `domoHome()`, `domoDbPath()`
  - `db.ts` — `db()` singleton, schema migration
  - `coast/{client,types,index}.ts` — typed coastd client
  - `projects.ts` — git/Coastfile detection + DB CRUD
  - `envs.ts` — env DB CRUD + `coast ls` reconciliation
  - `schemas.ts` — shared Zod schemas (Project, Env, Session, FsEntry,
    PublicUser/UserRole/UserStatus)
  - `users.ts` — `users` table CRUD (`countUsers`, `getUserByEmail`,
    `createUser`, `setUserStatus`, …) + `toPublic` (strips the hash)
  - `auth.ts` — server guards `requireUser`/`requireActiveUser`/
    `requireAdmin` (each re-reads the live `users` row — the cookie is
    identity-only, so approve/reject takes effect with no re-login)
  - `sessions.ts` — `sessions` table CRUD (Domo-side session pointer:
    title override, `done`, `viewed_at_per_device`, cached status) +
    `markSessionViewed` (per-device read-modify-write for the new-output dot)
  - `claudeCommands.ts` — builtin ∪ custom slash-command discovery
    (`<worktree>/.claude/commands/*.md` + user `<claudeConfigDir>/
    commands/*.md`, project precedence) + `expandSlashCommand`
    (`$ARGUMENTS` substitution); `mentions.ts` — `@`-mention index
    (`searchMentions`) + `expandMentions` (file/dir/`@git-changes`/
    `@<sha>`/`@url` → inline content); `promptExpand.ts` —
    `expandInWorktree` orchestrates both. **Expansion runs in the
    *entity* at execution time** (`executeClaudeTurn`), not in
    `sessions.prompt`, so the durable inbox / transcript keeps the raw
    text the user typed.
  - `workspace.ts` — `resolveEnvWorktree()` + `safeResolve()` (the single
    path-safety chokepoint), language-by-extension, binary/size sniff
  - `git.ts` — injection-safe `execFile git` helpers (status parse,
    show, stage/unstage/commit/push, check-ignore, plus
    `gitListPaths`/`gitRecentCommits`/`gitDiffWorking`/`gitShowCommit`
    for `@`-mention indexing/expansion)
  - `settings.ts` — `settings` table get/set (panel state, etc.)
  - `config.ts` — operator host config `<domoHome>/config.json`
    (`loadDomoConfig`, Zod, read fresh per use, defaults on missing/bad).
    Distinct from `settings.ts` (SQLite UX prefs): deploy-level, survives
    app updates. Today: `claude.env` / `claude.extraPath` merged into the
    `claude` spawn **before** `SCRUB_ENV` re-applies (scrub wins —
    Decided #9). See design Decided #19 (distribution).
  - `electric/` — Electric Agents session runtime: `config.ts` (URLs/ids),
    `schemas.ts` (locked `claude-code-cli` row/inbox Zod schemas),
    `claude.ts` (`runClaudeTurn`: host-side `claude` stream-json spawn,
    env scrub, `session_id` capture, **`--permission-prompt-tool stdio`
    control protocol** → `onPermissionRequest`/`onPermissionCancel`,
    **`--replay-user-messages` + `onReady(steer)`** for mid-turn
    steering, `AbortSignal`), `bridge.ts` (`createIdeBridge`: hand-rolled RFC 6455
    WS server + 8 tools — **dormant**, superseded by stdio permission;
    not booted per turn), `entity.ts` (`registerClaudeCodeCli` + handler
    + `executeClaudeTurn` → `expandInWorktree` then `runClaudeTurn` with
    `onPermissionRequest` (non-edit auto-allow; edit-family →
    `pendingDiffs` row + park) + `reconcileStalePendingDiffs` (rejects
    orphaned pending rows at handler entry — restart safety) + `mirrorToDb`
    — live status/`lastEventAt` into the Domo `sessions` row, the
    in-process runtime being the single writer), `runtime.ts`
    (`startElectricRuntime` singleton: registry + `createRuntimeHandler`
    + `runtime.registerTypes()` + pull-wake runner, non-fatal — the
    *worker* side), `client.ts` (the *driver* side: memoized
    `createRuntimeServerClient` + `ensureRuntimeReady` +
    `runnerDispatchPolicy` + `durableStreamUrl` + `deleteEntityBestEffort`,
    used by `sessions.*`). Booted by `server/plugins/electric.ts`.
    Dev-only `app/plugins/dev-api-client.client.ts` exposes `apiClient` on
    `window` so smoke procedures are callable from the browser console.
- **Chat surface = browser-direct durable subscription, adapter to
  `UIMessage`.** The browser subscribes to the entity stream itself (not
  a procedure) but through the same-origin `/_agents/**` transparent
  reverse proxy (`server/routes/_agents/[...].ts` → agents-server; h3
  `proxyRequest`, streaming-safe) so it works over Tailscale/Tunnel with
  no auth. `useSessionStream(sessionId)` wraps the framework-agnostic
  agents-runtime core (no Vue binding ships): resolve the stream *path*
  server-side via the `sessions.streamInfo` procedure (keyed by the Domo
  session id), then — importing **only** the browser-safe
  `@electric-ax/agents-runtime/client` entry —
  `createEntityStreamDB(appendPathToUrl(origin+'/_agents', streamPath),
  customState)` → `preload` → mirror each TanStack DB collection into a
  `shallowRef` on change (client-only, dynamic import — CodeMirror/xterm
  pattern). The full `@electric-ax/agents-runtime` entry is **never**
  imported client-side (its `createRuntimeServerClient`/`getEntityInfo`
  drag in `model-runner` → `node:os/path/fs` and break the production
  build — cross-cutting #11, now fixed this way).
  `app/utils/sessionMessages.ts` is the claude-cli **adapter**: folds the
  native stream-json `events` + inbox prompts → AI SDK `UIMessage[]`
  (Decided #17). Render path mirrors the chat template: `DomoChat`
  (`UChatMessages` + sticky `UChatPrompt`/`UChatPromptSubmit`) →
  `DomoChatMessageContent` (switch on part `type`) → `DomoChatToolCard`
  (per-tool cards, reuses `DomoDiffView`) / `DomoComark` (markdown,
  `defineComarkComponent`, on-demand shiki langs — no `@shikijs/langs`
  imports). Prompt input is `DomoChatInput` (wraps `UChatPrompt`/
  `UChatPromptSubmit` + the shared keyboard-nav `DomoChatAutocomplete`
  popup; owns `/` + `@` trigger detection off the textarea value/caret;
  nav keys intercepted at keydown-**capture** on the wrapper so they
  never reach `UChatPrompt`'s own Enter→submit / Esc→blur).
  `useDeviceId` (localStorage uuid) keys the per-device new-output dot;
  the transcript `#actions` slot hosts the edit-and-resend pencil.
  Client row mirrors of the locked entity schemas live in
  `app/utils/sessionStreamTypes.ts` (server `schemas.ts` is server-only).
- **Workspace + git are host-side.** Under Option A (host-side `claude`)
  the worktree is a host dir, so `workspace.{tree,read,write}` use
  `node:fs` directly and `git.*` shells `git -C <worktree>` on the host —
  *not* coastd `/files/*`. Every path is worktree-relative and must pass
  `safeResolve` (rejects `..`, abs-outside, symlink-out). The terminal is
  the only workspace surface that crosses into the container.
- **Terminal** = `WS /api/terminal?envId=…` (`server/api/terminal.ts`),
  a dumb pass-through to coastd `WS /api/v1/exec/interactive`. The client
  (`DomoTerminal`, xterm + `@xterm/addon-fit`) speaks coastd's frame
  protocol directly: first frame is a `{session_id}` JSON handshake
  (swallowed), resize is `\x01`+JSON, clear is `\x02clear`. **It's a
  center route** `…/e/:env/terminal` (Phase 4) — a peer of chat
  (`s/:session`) and file (`f/:path`), *not* a bottom panel: the
  `UDashboardGroup` is a non-wrapping flex row with no vertical
  stacking, so "bottom panel" never fit the primitive. `DomoCenterNavbar`
  links to it.
- **CodeMirror/xterm/Comark are client-only**; dynamic-import inside
  `onMounted` and keep grammars lazy (`app/utils/language.ts` maps a
  language id → `@codemirror/lang-*`). `DomoCodeEditor` (view/edit),
  `DomoDiffView` (`@codemirror/merge`), `DomoMarkdownView` (`<Comark>`).
- **`useSelectedEnv()`** resolves `{project,env,envId,...}` from the route
  for the workspace panels (`nuxt-procedures` `useCall` is keyed on its
  serialized input, so it does *not* refetch on reactive arg changes —
  re-`call()` inside a `watch` when you need that).
- **Procedure inputs reject empty strings** (Zod `z.string()` is
  non-empty-validated server-side → HTTP 400). Don't fire a `useCall`/
  `.call` with an id that may be `''`/undefined on a not-found URL or
  before a parent query resolves (it spams console 400s). Guard with a
  manual `ref` + `async refreshX()` that no-ops when the id is falsy and
  re-runs in a `watch` — see `p/[project]/index.vue` &
  `p/[project]/e/[env]/index.vue` `refreshEnvs`.
- **Panel state persists server-side** via `usePanelState(key, def)`
  (`settings` table), not ephemeral `useState`. **But the mobile
  workspace drawer is deliberately *ephemeral* (`ref(false)`)** — the
  persisted desktop `rightOpen:true` must not auto-open a full-screen
  slideover over the chat on every phone load. `app.vue` keeps both and
  routes the toggle/⌘B through a `workspaceOpen` computed keyed on
  `isDesktop` (`useBreakpoints`).
- **Responsive panels = component swap, not CSS hiding.** The dashboard
  group can't stack, so secondary surfaces swap component by breakpoint:
  the workspace panel is an inline resizable `UDashboardPanel` at ≥lg and
  a `USlideover` at <lg (`useBreakpoints(breakpointsTailwind)` mounts
  exactly one); the left rail uses Nuxt UI's built-in
  `UDashboardSidebar` mobile drawer (+ `UDashboardNavbar`'s auto
  `UDashboardSidebarToggle`). `@vueuse/nuxt` is a Nuxt module;
  `@vueuse/core` is a **direct** dependency (was only transitive via
  `@nuxt/ui` — don't let a lint "unused" sweep drop it).
- **Coast contract is the daemon's HTTP API**, not the CLI. Talk to coastd
  via `coast()` from `server/lib/coast`. CLI is only for `--version` / `doctor`.
- **Coast types** are currently modeled as Zod schemas in `server/lib/coast/types.ts`
  (mirrors Rust types in `../coasts/coast-core/src/protocol/`). Swap to
  vendored `ts-rs` bindings later — public API of `createCoastClient()`
  doesn't change.
- **Live state via `useCoastEvents`.** Composable opens a singleton WS to
  `/api/coast-events`; pages register handlers to invalidate their data
  on `instance.*` / `service.*` / `build.*` events. No polling.

## Reference projects in `../`

- `../coasts/` — Coast's Rust + React source.
  - **`coast-daemon/src/api/`** — every HTTP/SSE/WS route Domo can call
  - **`coast-guard/src/api/`** — working TypeScript client + SSE consumer (reference)
  - **`coast-core/src/protocol/`** — Rust request/response types (mirror these in Zod)
- `../claude-code/` — **public Claude Code source snapshot** (a research
  mirror; exposed via an npm source-map leak). Use **narrowly for protocol
  interop** (don't lift implementation code). The step-11 stdio permission
  wire shapes came from **`src/cli/structuredIO.ts`** (`createCanUseTool`,
  `control_request`/`control_response`); `src/cli/print.ts` shows
  `--permission-prompt-tool stdio` selection;
  `src/utils/permissions/PermissionPromptToolResultSchema.ts` is the
  allow/deny result schema.
- `../claudecode.nvim/` — Claude Code IDE bridge protocol (now dormant in
  Domo — see `bridge.ts`; superseded by stdio permission for approval).
  - **`PROTOCOL.md`** — canonical bridge writeup.
- `../claude-code-chat/` (andrepimenta) — the *MCP-tool* variant of
  `--permission-prompt-tool` (we use the built-in `stdio` variant instead;
  same semantics, no extra server). See `claude-code-chat-permissions-mcp/`.
- `../claude-code-chat-codeflow/` (codeflow-studio) — slash command and
  `@`-mention UI patterns. See `src/utils/slash-commands.ts` and
  `src/service/customCommandService.ts`.

## Gotchas

- **Nuxt UI v4 needs an app CSS entry — without it the WHOLE app is
  unstyled.** `app/assets/css/main.css` must contain `@import
  "tailwindcss"; @import "@nuxt/ui";` and be listed in `nuxt.config.ts`
  `css`. The `@nuxt/ui` module only injects theme color *variables*
  (`<style id="nuxt-ui-colors">` → `--ui-*`) and component runtime; it
  does **not** run Tailwind. Missing the entry = no Preflight + zero
  utility classes (`bg-*`/`flex`/`rounded`/…) → everything renders with
  native browser styles. This was missing project-wide through Phases
  0–4-firsthalf and went unnoticed because **every prior "verified live"
  used the Playwright accessibility tree only** — the a11y tree is
  identical whether or not CSS applies. **Lesson: visual/UI work MUST be
  confirmed with a real rendered check** — screenshot AND/OR
  `getComputedStyle` on a known element (e.g. a primary `UButton` bg must
  be an `oklch(...)`, not `rgb(239, 239, 239)`), not just the snapshot.
- **Never import the full `@electric-ax/agents-runtime` entry into client
  code.** It pulls `model-runner` → `node:os/path/fs`; the client bundle
  can't externalize them → Rollup `"join" is not exported by
  "__vite-browser-external"` (this broke `pnpm build` until the
  cross-cutting #11 fix). The browser must use **only** the browser-safe
  `@electric-ax/agents-runtime/client` entry (`createEntityStreamDB`,
  `appendPathToUrl` — no `node:` deps). Anything that needs the full
  entry's `createRuntimeServerClient`/`getEntityInfo` (e.g. resolving an
  entity's durable-stream path) must run **server-side** — that's why
  `useSessionStream` is keyed by the Domo session id and resolves the
  `streamPath` through the `sessions.streamInfo` procedure. `pnpm build`
  now passes; keep it green (don't reintroduce a full-entry client
  import).
- **Always pass `title` AND `description` to every `UModal`/`USlideover`
  /`UDrawer`.** Reka UI dialogs need an accessible name *and* description
  (missing description → console warning). Separately, Nuxt UI 4.7.1's
  `UDashboardSidebar` mobile slideover renders the **literal i18n path**
  `dashboardSidebar.title`/`.description` — its `DashboardSidebar.vue`
  calls `t('dashboardSidebar.*')` but the bundled `en` locale only ships
  `dashboardSidebarCollapse`/`...Toggle`, no `dashboardSidebar` key. Fix:
  pass `:menu="{ title, description }"` (forwarded to the slideover;
  `v-bind="menu"` is applied *after* the broken `:title`, so it wins).
  See `app.vue`.
- **`defineShortcuts` disables a shortcut while an INPUT/TEXTAREA/
  contenteditable is focused** unless `usingInput: true`. ⌘S (save in
  the editor) and ⌘↵ (commit from the message textarea) *must* set
  `usingInput: true` or they no-op exactly when you'd use them. It also
  `preventDefault()`s on match (so ⌘S won't open the browser save
  dialog). `meta_*` auto-maps to Ctrl off macOS — don't add a separate
  `ctrl_*`.

- **Nuxt UI v4 `UTabs` keys its `v-model` off each item's `value`**, not
  `id`. Items with only `{ id }` leave the model stuck — give them
  `{ value, label, icon }` (bit `DomoRightPanel` in Phase 2: Git tab
  silently rendered nothing until items got `value`).

- **IDE bridge connection didn't fire from a nested `claude` process** in the
  Phase 0 smoke. Resolved in the standalone Nuxt process: the 8d live smoke
  spawned host `claude` per turn and `sessionMeta.bridgePort` was populated
  for the duration (the bridge booted + the lock file was written under
  `~/.claude/ide/`). The spawn → stream-json → wake → handler → mirrored
  events path is fully validated.
- **Headless `claude -p` permission = `--permission-prompt-tool stdio`,
  NOT the IDE-bridge `openDiff` (resolved, step 11, `claude` 2.1.142).**
  `openDiff` is never called in `-p` stream-json mode (verified: under
  both `acceptEdits` and `default` a `Write`/`Edit` came back
  permission-denied, no park). The working mechanism — exactly what the
  official VS Code extension spawns — is `--permission-prompt-tool stdio
  --permission-mode default`: the CLI emits a `control_request`
  `{type:'control_request',request_id,request:{subtype:'can_use_tool',
  tool_name,input,tool_use_id}}` NDJSON line on **stdout**; the host
  replies on **stdin** with `{type:'control_response',response:{subtype:
  'success',request_id,response:{behavior:'allow',updatedInput}|{behavior:
  'deny',message}}}`. `--permission-prompt-tool` is a **hidden** flag
  (absent from `--help`) and `stdio` is its built-in value (not an MCP
  name). stdin MUST stay open for the whole turn (close on `result`).
  On allow the **CLI applies the edit itself** — never write the file
  in the live path. Wire shapes mirror the public Claude Code source
  snapshot `../claude-code/src/cli/structuredIO.ts`. `bridge.ts` is
  dormant (don't boot it / don't set `CLAUDE_CODE_SSE_PORT` —
  ENABLE_IDE_INTEGRATION competing with stdio permission caused the
  original confusion). After a server restart, **never replay-apply a
  dead turn's pending diff** — it races the re-run; `reconcile
  StalePendingDiffs` rejects orphaned rows and the interrupted prompt
  re-proposes instead.
- **Mid-turn steering: the CLI replay is a *consumption* ack, not a
  receipt ack** (Decided #18; spike `smoke/steering-spike.mjs`). A user
  message written to the live child's stdin mid-turn is *queued* and
  consumed at the next step/tool boundary (agent redirects, turn
  continues) — `--replay-user-messages` echoes it on stdout as
  `{type:'user',uuid,isReplay:true}` *only when the agent drains the
  queue*, so send→ack latency = the in-flight tool's remaining time
  (seconds), NOT immediate. So a steer needs a queued→delivered UI
  state, matched by the `uuid` we generate. Steered text is **not**
  `@`/slash expanded (keeps the raw-text invariant trivial — no inbox
  path). It's an in-process side-channel (`sessionControl.steerSession`),
  same reason as diff-decisions (single-flight runner can't deliver a
  wake mid-turn) — *not* a durable inbox message (a new inbox type would
  re-run as a turn after the snapshot → double turn; the durable record
  is a `steer_sent` *event* appended from inside the live handler).
  Best-effort across restart (a `steer_sent` with no replay shows a
  stale "queued" bubble; acceptable — contrast diff-approval, kept
  durable).
- **IDE bridge ≠ Nitro WS.** Browser↔Domo channels use
  `defineWebSocketHandler` (one app listener); the IDE bridge needs a
  *per-session ephemeral-port localhost* listener the `claude` child
  discovers via its own lock file, so it's a standalone hand-rolled
  `node:http` RFC 6455 server (design Decided #15). Don't "consolidate" it
  onto a Nitro route — the lock-file→port→`/` model can't multiplex.
- **Subscription billing confirmed** via `apiKeySource: "none"` in the
  `system` init event when `ANTHROPIC_API_KEY` is scrubbed.
- **Prompt expansion happens in the entity, not the procedure.** Custom
  slash-command + `@`-mention resolution runs in `executeClaudeTurn`
  (`expandInWorktree`), so `sessions.prompt`'s inbox payload — and thus
  the durable transcript — stays the *raw* text the user typed. Don't
  "optimize" by expanding in `sessions.prompt`: the transcript would then
  show a 60 KB file dump instead of `@file`. The CLI doesn't resolve
  either custom commands or `@`-mentions in `-p` stream-json mode, so the
  host must.
- **`creationArgsSchema` now requires `sessionId`** (== entity id; lets
  the in-process entity `mirrorToDb` live status/`lastEventAt` into the
  Domo `sessions` row for the rail). An entity persisted in agents-server
  Postgres *before* this change will fail `creationArgsSchema.parse` on
  resume — fine in dev (sessions are throwaway; restart/reset), but a
  reason not to treat dev streams as durable across schema bumps.
- **Autocomplete nav keys are intercepted at keydown-capture.**
  `UChatPrompt` binds its own Enter→submit / Esc→blur on the inner
  textarea. `DomoChatInput`'s wrapper `@keydown.capture` handles
  Arrow/Tab/Enter/Esc *and* `stopPropagation()` while the popup is open,
  so the event never reaches the textarea's bubble-phase handlers. Don't
  move this to a bubble listener — both fire on the same element and the
  submit would race the selection.
- **`@`-mentions are plain text tokens, not rich contenteditable chips.**
  The design mentions "inline chips"; we ship textarea `@token` text with
  server-side expansion (functionally equivalent, no contenteditable
  complexity). A future chip UI can layer on without changing the
  expansion contract.
- **Native modules** (`better-sqlite3`, `@parcel/watcher`, `esbuild`,
  `unrs-resolver`, `vue-demi`) require `allowBuilds:` in `pnpm-workspace.yaml` —
  pnpm 11 won't run install scripts otherwise.
- **Coast version pinning is still open** (cross-cutting decision 4). Tested
  against 0.1.53. The daemon API is at `/api/v1/`.
- **`@durable-streams/*` are pkg.pr.new URL deps, pinned to build 350.**
  `@electric-ax/agents-*` pull `@durable-streams/{client,server,state}` from
  `pkg.pr.new` URLs. pnpm 11 blocks URL *subdeps*; we hoist them to top-level
  `dependencies` + `pnpm.overrides` (build 350) so the global
  `block-exotic-subdeps` guard stays ON for everything else. Don't "fix" the
  lint by deleting these — bumping Electric means re-pinning all three URLs.
- **agents-server requires Postgres** (`DATABASE_URL`, throws without it) —
  hence `docker-compose.yml`. Durable streams run embedded (no Electric sync
  service). agents-server auto-migrates Postgres on boot.
- **Runtime boot is non-fatal & pull-wake.** `server/plugins/electric.ts`
  fire-and-forgets `startElectricRuntime()`; if agents-server is down Domo
  still serves P0–2 surfaces. Wake delivery is a long-lived **pull-wake**
  stream, *not* the `/_electric/builtin-agent-handler` push webhook (design
  Decided #13). `createRuntimeHandler.onEnter` keeps the webhook a drop-in.
- **Entity handler model.** One `handler(ctx, wake)` per wake; drain
  `ctx.db.collections.inbox` past `inboxState.lastProcessedInboxKey`. State
  via `ctx.db.collections.<c>.get/.toArray` + `ctx.db.actions.<c>_insert/_update`.
  `event.payload` schema must be `z.looseObject({})` (`z.record` emits
  JSON-Schema `propertyNames`, which agents-server's validator rejects).
- **`registry.define` ≠ control-plane registration.** It only registers
  the entity in-process. `spawnEntity('claude-code-cli', …)` 404s ("entity
  type not found") until the type is POSTed to agents-server via
  `runtime.registerTypes()` — `startElectricRuntime()` now does this on
  boot (after `createRuntimeHandler`, before runner start), mirroring
  electric-source `agents/src/server.ts → registerBuiltinAgentTypes`.
  Idempotent (upsert). A dev server started *before* this call was added
  won't have it active until restarted (the plugin's start is memoized).
- **No type-default dispatch policy — spawn with an explicit runner
  target.** agents-server resolves effective dispatch as
  per-entity ?? parent ?? entity-type-default; there is **no** implicit
  "route to any enabled local runner" fallback (verified in
  `agents-server/src/routing/dispatch-policy.ts`). We deliberately do not
  register a type default (matches electric-source builtin-agents — keeps
  the type servable by other runtimes), so `sessions.create` passes
  `dispatch_policy: { targets: [{ type:'runner', runnerId }] }` per spawn
  (design Decided #16). Recipe proven by
  `agents-server/test/horton-pull-wake-e2e.test.ts`. agents-server stores
  the `/send` body's `type` as the inbox row's `message_type` (so the
  entity's `prompt`/`diff_decision`/`abort` branch keys line up).
- **`ai` is a types-only devDependency.** `@nuxt/ui`'s
  `UChatMessages`/`UChatMessage`/`UChatPromptSubmit` `.d.ts` do
  `import type … from 'ai'`, but `ai` is only a *devDependency of
  `@nuxt/ui`* (not installed for consumers) — so using those components
  needs `ai` present for vue-tsc. We install it `-D` for **types only**
  (Decided #17). Don't `import` runtime values from `ai` in app code
  *for now* — the claude-cli adapter doesn't use the AI SDK runtime (a
  future `ai`-based backend may; not a permanent ban). Switch on the part
  `type` string instead of `ai`'s `isToolUIPart` guards.
  `import type { UIMessage, ChatStatus } from 'ai'` is fine (erased).
- **vue-tsc rejects inline `as` casts with type literals in template
  bindings.** `:x="(p as { t: string }).t"` / `:x="(p as any)"` →
  `TS1005 ',' expected`. Do the narrowing in `<script>` (a typed
  `computed`) and keep template expressions cast-free — see
  `DomoChatMessageContent`.
- **Retired GitHub runner silently wedged the release pipeline.**
  `release.yml`'s `darwin-x64` leg ran on `macos-13`, which GitHub
  **fully retired 2025-12-04**. A job on a dead runner label does not
  fail — it sits in `queued` forever, and because `release` is
  `needs: build`, *every* release (v0.1.2, v0.1.3) hung indefinitely
  with the other three tarballs built but never published. Fix:
  `darwin-x64` → **`macos-15-intel`** (the free x86_64 replacement,
  available **until 2027-08**; after that GitHub has **no** x86_64
  macOS runner and `darwin-x64` must be dropped or cross-built from an
  arm64 mac). Also bumped the five Node-20-deprecated actions
  (`checkout@v6`, `pnpm/action-setup@v6`, `setup-node@v6`,
  `upload-artifact@v7`, `download-artifact@v8`; Node 20 enforced
  2026-06-02). Lesson: a tag-triggered run uses the workflow **from the
  tagged commit**, so a workflow fix on `main` does *not* salvage an
  already-pushed tag — you must cut a fresh tag (this is why v0.1.4
  exists). Maintainer runbook: `docs/site/releasing.md`.

- **`nuxt-auth-utils` auto-writes a dev `.env` secret — that's why the
  `$DOMO_HOME/session-secret` plugin "doesn't run" in dev.** In dev with
  no `NUXT_SESSION_PASSWORD`, the module generates one and persists it to
  the project-root `.env` (gitignored — `.gitignore:25`), then maps it
  into `runtimeConfig.session.password`. `server/plugins/00.session-
  secret.ts` correctly *defers* when a secret already exists, so it
  no-ops in dev and only owns the **production** path (a built server
  does NOT auto-gen). Don't "fix" the plugin because no
  `$DOMO_HOME/session-secret` appears in dev — that's expected.
  **Corollary (bit us in v0.2.0): the dev `.env` masks the production
  path in *local* builds too.** `pnpm build` loads the project `.env`,
  so a local build bakes the dev secret into
  `runtimeConfig.session.password` and the plugin early-returns — the
  prod codepath never runs locally. The CI release build has no `.env`,
  bakes an empty password, runs the plugin for real. v0.2.0 shipped a
  plugin that did `rc.session.password = secret`, which **throws
  `TypeError: Cannot assign to read only property 'password'` at
  startup** because Nitro's production `runtimeConfig` is read-only — a
  crash no local build could reproduce. Fix: the plugin sets
  `process.env.NUXT_SESSION_PASSWORD` instead (nuxt-auth-utils resolves
  `defu({ password: process.env.NUXT_SESSION_PASSWORD },
  runtimeConfig.session)` lazily on first session use — see
  `node_modules/nuxt-auth-utils/.../session.js`). **To verify any
  change to this plugin, build with `.env` moved aside** (replicates the
  release condition) — a plain `pnpm build` + run will silently
  early-return. We do NOT write `.env` at install time: Nitro's
  production server doesn't read `.env`, and the design keeps `$DOMO_HOME
  /session-secret` as the single auto-managed store (no operator env
  var, one dir to back up / wipe).
- **The auth middleware must NOT gate the broad `/api/` prefix.**
  Framework endpoints live there too — `/api/_auth/session`
  (nuxt-auth-utils' own session fetch/clear) and `/api/_nuxt_icon/*`
  (the Nuxt Icon server bundle). Gating all of `/api/` 401s icon loads
  on the *public* auth screens. `server/middleware/auth.ts` instead
  enumerates Domo's own non-procedure endpoints (`/api/coast-events`,
  `/api/terminal`, `/api/envs/`, `/api/projects/`) + `/procedures/**` +
  `/_agents/**`. Add new Domo `/api/*` endpoints to that list explicitly.
- **Logout must null `me` (→ unmount the shell) BEFORE `clear()`.**
  `useAuth().logout()` sets `me.value = null` + `await nextTick()` first
  so `showShell` flips false and `DomoAppShell` unmounts *before* the
  awaited session `clear()`. Otherwise a still-mounted shell child
  refetches a now-gated procedure mid-logout and the (correct) 401
  surfaces as an **uncatchable** browser console error (a network 401 is
  logged by the browser even with a JS `.catch`). Same class of bug as
  the pre-auth `usePanelState` fetch — the fix there was extracting the
  shell so its composables never run on auth pages.
- **The session cookie is identity-only by design.** It carries
  `{id,email,name}`; `role`/`status` are deliberately re-read from the
  `users` table in every `server/lib/auth.ts` guard. This is what makes
  admin approve/reject take effect on the user's *next request* with no
  re-login (a sealed cookie can't be mutated server-side). Don't "cache"
  role/status in the cookie to save a query — it reintroduces a stale-
  permission window. `auth.me` is the client's fresh source; `/pending`
  polls it.

## Updating this file

Any session that lands work touching the topics here should update the
relevant section in the same change. Examples:

- Phase moves forward → bump "Where we are"
- A new convention is established → add it to "Layout + conventions"
- A gotcha is resolved or a new one surfaces → edit "Gotchas"
- Reference project added/removed → edit that section *and* `docs/initial-design.md`

If a finding contradicts something in `docs/initial-design.md`, update the
design doc first, then mention it here as a pointer.
