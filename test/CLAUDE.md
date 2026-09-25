# test/CLAUDE.md — the test suite

> Keep this file current in the *same* change that makes it stale.

## Layout and projects

There is a Vitest project per **runtime**, not per folder. A directory only
earns its own project when it needs a different `environment`, a different
setup file, or a dependency that must stay out of the default run. Everything
else is a directory inside a project.

| project | directories | what it is |
| --- | --- | --- |
| `unit` | `test/unit`, `test/docker` | plain node, no services, no Nuxt. Pure logic (`buildTranscript()`, the conversation-context builder and the
compaction cut, formatters, settings reconciliation, `.domo.json` parsing and validation, the generated build config, the image-metadata allow-list, the `docker run` argv and the runtime volume's name, the voice tools with everything below them mocked, the usage normalisers and the poller's scheduling with injected clients) plus Docker at the process boundary — the exact argv handed to `docker`, which needs no daemon. |
| `nuxt` | `test/nuxt` | components and composables in a real Nuxt runtime (happy-dom) through `mountSuspended` / `registerEndpoint`. |
| `integration` | `test/server`, `test/e2e`, `test/helpers` | everything that needs a real Postgres, one file at a time. `test/server` drives `repo.ts` and the schema directly (including booting on top of a pre-migration database), the whole ACP client against a fake agent on a pair of pipes, and the voice runtime with Google replaced by a recorder (which model it asks for, and what context a connect is told after a conversation has been folded); `test/e2e` drives a production build of the Nitro server over HTTP, no browser; `test/helpers/database.spec.ts` covers the harness's own reset, next to the code it tests. |
| `electric` | `test/electric` | the propagation loop, still without a browser: a page mounted in happy-dom drives the real Nitro server, which writes to real Postgres, which a real ElectricSQL streams back into the mounted page. Its own database and its own Electric — see below. |
| `docker-live` | `test/docker/*.live.spec.ts` | what needs a real Docker daemon: `inspectContainer` against a running container, and `dev-environment.live.spec.ts`, which creates and deletes real environments (real `devcontainer build`, real `docker run`: the built-in definition, a bare glibc image with no Node of its own, an Alpine image that must fail readably, an `ubuntu:22.04` one that must fail readably for a *different* reason, two environments sharing one runtime volume, and a real environment's compose Postgres and private `FROM` chain through `stopEnvironment` / `startEnvironment`, a simulated Domo restart (`restoreDockerProxies`) and retirement; plus the tar copy into the volume. Minutes on a cold cache, needs the network). Also `dood-proxy.live.spec.ts` and `dood-compose.live.spec.ts`, which drive the DooD socket proxy with the real `docker` CLI and with real `docker compose` — the transport is the point there, so a daemon is the only thing that can answer it (see below) — and `dood-ports.live.spec.ts`, a loopback-only compose service found, forwarded and fetched from the host through the port helper, then again after a restart with nothing replaced; and `dood-namespace.live.spec.ts`, two environments running one compose file side by side with a bystander container, volume and network made on the host, each environment's lists, prunes, events, inspects, refusals and `rm -f $(docker ps -aq)` touching only itself; and `dood-publish.live.spec.ts`, two stand-in environments whose containers' `-p` / `ports:` answer on each one's own `localhost` (compose postgres through `psql`, TCP and UDP, loopback vs every address, ranges, `-P`, allocation as every command reports it, the same port in both at once, a refused start, restarts of every kind, a simulated Domo restart, `compose down`) and whose services reach loopback-only servers in *their own* environment at `host.docker.internal`, both environments at once; and `dood-binds.live.spec.ts`, a stand-in environment mounted like a real one (checkout volume, a second volume, a host directory at `~/.aws`, the proxy socket) where compose and the CLI bind `~/.aws`, a path in the other volume reached by `..`, `/etc/localtime` and the socket (a service listing and creating containers through it, scoped and labelled), are refused for paths only the environment has, see their own sources in inspect, run `network_mode: host` / `--pid host` in the environment's namespaces through a stop/start of it, forward `-P` to the host, and keep `host.docker.internal` pointing at the environment after it comes back on another address; and `dood-images.live.spec.ts`, two stand-in environments building the same tag at once, `FROM` / `COPY --from` their own images (a stage named like one stays the stage), `--progress=plain` diffed against a direct build, `--metadata-file`, `tag`, `commit`, `save`/`load` past a shared tag of the same name, `push` (and `build --push`) to a throwaway `registry:2`, pulls, `rmi`, `builder prune` refused, compose `build` then `up` with `image:` + `build:`, `pull_policy` and one service `FROM` another's, the legacy builder, image events, no hang-up noise, and the retirement sweep of private tags. Opt in. |
| `agents-live` | `test/agents/*.live.spec.ts` | both coding agents for real: a real account, a real adapter process, a real container, real Postgres. Needs Postgres **and** Docker **and** a Claude token **and** a Codex login. Opt in. |

`test/unit` and `test/docker` share a project because nothing distinguished
them but a label; `test/server` and `test/e2e` share one because they have the
same environment and the same test database. `nuxt` is separate because
`environment: 'nuxt'` really is a different runtime, `electric` because it needs
a database nothing may reset with `drop schema`, and `docker-live` because a
daemon is not something the default run may assume.

## Commands

**`docker compose up -d` is a precondition of the suite, not a branch in it.**

| command | needs | runs |
| --- | --- | --- |
| `pnpm test` | the services | `unit` + `nuxt` + `integration` + `electric` — the default, ~30 s. |
| `pnpm test:unit` | nothing | `unit`. |
| `pnpm test:nuxt` | nothing | `nuxt`. |
| `pnpm test:integration` | Postgres | `integration`. |
| `pnpm test:electric` | Postgres + `electric-e2e` | `electric`. |
| `pnpm test:docker` | a Docker daemon | every `test/docker` file, live ones included. |
| `pnpm test:agents` | Postgres + Docker + real accounts | `agents-live`. ~90 s warm, minutes cold. |
| `pnpm test:watch` | nothing | `unit` + `nuxt` in watch mode. |

### An unreachable service fails the run

There is no skip and no opt-out. Both service-backed projects check what they
need in a `globalSetup` — `test/setup/require-database.ts` for `integration`,
`test/electric/global-setup.ts` for `electric` — and throw before a single test
reports, naming the layers that did not run and the command that fixes it.

That is the whole of it now, and it used to be two mechanisms. The files also
skipped themselves through `describe.skipIf(databaseUnavailable())`, so with
Postgres down the suite printed a green "263 passed" while a third of it — the
repo layer, the SQL schema, the migration path — had not executed at all. A
warning scrolls past; an exit code does not. The hard failure came later, an
opt-out came after that to preserve the old behaviour, and the two paths were
then kept in step by hand for no benefit. Do not reintroduce either.

`test:unit` and `test:nuxt` are the ones that need no services, and they need no
flag to say so.

**Asserting on the argv handed to `docker` cannot tell you Docker accepts it.**
`test/docker/dev-environments.spec.ts` was green while every environment for a
project without a `.devcontainer/` failed to start. The live spec exists for
that gap; when the environment lifecycle changes, run `pnpm test:docker`. It
leaves nothing behind, and its `afterEach` removes containers, workspace volumes,
Docker-in-Docker volumes, what an environment started on the host daemon, and
per-environment images when an assertion fails halfway. Everything it creates is named `domo-live-test-…`.

The shared runtime volume is deliberately *not* swept: it is the expensive part
(a Node copy and an `npm install` of both adapters) and the point of it is that
the second environment reuses it. It is named `domo-live-test-runtime-<hash>`
under the test prefix, so `docker volume rm` it by hand if a pin changes.

**The DooD proxy can only be tested against a real client, and `docker run` is
not evidence for `docker compose`.** The translation itself is pure and lives in
`test/unit/dood-*.spec.ts` — request rewrites, names and reference resolution,
response rewrites, response framing split at every byte, and the scope layer
against a fake Engine API client; everything else about the proxy is transport,
and transport is exactly where it broke. Two failures cost an afternoon and
neither is visible from an argv assertion: an `http.createServer` proxy
deadlocks every `docker run`, because a Docker client reuses one connection, a
`wait` on it is a long poll, and an HTTP server may not answer out of order — so
the `start` that would end the wait queues behind it forever. And Node's default
`allowHalfOpen: false` tears down the write side back to the client when the
client half-closes after an attach, so a container's output silently never
arrives and `docker run` prints nothing. Hence a byte splice that holds bytes
back only where a rewrite needs a whole JSON body, and hence a separate compose
spec: compose speaks the Engine API itself, so nothing the CLI proves carries
over to it. It found the third failure: `compose down` *inspects* a network
before deleting it and, on seeing the environment's endpoint there, never sends
the DELETE at all — so the specs use a real stand-in container that really
joins the network. A second `compose up` recreating nothing is the check that
inspect's rewrites agree with what compose itself expects to see.

**Every live file that goes through `ensureDoodProxy` sets its own
`NUXT_DEV_ENV_RESOURCE_PREFIX` and removes `portHelperName()` and
`portHelperImage()` at the end.** Publishing runs in the port helper, which is
one per install and built locally (`RUNTIME_IMAGE` + iptables): without a
prefix a test would drive — and leave behind — the developer's own helper.

**Every live file that goes through `ensureDoodProxy` keeps its socket
directory short (`mkdtemp('/tmp/ddX-')`), and none `docker restart`s a
container that mounts the socket.** Docker Desktop forwards a host socket into a container only from a
path of at most 88 bytes — `$TMPDIR` alone is ~50 — and past it the mount
succeeds and every connection is `ECONNREFUSED`; `doodSocketPath` now refuses
such a path, so a long `NUXT_DOOD_SOCKET_DIR` fails the whole file in
`beforeAll` (every test "skipped"). And `docker restart` of a container that
mounts a host socket fails on Docker Desktop (`open /socket_mnt/…: no such
file or directory`) where `stop` + `start` works: the stand-in environment is
stopped and started, as Domo does it.

**Never run the CLI synchronously in a process that hosts a proxy.** The
proxy is this process's event loop, so a `spawnSync('docker', …)` through it
waits for an answer the blocked loop can never give — the run just hangs. Use
the async `exec`/`run` helpers the live files already have.

**A `registry:2` for a push test needs a host port chosen by the test.**
Measured on Docker Desktop: the daemon pushes to `localhost:<port>` only when
the port was asked for (`-p 127.0.0.1:<port>:5000`); with a port Docker
allocated (`-p 127.0.0.1::5000`) every push times out on `GET /v2/`.
`dood-images.live.spec.ts` picks a free one first.

**The daemon keeps only the last 256 events** (measured: `docker events
--since 1h --until 0s` returns exactly 256 lines). The live files run in parallel
and the dood ones make hundreds of events between them (every `docker exec` is
three), so a test reading event *history* must make its own events in a window
of a second or two, not read back what an earlier test did — the events test in
`dood-namespace.live.spec.ts` found out by failing only in the full run.

**`dev-environments.spec.ts` mocks `server/lib/dood/manager`.** The real
`ensureDoodProxy` listens on a real socket under `~/.domo/s/`, and in a spec
that never closes it that is a file left in the developer's home per test.

**`browserTools` is off for the whole `docker-live` layer, and the two browser
tests turn it on and back off in an `afterEach`.** Left on, every other test in
the file builds and mounts a several-hundred-megabyte volume it has nothing to
say about. The pair of them is what proves the preflight's browser probe is
worth having: `ubuntu:22.04` runs the bundled Node quite happily and cannot run
the browser, so without the probe creation would succeed and the failure would
land on the first agent to open a page.

**Both `test/docker` specs mock `server/lib/settings` and point
`NUXT_HOME_OVERLAY_DIR` at a scratch directory.** The home overlay is the one
thing in the environment lifecycle that reads settings, and neither project has
a Postgres; the scratch home is for the same reason `NUXT_CLAUDE_CONFIG_DIR` is
one — a test must never mount the developer's real `~/.ssh` or `~/.gitconfig`
into a container. The live spec also listens on a throwaway unix socket and
points `SSH_AUTH_SOCK` at it, which exercises the non-Docker-Desktop agent
branch.

**A dev container's own `~/.docker/config.json` can break `pnpm test:docker`.**
VS Code writes `"credsStore": "dev-containers-<id>"` into it, and that helper
only answers while the editor's own session is alive; outside it every pull
fails with `error getting credentials - err: exit status 255` before a single
assertion runs. Point `DOCKER_CONFIG` at a scratch directory holding `{}` —
every image the suite uses is public. It is the same failure `.docker` would
cause inside an environment, which is why it is not a default home mount.

**The ordering assertions in `dev-environments.spec.ts` are the contract.**
Build before run, preflight before the `chown`, `chown` before the generated
`~/.gitconfig` before `postCreateCommand`, and a full teardown (container,
workspace volume, DinD volume, image) at every failure point. None of that is
visible in any single argv, and all of it has been wrong at some point.

What is deliberately *not* tested: a real Gemini Live session and
`useVoiceChannel` (a real browser and a real Live session; only what the runtime
*sends* is covered, with the SDK faked — the model and voice it connects with in
`test/server/voice-runtime-model.spec.ts`, when a proactive note is allowed
to reach the model in `test/unit/voice-runtime-notes.spec.ts`, and what it
records about its context window in `test/unit/voice-runtime-usage.spec.ts`,
where the repo, the settings and the tools are faked too so they need no
database). That is the whole list now: spawning ACP adapters used to be on it
and is covered by `agents-live`.

### No layer may reach a real usage account

The usage poller starts with the Nitro server, so both server-backed layers
would have polled a real Claude and a real Codex on boot. Blanking the API keys
does not stop it — the poller reads `NUXT_CLAUDE_CODE_OAUTH_TOKEN`, and a
developer with that exported would have had `pnpm test` spending their own
quota. Three locks in `test/e2e/api.spec.ts` and `test/electric/global-setup.ts`,
because one is brittle:

- `NUXT_CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` blanked, which
  makes the Claude poll answer `unconfigured` before it builds a request at all;
- `NUXT_ANTHROPIC_API_BASE` pointed at `http://127.0.0.1:1`, so a token that
  ever leaks in still cannot reach Anthropic;
- `NUXT_CODEX_ENTRY` pointed at `test/helpers/dead-adapter.mjs`, the same stub
  the ACP adapters get, so no real `codex app-server` is ever spawned.

Everything else about the poller is covered in `unit` with injected clients and
fake timers (`test/unit/usage-poller.spec.ts`), and the Codex exchange runs
against a fake JSON-RPC server on a pair of pipes
(`test/server/codex-usage.spec.ts`) — the same technique as the fake ACP agent,
so the framing and the handshake order are the real ones.

## The `agents-live` layer

`pnpm test:agents`. One environment (`docker: false`, so unprivileged and quick)
shared by every session, and both adapters run in it in turn — a supported and
important case that nothing else exercises.

- **Its `globalSetup` names everything that is missing at once**, not one thing
  per run: the database, the daemon, `NUXT_CLAUDE_CODE_OAUTH_TOKEN`, and a Codex
  login. No skip, no opt-out, same rule as every other service-backed project.
- **The mesh server runs in the test process, bound to every interface.** It has
  to be this process — the token secret is `randomBytes(32)` at module scope and
  a token minted here verifies only here. The wildcard is what makes it
  reachable in both topologies: on a Docker Desktop host `host.docker.internal`
  forwards to the host's IPv4 loopback (and a listener on `[::1]` alone is
  refused), but when the suite itself runs **inside a dev environment** the
  agent's container is a sibling on whatever daemon that environment talks to and
  `host.docker.internal` is the bridge gateway instead. Bound to `127.0.0.1` the
  whole layer failed there, with nothing in the output naming the network as the
  cause — every mesh assertion simply saw no call arrive.
