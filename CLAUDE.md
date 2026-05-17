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

## Where we are

Phase 0 + 1 + 2 done. **Phase 3 in progress** (`docs/tasks/phase-3-sessions.md`).
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

**Phase 4 (polish) — first half landed** (`docs/tasks/phase-4-polish.md`):
dark-mode toggle (`UColorModeButton` in `DomoCenterNavbar`), global
error/loading scaffolding (`app/error.vue`, `<NuxtErrorBoundary>` +
`<NuxtLoadingIndicator>` in `app.vue`, reusable `DomoEmptyState`,
`USkeleton` on the env page, `UAlert` for env-action errors), and the
first-run onboarding (`app/pages/index.vue` rewrite + `DomoEmptyState`
for project/env not-found). **Next half:** aborts everywhere (env
ops/build), keyboard shortcuts, responsive mobile layout.

## Running it

```bash
pnpm install        # pnpm 11; native builds in pnpm-workspace.yaml; @durable-streams/*
                    # pinned to pkg.pr.new build 350 in package.json (deps + pnpm.overrides)
docker compose up -d  # Postgres + agents-server (Phase 3 session runtime; not needed for P0–2)
pnpm dev            # http://localhost:3000
pnpm typecheck      # vue-tsc
pnpm lint           # eslint
```

## Browser testing

The **Playwright MCP** is available — use `mcp__playwright__browser_*`
tools to drive http://localhost:3000 in a real browser (snapshot the
DOM, click, type, evaluate JS, watch console / network). Prefer this
over curl when validating UI flows: the project-add wizard, env
lifecycle buttons, build/run SSE streams, and `apiClient.*` calls
all execute client-side, so an SPA mode app needs a browser context
to exercise end-to-end. Start `pnpm dev` first, then navigate the
browser at `http://localhost:3000/`.

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
  - `schemas.ts` — shared Zod schemas (Project, Env, Session, FsEntry)
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
  - `electric/` — Electric Agents session runtime: `config.ts` (URLs/ids),
    `schemas.ts` (locked `claude-code-cli` row/inbox Zod schemas),
    `claude.ts` (`runClaudeTurn`: host-side `claude` stream-json spawn,
    env scrub, `session_id` capture, **`--permission-prompt-tool stdio`
    control protocol** → `onPermissionRequest`/`onPermissionCancel`,
    `AbortSignal`), `bridge.ts` (`createIdeBridge`: hand-rolled RFC 6455
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
  no auth. `useSessionStream(entityId)` wraps the framework-agnostic
  agents-runtime core (no Vue binding ships): `createRuntimeServerClient`
  → `getEntityInfo` → `createEntityStreamDB(url, customState)` →
  `preload` → mirror each TanStack DB collection into a `shallowRef` on
  change (client-only, dynamic import — CodeMirror/xterm pattern).
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
  (swallowed), resize is `\x01`+JSON, clear is `\x02clear`.
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
  (`settings` table), not ephemeral `useState`.
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
- **`pnpm build` (production) is currently broken** (pre-existing,
  unrelated to styling): `@electric-ax/agents-runtime`'s `model-runner`
  imports `node:os/path/fs`; the client bundle (it's dynamically imported
  by `useSessionStream`) can't externalize them → Rollup
  `"join" is not exported by "__vite-browser-external"`. The project has
  only ever run via `pnpm dev` (all docs say so). Production build is a
  cross-cutting follow-up (split the agents-runtime client surface from
  its Node `model-runner`, or alias it browser-side). Until then, verify
  via `pnpm dev` only.
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

## Updating this file

Any session that lands work touching the topics here should update the
relevant section in the same change. Examples:

- Phase moves forward → bump "Where we are"
- A new convention is established → add it to "Layout + conventions"
- A gotcha is resolved or a new one surfaces → edit "Gotchas"
- Reference project added/removed → edit that section *and* `docs/initial-design.md`

If a finding contradicts something in `docs/initial-design.md`, update the
design doc first, then mention it here as a pointer.
