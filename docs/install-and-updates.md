# Installing Domo and keeping it updated

How Domo is released, and how an installed Domo is laid out, run and updated,
and why. The code is `scripts/release.mjs` and
`.github/workflows/release.yml` (releases), `bin/domo.mjs`,
`scripts/install.sh` and `server/lib/updates.ts`. Read this before you change
any of them.

The rules everything below follows: an install runs only what a release
ships, built by CI, never source and never a build on the user's machine;
the running server never replaces itself, a separate process does; a new
version is downloaded beside the running one and switched to, never in
place, and only after it matched its checksum and started; a lock is held by
a live pid, not a timestamp.

## Releases

Every push to `release` runs `.github/workflows/release.yml`: it builds on
each platform (macOS arm64 and x64, Linux x64 and arm64, glibc) and publishes
a GitHub Release to `andresberrios/domo-releases`, a public repository with
no source. Installs read it without an account. The version is the commit's
UTC date and short hash, `2026.10.15-ab18e19`, so every job that builds one
commit agrees on it. Each release holds:

- `domo-<version>-<os>-<arch>.tar.gz`, one directory `domo/` with the built
  app (`.output`), a `node_modules` with only the packages the server
  resolves from its working directory, the launcher, the `Caddyfile`, the
  production compose file, `.tool-versions` (without pnpm: nothing is built)
  and `build.json` (`version`, `commit`, `subject`, `builtAt`, `platform`).
  No source: the release build (`DOMO_RELEASE_BUILD=1` in `nuxt.config.ts`)
  writes no source maps, which embed the source, and minifies the server.
- `manifest.json`: the version, the Node it runs on, the launcher's checksum,
  each platform's tarball with its sha256 and size, and the last hundred
  releases with the commits each brought, newest first, so an install several
  releases behind can list what it would get. `version`, `node` and
  `launcherSha256` sit on lines of their own: `install.sh` reads them with sed.
- `SHA256SUMS`, `domo.mjs` (the launcher) and `install.sh`.