- **Everything it creates is named `domo-agents-test-…`**, and the last test
  asserts that no container, workspace volume or image with that prefix
  survives. The shared runtime volume is deliberately kept, exactly as in
  `docker-live`.
- **What makes each adapter ask permission is not the same**, and both were
  measured rather than assumed. Claude Code's default "Manual" mode asks about
  its *own* tools only: Domo advertises `fs/writeTextFile`, and a write the
  adapter delegates to the client raises no permission at all, so the probe is a
  shell command. codex-acp starts in `agent` ("Approve for me") and asks for
  nothing; in `read-only` it asks to edit files rather than about the command.
  `ASKS` in the spec records both.
- **The browser test's page is served by the mesh harness**, on the same socket
  in the same process, because it has to be reachable from inside the container
  at a URL the test knows. A hit on `/probe` is the assertion that matters:
  nothing else in the process can produce one, so it means a real Chromium in
  the container really fetched a page. The reply's wording is a model's, so the
  other assertions are on the recorded `tool_call` names.
- **Keep the prompts single-turn and the models cheap.** `haiku` for Claude and
  `gpt-5.6-luna` for Codex, chosen off a real `session/new` — and note neither id
  is guessable (Claude lists `haiku`, not `claude-haiku-4-5`; Codex has no
  `*-mini`).

