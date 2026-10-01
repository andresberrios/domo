# Installing Domo and keeping it updated

Design (October 2026). The install, the supervisor and `domo update` exist
(`bin/domo.mjs`, `scripts/install.sh`); the in-app check, the Updates card,
the quiet-moment gate and auto-apply do not yet. Read it before you work on
any of them, and delete it once the code and `README.md` say the same thing.

## What Hermes does, and what to copy

Hermes Desktop (NousResearch/hermes-agent) is the reference the user likes:
the badge in the bottom-right corner that says "N commits behind main".
Read from the source in `~/.hermes/hermes-agent` on this machine.

How it works:

- **The install is a git checkout** (`~/.hermes/hermes-agent`), not a package.
  Hermes bundles its own runtimes next to it: a Node tarball in
  `~/.hermes/node`, a Python venv inside the checkout, `uv` and other tools in
  `~/.hermes/bin`. Only Docker and git come from the machine.
- **The check** is `git fetch origin main` (scoped to the one branch, 10 s
  timeout) and then `git rev-list --count HEAD..origin/main`. The result is
  cached for six hours in a file and rendered by the CLI banner and the
  desktop badge. Shallow clones cannot count, so Hermes compares tip SHAs and
  asks the GitHub compare API for the number; a failed fetch never produces a
  false "up to date".
- **`hermes update`** is one sequential pipeline: snapshot of runtime state,
  `git pull` (auto-stash of local edits, a backup ref if `main` diverged),
  compile-check of startup files with `git reset --hard` to the previous SHA
  on failure, dependency install, config migration, then a desktop rebuild
  and a **drain-first restart** of the gateway: it refuses new turns and waits
  up to thirty minutes for in-flight work before exiting.
- **The desktop rebuild happens in a detached script** that runs after the
  updater exits and swaps the packaged app on disk. A lock marker
  (`.hermes-update-in-progress`) parks every new backend spawn while an update
  owns the install. A build stamp (`commit`, `builtAt`) written into the
  bundle lets a running instance notice that the bundle under it was swapped.

What went wrong for them, from their own issue tracker:

- An auto-updater that extracted a release zip over the checkout desynced
  git from the files, and the "up to date" badge compared against a release
  tag while the CLI compared against `origin/main`.
- A rebuild on every boot regardless of whether the SHA changed, which killed
  active chats in a loop.
- The update lock expiring while the updater was still working.
- A cache that kept showing "N commits behind" for hours after the update.

Lessons for Domo: git stays the single source of truth for what is
installed; the running server never rebuilds or replaces itself, a separate
process does; build the new version beside the running one and switch, never
in place; rebuild only when the commit changed; a lock is held by a live pid,
not by a timestamp; recompute the badge from the checkout after an update.

## Layout of an installed Domo

Everything under one directory, `~/.domo` by default (`DOMO_HOME`):

```
~/.domo/
  app/          full git clone of andresberrios/domo; only fetched, never run
  releases/     one git worktree per commit, with its own node_modules and .output
  current  ->   releases/<sha>      the release the server runs from
  previous ->   releases/<sha>      the one before it, kept for rollback
  node/         the official Node LTS tarball for this platform (.node-version)
  bin/          caddy, uv, pnpm, domo.mjs (the launcher) and `domo`, a shim for it
  data/         uploads, models, voices, pocket-tts.pid (NUXT_DATA_DIR)
  .env          keys and overrides, read by the launcher at every server start
  state.json    channel, last apply; logs/domo.log; supervisor.pid; update.lock
```

Docker, git and a browser come from the machine. Everything else comes with
Domo: Node, pnpm, Caddy, `uv` (for Pocket TTS), the ACP adapters and the
coding-agent CLIs (already npm dependencies; Claude Code ships inside the
Claude ACP adapter, Codex and OpenCode ship their binaries), the ONNX speech
models (downloaded into `data/models` on first use, as today). Postgres and
Electric keep running in Docker through the checked-in `docker-compose.yml`;
the compose project name `domo` means the existing volume is reused.

A release is a worktree with a full `pnpm install`, not just the `.output`.
Nitro's tracing carries the adapters' JavaScript but not the platform
packages they resolve at run time (Codex's binary, Claude Code's, OpenCode
altogether), and `adapterEntry()` resolves from the working directory first,
so the server runs with the worktree as its cwd. pnpm links every package
from one store, so a second release costs little disk and installs in
seconds.

## Processes

Three processes, and no more:

