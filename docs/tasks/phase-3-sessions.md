# Phase 3 — Agent sessions

The chat surface comes online: Electric Agents host the `claude-code-cli` entity, the IDE bridge handles approvals, and the diff-approval round-trip ties chat to the workspace.

> **Architecture resolved in Step 8a** (see `initial-design.md` Decided #11–14):
> agents-server + Postgres run via `docker-compose.yml` (durable streams
> embedded); the runtime is hosted in-process in Nuxt and connects out via
> **pull-wake** (not the push webhook); `claude` runs host-side (Option A);
> Domo metadata stays in SQLite. Pending-decision references live in
> `../../initial-design.md` (there is no `tasks/README.md`).

## 8. Electric Agents bring-up

- [x] Run `@electric-ax/agents-server` as a sidecar (docker-compose: Postgres + agents-server); healthcheck via `electricSmoke` procedure
- [x] ~~Mount `/_electric/builtin-agent-handler` Nitro route~~ → **pull-wake runner** instead (`createPullWakeRunner`, `server/lib/electric/runtime.ts`); push webhook remains a drop-in via `createRuntimeHandler.onEnter`
- [x] Define `claude-code-cli` entity, host-side spawn variant (`server/lib/electric/entity.ts` + `claude.ts`) — registration, handler, and the real host-side `claude` stream-json spawn (8b seam filled; reuses the Phase 0 smoke's proven invocation)
- [x] Implement the 8 required IDE bridge tools (`openDiff`, `openFile`, `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `checkDocumentDirty`, `saveDocument`, `closeAllDiffTabs`) — **8c** (`server/lib/electric/bridge.ts`: standalone per-session RFC 6455 WS server, hand-rolled — design Decided #15; `getDiagnostics` also stubbed to `[]`. `openDiff` delegates to an injected resolver; the durable approval round-trip is step 11. Codec + MCP dispatch smoke-verified incl. 70 KB-payload reassembly; bridge boot + lock-file lifecycle verified live in the 8d smoke — `openDiff` Edit/Write routing first exercised in step 11)
- [x] Lock-file lifecycle at `~/.claude/ide/<port>.lock` (create on bridge boot, clean on `close()`; honors `CLAUDE_CONFIG_DIR`) — **8c**
- [x] Always strip `ANTHROPIC_API_KEY` (+ nested-claude session vars) from spawn env; set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (`server/lib/electric/claude.ts`)
- [x] Lock down `events` / `pendingDiffs` / `sessionMeta` / `inboxState` row schemas (`server/lib/electric/schemas.ts`; resolves design Pending Discussion 1)
- [x] Capture `session_id` from the first `system` event into `sessionMeta.nativeSessionId`; `--resume <id>` thereafter (**verified live in 8d** — captured id matched the `system` event's `session_id`)
- [x] **8d — `sessions.*` procedures, verified live end-to-end.** `create`/`list`/`get`/`prompt`/`diffDecision`/`abort`/`rename`/`done`/`delete` over `server/lib/sessions.ts` (DB pointer row) + `server/lib/electric/client.ts` (driver: `createRuntimeServerClient` spawn/send/delete). `create` spawns the entity with an **explicit runner dispatch policy** (design Decided #16); `startElectricRuntime()` now `registry.define`s **and** `runtime.registerTypes()`-es on boot (the missing control-plane registration that would 404 spawns). Typecheck + lint clean. **Live smoke passed** (isolated `DOMO_HOME`, throwaway git worktree, no Coast container): create → entity on agents-server carries `dispatch_policy {runner: domo-runtime}`; prompt → wake → pull-wake runner → handler → host `claude` → `system`/`assistant`/`result` mirrored to the durable stream, `apiKeySource: none` (subscription billing), `session_id` → `nativeSessionId`, IDE bridge booted (`bridgePort`), `assistant: "PONG"`; delete → entity `stopped` + DB row gone. (No-tool prompt, so the bridge `openDiff` Edit/Write round-trip is first exercised in step 11.)

## 9. Chat surface

> **Core landed & verified live end-to-end** (step-9 smoke: isolated `DOMO_HOME`,
> throwaway worktree, no Coast container — created a session from the left rail,
> sent a prompt, the browser rendered *user prompt → `Read` tool card →
> assistant "PONG"* through the `/_agents` proxy + durable subscription +
> `UIMessage` projection; typecheck + lint clean, 0 console errors). The
> AI-SDK-`UIMessage` standardization is design **Decided #17**.

- [x] Subscribe to the entity's durable stream via the Electric runtime client + TanStack DB (`app/composables/useSessionStream.ts` — wraps the framework-agnostic core through the same-origin `/_agents` reverse proxy, `server/routes/_agents/[...].ts`)
- [x] Project `events` rows into `UIMessage.parts` for `UChatMessages` (`app/utils/sessionMessages.ts` — per-adapter client-side projection; tool_use↔tool_result correlated by id; inbox prompts interleaved as user messages)
- [x] Reuse `MessageContent.vue` pattern (text / reasoning / tool parts) — `DomoChatMessageContent` switches on the AI SDK part `type` (no `ai` runtime import; `ai` is a types-only devDep)
- [x] Tool renderers: Read, Glob, Grep, Edit, Write, Bash, TodoWrite, generic fallback (`DomoChatToolCard` — collapsed chip / inline `DomoDiffView` / bash block / todo checklist, per the audited VS Code patterns)
- [x] Audit 2–3 open-source Claude Code VS Code wrappers for tool-card UX (andrepimenta + codeflow-studio `claude-code-chat`; findings drove `DomoChatToolCard`, also informing the deferred slash/`@` work below)
- [x] Prompt input with abort — **abort done** (`UChatPromptSubmit` stop → `sessions.abort`); **edit-and-resend done** (pragmatic: `#actions` pencil pulls a past user message back into the prompt; same session, claude `--resume` keeps context). True edit-and-**fork** (branch the durable stream + fork the native claude session at message N) stays deferred — needs durable-stream branch + arbitrary-offset claude rewind primitives we haven't validated; see [Reconciling Claude's session file with the durable stream](../initial-design.md#reconciling-claudes-session-file-with-the-durable-stream)
- [x] Slash-command popup (`/`-triggered): built-in commands + custom commands scanned from `<worktree>/.claude/commands/*.md` and user `<claudeConfigDir>/commands/*.md` with `$ARGUMENTS` substitution — `server/lib/claudeCommands.ts` + `sessions.commands`; popup `DomoChatAutocomplete` via `DomoChatInput`. **Verified live** (16 builtins ∪ custom `/greet` tagged "project"; `/greet Bob` → transcript shows raw `/greet Bob`, assistant greeted "Bob")
- [x] `@`-mention popup: file/folder/`@git-changes`/commit-sha/url; **server-side expansion at execution time** (entity, not `sessions.prompt`, so the transcript stays raw) — `server/lib/mentions.ts` + `sessions.mentions`. Plain-text tokens, not rich contenteditable chips (functionally equivalent; chips can layer on later). **Verified live** (popup filtered to `hello.txt`, Tab-accept inserted `@hello.txt `)

### Step 9 — fully landed (core + remainder)

Step 9 core **and** the deferred remainder (input affordances + polish +
auto-navigate + edit-and-resend) are landed, typecheck/lint clean, and
verified live. The architecture recap + gotchas + smoke recipe below are
kept for step 11.

**Architecture recap (how the chat surface is wired):**

- Browser subscribes to the entity's durable stream **directly**, but
  through the same-origin transparent proxy `server/routes/_agents/[...].ts`
  (`/_agents/**` → agents-server; h3 `proxyRequest`, streaming-safe).
  The agents-runtime client resolves everything as `baseUrl + path`, so
  that one catch-all covers the `_electric` control GETs *and* the
  long-poll/SSE stream. `baseUrl` used client-side = `location.origin + '/_agents'`.
- `app/composables/useSessionStream.ts` — wraps the framework-agnostic
  agents-runtime core (no Vue binding ships): `createRuntimeServerClient`
  → `getEntityInfo(entityId)` → `createEntityStreamDB(url, customState)`
  → `preload()` → mirrors each TanStack DB collection into a `shallowRef`
  on every change. Custom collections passed explicitly (`events`,
  `sessionMeta`, `pendingDiffs` pk `callId`, `inboxState`) — without
  `customState` the client only materializes built-ins and our rows are
  dropped. Client row mirrors: `app/utils/sessionStreamTypes.ts` (server
  `schemas.ts` is server-only — keep these structurally in sync).
- `app/utils/sessionMessages.ts` — the **claude-cli adapter**
  (Decided #17): folds native stream-json `events` + `inbox` prompts →
  AI SDK `UIMessage[]`. Render: `DomoChat` (`UChatMessages` +
  `UChatPrompt`/`UChatPromptSubmit`) → `DomoChatMessageContent` →
  `DomoChatToolCard` / `DomoComark`. Status comes from `sessionMeta`
  (`running`/`pending-approval` → `streaming`), not the transcript.
- Procedures: `sessions.prompt` / `sessions.abort` already wired to the
  prompt box. `sessions.diffDecision` exists (used by step 11).

**Landed (this group), verified live:**

- [x] **Left-rail "New session" auto-navigate** — root cause: `useRouter()`
  captured after the top-level `await` in the async-setup component runs
  outside the instance context, so its `push` silently no-ops. Fixed with
  `navigateTo`, navigating *before* the list `refresh()` (the chat page
  resolves the session itself). Smoke: New session → URL becomes
  `/p/.../s/<id>`, chat renders.
- [x] **Edit-and-resend** — `#actions` pencil on past user messages pulls
  the text back into the prompt (`DomoChatInput` exposes `focus()`). Same
  session (claude `--resume` keeps context). True edit-and-**fork**
  (durable-stream branch + native claude rewind at message N) deferred —
  primitives unvalidated; design pointer in `initial-design.md`.
- [x] **Slash-command popup** — `server/lib/claudeCommands.ts`
  (`BUILTIN_SLASH_COMMANDS` ∪ project `<worktree>/.claude/commands/*.md`
  ∪ user `<claudeConfigDir>/commands/*.md`, project precedence,
  `# heading`→description, `$ARGUMENTS` substitution) + `sessions.commands`
  procedure + `DomoChatAutocomplete`/`DomoChatInput`.
- [x] **`@`-mention popup** — `server/lib/mentions.ts` (`searchMentions`
  over `git ls-files` + dirs + recent commits + `@git-changes`;
  `expandMentions` → file/dir/diff/commit content) + `sessions.mentions`.
  Plain-text tokens (not contenteditable chips — functionally equivalent).
- [x] **Expansion runs in the entity** (`expandInWorktree` in
  `executeClaudeTurn`), not `sessions.prompt`, so the durable inbox /
  transcript keeps the raw text the user typed.
- [x] **Tool-card polish** — long-output show-more + copy in
  `DomoChatToolCard`.

**Gotchas that will bite a fresh session (also in CLAUDE.md):**

- `ai` is a **types-only devDep**; never import its runtime in app code
  yet (claude-cli adapter doesn't need it). Type-only `import type` ok.
- vue-tsc rejects inline `as` casts with type literals in template
  bindings — narrow in `<script>` (see `DomoChatMessageContent`).
- `pkill -f`/`pgrep -f` patterns that contain "nuxt"/"dev" match the
  command's own shell → exit 144 and the cleanup half-runs. Kill dev
  servers by explicit PID (iterate `/proc/*/cmdline`, match
  `projects/domo` + `nuxt.mjs dev`).

**Live smoke recipe (isolated; never touches `~/.domo`):** agents-server
must be up (`docker compose up -d`). Make a throwaway git worktree, start
`DOMO_HOME=/tmp/xxx NUXT_IGNORE_LOCK=1 pnpm dev` **from the repo root**
(not `cd`-ed into the worktree — no package.json there), seed a
`projects` + `envs` row (better-sqlite3, `worktree_path` → the throwaway
repo, env `status='running'`), then drive `http://localhost:3000` with
the Playwright MCP: expand the project in the left rail → New session →
type a prompt that reads a file → assert *user prompt → tool card →
assistant text* render with 0 console errors. Tear down by PID + `rm -rf`
the temp `DOMO_HOME`.

## 10. Session lifecycle UI — landed & verified live

- [x] Status indicators per session row: `active` / `waiting` / `pending-approval` / `error` — the in-process entity `mirrorToDb`'s its live status (mapped from `sessionMeta.status`) + `lastEventAt` into the Domo `sessions` row; the rail dot reads the cached value, kept fresh by a single 4 s tick in `DomoLeftRailTree` (paused when the tab is hidden — sessions have no coast-style browser event channel). `creationArgsSchema`/`sessionMetaRowSchema` now carry `sessionId` (== entity id) so the entity can address the row.
- [x] New-output dot (per-device viewed-at tracking) — `useDeviceId` (localStorage uuid) + `sessions.markViewed` (read-modify-write of `viewed_at_per_device`); `DomoChat` stamps it debounced while focused, so the dot only shows for *other* devices / background sessions. Smoke confirmed: device stamp newer than `lastEventAt` after a turn ⇒ no false dot on the open session.
- [x] Mark-done action + done state in DB — per-row kebab (`UDropdownMenu`) in `DomoLeftRailSessionList`: Rename (inline), Mark done / not done (`sessions.done`), Delete (`sessions.delete`, confirms; navigates away if the open session). Smoke: Mark done → row hidden (show-done off).
- [x] "Show done" toggle at top of left panel — pre-existing `DomoLeftRailFooter` switch (`useState('leftRail:showDone')`); smoke confirmed it reveals/hides done rows.

## 11. Diff approval round-trip

- [ ] `openDiff` parks the WS request, writes `pendingDiffs` row, emits a tool event
- [ ] Inline diff card in the chat with accept/reject buttons
- [ ] Full diff view in the workspace surface (`/p/.../f/*path` in `diff` mode)
- [ ] `POST /api/sessions/:id/diff-decision` → inbox `diff_decision` → entity resolves parked call with `FILE_SAVED` / `DIFF_REJECTED`
- [ ] Cleanup on session abort or env stop
