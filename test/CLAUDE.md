# test/CLAUDE.md — the test suite

> Keep this file current in the *same* change that makes it stale.

## Layout and projects

There is a Vitest project per **runtime**, not per folder. A directory only
earns its own project when it needs a different `environment`, a different
setup file, or a dependency that must stay out of the default run. Everything
else is a directory inside a project.

| project | directories | what it is |
| --- | --- | --- |
| `unit` | `test/unit`, `test/docker` | plain node, no services, no Nuxt. Pure logic (`buildTranscript()`, formatters, settings reconciliation, devcontainer config parsing, the voice tools with everything below them mocked) plus Docker at the process boundary — the exact argv handed to `docker`, which needs no daemon. |
| `nuxt` | `test/nuxt` | components and composables in a real Nuxt runtime (happy-dom) through `mountSuspended` / `registerEndpoint`. |
| `integration` | `test/server`, `test/e2e`, `test/helpers` | everything that needs a real Postgres, one file at a time. `test/server` drives `repo.ts` and the schema directly (including booting on top of a pre-migration database); `test/e2e` drives a production build of the Nitro server over HTTP, no browser; `test/helpers/database.spec.ts` covers the harness's own reset, next to the code it tests. |
| `docker-live` | `test/docker/*.live.spec.ts` | the few things that need a real Docker daemon. Opt in. |

`test/unit` and `test/docker` share a project because nothing distinguished
them but a label; `test/server` and `test/e2e` share one because they have the
same environment and the same per-file database. `nuxt` is separate because
`environment: 'nuxt'` really is a different runtime, and `docker-live` because
a daemon is not something the default run may assume.

## Commands

| command | needs | runs |
| --- | --- | --- |
| `pnpm test` | `docker compose up -d` | `unit` + `nuxt` + `integration` — the default. **Fails if Postgres is unreachable.** |
| `pnpm test:offline` | nothing | `unit` + `nuxt`. Sets the opt-out itself. |
| `pnpm test:unit` | nothing | `unit`. |
| `pnpm test:nuxt` | nothing | `nuxt`. |
| `pnpm test:integration` | Postgres | `integration`. |
| `pnpm test:docker` | a Docker daemon | every `test/docker` file, live ones included. |
| `pnpm test:watch` | nothing | `unit` + `nuxt` in watch mode. |

### An unreachable database fails the run

The database-backed files skip themselves through
`describe.skipIf(databaseUnavailable())`. That is the right behaviour once
someone has *said* they want it, and a trap otherwise: with Postgres down the
suite used to print a green "263 passed" while a third of it — the repo layer,
the SQL schema, the migration path — had not executed at all. A warning scrolls
past; an exit code does not.

So the run-level setup now throws when it cannot reach Postgres, before a single
test reports, and says which layers did not run. `DOMO_TEST_ALLOW_SKIP=1` is the
deliberate way out: the layers skip, Vitest reports them as skipped in the
summary (`178 passed | 89 skipped`), and the run exits 0. `pnpm test:offline`
sets it itself, because "no services at all" is its whole purpose and nobody
should have to remember a variable to get it.

What is deliberately *not* tested: the Gemini Live runtime and
`useVoiceChannel` (a real browser and a real Live session), and spawning ACP
adapters (a real Claude Code / Codex account). Permissions are still covered
end to end, because a permission is a row — `answerPermission` resolves it with
no adapter attached.

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
- **`database.ts` is the per-file half** — a `setupFiles` entry that empties the
  database in a *top-level await* and points `DATABASE_URL` at it.

### Why one database, and what it costs

Per-file databases (`domo_test_<uuid>`) existed to let test *files* run in
parallel workers. We do not need that: the suite is ~18 s and roughly half of
it is the Nuxt transform in a different project, which serialising the database
files does not touch. What per-file databases *did* cost was a permanent
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
  fallback is an unreachable `postgresql://127.0.0.1:1/domo_test`. A suite that
  forgot to skip then fails to connect instead of quietly writing to the
  developer's own `domo`. Never let it fall through to the default.
- **The skip reason travels through the environment**, not module state: a setup
  file and its test file do not reliably share a module registry.
  `databaseUnavailable()` reads `process.env`, and a refused connection arrives
  as an `AggregateError` with an *empty* message — store `''` and the suites run
  against whatever `DATABASE_URL` happens to be. This once destroyed a real
  `domo` database. Keep the `|| error.name` fallback.

### ElectricSQL is already replicating from `domo_test`

This is no longer hypothetical. As of this writing there is a second Electric
instance bound to the test database, for the browserless end-to-end layer that
tests real propagation to the frontend:

```
electric_slot_default    | domo      | active
electric_slot_domo_test  | domo_test | active
```

A fixed database name is what makes that possible at all — you cannot stand up
an Electric instance per worker per file. But it collides with the reset, and
the collision is measurable. After a full run:

- the **replication slot survives** (slots belong to the database, not the
  schema) and stays active,
- the **publication survives** (`electric_publication_domo_test`),
- but `select count(*) from pg_publication_tables` in `domo_test` is **0** —
  `drop schema public cascade` removed every table from the publication, and
  the tables the app re-bootstraps afterwards are not members of it.

So an Electric-bound layer will see nothing replicate after the first reset
until something re-adds the tables. Whoever builds that layer has to decide
between re-adding them after each reset, resetting with `truncate` instead (I
do not know how Electric handles a replicated `TRUNCATE` — find out, do not
assume), or giving that layer its own database. **Do not drop `domo_test`**: a
replication slot blocks `drop database` and retains WAL forever, silently,
until the disk fills. If a drop is ever genuinely needed, `pg_drop_replication_slot()`
and `drop publication` come first.

## Other gotchas

- **Electric is stubbed in the current e2e layer** (`test/helpers/electric-stub.ts`).
  The stub answers gzipped, like Electric does, which is what the shape proxy
  has to cope with. The real instance on `domo_test` is for the new propagation
  layer, not for this one.
- **`MarkdownView` renders asynchronously** (Shiki). In a component test, poll
  with `expect.poll(() => component.text())`; a single `nextTick` is not enough.
- **Do not `mockNuxtImport('useRouter')`** — Nuxt's own plugins call
  `router.afterEach` / `beforeResolve` and the whole runtime fails to set up.
  Spy on the real router instead.
- **`pnpm typecheck` covers the tests too.** `test/nuxt` comes in through the
  generated app tsconfig; everything else through `test/tsconfig.json`,
  referenced from the root `tsconfig.json` (`nuxt prepare` leaves it alone).
- **The e2e files build into `.nuxt/test/<id>` and do not always clean up** —
  roughly 40 MB per run. `rm -rf .nuxt/test` when it gets in the way; it is
  gitignored either way.

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
