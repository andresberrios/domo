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

Phase 0 + 1 + 2 done. Phase 3 (`docs/tasks/phase-3-sessions.md`) is next:
Electric Agents bring-up, the `claude-code-cli` entity, chat surface,
session lifecycle, diff approval. Phase 3's agent-diff approval card
reuses the workspace surface's `DomoDiffView` (`@codemirror/merge`).

## Running it

```bash
pnpm install     # uses pnpm 11, native modules approved via pnpm-workspace.yaml
pnpm dev         # http://localhost:3000
pnpm typecheck   # vue-tsc
pnpm lint        # eslint
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
  - `schemas.ts` — shared Zod schemas (Project, Env, FsEntry)
  - `workspace.ts` — `resolveEnvWorktree()` + `safeResolve()` (the single
    path-safety chokepoint), language-by-extension, binary/size sniff
  - `git.ts` — injection-safe `execFile git` helpers (status parse,
    show, stage/unstage/commit/push, check-ignore)
  - `settings.ts` — `settings` table get/set (panel state, etc.)
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
- `../claudecode.nvim/` — Claude Code IDE bridge protocol.
  - **`PROTOCOL.md`** — canonical writeup. Read this before Phase 3.
- `../claude-code-chat/` (andrepimenta) — fallback pattern for diff approval via
  `--permission-prompt-tool` + custom MCP. See `claude-code-chat-permissions-mcp/`.
- `../claude-code-chat-codeflow/` (codeflow-studio) — slash command and
  `@`-mention UI patterns. See `src/utils/slash-commands.ts` and
  `src/service/customCommandService.ts`.

## Gotchas

- **Nuxt UI v4 `UTabs` keys its `v-model` off each item's `value`**, not
  `id`. Items with only `{ id }` leave the model stuck — give them
  `{ value, label, icon }` (bit `DomoRightPanel` in Phase 2: Git tab
  silently rendered nothing until items got `value`).

- **IDE bridge connection didn't fire from a nested `claude` process** in the
  Phase 0 smoke. Stream-json itself works fine; the bridge attaches when we
  spawn from a standalone Nuxt process. Validate end-to-end in Phase 3.
- **Subscription billing confirmed** via `apiKeySource: "none"` in the
  `system` init event when `ANTHROPIC_API_KEY` is scrubbed.
- **Native modules** (`better-sqlite3`, `@parcel/watcher`, `esbuild`,
  `unrs-resolver`, `vue-demi`) require `allowBuilds:` in `pnpm-workspace.yaml` —
  pnpm 11 won't run install scripts otherwise.
- **Coast version pinning is still open** (cross-cutting decision 4). Tested
  against 0.1.53. The daemon API is at `/api/v1/`.

## Updating this file

Any session that lands work touching the topics here should update the
relevant section in the same change. Examples:

- Phase moves forward → bump "Where we are"
- A new convention is established → add it to "Layout + conventions"
- A gotcha is resolved or a new one surfaces → edit "Gotchas"
- Reference project added/removed → edit that section *and* `docs/initial-design.md`

If a finding contradicts something in `docs/initial-design.md`, update the
design doc first, then mention it here as a pointer.