A release is built on the platform it is for. Nitro's tracing carries the
adapters' JavaScript but not the platform binaries they resolve at run time
(Claude Code's, Codex's, OpenCode's), and it traces sharp and the ONNX
runtime for the machine it runs on. So the tarball's `node_modules` is a
fresh `pnpm install --prod` of the four packages `adapterEntry()` and
`codexBinary()` resolve, from the same lockfile, hoisted into plain
directories; the server runs with the release as its cwd. OpenCode's
postinstall copies its binary into `@opencode/cli/bin`, and the platform
package it came from is dropped as a second copy. A tarball is about 450 MB,
most of it the three agents' binaries.

The manifest is cumulative: the publish job downloads the latest one and adds
the new release on top. The release is a draft until every file is up, since
`latest/download/…` is what installs read.

## Layout of an installed Domo

Everything under one directory, `~/.domo` by default (`DOMO_HOME`):

```
~/.domo/
  releases/     one unpacked release per version
  current  ->   releases/<version>      the release the server runs from
  previous ->   releases/<version>      the one before it, kept for rollback
  node/         the official Node tarball for this platform (.tool-versions)
  bin/          caddy, uv, domo.mjs (the launcher) and `domo`, a shim for it
  data/         uploads, models, voices, install-id, pocket-tts.pid (NUXT_DATA_DIR)
  .env          absent: Domo is set up in the app. A developer's overrides (docs/configuration.md) if one is made
  state.json    feed (when not the default), last apply; logs/domo.log, logs/update.log
  supervisor.pid, update.lock (a live pid), restart-requested, update-failed.json
```

Docker, git and a browser come from the machine; the installer installs git
when it is missing (below). Everything else comes with Domo: Node, Caddy,
`uv` (for Pocket TTS), the ACP adapters and the coding-agent CLIs, the ONNX
speech models (fetched into `data/models` at boot, see `docs/voice.md`).
Postgres and Electric run in Docker from the release's
`docker-compose.prod.yml`: those two services only, project `domo-prod`,
ports 54322 and 30002, a volume of its own. The development stack
(`docker-compose.yml`: project `domo`, ports 54321 and 30000, plus the test
layer's database) is a different stack, so a machine that develops Domo runs
both. Never give the two one compose project name: `compose up` of one stops
the other's containers as surplus replicas.

## Processes

Three processes, and no more:

1. **The supervisor**, `~/.domo/bin/domo run`, a small plain-JavaScript file
   with no dependencies, started at login by launchd (macOS,
   `~/Library/LaunchAgents/com.domo.app.plist`, `KeepAlive`) or a systemd user
   unit (Linux). It loads `.env` if there is one, starts Caddy and the server from `current`,
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
2. **Caddy**, from the `Caddyfile` in the release.
3. **The Nitro server**, `node current/.output/server/index.mjs` with cwd
   `current`, `PORT`, `HOST=0.0.0.0`, `DOMO_HTTPS_ADDRESS`, `NUXT_DATA_DIR`,
   `NITRO_SHUTDOWN_TIMEOUT=5000` (Electric's long-polls would otherwise make
   every restart a thirty-second drain), the production stack's
   `DATABASE_URL` and `ELECTRIC_URL`, and any `.env` overrides, with the
   PATH of the user's login shell so agents find git, docker and Homebrew.
   Readiness is `GET /` answering, not `/api/health`: that route waits on
   Postgres, and a database that is down is the UI's banner, not a bad release.

## The update check

`server/lib/updates.ts`, started by `boot.ts` like the cron scheduler. It does
nothing when Domo is not an installed instance (`DOMO_HOME` unset, which is
every `pnpm dev`).

- Every `checkIntervalMinutes` (default 60, minimum 5), twenty seconds after
  boot, and when settings change, the server runs
  `domo update --check --json`, which reads `<feed>/latest/download/manifest.json`.
  The feed is `https://github.com/andresberrios/domo-releases/releases`, or
  `DOMO_FEED` (environment, `.env`, or `state.json`, where `domo install`
  keeps the one it was given). `behind` is the number of commits in the
  releases between the installed one and the newest, from the manifest's
  history; `null` is "an update, count unknown": the installed release is
  older than the history, or was built from git (below).
- The result is one row of the synced table `app_update` (`REPLICA IDENTITY
  FULL`, written once per check or state change): see `AppUpdate` in
  `shared/types`. Its `installedCommit` and `targetCommit` hold release
  versions; `shared/releases.ts` shows a commit short and a version whole.
  The UI renders only this row. A failed check leaves `behind` as it was and
  records the error; it never writes zero.
- There is one feed and no channel: `--channel` is still accepted from a
  server that passes it, and ignored.

Settings, in `AppSettings.updates`, with a card at Settings → Updates:

```
updates: {
  checkIntervalMinutes: 60,
  autoApply: false,
  minHoursBetweenApplies: 1
}
```

`app/pages/settings/updates.vue` shows the installed version and date, the
state, the changelog, "Check now", "Update now" (or "Restart now" once a
release is waiting), the auto-apply switch and the two intervals, and the
last error. `UpdateBadge.vue` in the sidebar footer shows "3 commits behind"
and links there. Both read `useAppUpdate()`.

## Applying an update

Applying is a job run by **a detached updater process**,
`domo update --no-restart`, the same file as the supervisor with a different
subcommand. The server spawns it detached with its output appended to
`logs/update.log`, keeps the row at `building` (shown as downloading), and
reads the result from the exit code and from where `current` points. If the
server is restarted under it, the job goes on; the next server finds the live
`update.lock` and watches it. Steps:

1. Take `~/.domo/update.lock` holding the updater's pid. A lock whose pid is
   dead is stale and taken over. No expiry by time.
2. Read the manifest. If `releases/<version>/build.json` exists, skip to
   step 4.
3. Stream this platform's tarball into `releases/.download-*`, hashing it on
   the way; a sha256 that differs from the manifest's stops here. Unpack it
   beside the download and rename it to `releases/<version>` whole, so a
   release directory with `build.json` is always complete.
4. Bring the tools the release's `.tool-versions` names (`ensureTools`: Node
   by swapping the directory, Caddy, `uv`), so a release moves any of them.
5. Smoke test: start the release on a spare port with
   `DATABASE_URL=postgresql://127.0.0.1:1/none` and `ELECTRIC_URL` likewise, and
   require `GET /` to answer within thirty seconds. This proves the bundle
   loads and serves without ever touching the real database (a real boot
   marks every session stopped). A release that fails is deleted, so the
   next attempt downloads it again.
6. Point `previous` at the old `current` and `current` at the new release,
   delete every other release, replace the launcher if the release's
   differs, and exit. The server, seeing `current` differ from its own
   release, marks the row `ready` and waits for a quiet moment (see below);
   then it writes `restart-requested`, marks `restarting`, and sends itself
   SIGTERM, which runs Nitro's close hooks. The supervisor does the rest,
   including rollback. On any failure before this step the running release
   is untouched.

**A quiet moment** means all of these, checked by the server, which is the
only process that knows:

- no `agent_sessions` row in `starting`, `thinking` or `awaiting-permission`;
- no inbox message younger than two minutes still waiting, which is most
  often a subscription note about to wake an idle agent. An older one does
  not hold the restart, and the boot delivers anything from the last hour;
- no `dev_environments` row in `creating` or `upgrading`;
- no cron job due in the next two minutes.

`restartBlockers()` in `repo.ts` answers this, as phrases the row carries
in `blockers` so the card can say what it is waiting for. The server
re-checks every thirty seconds for as long as it takes; a turn started in
that window is allowed, because refusing work until a restart is worse for
the user than a later restart. "Restart now" in the UI forces
it, and says that it interrupts whatever is running.

**Auto-apply** (`shouldAutoApply()`, pure and unit-tested) starts the same
path when the check finds the setting on, something new that is not the
target that just failed, no update or restart in progress, and the last
switch more than `minHoursBetweenApplies` ago. Downloading runs while agents
work, since it touches nothing they use; only the restart waits.

**Rollback** is the supervisor's: a release that does not come up within
sixty seconds of starting is swapped back for `previous`.

### Installs that were built from git

Before releases, an install was a shallow clone in `~/.domo/app` and each
release a git worktree of it, built on the machine. Such an install moves
onto releases by itself: its old launcher takes the commit that brought this
launcher from `release` as an ordinary update, builds and switches to it,
and copies the new launcher into `bin/`. From then on its checks read the
feed. A release built from git has a `.git` file; it always counts as
behind, even against the release of its own commit, so the next update
downloads that release. The git-built one stays as `previous` for rollback;
the update after that prunes it, and with no release left that came from
git, `app/` is removed. `.env`, `data/` and the database are never touched.
Running the install one-liner over such an install does the same at once.

## Installing

`install.sh`, published with each release and run as
`curl -fsSL https://github.com/andresberrios/domo-releases/releases/latest/download/install.sh | sh`:

1. Check for `docker` (running), `curl`, `tar` and a supported
   platform (macOS arm64/x64, Linux x64/arm64 with glibc). Stop with one
   line saying what is missing. Then make sure of git (next section).
2. Read the newest manifest; download the Node it names into `~/.domo/node`
   and the launcher into `~/.domo/bin`, checked against `launcherSha256`.
3. Hand over to `domo install`, which writes no `.env` (the launcher's
   defaults are all an install needs), keeps `DOMO_FEED` in `state.json` if
   one was given, runs `domo update --force --no-restart` to download and
   place the first release, installs the launchd or systemd unit, starts it,
   runs `caddy trust` against the running server's admin socket
   (`~/.domo/caddy.sock`; `caddy trust` asks a running server for its root
   certificate, so it cannot go before the start) and opens the browser.
   `--no-service` stops after placing the release, for running `domo run`
   under a supervisor of one's own.

### When the machine has no git

Domo itself is downloaded, but the server (worktrees, project creation) and
all three coding agents run `git` from the PATH, so the installer makes sure
of it first.

- **macOS**: `/usr/bin/git` always exists, but without the Command Line Tools
  it is a stub that opens their installer and fails, so the check is
  `xcode-select -p`, which never opens it. When git is missing the script
  runs `xcode-select --install`, says that Apple's dialog wants a click, and
  polls until git runs. The dialog's process (`Install Command Line Developer
  Tools`) going away before that means it was cancelled; the script stops
  with what to do, and gives up after an hour either way. Homebrew and
  MacPorts need the Command Line Tools themselves, so they are no shortcut.
- **Linux**: the distribution's package (apt, dnf, yum, zypper, pacman, apk),
  through sudo when not root.

`domo` subcommands: `run` (the supervisor), `start`, `stop`, `restart`,
`status`, `trust`, `logs`, `update [--check] [--json] [--force]
[--no-restart]`, `install`, `uninstall`. One plain `.mjs` file at
`bin/domo.mjs`, so it needs no build step and runs on the bundled Node.

## Moving a machine from `pnpm dev` to an install

The installed Domo gets its own stack and a copy of the data. It never runs
on the development stack, whose Postgres is the one `pnpm test` uses.

1. Install (the one-liner in the README). The first start creates the schema in the
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
3. Stop `pnpm dev` for good, and `domo start`. An install needs no `.env`;
   if `~/.domo/.env` sets `NUXT_DATA_DIR`, it must point at `~/.domo/data`. The checkout becomes a
   development checkout only: merge freely, run tests, work in environments.
   Deploy by pushing `release`: CI publishes it, and the install picks it up
   within the hour. For an in-browser check of unmerged work, use the scratch
   recipe below.

## Testing a change to any of this

Build a release of the branch, serve it as a feed, and install it into a
scratch home against a scratch stack, so the real `domo` database and the
real service are never touched:

```sh
node scripts/release.mjs build --out /tmp/domo-dist
node scripts/release.mjs manifest --out /tmp/domo-dist
node scripts/release.mjs serve --out /tmp/domo-dist --port 8765 &
COMPOSE_PROJECT_NAME=domo-inst DOMO_PG_PORT=54331 DOMO_ELECTRIC_PORT=30010 \
  docker compose -f docker-compose.prod.yml up -d
mkdir -p /tmp/domo-home && printf '%s\n' \
  DATABASE_URL=postgresql://postgres:password@localhost:54331/domo \
  ELECTRIC_URL=http://localhost:30010 COMPOSE_PROJECT_NAME=domo-inst \
  DOMO_PG_PORT=54331 DOMO_ELECTRIC_PORT=30010 \
  DOMO_PORT=3867 DOMO_HTTPS_ADDRESS=localhost:3866 \
  NUXT_DEV_ENV_RESOURCE_PREFIX=domo-inst- > /tmp/domo-home/.env
DOMO_HOME=/tmp/domo-home DOMO_FEED=http://localhost:8765 \
  DOMO_INSTALL_ARGS="--skip-trust --no-open" sh scripts/install.sh
```

Then open `https://localhost:3866`. For an update, commit, build and
`manifest --previous` the old `manifest.json` into a new directory, serve
that, and watch Settings → Updates. Afterwards
`DOMO_HOME=/tmp/domo-home /tmp/domo-home/bin/domo uninstall`,
`docker compose -p domo-inst down -v`, and remove `/tmp/domo-home`. The
launchd label is `com.domo.app` whichever home is used, so the scratch
service and a real one cannot run at the same time. To test the move from
git, install `main`'s `scripts/install.sh` first with `DOMO_REPO` set to a
bare clone (`file:///…`) whose `release` is the old commit, then push the
branch to that `release`.

For Linux, `test/helpers/install-linux.sh` runs the same install with
`--no-service` and `domo run` in a Debian container with the host's Docker
socket, from a feed served on the host:

```sh
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v $PWD/test/helpers/install-linux.sh:/test.sh:ro -v $PWD/scripts/install.sh:/install.sh:ro \
  --add-host host.docker.internal:host-gateway debian:bookworm-slim sh /test.sh http://host.docker.internal:8765
```

It proves the downloads, the checksums, the supervisor, the update check and
creating a project on Linux; the systemd unit itself is not exercised, since
a container has no systemd. The image has no git, so it also proves the
installer installs Debian's.
