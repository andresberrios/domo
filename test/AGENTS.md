# test/AGENTS.md

> `CLAUDE.md` is a symlink to this file.

Same bar as `AGENTS.md`: only what an agent working on tests has to know
before it acts. `vitest.config.ts` and `test/setup/` answer the rest.

## Layout

| project | where | needs |
| --- | --- | --- |
| `unit` | `test/unit`, `test/docker` | nothing. Pure logic and the argv handed to `docker`. |
| `nuxt` | `test/nuxt` | nothing. Components in a Nuxt runtime (happy-dom). |
| `integration` | `test/server`, `test/e2e`, `test/helpers` | Postgres. |
| `electric` | `test/electric` | Postgres and the `electric-e2e` service. |
| `docker-live` | `test/docker/*.live.spec.ts` | a Docker daemon. Opt in: `pnpm test:docker`. The `dood-*.live.spec.ts` files drive the Docker proxy with the real CLI, compose and buildx. |
| `agents-live` | `test/agents/*.live.spec.ts` | Postgres, Docker, a Claude token, a Codex login and `NUXT_OPENCODE_API_KEY`. Opt in: `pnpm test:agents`. |

`pnpm test` runs the first four projects and needs `docker compose up -d`.
Add a new project only when tests need a different runtime, setup file or
dependency.

## Rules

- **If a service is unreachable, the run fails. There is no skip and no
  opt-out.** Each service-backed project checks its services in a
  `globalSetup` and throws. Do not add `skipIf` or an environment flag: an
  earlier suite skipped a third of its tests and still reported success.
- **The default layers never touch the developer's data or accounts.** They
  must stay fast, offline and unattended. Real agents and real accounts are
  welcome in `agents-live`.
  - `DATABASE_URL` always names `domo_test`, even when Postgres is down. In
    that case it points at an unreachable host. Never let it fall back to
    `domo`.
  - A refused pg connection is an `AggregateError` with an *empty* message.
    Keep the `error.message || error.name` fallback: without it, an earlier
    harness treated the database as reachable and emptied the real `domo`.
  - All three ACP adapter entries and `NUXT_CODEX_ENTRY` point at
    `test/helpers/dead-adapter.mjs`. The server-backed layers blank the Claude
    OAuth tokens and point `NUXT_ANTHROPIC_API_BASE` at an unreachable address.
    Clearing the API keys is not enough: on macOS, Claude Code reads its login
    from the Keychain.
  - Nothing in `unit` may call `security find-generic-password`. It opens a GUI
    prompt, and the run hangs.
  - Docker specs use a scratch home overlay (`NUXT_HOME_OVERLAY_DIR`). Never
    mount the real `~/.ssh` or `~/.gitconfig`.
- **One test database, `domo_test`. It is emptied before each file with
  `drop schema public cascade`.** `fileParallelism` is off for `integration`
  only. This database is shared by every checkout on the machine, and two runs
  at once corrupt each other with foreign-key errors that look like real bugs.
  Before a long run, check `pgrep -f vitest`.
- **Electric never replicates from `domo_test`.** The `electric` layer has its
  own database (`domo_e2e`) and its own instance (port 30001). A schema drop
  removes every table from Electric's publication without an error, and writes
  are then lost. Never drop a database that has a replication slot. An
  inactive slot keeps WAL until the disk fills.

## Writing tests

- **The common failure here is an assertion that cannot fail.** Causes seen:
  asserting something upstream of what broke, a probe that could not trigger
  the behavior, and a check of an adapter's report format instead of the
  behavior. **Break the code on purpose and confirm the test fails.** When a
  fix loosens an assertion, check what the assertion still catches.
- An argv assertion cannot prove Docker accepts the argv. After a change to
  the environment lifecycle, run `pnpm test:docker`. Inside a VS Code dev
  container, set `DOCKER_CONFIG` to a scratch directory that holds `{}`.
- **A fake daemon for the leftover sweep has to keep state.** The sweep
  decides by observing, and an empty stdout is what a real daemon answers both
  for a clean machine and for one it cannot reach. `daemon()` in
  `dev-environments.spec.ts` answers the listings from what it still holds,
  removes on `rm`, and can refuse a name. Only a real daemon proves a refusal,
  so `dev-environment.live.spec.ts` has one. **`docker image rm` of an image
  with a second tag only removes the tag and succeeds**, even while a container
  runs from it, so an image-refusal test must build a singly-tagged image.
- A fake ACP agent must behave like the real one: answer based on whether a
  turn is running, and fail with `acp.RequestError`, not `Error`. Otherwise the
  test checks the fake.
- Reka opens a `UDropdownMenu` on `pointerdown` and a `USelectMenu` on
  `click`. happy-dom does not open a `UPopover`, so emit its `update:open`
  instead. Search for a dialog's buttons inside the dialog. The menu that
  opened it is still in the DOM.
- `MarkdownView` renders asynchronously, so use `expect.poll`. Do not
  `mockNuxtImport('useRouter')`. Spy on the real router.
- happy-dom does not enforce CSP. To test a CSP change, load the production
  build in a real browser.

## The Docker proxy (`dood-*` specs)

- The translation is pure and tested in `test/unit/dood-*.spec.ts`. The rest
  of the proxy is transport, and transport is where it broke (see
  `docs/dev-environments.md`), so only a real client can test it. **`docker
  run` passing is not evidence for `docker compose`**: compose speaks the
  Engine API itself. The compose specs use a real stand-in container that
  joins the network, or `compose down` behaves differently.
- A live file that uses `ensureDoodProxy` sets its own
  `NUXT_DEV_ENV_RESOURCE_PREFIX`, takes each environment down with
  `removeEnvironmentResources(id)` (the sweep, with the test standing in for
  the retired row), and removes `portHelperName()` and `portHelperImage()` at
  the end. Otherwise it drives, and leaves behind, the
  developer's own port helper.
- Keep the socket directory short (`mkdtemp('/tmp/ddX-')`). `$TMPDIR` alone is
  ~50 bytes, and past Docker Desktop's 88-byte limit `doodSocketPath` refuses,
  so the whole file fails in `beforeAll` and every test reports "skipped".
- Never `docker restart` a container that mounts the socket. It fails on
  Docker Desktop. Stop and start it, as Domo does.
- Never run the CLI synchronously in a process that hosts a proxy. The proxy
  runs on that event loop, so `spawnSync('docker', …)` hangs forever. Use the
  async helpers the live files already have.
- A `registry:2` push test must choose its host port
  (`-p 127.0.0.1:<port>:5000`). With a port Docker allocated, every push times
  out on `GET /v2/` (Docker Desktop).
- The daemon keeps only the last 256 events, and the live files run in
  parallel. A test that reads event history must make its own events within a
  second or two.
- `dev-environments.spec.ts` mocks `server/lib/dood/manager`. The real one
  listens on a socket under `~/.domo/s/` and would leave a file in the
  developer's home per test.
