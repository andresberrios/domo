# Phase 5 — Multi-user & collaboration

Auth (secure the install + named users) and group-chat collaboration on
agent sessions. Design: `initial-design.md` Decided #20 (auth, built) +
#21 (collaboration, designed not built).

## Part A — Auth (email+password, first-run admin, admin approval)

**Landed & verified live e2e** (isolated `DOMO_HOME`, 0 console errors,
CSS rendered oklch). `nuxt-auth-utils`, no email ever sent.

- [x] **Dependency + auto-managed session secret** — `nuxt-auth-utils`
  module; `runtimeConfig.session` (30-day maxAge); `server/plugins/
  00.session-secret.ts` generates/persists `$DOMO_HOME/session-secret`
  (0600), `NUXT_SESSION_PASSWORD` overrides. Dev: nuxt-auth-utils' own
  `.env` auto-gen takes precedence (gitignored) — plugin owns prod only.
- [x] **`users` table + `server/lib/users.ts`** — `id,email UNIQUE,name,
  password_hash,role,status,created_at,last_login_at` in the existing
  `db.ts` migrate block; CRUD + `toPublic` (strips hash). `PublicUser`/
  `UserRole`/`UserStatus` Zod in `schemas.ts`. `shared/types/auth.d.ts`
  augments `#auth-utils` `User` = `{id,email,name}`.
- [x] **Auth procedures** — `server/procedures/auth/`: `bootstrap`
  (needsSetup), `setup` (first admin, 409 if any user), `register`
  (member+pending), `login`, `me` (DB-fresh role/status).
- [x] **Admin procedures** — `auth/admin/{listUsers,approveUser,
  deleteUser}`, `requireAdmin`-gated (can't delete self / an admin).
- [x] **Server enforcement** — `server/lib/auth.ts`
  (`requireUser`/`requireActiveUser`/`requireAdmin`, each re-reads the
  live row); `server/middleware/auth.ts` gates `/procedures/**` +
  Domo's `/api/*` SSE/WS + `/_agents/**`, allow-listing the 5 auth
  procs. Verified: unauth gated→401, pending→403, member→403 on admin.
- [x] **SPA shell + pages** — `useAuth()` composable; `app/middleware/
  auth.global.ts`; bare pages `setup`/`login`/`register`/`pending` +
  `admin/users`; `DomoAppShell` extracted from `app.vue` (mounts only
  for active users → no pre-auth procedure calls); `DomoLeftRailFooter`
  user menu (Manage users for admin + Sign out). Logout nulls `me`
  before `clear()` (shell-unmount-before-network — see CLAUDE.md gotcha).
- [x] **Verified e2e** — first-run→admin→app, reload persistence,
  logout (bare + shell, 0 errors), register→pending (403), admin
  approve→member access, member blocked from admin (403), unauth→401.

## Part B — Group-chat collaboration (DESIGNED, NOT BUILT)

Decided #21. A chat message does NOT trigger the agent; only an `@agent`
mention or a "Send to agent" button does. Durable-stream as the single
source of truth.

- [ ] **Durable `chat` inbox/event type** — extend `electric/schemas.ts`
  with `{text, author:{userId,userName}}`; `sessions.prompt` (or a new
  `sessions.chat`) injects the authenticated user's identity.
- [ ] **Entity: record-without-running + trigger detection** — handler
  appends a durable `chat` event and advances the inbox WITHOUT a turn;
  triggers `executeClaudeTurn` only on an `@agent` mention or
  `trigger:true`. Trigger detection lives in the entity (raw-text
  invariant). Fold the un-consumed chat backlog into the synthesized
  prompt; track a `lastConsumedChatKey` in sessionMeta.
- [ ] **Mid-turn `@agent`** — reuse the existing steering side-channel
  (Decided #18); plain mid-turn chat is recorded only.
- [ ] **Adapter + UI** — `sessionMessages.ts` projects `chat` events to
  authored user `UIMessage`s; `DomoChat` renders human authors distinctly
  from the agent; add a "Send to agent ▶" button + `@agent` autocomplete
  entry.
- [ ] **Access model** — v1: any active user participates in all
  sessions. Per-session membership/ACL deferred.
- [ ] **Verify e2e** — multi-user chat without agent turns; `@agent` /
  button triggers a turn that sees the backlog; restart-safe; 0 console
  errors; CSS rendered.