1. **The supervisor**, `~/.domo/bin/domo run`, a small plain-JavaScript file
   with no dependencies, started at login by launchd (macOS,
   `~/Library/LaunchAgents/com.domo.app.plist`, `KeepAlive`) or a systemd user
   unit (Linux). It loads `.env`, starts Caddy and the server from `current`,
   restarts either if it dies, and handles two exit codes from the server:
   `75` means "restart me onto `current`", anything else is a crash. After a
   restart it waits for `/api/health` to answer; if the new release does not
   answer within sixty seconds it swaps `current` and `previous` back,
   restarts, and writes the failure where the server can show it.
   The launcher is copied from the release on every update when it differs;
   the running supervisor keeps the code it started with, so an update that
   changed the launcher restarts the whole service (`launchctl kickstart -k`
   or `systemctl --user restart`) instead of only the server.
2. **Caddy**, as today, from the `Caddyfile` in the release.
3. **The Nitro server**, `node current/.output/server/index.mjs` with cwd
   `current`, `PORT`, `HOST=0.0.0.0`, `DOMO_HTTPS_ADDRESS`, `NUXT_DATA_DIR`,
   `NITRO_SHUTDOWN_TIMEOUT=5000` (Electric's long-polls would otherwise make
   every restart a thirty-second drain) and the `.env` variables, with the
   PATH of the user's login shell so agents find git, docker and Homebrew.
   Readiness is `GET /` answering, not `/api/health`: that route waits on
   Postgres, and a database that is down is the UI's banner, not a bad build.

There is no Electron app in this plan. A web app installed as a service gives
the user everything Hermes Desktop gives them except a dock icon, and avoids
Hermes's most painful class of bugs (renderer and backend from different
builds). A menu-bar tray item that opens the browser and shows the update
badge can be added later as a tiny separate process without changing any of
this.

## The update check

A module `server/lib/updates/` in the server, started by `boot.ts` like the
cron scheduler. It does nothing when Domo is not an installed instance
(`DOMO_HOME` unset, which is every `pnpm dev`).

- Every `checkIntervalMinutes` (default 60, minimum 5) and on boot:
  `git -C ~/.domo/app fetch origin <channel> --quiet` with a 15 s timeout,
  then `git rev-list --count HEAD..origin/<channel>` and
  `git log --format=%H%x1f%s%x1f%aI HEAD..origin/<channel>` for the changelog.
  The clone is always full, so the count is exact; no shallow-clone or
  compare-API paths.
- The result is written to one row of a new synced table, `app_update`
  (single row, `REPLICA IDENTITY FULL`, written at most once per check or
  state change): `installedCommit`, `installedAt`, `channel`, `behind`,
  `commits` (the changelog), `checkedAt`, `state`
  (`idle | checking | downloading | building | ready | restarting | failed`),
  `lastError`, `lastAppliedAt`. The UI renders only this row, as everywhere
  else in Domo. A failed fetch leaves `behind` as it was and records the
  error; it never writes zero.
- **Channel** is a branch name, default `release`. Deploying from the dev
  checkout is then `git push origin main:release`, and the installed Domo
  picks it up within the hour. Anyone else installs on `release` and gets
  what was pushed there; `main` is available for the brave.

Settings, in `AppSettings.updates`, with a card at Settings → Updates:

```
updates: {
  channel: 'release',
  checkIntervalMinutes: 60,
  autoApply: false,
  minHoursBetweenApplies: 1
}
```

The card shows the installed commit and date, the badge count, the changelog,
"Check now", "Update now", the auto-apply toggle and the two intervals, and
the last error. The sidebar footer shows the badge ("3 commits behind") and
links to the card, which is the Hermes behaviour the user asked for.

## Applying an update

Applying is a job run by **a detached updater process**, `domo update`, the
same file as the supervisor with a different subcommand. The server spawns it
detached and watches the `app_update` row the updater writes to (the updater
is given `DATABASE_URL` and writes through a small copy of the row writer, or
writes a JSON status file that the server mirrors into the row; the file is
simpler and keeps the updater free of `pg`). Steps:

1. Take `~/.domo/update.lock` holding the updater's pid. A lock whose pid is
   dead is stale and taken over. No expiry by time.
2. `git fetch origin <channel>` in `app/`, which is never checked out or
   edited, so there is nothing to stash and nothing to merge. If
   `releases/<sha>/build.json` exists, skip to step 5; a worktree without it
   did not finish and is removed and built again.
3. `git worktree add --detach releases/<sha> <sha>`, then
   `pnpm install --frozen-lockfile` and `pnpm build` inside it with the
   bundled Node and pnpm, then write `build.json` (`commit`, `builtAt`,
   `nodeVersion`, `subject`).
4. Smoke test: start the release on a spare port with
   `DATABASE_URL=postgresql://127.0.0.1:1/none` and `ELECTRIC_URL` likewise, and
   require `GET /` to answer within thirty seconds. This proves the bundle
   loads and serves without ever touching the real database (a real boot
   marks every session stopped).
