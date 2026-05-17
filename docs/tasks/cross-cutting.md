# Cross-cutting work

Items that don't belong to any single phase: open decisions, pending discussions, and docs we owe alongside implementation.

## Pending decisions

- [x] **1. Where `claude` runs — host-side vs in-coast.** **Settled → host-side (Option A)**, `initial-design.md` Decided #11. In-coast revisit path retained for after first real users.
- [ ] **2. Auto-install of Domo-flavored Coast skill into each env's worktree.** If host-side: yes — decide files (`CLAUDE.md` vs `.claude/skills/coasts/SKILL.md`), merge policy, opt-out.
- [ ] **3. Coastfile-init heuristics.** Exact contents the "init Coastfile" button writes; whether to surface `coast installation-prompt` as a handoff to the user's agent.
- [ ] **4. Coast version pinning / version check.** Which versions we test against; behavior when too old.
- [x] **5. Wire-level schema for `events` and `pendingDiffs` rows.** **Settled** (Phase 3 step 8) — locked in `server/lib/electric/schemas.ts`; client mirror in `app/utils/sessionStreamTypes.ts`. See `initial-design.md` Pending-discussion 1 (resolved).
- [x] **6. Caching strategy: `coast ls` polling vs coastd events.** **Settled**: subscribe to coastd's `WS /api/v1/events` (typed `CoastEvent` enum) and use REST `/ls`+`/ports`+`/ps` for snapshots. No polling needed. Implemented in `server/lib/coast/`.
- [ ] **7. Multi-user / auth design.** Deferred from v1.
- [ ] **8. Mobile app (Capacitor wrapper).** Post-v1.
- [ ] **9. No-remote projects (clone-from-remote inside Domo).** Post-v1.
- [ ] **10. Concurrent-edit conflict surfacing within an env.** Lightweight badge in v1; soft locks later if needed.
- [x] **11. `pnpm build` (production) is broken.** **Resolved.** Root cause: `useSessionStream` dynamically imported the *full* `@electric-ax/agents-runtime` entry for `createRuntimeServerClient` → `getEntityInfo`; that entry drags in `model-runner` → `node:os/path/fs`, so the client bundle failed to externalize (`RollupError: "join" is not exported by "__vite-browser-external"`). Fix: the browser now imports **only** the browser-safe `@electric-ax/agents-runtime/client` entry (`createEntityStreamDB` + `appendPathToUrl`, no `node:` deps), and the entity's durable-stream *path* is resolved server-side via a new `sessions.streamInfo` procedure (keyed by the Domo session id) instead of a browser `getEntityInfo` call. `pnpm build` now exits 0 ("Build complete!"); verified live end-to-end (seeded throwaway project/env/session → prompt → assistant reply rendered through the refactored stream, 0 console errors). Surfaced during Phase 4 first-half visual verification; fixed in the second-half sweep.

## Pending discussions (carried from `initial-design.md`)

- [x] Wire-level shape for the `claude-code-cli` entity rows (events / pendingDiffs / inbox messages) — **settled** Phase 3 step 8 (`server/lib/electric/schemas.ts`)
- [x] Domo data-dir conventions — **settled**: default `~/.domo/`, override via `DOMO_HOME` env var, XDG-aware fallback to `$XDG_DATA_HOME/domo` when set. State DB at `<domo-home>/state.db`. See `server/lib/paths.ts`.
- [ ] Service-URL UX (where the clickable env-service URL surfaces; new tab vs proxied)

## Docs we still owe

- [ ] `docs/site/getting-started.md` (VPS five-minute path)
- [ ] `docs/site/concepts.md` (Project / Env / Session, Coast relationship)
- [ ] `docs/site/projects.md`, `envs.md`, `sessions.md`
- [ ] `docs/site/securing-your-install.md` (Tailscale, Tunnel, Caddy front-proxy; explicit "no auth in v1")
- [ ] `docs/site/billing-and-credentials.md` (subscription auth, `~/.claude` keychain, `ANTHROPIC_API_KEY` scrubbing)
- [ ] `docs/site/exposing-dev-servers.md` (dynamic vs canonical ports; Tailscale/Tunnel routing)
- [ ] `docs/site/troubleshooting.md`
- [ ] `docs/site/reference.md` (Coastfile minimum, env vars, `.worktrees` gitignore convention, Coast version)