## The test-database lifecycle

**There is one test database, `domo_test`, and it is never dropped.** It is
created if it is missing, emptied before every test file, and left in place at
the end. A single reused database is zero-clutter by definition: nothing
accumulates, so nothing has to be swept, and no teardown has to survive a
`kill -9`.

Two halves, both under `test/setup`:

- **`require-database.ts` is the once-per-run half** — a Vitest `globalSetup` on
  the `integration` project, so it runs in the main process before any worker
  forks and not at all for the service-free projects. It creates `domo_test` if
  it is missing and turns an unreachable Postgres into an exit code.
  (`build-app.ts` sits beside it: same project, same reason — see below.)
- **`database.ts` is the per-file half** — a `setupFiles` entry that empties the
  database in a *top-level await* and points `DATABASE_URL` at it.

### Why one database, and what it costs

Per-file databases (`domo_test_<uuid>`) existed to let test *files* run in
parallel workers. We do not need that: the whole suite is ~30 s and a large
share of it is the Nuxt transform in a different project, which serialising the
database files does not touch. What per-file databases *did* cost was a permanent
cleanup problem — anything that killed a run (crash, `Ctrl-C`, a worker
timeout) leaked a database forever, and any sweep that fixes that has to decide
whether a database it did not create is dead, which it cannot do reliably.

