# Installing Domo and keeping it updated

How an installed Domo is laid out, run and updated, and why. The code is
`bin/domo.mjs`, `scripts/install.sh` and `server/lib/updates.ts`. Read this
before you change any of them.

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
  app/          shallow clone (--depth 1) of andresberrios/domo; only fetched, never run
  releases/     one git worktree per commit, with its own node_modules and .output
  current  ->   releases/<sha>      the release the server runs from
  previous ->   releases/<sha>      the one before it, kept for rollback
  node/         the official Node LTS tarball for this platform (.node-version)
  bin/          caddy, uv, pnpm, domo.mjs (the launcher) and `domo`, a shim for it
  data/         uploads, models, voices, install-id, pocket-tts.pid (NUXT_DATA_DIR)
  .env          keys and overrides, read by the launcher at every server start
  state.json    channel, last apply; logs/domo.log, logs/update.log
  supervisor.pid, update.lock (a live pid), restart-requested, update-failed.json
```

Docker, git and a browser come from the machine. Everything else comes with
Domo: Node, pnpm, Caddy, `uv` (for Pocket TTS), the ACP adapters and the
coding-agent CLIs (already npm dependencies; Claude Code ships inside the
Claude ACP adapter, Codex and OpenCode ship their binaries), the ONNX speech
models (downloaded into `data/models` on first use, as today). Postgres and
Electric run in Docker from the checked-in `docker-compose.prod.yml`: those
two services only, project `domo-prod`, ports 54322 and 30002, a volume of
its own. The development stack (`docker-compose.yml`: project `domo`, ports
54321 and 30000, plus the test layer's database) is a different stack, so a
machine that develops Domo runs both. They once shared a project name, and
the installed Domo's `compose up` stopped the development stack and every
environment's as surplus replicas of its own.

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
   restarts either if it dies, and treats a server exit as a restart request
   when the server left a `restart-requested` file (or exited `75`); anything
   else is a crash with backoff. After a restart it waits for the app shell
   to answer; if the new release does not within sixty seconds it swaps
   `current` and `previous` back, restarts, and writes `update-failed.json`,
   which the server shows as a failed update.
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

- Every `checkIntervalMinutes` (default 60, minimum 5), twenty seconds after
  boot, and when settings change, the server runs
  `domo update --check --json`. That is a plain `git fetch` of the channel
  (explicit refspec, so a channel other than the one cloned works) in the
  shallow `app/` clone, which brings only the commits between the installed
  one and the tip; then, when the installed commit is an ancestor of the tip,
  `git rev-list --count` and `git log` for the changelog, otherwise `behind`
  is `null`: "an update, count unknown". `--depth` on the fetch is avoided on
  purpose; it re-measures from the tip and can pull the whole history. No
  GitHub compare API: an unknown count is shown as such.
- The result is one row of the synced table `app_update` (`REPLICA IDENTITY
  FULL`, written once per check or state change): see `AppUpdate` in
  `shared/types`. The UI renders only this row. A failed fetch leaves
  `behind` as it was and records the error; it never writes zero.
- **Channel** is a branch name, default `release`. Deploying from the dev
  checkout is then `git push origin main:release`, and the installed Domo
  picks it up within the hour. Anyone else installs on `release` and gets
  what was pushed there; `main` is available for the brave. The channel is
  a setting whose default is what the installer was given (`DOMO_CHANNEL`,
  kept in `state.json` and passed to the server by the launcher).

Settings, in `AppSettings.updates`, with a card at Settings → Updates:

```
updates: {
  channel: 'release',
  checkIntervalMinutes: 60,
  autoApply: false,
  minHoursBetweenApplies: 1
}
```

`app/pages/settings/updates.vue` shows the installed commit and date, the
state, the changelog, "Check now", "Update now" (or "Restart now" once a
build is waiting), the auto-apply switch and the two intervals, and the last
error. `UpdateBadge.vue` in the sidebar footer shows "3 commits behind" and
links there. Both read `useAppUpdate()`.

## Applying an update

Applying is a job run by **a detached updater process**,
`domo update --no-restart`, the same file as the supervisor with a different
subcommand. The server spawns it detached with its output appended to
`logs/update.log`, keeps the row at `building`, and reads the result from the
exit code and from where `current` points. If the server is restarted under
it, the build goes on; the next server finds the live `update.lock` and
watches it. Steps:

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
5. Point `previous` at the old `current` and `current` at the new release,
   delete every other release, and exit. The server, seeing `current` differ
   from its own commit, marks the row `ready` and waits for a quiet moment
   (see below); then it writes `restart-requested`, marks `restarting`, and
   sends itself SIGTERM, which runs Nitro's close hooks. The supervisor does
   the rest, including rollback. On any failure before step 5 the unfinished
   worktree is removed and the running release is untouched.

**A quiet moment** means all of these, checked by the server, which is the
only process that knows:

- no `agent_sessions` row in `starting`, `thinking` or `awaiting-permission`,
  and no adapter process alive in `acpManager`;
- no `voice_sessions` row that is not `idle`;
- no `dev_environments` row in `creating`;
- no cron job due in the next two minutes.

`restartBlockers()` in `repo.ts` answers this, as phrases the row carries
in `blockers` so the card can say what it is waiting for. The server
re-checks every thirty seconds for as long as it takes; a turn started in
that window is allowed, because refusing work the way Hermes's drain does
is worse for the user than a later restart. "Restart now" in the UI forces
it, and says that it interrupts whatever is running.

**Auto-apply** (`shouldAutoApply()`, pure and unit-tested) starts the same
path when the check finds the setting on, something new that is not the
target that just failed, no build or restart in progress, and the last
switch more than `minHoursBetweenApplies` ago. Building runs while agents
work, since it touches nothing they use; only the restart waits.

**Rollback** is the supervisor's: a release that does not come up within
sixty seconds of starting is swapped back for `previous`.

## Installing

`scripts/install.sh` in the repo, served as `https://domo.sh` or the raw
GitHub URL, run as `curl -fsSL … | sh`:

