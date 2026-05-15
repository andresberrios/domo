# Phase 2 — Workspace

The right and bottom panels become useful: file tree + CodeMirror viewer/editor, a terminal pane backed by `coast exec`, and a VS Code-style git changes view.

## 5. Workspace surface

- [x] File tree component (`workspace.tree` procedure, lazy per-directory, honors `.gitignore` via `git check-ignore`, hides `.git`) — `DomoFileTree` / `DomoFileTreeNode`
- [x] CodeMirror 6 viewer, read-only first; language detection by extension (`workspace.read` returns a language id, client maps it via `app/utils/language.ts`) — `DomoCodeEditor`
- [x] Markdown view via Comark (`@comark/nuxt`) — `DomoMarkdownView`, toggled against editable source
- [x] Edit mode + save (`workspace.write` procedure); unsaved indicator + Save button on the file route
- [x] Path-safety: reject `..`, absolute paths outside the worktree, symlink traversal (`server/lib/workspace.ts` `safeResolve`)

## 6. Terminal pane

- [x] xterm.js + `@xterm/addon-fit` in the bottom panel — `DomoTerminal`
- [x] `WS /api/terminal?envId=…` proxying coastd's `WS /api/v1/exec/interactive` (an interactive shell inside the env's Coast instance); dumb bidirectional pass-through, client speaks coastd's frame protocol (`{session_id}` handshake, `\x01`+JSON resize)
- [x] Hide/expand panel state persisted server-side (`settings` table via `settings.get` / `settings.set`, `usePanelState`)

## 7. Git changes pane

- [x] `git.status` → branch/ahead/behind + staged/unstaged/untracked lists (`git status --porcelain=v1 -z --branch`)
- [x] Per-file diff using the same CodeMirror merge component (`git.diff` → before/after text, `DomoDiffView` = `@codemirror/merge`)
- [x] Stage / unstage / commit (with message input) / push — `git.stage` / `git.unstage` / `git.commit` / `git.push`, `DomoGitChanges`
- [x] Run all git operations on the host against the worktree path (`server/lib/git.ts`, injection-safe `execFile` argv)

## Notes / deferred

- The design's "Server routes" table is authoritative: workspace + git are
  **`nuxt-procedures`** (request/response), not classic `/api/` routes — the
  earlier `/api/workspace/tree` / `PUT /api/workspace/file` wording is
  superseded by `workspace.tree` / `workspace.write`.
- File ops read/write the **host worktree directly** with `node:fs` (the
  worktree is a host-side dir under Option A — host-side `claude`), not via
  coastd `/files/*`. Same for git (`execFile git` on the host).
- Logs preview tiles / `WS /api/logs` follow remain **deferred** — not in
  this phase's checklist; they ride along whenever the env screen gets its
  logs section (post-Phase-2 polish).
- Full interactive-terminal round-trip needs a live Coast container; the
  WS proxy + xterm wiring is verified to connect and the protocol/resize
  path is in place. Browser-tested file tree, editor, save, markdown,
  git status/diff/stage/commit, and graceful terminal degradation.