So the trade is explicit: **`fileParallelism: false` on the `integration`
project only**. `unit` and `nuxt` stay parallel — they share no state, and that
is where the time actually is. Do not make it global.

### The reset is `drop schema public cascade`, not `truncate`

`truncate` would be faster and would leave the schema alone, but it cannot
serve `test/server/schema-migration.spec.ts`: that file installs the *old*
shape of `voice_sessions`, `projects` and `dev_environments` with bare
`create table` statements, which only work against a database that has never
been booted. Dropping the schema and letting `server/lib/db.ts` bootstrap it
again on the next `getDb()` is also the most faithful thing available — it is
exactly what a fresh install does.

The reset does **not** terminate other connections. Dropping a schema needs a
lock on each table, not an empty database the way `drop database` does, and an
idle pool holds no table locks; a `lock_timeout` turns the one case that really
is blocked into a readable error rather than a hang. This matters because
something else may legitimately be attached — see below.

### Things that are load-bearing here

- **`server/lib/db.ts` reads `DATABASE_URL` once, at import time**, and
  bootstraps the schema on its first connection. The database has to exist, be
  empty, and be named by the variable before the test file — and everything it
  imports — is loaded. Hence the top-level await in the setup file.
- **The reset happens *before* a file, not after it.** A file that crashes
  cannot hand the next one a dirty database, because the next one cleans first.
