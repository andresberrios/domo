# Phase 3 — Agent sessions

The chat surface comes online: Electric Agents host the `claude-code-cli` entity, the IDE bridge handles approvals, and the diff-approval round-trip ties chat to the workspace.

## 8. Electric Agents bring-up

- [ ] Run `@electric-ax/agents-server` as a sidecar process; healthcheck in Domo
- [ ] Mount `/_electric/builtin-agent-handler` Nitro route delegating to `runtime.onEnter`
- [ ] Define `claude-code-cli` entity (host-side spawn variant for v1 — see Pending Decision 1 in [`README.md`](README.md))
- [ ] Implement the 8 required IDE bridge tools (`openDiff`, `openFile`, `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `checkDocumentDirty`, `saveDocument`, `closeAllDiffTabs`)
- [ ] Lock-file lifecycle at `~/.claude/ide/<port>.lock` (create on entity boot, clean on shutdown)
- [ ] Always strip `ANTHROPIC_API_KEY` from spawn env
- [ ] Lock down `events` row schema and `pendingDiffs` row schema (see Pending Decision 5)
- [ ] Capture `session_id` from the first `system` event into `sessionMeta.nativeSessionId`; use `--resume <id>` thereafter

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
