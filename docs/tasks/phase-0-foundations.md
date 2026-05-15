# Phase 0 — Foundations

Smoke-test the load-bearing assumptions before any UI code, then stand up the Nuxt skeleton and the Coast adapter. Nothing in later phases works without these.

## 0. Smoke tests (before any code)

- [x] Verify `claude -p --output-format stream-json --input-format stream-json` composes with `ENABLE_IDE_INTEGRATION=true` + `CLAUDE_CODE_SSE_PORT` — **partial**: stream-json on stdout works cleanly (see `smoke/ide-bridge.mjs`); bridge connection from a nested `claude` session did NOT fire. Defer end-to-end bridge validation to Phase 3 from a standalone Nuxt process. Fallback path documented: MCP `--permission-prompt-tool` (see [Fallback section](../initial-design.md#fallback---permission-prompt-tool-via-custom-mcp))
- [ ] Verify `--permission-mode acceptEdits` lets Edit/Write reach the bridge's `openDiff` (not silently auto-applied) — depends on bridge connecting; blocked on Phase 3 validation
- [x] Confirm subscription billing routes through OAuth — **verified**: with `ANTHROPIC_API_KEY` scrubbed, `system` init event reports `apiKeySource: "none"`, meaning the CLI is using OAuth via `~/.claude` keychain
- [x] ~~Confirm `coast ls`, `coast ports`, `coast ps`, `coast lookup` machine-readable output shapes — informs the Coast adapter API~~ — **settled**: coastd publishes a full HTTP+SSE+WS API at `localhost:31415/api/v1/` (same surface Coastguard uses). Talk to that directly instead of shelling out to the CLI. See updated [Stack & dependencies](../initial-design.md#stack--dependencies).
- [x] ~~Confirm coastd event subscription~~ — **settled**: coastd exposes `WS /api/v1/events` broadcasting a typed `CoastEvent` enum (`instance.*`, `build.*`, `service.*`, `port.*`, `docker.status_changed`, …). No polling needed for state; SSE under `/api/v1/stream/*` for long ops.

## 1. Skeleton

- [x] New Nuxt app, Nuxt UI 4.x, Tailwind 4, three-panel shell (left / center / right + bottom). UDashboard primitives (`UDashboardGroup`/`UDashboardSidebar`/`UDashboardPanel`/`UDashboardNavbar`/`UDashboardToolbar`) — handles resize, mobile drawer, persisted sizes.
- [x] Routing — `pages/index.vue`, `pages/p/[project]/index.vue`, `pages/p/[project]/e/[env]/index.vue` (more under Phase 1+)
- [x] SQLite metadata DB via `better-sqlite3` with `projects`, `envs`, `sessions`, `settings` tables + `schema_version` row (see `server/lib/db.ts`)
- [x] Default data dir at `~/.domo/`, override via `DOMO_HOME`; XDG-aware fallback (see `server/lib/paths.ts`)
- [x] ESLint + TS + Vue-tsc baseline — `pnpm typecheck` (vue-tsc --build) and `pnpm lint` (ESLint flat config) both green

## 2. Coast adapter (server-side)

- [x] `lib/coast.ts` — typed HTTP/SSE/WS client for coastd at `localhost:31415/api/v1/`. See `server/lib/coast/{client,types,index}.ts`.
  - REST: `ls`, `lookup`, `ports`, `ps`, `stop`, `start`, `rm`, `checkout`
  - SSE: `build`, `run`, `assign` via `consumeSse()` helper (matches Coastguard's `progress`/`complete`/`error` contract)
  - WS: `subscribeEvents()` → typed `CoastEvent` discriminated union
- [ ] Vendor or regenerate Coast's `ts-rs`-exported TypeScript bindings against a pinned Coast tag — for now we model the slice we use with Zod schemas; swap to vendored bindings later (no API change)
- [x] Surface coastd errors with enough context to render in the UI — `CoastError` class carries HTTP status + JSON `{ error }` body
- [ ] Minimum supported Coast version check at server startup
- [x] Smoke-test the adapter against the live coastd — `/api/_coast-smoke` confirms `/ls` round-trips and validates against the Zod schema