1. Check for `docker` (running), `git`, `curl`, `tar` and a supported
   platform (macOS arm64/x64, Linux x64/arm64). Stop with one line saying
   what is missing.
2. `git clone --depth 1 --branch release` into `~/.domo/app`. (git ignores
   `--depth` for a plain local path, so a test against a local checkout
   names it as `file:///…`.)
3. Download the Node LTS tarball named in `.node-version` into `~/.domo/node`,
   and the pnpm, Caddy and `uv` binaries for the platform into `~/.domo/bin`
   (versions pinned in the script).
4. Hand over to `domo install`, which writes `.env` from `.env.example` if
   absent, runs `domo update --force --no-restart` to build and place the
   first release, installs the launchd or systemd unit, starts it, runs
   `caddy trust` against the running server's admin socket (`~/.domo/caddy.sock`;
   `caddy trust` asks a running server for its root certificate, so it cannot
   go before the start) and opens the browser. `--no-service` stops after the
   build, for running `domo run` under a supervisor of one's own.

`domo` subcommands: `run` (the supervisor), `start`, `stop`, `restart`,
`status`, `trust`, `logs`, `update [--check] [--json] [--channel …] [--force]
[--no-restart]`, `install`, `uninstall`. One plain `.mjs` file at
`bin/domo.mjs`, so it needs no build step and runs on the bundled Node.

## Moving a machine from `pnpm dev` to an install

The installed Domo gets its own stack and a copy of the data. It never runs
on the development stack, whose Postgres is the one `pnpm test` and the
environments' checks use.

1. Install (`scripts/install.sh`). The first start creates the schema in the
   empty `domo-prod` database.
2. `domo stop`, stop prod's Electric, and copy the data over:
   ```sh
   docker compose -f docker-compose.prod.yml rm -sf electric
   docker exec domo-postgres-1 pg_dump -U postgres -Fc --no-publications --no-subscriptions domo \
     | docker exec -i domo-prod-postgres-1 pg_restore -U postgres -d domo --clean --if-exists --no-owner
   cp -R .data/ ~/.domo/data
   ```
   Electric is removed, not stopped, so it comes back with no shape cache from
   before the copy. `--no-publications` leaves Electric's publication to the
   Electric that owns the database.
3. Point `NUXT_DATA_DIR` in `~/.domo/.env` at `~/.domo/data` (the launcher's
   default), stop `pnpm dev` for good, and `domo start`. The checkout becomes a
   development checkout only: merge freely, run tests, work in environments.
   Deploy by pushing `release`. For an in-browser check of unmerged work, use
   the scratch recipe below.

## Testing a change to any of this

Install the branch into a scratch home against a scratch stack, so the real
`domo` database and the real service are never touched:

```sh
COMPOSE_PROJECT_NAME=domo-inst DOMO_PG_PORT=54331 DOMO_ELECTRIC_PORT=30010 \
  docker compose -f docker-compose.prod.yml up -d
mkdir -p /tmp/domo-home && printf '%s\n' \
  DATABASE_URL=postgresql://postgres:password@localhost:54331/domo \
  ELECTRIC_URL=http://localhost:30010 COMPOSE_PROJECT_NAME=domo-inst \
  DOMO_PG_PORT=54331 DOMO_ELECTRIC_PORT=30010 \
  DOMO_PORT=3867 DOMO_HTTPS_ADDRESS=localhost:3866 \
  NUXT_DEV_ENV_RESOURCE_PREFIX=domo-inst- > /tmp/domo-home/.env
DOMO_HOME=/tmp/domo-home DOMO_REPO=file://$PWD DOMO_CHANNEL=<branch> \
  DOMO_INSTALL_ARGS="--skip-trust --no-open" sh scripts/install.sh
```

Then open `https://localhost:3866`, commit to the branch, and watch Settings →
Updates. Afterwards `DOMO_HOME=/tmp/domo-home /tmp/domo-home/bin/domo uninstall`,
`docker compose -p domo-inst down -v`, and remove `/tmp/domo-home`. The
launchd label is `com.domo.app` whichever home is used, so the scratch
service and a real one cannot run at the same time.

For Linux, `test/helpers/install-linux.sh` runs the same install with
`--no-service` and `domo run` in a Debian container with the host's Docker
socket, cloning from a bare copy of the branch (a worktree's `.git` is a
pointer the container cannot follow):

```sh
git clone --bare . /tmp/domo-src.git
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v $PWD:/src:ro \
  -v /tmp/domo-src.git:/repo.git:ro -v $PWD/test/helpers/install-linux.sh:/test.sh:ro \
  --add-host host.docker.internal:host-gateway debian:bookworm-slim sh /test.sh <branch>
```

It proves the downloads, the build, the supervisor and the update check on
Linux; the systemd unit itself is not exercised, since a container has no
systemd.
