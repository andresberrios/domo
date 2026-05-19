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

## Where we are — mid-pivot

Phases 0–4 + multi-user auth Part A **shipped** on an **Electric Agents
session engine + Coast environments** stack (last release **v0.3.0**;
narrative in `history.md`). Testing showed that stack corrupts sessions
on restart — a structural flaw of a stateful agent-server intermediary,
not a fixable bug. **Decision:** replace it with an **in-process engine
over the existing SQLite** (`session_events` log + single-flight
**long-lived per-session `claude` process** + `--resume`), a **unified
change-bus + `/api/live` SSE** reactivity spine, and **devcontainer +
rootless-DinD** environments with a `Domofile` + in-process port
forwarding. Engine first, then devcontainers. Full design + build
sequence in `initial-design.md`.

**Rescued from `dev` (merged):** the **deadline-critical subscription-
billing fix** (`51a6517` — spawn like the official VS Code 2.1.142
extension: no `-p`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`; see the
billing gotcha), **live partial streaming** (`672cdc6` — coalesced
`stream_event` → `assistant_partial`), and the **build-progress
checklist** (`2f64638`). These already live in `electric/claude.ts`/
`entity.ts` (reconciled with main's approval modes) and carry straight
into the new engine.

**So:** `server/lib/electric/*`, `server/routes/_agents/*`, the
agents-server/Postgres compose + boot-relink patch + `apply-patches.sh`,
the `@durable-streams/*` pins, and `server/lib/coast/*` are **legacy,
scheduled for deletion** (tasks.md steps 1–4). Don't extend them; build
the replacements per the design. `electric/claude.ts` is the exception —
its host-side `claude` spawn (billing argv, stdio-permission, steering,
scrub, partial-stream coalescer) is **kept and reused** by the new
engine.

## Running it

```bash
pnpm install        # pnpm 11; native builds in pnpm-workspace.yaml
pnpm dev            # http://localhost:7576 (dev port; prod is 7575)
pnpm typecheck      # vue-tsc
pnpm lint           # eslint
pnpm build          # production build
pnpm run update:local   # build + install over the LOCAL prod install
                        # ($DOMO_HOME), then app-only restart
docker compose up -d    # LEGACY (Postgres + agents-server) — only the
                        # not-yet-replaced session engine needs it;
                        # goes away in tasks.md step 1
```

Distribution (built; v0.3.0 on the old stack): host installer
(`scripts/install.sh`, curl|sh) + `domo` CLI (`bin/domo`) + CI release
matrix. Per-`{linux,darwin}-{x64,arm64}` tarballs, bundled Node, all
data under `$DOMO_HOME`. Canonical port **7575**, `127.0.0.1` by default
(`DOMO_BIND=0.0.0.0` to widen). The new engine removes the
Postgres/agents-server infra entirely.

## Testing

**This machine runs the user's LIVE prod Domo at `localhost:7575`** — do
not kill/seed it. Test on an **isolated `DOMO_HOME` + the dev port
7576**. `DOMO_HOME` overrides the data dir (default `~/.domo`, XDG
fallback); `DOMO_PROJECTS_ROOT` sets the dir-picker root.

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
  WS, and env reverse-proxy live here; procedures orchestrate them.
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
  cannot reintroduce `ANTHROPIC_API_KEY`). **To build:**
  `sessionEngine` (single-flight `claude` manager + `session_events`),
  `changeBus` + `/api/live`, devcontainer client + `portForwarder`. **To
  delete:** `electric/*` (keep `claude.ts`'s spawn), `coast/*`.
- **Workspace + git are host-side.** `workspace.{tree,read,write}` use
  `node:fs`; `git.*` shells `git -C <worktree>` on the host. Every path
  worktree-relative through `safeResolve` (rejects `..`, abs-outside,
  symlink-out). Only the terminal crosses into the container.
- **Chat surface.** UI transcript = AI SDK `UIMessage` shape; each
  backend is an adapter (`app/utils/sessionMessages.ts` folds native
  stream-json + prompt/`chat`/`steer_sent` events → `UIMessage[]`). `ai`
  is a **types-only devDep** — don't import its runtime in app code
  (switch on the part `type` string; `import type` is fine). Render:
  `DomoChat`→`DomoChatMessageContent`→`DomoChatToolCard`/`DomoComark`;
  input `DomoChatInput`+`DomoChatAutocomplete` (nav keys intercepted at
  keydown-**capture** so they never reach `UChatPrompt`'s Enter/Esc).
  Per-session approval modes (`manual`/`auto`/`passthrough`, plain read
  per turn). *(New engine: the browser tails `session_events` via the
  `/api/live` seq path instead of a durable-stream subscription.)*
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
  the official VS Code extension (deadline ~2026-06-15).** The spawn in
  `electric/claude.ts` runs **no `-p`**, sets
  `CLAUDE_CODE_ENTRYPOINT=claude-vscode` (it's in `SCRUB_ENV` for
  nested-claude hygiene → must be re-pinned *after* the scrub, never
  left scrubbed), and passes the extension's exact argv. Post-2026-06-15
  the `-p`/`sdk-cli` path drops to a capped credit; `cc_entrypoint`
  drives the classifier. `-p` is a red herring (spike
  `smoke/no-print-lifecycle-spike.mjs`). Don't "simplify" the argv or
  re-scrub the entrypoint. Verify via `apiKeySource:"none"` +
  `cc_entrypoint=claude-vscode` on the spawned process. Memory:
  `project-agent-sdk-billing`. Long-lived per-session process (vs
  spawn-per-turn) is the tracked fidelity follow-up
  (`smoke/persistent-session-spike.mjs`).
- **Dogfooding/sandbox litter.** If the operator's `~/.claude` has
  `permissions.defaultMode:"auto"`, Claude Code's bwrap sandbox bind-
  mounts immutable empty stubs over alt-package-manager/submodule paths
  (`.npmrc`, `yarn.lock`, `.gitmodules`, …) in every worktree and makes
  `node_modules/.bin` **read-only** (so `pnpm <script>`/`pnpm install`
  EROFS-fail — run tools node-direct: `NODE_OPTIONS=--max-old-space-size=8192
  node node_modules/nuxt/bin/nuxt.mjs typecheck`, `node
  node_modules/eslint/bin/eslint.js <files>`, with the Bash tool's
  `dangerouslyDisableSandbox`). The stub litter is `.gitignore`d
  (stopgap); the real fix (pin `sandbox.enabled:false` or operator drops
  `defaultMode:auto`) is unverified — measuring it from inside a Claude
  Code session is confounded by the harness's own bwrap.
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
