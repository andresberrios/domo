# CLAUDE.md — orientation for future Claude Code sessions

> **Living document.** Update this in the *same* change as the code/docs
> whenever something here goes stale. Doc-sync (design ↔ tasks ↔ this
> file) is a **prime directive**, never optional.

## What this repo is

Domo — a self-hosted Nuxt app running parallel Claude Code agents over
isolated dev environments. Read these first:

- `docs/project-context.md` — what Domo is/isn't (high level)
- `docs/initial-design.md` — authoritative forward design
- `docs/tasks.md` — work tracker (new-architecture build)
- `docs/history.md` — superseded implementation + resolved gotchas

**Licensing:** source-available **FSL-1.1-ALv2** (`LICENSE.md`); auto-
converts to Apache-2.0 after 2 years. Contributions need a DCO sign-off
(`git commit -s`) + the grant in `CONTRIBUTING.md`. Keep landed commits
signed off.

## Where we are — mid-pivot, steps 1 + 2 landed

Phases 0–4 + multi-user auth Part A **shipped** on an **Electric Agents
session engine + Coast environments** stack (last release **v0.3.0**;
narrative in `history.md`). Testing showed that stack corrupts sessions
on restart — a structural flaw of a stateful agent-server intermediary,
not a fixable bug. **Decision:** replace it with an **in-process engine
over the existing SQLite** (`session_events` log + single-flight
**long-lived per-session `claude` process** + `--resume`), a **unified
change-bus + `/api/live` SSE** reactivity spine, and **devcontainer +
rootless-DinD** environments with `devcontainer.json` as the single
source of truth (no `Domofile`), `claude` running **inside** the env
container via a Domo-owned devcontainer Feature with a shared
`~/.claude` per Domo user, and **TCP-only cross-platform port
forwarding** (published random host ports + on-demand userland
forwarders + an "expose externally" toggle; no HTTP reverse-proxy, no
canonical env in v1). Engine first, then devcontainers. Full design +
build sequence in `initial-design.md`.

**Step 1 (session engine swap) landed.** `server/lib/sessionEngine/{engine,
claude,store}.ts` owns the session lifecycle: single-flight per-session
manager, **long-lived per-session `claude` process** (multi-turn over one
stdin, demux by `result`, idle-reap ~15 min → `--resume` respawn), the
host spawn moved verbatim from `electric/claude.ts` (billing argv +
`cc_entrypoint=claude-vscode` re-pin + env scrub + stdio permission +
steering + partial-stream coalescer). `session_events(session_id,seq,
type,payload,message_id,created_at)` + `pending_diffs` SQLite tables are
the durable truth — every row an INSERT (no UPDATEs), monotonic `seq`
the cursor. Boot reconcile (`plugins/sessionEngine.ts`) flips stale
`active`/`pending-approval` cached statuses to `waiting` and auto-rejects
orphan `pending` diffs with a `diff_decision { reason:'runtime restarted' }`
event so cards clear cross-device — the "no corruption mode" property
the old stack couldn't have.

**Step 2 (reactivity spine) landed.** One auth-gated SSE endpoint
(`server/api/live.ts`), one tab-wide browser singleton
(`app/composables/liveBus.ts`), three event types on the same wire:
`session-event` for durable `session_events` rows (replayed past
`?since=` on connect then tailed via the change bus, idempotent
reconnect), `partial` for **live-only** coalesced streaming deltas
(NOT persisted — the complete `assistant` row supersedes them in the
adapter, matched by Anthropic `message.id`), and `table-change` for
coarse `{table,id,op}` notices fired from every helper-layer write to
`projects`/`envs`/`sessions` in `lib/{sessions,envs,projects}.ts`
(including the engine's per-turn `updateSession` for status +
`lastEventAt`). `?sessionId=` is optional — without it the connection
only carries `table-change` (landing / project / env-overview pages).
The chat surface uses `useSessionStream` (now consuming the singleton —
no per-component EventSource); the rail + overview pages use
`useLiveRefresh(refresh, { tables: [...] })`, which binds a
`useCall.refresh()` to matching `table-change` frames with a 150 ms
trailing debounce so a turn's flurry of `updateSession` writes
collapses into one SELECT. The 4 s rail-poll (`LeftRailTree`'s
`sessionTick` setInterval) is **deleted** — the rail's session
status dot, new-output dot, and env list are push-live. Coast events
still drive the env runtime overlay (`liveStatus`/checkout — those
come from `coast ls`, not our SQLite row) until step 3 swaps Coast
out.

