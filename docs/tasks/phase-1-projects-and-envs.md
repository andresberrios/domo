# Phase 1 — Projects and environments

The left-rail tree comes to life: users can add a project (with git-init / Coastfile-init prompts), create a Coast env from it, and see the env's services and lifecycle in the center area.

## 3. Project setup flow

- [x] Server-side directory picker procedure (`fs.browse`) — scoped to `DOMO_PROJECTS_ROOT` (or `$HOME`) by default, but accepts any absolute path
- [x] `projects.add` procedure with discriminated-union output (`missing-git` / `missing-coastfile` / `missing-gitignore-worktrees` / `already-exists` / `ok`); UI confirms each step and retries with the corresponding `confirm*` flag
- [x] Coastfile-init heuristic: minimal `[coast] name = …` (user-overridable in modal), auto-detect `./docker-compose.yml` / `compose.yml`, empty `[ports]`
- [x] `coast build` integration with streaming progress UI — classic Nitro SSE proxy at `/api/projects/build`; rendered by `DomoBuildProgress`
- [x] Add `.worktrees/` to `.gitignore` if missing (with user prompt as the third confirm step)

## 4. Environment creation + env screen

- [x] Create-env form (name → branch = worktree = instance name) — `DomoAddEnvModal`, posting `envs.create` then streaming `coast run` via `/api/envs/run`
- [x] `POST /api/envs/run` SSE proxy → coastd `/stream/run`; env row status flips to `provisioning`, then settled via coastd events
- [x] Env overview screen (`/p/:project/e/:env`): header (status badge, checkout indicator), services table (`coast ps`), ports table with clickable dynamic URLs, worktree info, lifecycle buttons (stop/start/restart/checkout/release/delete)
- [x] Cached `coast ls` + live coastd events — `/api/coast-events` WS pass-through; `useCoastEvents` composable triggers `envs.list` / `envs.overview` refreshes
- [ ] Logs preview tiles with "follow" deep link — deferred to Phase 2 alongside the terminal pane
