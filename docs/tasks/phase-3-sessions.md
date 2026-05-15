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
- [x] Implement the 8 required IDE bridge tools (`openDiff`, `openFile`, `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `checkDocumentDirty`, `saveDocument`, `closeAllDiffTabs`) — **8c** (`server/lib/electric/bridge.ts`: standalone per-session RFC 6455 WS server, hand-rolled — design Decided #15; `getDiagnostics` also stubbed to `[]`. `openDiff` delegates to an injected resolver; the durable approval round-trip is step 11. Codec + MCP dispatch smoke-verified incl. 70 KB-payload reassembly; live claude-connect check rides on 8d like 8b)
- [x] Lock-file lifecycle at `~/.claude/ide/<port>.lock` (create on bridge boot, clean on `close()`; honors `CLAUDE_CONFIG_DIR`) — **8c**
- [x] Always strip `ANTHROPIC_API_KEY` (+ nested-claude session vars) from spawn env; set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (`server/lib/electric/claude.ts`)
- [x] Lock down `events` / `pendingDiffs` / `sessionMeta` / `inboxState` row schemas (`server/lib/electric/schemas.ts`; resolves design Pending Discussion 1)
- [x] Capture `session_id` from the first `system` event into `sessionMeta.nativeSessionId`; `--resume <id>` thereafter (live end-to-end check rides on 8d's `sessions.create`/`prompt`)

## 9. Chat surface

- [ ] Subscribe to the entity's durable stream via the Electric runtime client + TanStack DB
- [ ] Project `events` rows into `UIMessage.parts` for `UChatMessages`
- [ ] Reuse `MessageContent.vue` pattern (text / reasoning / tool parts)
- [ ] Tool renderers: Read, Glob, Grep, Edit, Write, Bash, TodoWrite, generic fallback
- [ ] Audit 2–3 open-source Claude Code VS Code wrappers for tool-card UX
- [ ] Prompt input with abort, edit-and-regenerate
- [ ] Slash-command popup (`/`-triggered): built-in commands + custom commands scanned from `<worktree>/.claude/commands/*.md` and `~/.claude/commands/*.md` with `$ARGUMENTS` substitution — see [Chat input affordances](../initial-design.md#chat-input-affordances)
- [ ] `@`-mention popup: file/folder/git-changes/commit-sha/url; inline chip rendering; server-side expansion before send

## 10. Session lifecycle UI

- [ ] Status indicators per session row: `active` / `waiting` / `pending-approval` / `error`
- [ ] New-output dot (per-device viewed-at tracking)
- [ ] Mark-done action + done state in DB
- [ ] "Show done" toggle at top of left panel

## 11. Diff approval round-trip

- [ ] `openDiff` parks the WS request, writes `pendingDiffs` row, emits a tool event
- [ ] Inline diff card in the chat with accept/reject buttons
- [ ] Full diff view in the workspace surface (`/p/.../f/*path` in `diff` mode)
- [ ] `POST /api/sessions/:id/diff-decision` → inbox `diff_decision` → entity resolves parked call with `FILE_SAVED` / `DIFF_REJECTED`
- [ ] Cleanup on session abort or env stop