- **`DATABASE_URL` always names `domo_test`**, even when Postgres is down: the
  fallback is an unreachable `postgresql://127.0.0.1:1/domo_test`, set *before*
  the setup file throws. Anything that still runs then fails to connect instead
  of quietly writing to the developer's own `domo`. Never let it fall through to
  the default, and never point the suite at a database called `domo`.
- **A refused pg connection is an `AggregateError` with an *empty* message.**
  Keep the `error.message || error.name` fallback in `ensureTestDatabase()`. An
  early version derived "is the database reachable?" from `error.message` alone,
  read the empty string as "reachable", ran against whatever `DATABASE_URL`
  happened to be, and destroyed a real `domo` — ~18 conversations and ~5,200
  agent events, unrecoverable.

### ElectricSQL never replicates from `domo_test`

It did, briefly, and the collision is why the rule exists. The `electric` layer
runs against its own database, **`domo_e2e`**, with its own Electric instance
(compose service `electric-e2e`, host port 30001, a distinct
`ELECTRIC_REPLICATION_STREAM_ID` so the slot and publication cannot collide).
Keep it that way.

The reason is measured, not theoretical. Point an Electric at `domo_test` and
after the first reset:

- the **replication slot survives** (slots belong to the database, not the
  schema) and stays active,
- the **publication survives**,
- but `select count(*) from pg_publication_tables` is **0** — `drop schema
  public cascade` removed every table from the publication, and the tables the
  app re-bootstraps afterwards are not members.