**Deleted with step 1** (don't try to import or revive): `server/lib/
electric/*`, `server/routes/_agents/*`, `server/plugins/electric.ts`,
`server/procedures/electricSmoke.ts`, `sessions/streamInfo.ts`,
`docker-compose.yml`, `release/{docker-compose.yml,Dockerfile.agents-server,
agents-server-0.4.2-boot-relink.patch}`, `scripts/apply-patches.sh`, the
`@electric-ax/agents-{runtime,server}` + `@electric-ax/durable-streams-
state-beta` + `@durable-streams/{client,server,state}` deps and the
`pnpm.overrides` URL pins + `blockExoticSubdeps`, the unused
`agent-session-protocol` dep (IDE-bridge leftover), `agentsServerUrl`
runtimeConfig + `DOMO_AGENTS_*` env vars. `bin/domo` collapsed to a
one-Nitro-process manager (no Docker compose); `install.sh` /
`build-release.sh` / `local-update.sh` dropped the infra copies + the
`infra.agentsServer` manifest field.

**CLI argv + env now verified against the live VS Code 2.1.142
extension** (capture from `ps eww` on the user's Mac, 2026-05-20):
argv identical for a fresh session in `manual` mode; four extra env
vars added alongside `CLAUDE_CODE_ENTRYPOINT=claude-vscode` —
`MCP_CONNECTION_NONBLOCKING=true`, `CLAUDE_CODE_ENABLE_TASKS=0`,
`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`,
`CLAUDE_AGENT_SDK_VERSION=0.3.142` (pinned literal — bump when matching
a newer extension capture).

**Next up:** step 3a (devcontainer lifecycle off `devcontainer.json`
directly, rootless-DinD baseline sysbox→rootless-dind→privileged-warn,
terminal → `docker exec`, Coast adapter removed) → step 3b (`claude`
spawn site moves from host into `docker exec` inside the env container,
delivered by a Domo-owned devcontainer Feature, shared
`<DOMO_HOME>/claude-home/<userId>/` → `~/.claude` bind-mount carrying
OAuth + slash-commands + MCP across that user's envs) → step 4
(TCP-only port forwarding: `-p 127.0.0.1:0:<inner>` at create + userland
forwarders for ad-hoc + "expose externally" toggle) → steps 5–6. Step
7's billing live-verify is a **single end-of-build check** scoped by
the user to *after* all of steps 1–6 land (including the devcontainer
swap and the release re-cut). Don't surface it as a milestone in the
meantime — just keep the whole build moving so it lands well before
~2026-06-15.

`server/lib/coast/*` + `app/composables/useCoastEvents.ts` +
`server/api/coast-events.ts` + the Coast adapter in `envs.*` stay in
the tree — they're step 3's swap (devcontainers). Don't extend them.

## Running it

```bash
pnpm install        # pnpm 11; native builds in pnpm-workspace.yaml
pnpm dev            # http://localhost:7576 (dev port; prod is 7575)
pnpm typecheck      # vue-tsc
pnpm lint           # eslint
pnpm build          # production build
pnpm run update:local   # build + install over the LOCAL prod install
                        # ($DOMO_HOME), then app-only restart
```

Distribution (built; v0.3.0 on the old stack): host installer
(`scripts/install.sh`, curl|sh) + `domo` CLI (`bin/domo`) + CI release
matrix. Per-`{linux,darwin}-{x64,arm64}` tarballs, bundled Node, all
data under `$DOMO_HOME`. Canonical port **7575**, `127.0.0.1` by default
(`DOMO_BIND=0.0.0.0` to widen). **Post-step-1: no engine infra** —
`bin/domo` is just the Nitro-process manager, `install.sh` only checks
for the runtime prereqs (Docker for devcontainers later, git, `claude`),
the release tarball is `.output/` + bundled Node + `bin/domo` + VERSION.

## Testing

**Prod was DECOMMISSIONED 2026-05-19** (user-driven, to clear the way for
the pivot): the prod app is stopped, all Coast envs `coast rm`'d, the
Electric/dev/prod compose stacks down, `~/.domo` wiped. There is no live
Domo on `localhost:7575` until the user reinstalls from the new release
line. **Still test on an isolated `DOMO_HOME` + the dev port 7576**;
the don't-touch-7575 caution returns post-reinstall. `DOMO_HOME`
overrides the data dir (default `~/.domo`, XDG fallback);
`DOMO_PROJECTS_ROOT` sets the dir-picker root.

**Playwright MCP** (`mcp__playwright__browser_*`) drives a real browser
— prefer it over curl for UI flows (the SPA executes `apiClient.*`
client-side). **UI work MUST be confirmed with a real rendered check**
(screenshot / `getComputedStyle` is `oklch(...)`), not just the a11y
snapshot — the a11y tree is identical with/without CSS (this hid a
project-wide missing-CSS bug for 4 phases). **Scroll behaviour MUST be
smoke-tested with a transcript taller than the viewport at a mobile
breakpoint** — short exchanges never exercise the scroll container.

Workspace + git are host-side: exercise the file tree/editor/git pane
without a container by seeding a `projects` + `envs` row whose
`worktree_path` points at any on-disk git repo (`status='running'`);
clean up seeded rows after (they pollute the real `~/.domo/state.db`).

## Layout + conventions

- **Nuxt 4 at repo root.** `app/` (Vue), `server/` (Nitro routes+libs),
  `docs/`, `smoke/`. **SPA**: `routeRules:{'/**':{ssr:false}}` (top-level
  `ssr:false` breaks Nuxt 4.4's vite-builder) — use `location` directly,
  no `useRequestURL`.
- **Components** `app/components/Domo/*` with a `Domo` prefix. Use
  **UDashboard primitives** for shell pieces. The center `UDashboardPanel`
  carries **no `default-size`** (size-less = `flex-1` filler; a sized one
  won't reclaim space and `useResizable` ignores a reactive size after
  mount). Only side rails are sized/resizable.
- **Theme = `app/app.config.ts` + `@theme static` in `main.css`** (Robo
  palette). Custom scales `--color-robo*` must each be the full 50–950
  (Nuxt UI derives `--ui-*` across the ramp; a partial scale falls
  back). Fonts only via `--font-{sans,serif,mono}` (`@nuxt/fonts` scans
  them). Re-skin by editing the hex scales, not component classes.
- **Backend = `nuxt-procedures`.** Files under `server/procedures/`
  export `defineProcedure({input,output,handler})`; auto-imported
  `apiClient` (`projects/add.ts`→`apiClient.projects.add.call/.useCall`).
  Zod in+out, superjson serializes (Date/Map work). Multi-step flows use
  discriminated-union outputs (see `projects.add`). Handler gets
  `{input,event}`; only auth/admin procs use `event` (the middleware
  gates the rest). **Inputs reject empty strings** (`z.string()`
  non-empty server-side → 400): guard a `useCall`/`.call` against ``''``/
  undefined ids (manual `ref` + `async refresh()` that no-ops when
  falsy, re-run in a `watch`).
- **Streaming stays classic Nitro** (`server/api/`,
  `defineEventHandler`/`defineWebSocketHandler`): `nuxt-procedures` is
  request/response only. The change-bus/chat SSE (`/api/live`), terminal
  WS, and per-env TCP forwarders live here; procedures orchestrate them.
- **Auth = `nuxt-auth-utils` + one Nitro middleware.**
  `server/middleware/auth.ts` is the real boundary — gates
  `/procedures/**` + Domo's own `/api/*` SSE/WS, allow-lists only
  bootstrap/setup/register/login/me. It must **NOT** gate the broad
  `/api/` prefix (framework `/api/_auth/`, `/api/_nuxt_icon/` live
  there — add new Domo `/api/*` endpoints to the list explicitly). The
  sealed cookie is **identity-only** (`{id,email,name}`); `role`/
  `status` are re-read from `users` in every guard (`server/lib/auth.ts`)
  so approve/reject needs no re-login — don't cache them in the cookie.
  Session secret auto-managed at `$DOMO_HOME/session-secret`
  (`server/plugins/00.session-secret.ts`; in dev nuxt-auth-utils'
  `.env` auto-gen takes precedence — the plugin owns prod only; to test
  the plugin, build with `.env` moved aside, and it must set
  `process.env.NUXT_SESSION_PASSWORD`, not assign read-only prod
  `runtimeConfig`). `setup.vue`/`register.vue` wrap a `UForm` + Zod
  mirroring the server input (inline per-field errors pre-submit).
- **Server libs** `server/lib/`: `paths.ts`, `db.ts` (better-sqlite3
  singleton + `CREATE TABLE IF NOT EXISTS` migrate + `ensureColumn`),
  `schemas.ts` (shared Zod), `users.ts`+`auth.ts`, `projects.ts`,
  `envs.ts`, `sessions.ts` (Domo session pointer: title/done/per-device
  viewed/cached status), `claudeCommands.ts`/`mentions.ts`/`promptExpand.ts`
  (slash + `@` discovery & **expansion at execution time, not in
  `sessions.prompt`** — transcript keeps raw text), `workspace.ts`
  (`resolveEnvWorktree`+`safeResolve` — the path-safety chokepoint),
  `git.ts` (injection-safe `execFile git -C`), `settings.ts` (UX prefs),
  `config.ts` (`<domoHome>/config.json` operator host config, read fresh;
  `claude.env`/`extraPath` merged **before** the security scrub —
  cannot reintroduce `ANTHROPIC_API_KEY`), and (post-steps-1+2):
  `sessionEngine/{engine,claude,store}.ts` (single-flight long-lived
  per-session `claude` manager; `session_events` + `pending_diffs`
  durable log; the host `claude` spawn moved from `electric/claude.ts`)
  and `changeBus.ts` (in-process emitter with three channels:
  `session-event` durable rows, `session-partial` live deltas,
  `table-change` coarse `{table,id,op}` from every helper-layer
  insert/update/delete — `lib/{sessions,envs,projects}.ts` fire on
  every write chokepoint including the engine's per-turn
  `updateSession`). **Still to build:** the devcontainer client +
  `portForwarder` (steps 3–4). **Still legacy (step 3 swap):** `coast/*`.
- **Workspace + git are host-side.** `workspace.{tree,read,write}` use
  `node:fs`; `git.*` shells `git -C <worktree>` on the host. Every path
  worktree-relative through `safeResolve` (rejects `..`, abs-outside,
  symlink-out). Only the terminal crosses into the container.
- **Chat surface.** UI transcript = AI SDK `UIMessage` shape; each
  backend is an adapter (`app/utils/sessionMessages.ts` folds native
  stream-json + `prompt`/`steer_sent` events → `UIMessage[]`). `ai`
  is a **types-only devDep** — don't import its runtime in app code
  (switch on the part `type` string; `import type` is fine). Render:
  `DomoChat`→`DomoChatMessageContent`→`DomoChatToolCard`/`DomoComark`;
  input `DomoChatInput`+`DomoChatAutocomplete` (nav keys intercepted at
  keydown-**capture** so they never reach `UChatPrompt`'s Enter/Esc).
  Per-session approval modes (`manual`/`auto`/`passthrough`, plain read
  per turn). **The browser tails the engine via `/api/live`** through a
  **tab-wide singleton** (`app/composables/liveBus.ts`) that
  multiplexes three SSE event types over one connection:
  `session-event` (durable `session_events` rows, replayed past
  `?since=` on connect → idempotent reconnect, never UPDATEd),
  `partial` (live-only coalesced assistant deltas, NOT persisted — the
  complete `assistant` row arrives on the durable channel and
  supersedes the partial bubble in the adapter, joined by Anthropic
  `message.id`), and `table-change` (coarse `{table,id,op}`).
  `?sessionId=` is optional — without it the connection carries only
  `table-change`. `useSessionStream` consumes the singleton (the chat
  surface calls `liveBus().focusSession(id)`; `releaseFocusIf(id)` is
  a CAS so page-transition mount-before-unmount doesn't clobber the
  next chat's focus). `projectSessionMessages(events, partial)`
  renders the streaming bubble in place. The pending-diff queue + the
  chat status are **derived client-side** from the event stream
  (`pending_diff` + `diff_decision` events fold into a map;
  `prompt`/assistant activity → `active`, `result`/`aborted` →
  `waiting`, `error` → `error`). Rails and overview pages refetch via
  `useLiveRefresh(refresh, { tables: [...] })` — bound to the coarse
  `table-change` channel, 150 ms trailing debounce so a turn's flurry
  of `updateSession` writes collapses into one SELECT. The 4 s
  rail-poll is gone; coast events still drive the env runtime
  overlay (`liveStatus`/checkout) until step 3 swaps Coast out.
- **CodeMirror/xterm/Comark are client-only** — dynamic-import in
  `onMounted`, lazy grammars (`app/utils/language.ts`). `DomoCodeEditor`,
  `DomoDiffView` (`@codemirror/merge`; split ≥md, inline below — the
  approval card forces `inline`), `DomoMarkdownView`.
- **`useSelectedEnv()`** resolves `{project,env,...}` from the route.
  `nuxt-procedures` `useCall` is **keyed on serialized input** — it does
  NOT refetch on reactive arg changes; re-`.call()` in a `watch`, or
  drive `.call()` imperatively per nav (the `DomoDirectoryPicker`
  cautionary case: `useCall`+`refresh()` re-sent the original args and
  stuck the picker on `$HOME`).
- **Panel state persists server-side** via `usePanelState`
  (`settings`), except the **mobile workspace drawer is ephemeral
  `ref(false)`** (a persisted desktop `rightOpen:true` must not
  auto-open a slideover on phones); `app.vue` routes the toggle/⌘B
  through an `isDesktop`-keyed computed.
- **Responsive = component swap, not CSS hide** (the dashboard group
  can't stack): workspace = inline `UDashboardPanel` ≥lg ↔ `USlideover`
  <lg via `useBreakpoints`; left rail = Nuxt UI `UDashboardSidebar`
  mobile drawer. `@vueuse/core` is a **direct** dep (don't let a lint
  sweep drop it as "unused").

## Reference projects in `../`

- `../claude-code/` — public Claude Code source snapshot. Narrow
  protocol-interop use only. The stdio-permission wire shapes are in
  `src/cli/structuredIO.ts` (`createCanUseTool`, `control_request`/
  `control_response`).
- `../claude-code-chat*/` — slash-command + `@`-mention UI patterns.
- `../nuxt-chat-template/` — `UChat*` layout / `MessageContent` /
  `Comark` patterns.

(Electric/Coast/IDE-bridge references are now history — see
`history.md`.)

## Gotchas (live)

- **Subscription billing is load-bearing and `claude` spawn must mirror
  the official VS Code 2.1.142 extension** (Anthropic's billing change
  lands ~2026-06-15; post-change the `-p`/`sdk-cli` path drops to a
  small capped credit and `cc_entrypoint` drives the classifier).
  `server/lib/sessionEngine/claude.ts` runs **no `-p`**, passes the
  extension's exact argv (verified against a `ps eww` capture of the
  live extension binary 2026-05-20), pins
  `CLAUDE_CODE_ENTRYPOINT=claude-vscode` (which is in `SCRUB_ENV` for
  nested-claude hygiene → must be re-pinned *after* the scrub, never
  left scrubbed), and also pins the four ancillary env vars the
  extension sets alongside it: `MCP_CONNECTION_NONBLOCKING=true`,
  `CLAUDE_CODE_ENABLE_TASKS=0`,
  `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`,
  `CLAUDE_AGENT_SDK_VERSION=0.3.142` (literal — bump when re-checking
  against a newer extension). Don't "simplify" the argv, don't drop any
  of these vars, and don't re-scrub the entrypoint. The
  **long-lived per-session process** (one process serves multiple
  turns over one stdin, demux by `result`, idle-reap → exit, next
  prompt respawns with `--resume`) is the engine's actual model
  (spike-proven by `smoke/persistent-session-spike.mjs`). **Step 3b
  moves the spawn site from host-side into `docker exec` inside the env
  container** (same VS Code Dev Containers extension behavior); argv +
  the 5 env vars + `ANTHROPIC_API_KEY` scrub move into the `--env` flags
  of the exec call. Until step 3b lands, the host-side spawn from step 1
  remains. Memory: `project-agent-sdk-billing`. The single end-of-build
  live-verify is tasks.md step 7 — runs *after* all of steps 1–6 land,
  not before.
- **Dogfooding/sandbox litter (Claude-inside-Domo only).** If the
  operator's `~/.claude` has `permissions.defaultMode:"auto"` *and* the
  Claude Code session is running inside a Domo-spawned env, Claude Code's
  bwrap sandbox bind-mounts immutable empty stubs over alt-package-
  manager/submodule paths (`.npmrc`, `yarn.lock`, `.gitmodules`, …) in
  every worktree and makes `node_modules/.bin` **read-only** (so
  `pnpm <script>`/`pnpm install` EROFS-fail — run tools node-direct with
  the Bash tool's `dangerouslyDisableSandbox`). **Running Claude Code
  outside Domo (e.g. against this repo directly) is unaffected — use
  plain `pnpm typecheck` / `pnpm lint`.** The stub litter is
  `.gitignore`d (stopgap); the real fix (pin `sandbox.enabled:false` or
  operator drops `defaultMode:auto`) is unverified.
- **Nuxt UI v4 needs an app CSS entry** — `main.css` must have `@import
  "tailwindcss"; @import "@nuxt/ui";` and be in `nuxt.config.css`, else
  the whole app is unstyled (and the a11y tree looks fine — verify with
  a rendered check).
- **`UChatMessages` scrolls the nearest `overflow-y:auto` ancestor**,
  not itself — keep the transcript wrapper a bounded `flex-1 min-h-0
  overflow-y-auto`, input/cards pinned below as `shrink-0`.
- **Always pass `title` AND `description` to every `UModal`/`USlideover`
  /`UDrawer`** (Reka UI needs both). Nuxt UI's `UDashboardSidebar`
  mobile slideover renders literal `dashboardSidebar.title` unless you
  pass `:menu="{title,description}"` (see `app.vue`).
- **`defineShortcuts` disables a shortcut while an input is focused**
  unless `usingInput:true` — ⌘S (editor save) and ⌘↵ (commit) must set
  it or they no-op exactly when used. `meta_*` auto-maps to Ctrl off
  macOS.
- **A static `<img src="/public-asset">` build-resolves the asset** —
  the file must be committed in `public/` or Vite fails the whole SPA
  build (blank page). Use a bound `:src` for not-yet-committed assets.
- **Logout must null `me` (unmount `DomoAppShell`) before `clear()`** —
  else a still-mounted shell child refetches a now-gated procedure and
  the 401 is an uncatchable console error.
- **`UTabs` v-model keys off each item's `value`**, not `id` — items
  with only `{id}` leave the model stuck.
- **`UDashboardSidebar` collapse floors at 64px** — true-hide via
  `:ui="{root:'min-w-0 border-e-0 overflow-hidden'}"` only while
  collapsed; the desktop expand control must live outside the rail
  (`DomoCenterNavbar`) so it survives the hide.
- **Native modules** (`better-sqlite3`, `@parcel/watcher`, `esbuild`,
  `unrs-resolver`, `vue-demi`) need `allowBuilds:` in
  `pnpm-workspace.yaml` (pnpm 11 won't run install scripts otherwise).
- **vue-tsc rejects inline `as` casts in template bindings** — narrow in
  `<script>` (a typed `computed`), keep template expressions cast-free.

## Updating this file

Any session that lands work touching the topics here updates the
relevant section in the *same* change (phase moves → "Where we are"; new
convention → "Layout"; gotcha resolved/surfaced → "Gotchas"; reference
added/removed → that section *and* `initial-design.md`). If a finding
contradicts `initial-design.md`, fix the design doc first, then point
here.
