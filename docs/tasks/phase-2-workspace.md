# Phase 2 — Workspace

The right and bottom panels become useful: file tree + CodeMirror viewer/editor, a terminal pane backed by `coast exec`, and a VS Code-style git changes view.

## 5. Workspace surface

- [ ] File tree component (`/api/workspace/tree`, honors `.gitignore`)
- [ ] CodeMirror 6 viewer, read-only first; language detection by extension
- [ ] Markdown view via Comark
- [ ] Edit mode + save (`PUT /api/workspace/file`); unsaved indicator
- [ ] Path-safety: reject `..`, absolute paths outside the worktree, symlink traversal

## 6. Terminal pane

- [ ] xterm.js + addon-fit in the bottom panel
- [ ] `WS /api/terminal?envId=…` proxying an interactive `coast exec <env>` shell
- [ ] Hide/expand panel state persisted server-side

## 7. Git changes pane

- [ ] `GET /api/git/status` → staged/unstaged lists
- [ ] Per-file diff using the same CodeMirror merge component
- [ ] Stage / unstage / commit (with message input) / push
- [ ] Run all git operations on the host against the worktree path