Nothing errors. You get a live-looking instance, an active slot and a healthy
publication, replicating nothing. Electric *does* eventually re-add a table it
is asked for — but roughly **22 seconds** later, and a write issued in that
window never reaches the shape log and is **permanently lost**. Silently stale
data is the worst failure this suite could produce, so the layers are kept on
separate databases instead.

Two more facts worth not re-deriving:

- **`TRUNCATE` is safe but a blunt instrument.** Against a live Electric with a
  subscribed `ShapeStream`, the next poll answers HTTP 409 with
  `{"control":"must-refetch"}`; the client discards, resyncs from a fresh
  snapshot with a new handle, and a post-truncate insert arrives ~50 ms later.
  It works — it just invalidates every shape on the table. The `electric` layer
  resets with `delete from` instead: ordinary DML, decodes like every other
  write, no re-download per test.
- **Publication membership is demand-driven.** Electric adds a table the first
  time a shape asks for it, not schema-wide. Do not assert that every synced
  table is published; it only means nothing has subscribed yet.

**Never drop a database that has a slot on it.** `drop database … with (force)`
fails immediately with `is used by an active logical replication slot` — that
one is loud. The quiet danger is an *inactive* slot left behind, which retains
WAL forever until the disk fills. `pg_drop_replication_slot()` and
`drop publication` come first.

## The fake agent in `acp-stream.spec.ts`

`serve()` puts the SDK's own *agent* side on the far end of the pipes the
manager just took the client side of, so everything above the ACP boundary is
real. Three things in it are load-bearing and easy to break:

- **A turn that hangs is the only interesting state.** `steer`, `queue` and
  `interrupt` are the same thing — a prompt — against an idle session, so the
  delivery tests run against `heldTurn()`, which starts a turn and waits for the
  test to release it. `working()` wraps the whole setup.