5. Wait for a quiet moment (see below), then point `previous` at the old
   `current`, `current` at the new release, and ask the server to exit with
   code `75`. The supervisor does the rest, including rollback.
6. Delete every release that is neither `current` nor `previous`. Release the
   lock. On any failure before step 5, delete the `.building` directory,
   write the error, and leave the running release untouched.

**A quiet moment** means all of these, checked by the server, which is the
only process that knows:

- no `agent_sessions` row in `starting`, `thinking` or `awaiting-permission`,
  and no adapter process alive in `acpManager`;
- no `voice_sessions` row that is not `idle`;
- no `dev_environments` row in `creating`;
- no cron job due in the next two minutes.

The server exposes this as `canRestartNow()`. When the updater is ready and
the moment is not quiet, the server marks the row `ready` and re-checks every
thirty seconds for as long as it takes; a turn that is started in that window
is allowed, because refusing work the way Hermes's drain does is worse for the
user than a later restart. "Update now" from the UI forces the restart after
the running turns end, and says so.

**Auto-apply** runs the same path when `autoApply` is on, `behind > 0`, the
last apply was more than `minHoursBetweenApplies` ago, no update is in
progress, and the moment is quiet at the time the check finishes. The
building (steps 1 to 4) may run while agents work, since it touches nothing
they use; only step 5 waits.

**Rollback** is the supervisor's: a release that does not answer health within
sixty seconds of starting is swapped back for `previous`. The updater also
refuses to apply a release whose `build.json` names a different major Node
than the bundled one.

## Installing

`scripts/install.sh` in the repo, served as `https://domo.sh` or the raw
GitHub URL, run as `curl -fsSL … | sh`:

1. Check for `docker` (running), `git`, and a supported platform
   (macOS arm64/x64, Linux x64/arm64). Stop with one line saying what is
   missing.
2. `git clone` (full) into `~/.domo/app`, checkout `origin/release`.
3. Download the Node LTS tarball named in `app/.node-version` into
   `~/.domo/node`; `corepack enable --install-directory ~/.domo/bin` for pnpm;
   download the Caddy and `uv` binaries for the platform into `~/.domo/bin`.
4. `pnpm install --frozen-lockfile && pnpm build`, place the release, point
   `current` at it, copy the launcher to `~/.domo/bin/domo`.
5. Write `~/.domo/.env` from `.env.example` if absent. Keys can be added later
   in Settings; the first screen says what is missing.
6. `docker compose up -d` from `app/`, `caddy trust`, install the launchd or
   systemd unit, start it, open `https://localhost:3666`.

`domo` subcommands: `run` (the supervisor), `start`, `stop`, `restart`,
`status`, `update [--check]`, `logs`, `uninstall`. The CLI is one plain `.mjs`
file at `bin/domo.mjs` in the repo, so it needs no build step and runs on the
bundled Node.

## Moving this machine over

Today `pnpm dev` runs in the main checkout, so every merge restarts it and
kills the agents. After this work:

1. Build and test the installer against a scratch stack first
   (`docs/working-on-domo.md`, "A second dev server"), with `DOMO_HOME=/tmp/x`.
2. Stop `pnpm dev`. Run the installer with the real compose stack and move
   `.data` to `~/.domo/data`. Start the service. The `domo` database is reused
   as it is.
3. The checkout in `Projects/everynow/domo` becomes a development checkout
   only: merge freely, run tests, work in environments. Deploy by pushing
   `release`. For an in-browser check of unmerged work, use the scratch-stack
   recipe, which already exists.

## Order of work

1. Done: `bin/domo.mjs` (supervisor, start/stop/restart/status/logs, update,
   install, uninstall), launchd and systemd units, `scripts/install.sh`,
   `.node-version`. Verified by installing into `/tmp` against a scratch
   stack (`DOMO_HOME=/tmp/x DOMO_REPO=<local path> DOMO_CHANNEL=<branch>
   DOMO_INSTALL_ARGS="--skip-trust --no-open" sh scripts/install.sh`, with a
   `.env` naming the scratch ports and `COMPOSE_PROJECT_NAME`), running one
   agent per adapter, updating to a new commit, and rolling back a release
   whose server throws on start. Not yet verified on Linux.
2. The check: `server/lib/updates/`, the `app_update` table, settings, the
   Updates card and the sidebar badge.
3. Applying: `domo update`, the quiet-moment gate, exit code `75`, rollback,
   auto-apply.
4. Switch this machine; update `README.md` (Quick start becomes the one-line
   installer, `pnpm dev` moves under a Development heading) and delete this
   file.