- **The steering answer depends on whether a turn is running**, exactly as both
  real adapters' do: `injected` with one in flight, and `promptRequired` for an
  idle steer that opted in through `_meta`. A fake that always answered
  `injected` would pass whatever Domo sent it.
- **The fake answers a cancelled prompt with `stopReason: 'cancelled'`.** A real
  adapter does, and Domo's own abort races that answer — whichever lands first,
  the turn must settle as cancelled and never as an `error`. A fake that
  returned `end_turn` made the `interrupt` test depend on which won.
- **A turn that fails has to fail with a `RequestError`.** A bare `throw new
  Error('You\'ve hit your session limit …')` inside the fake reaches the client
  as JSON-RPC's own `Internal error` and nothing else: the SDK's `errorToResult`
  moves the reason into `data`, so `last_error` reads "Internal error" and an
  assertion on what the row *says* is testing the test. `refuse()` in the
  failed-turn describe throws `acp.RequestError.internalError({}, LIMIT)`, which
  is the shape a real adapter reports a refused turn in.

`stopSubscriptionNotifier()` runs in `afterEach` **before** `acpManager.shutdown()`:
`adapter-exit` is one of the things a subscriber is told about, and the shutdown
raises one per session.

## Other gotchas

- **Electric is stubbed in the current e2e layer** (`test/helpers/electric-stub.ts`).
  The stub answers gzipped, like Electric does, which is what the shape proxy
  has to cope with. The real instance belongs to the `electric` layer, on
  `domo_e2e`; this one never touches it.
- **`MarkdownView` renders asynchronously** (Shiki). In a component test, poll
  with `expect.poll(() => component.text())`; a single `nextTick` is not enough.
- **Do not `mockNuxtImport('useRouter')`** — Nuxt's own plugins call
  `router.afterEach` / `beforeResolve` and the whole runtime fails to set up.
  Spy on the real router instead.
- **`pnpm typecheck` covers the tests too.** `test/nuxt` comes in through the
  generated app tsconfig; everything else through `test/tsconfig.json`,
  referenced from the root `tsconfig.json` (`nuxt prepare` leaves it alone).
- **`test/e2e` and `test/electric` share one production build.** They differ only in
  the environment their server is started with, so building twice cost ~15 s for
  nothing. `test/helpers/app-build.ts` builds `.nuxt/test/app` once per run from
  whichever project's `globalSetup` runs first, and both start a server from it
  with `build: false`. The "already built" mark is an **environment variable**,
  not module state: Vitest runs each project's `globalSetup` in the main process
  but with its own module registry, so the two callers import two copies of the
  file. They run one after the other, never concurrently, so a flag is enough —
  if that ever changes, this needs a lock.
- **The build is a child process** (`test/helpers/build-app.mjs`). A Nuxt build
  inside Vitest's main process takes stdout with it and the report never
  appears.
- **`.nuxt/test` is roughly 40 MB and gitignored.** It is one directory now
  (`app`), rebuilt every run, so it no longer accumulates the way the random
  `.nuxt/test/<id>` dirs did. `rm -rf .nuxt/test` when it gets in the way.

## Verifying a change to the lifecycle

The property to preserve is that the developer's own `domo` database is never
written to, and that `domo_test` is the only database the suite ever creates.
Prove it, do not assume it:

```sh
# domo must be untouched across a full run
docker compose exec -T postgres psql -U postgres -d domo -Atc \
  "select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables"
pnpm test
# …same number, and exactly `domo` + `domo_test`, nothing else:
docker compose exec -T postgres psql -U postgres -d postgres -Atc \
  "select datname from pg_database where datname like 'domo%' order by 1"
```

`test/helpers/database.spec.ts` covers the reset itself — that it leaves no
trace of the previous file, leaves a schema the app can boot into (with
`replica identity full` intact), and does not need to terminate anything that
happens to be connected. It is the one piece everything else assumes.
