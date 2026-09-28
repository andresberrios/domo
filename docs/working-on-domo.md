# Working on Domo from inside Domo

Read this before you change Domo while it is running your own session.

## Parallel tasks

Give each parallel task to an agent in a dev environment, with one environment
and one branch per task. Bring the results home with `export_branch`.

## Applying `server/` changes

Any edit to `server/` in the running checkout restarts Nitro and kills every
agent, including the one that made the edit. Apply the edit only when no turn
is running. If you have to apply it yourself, run it as a detached job that
starts after your own turn ends:

```sh
nohup sh -c '<wait for the turn to end>; <apply the change>' >/dev/null 2>&1 & disown
```

macOS has no `setsid`, and `nohup setsid …` does nothing and reports no error.

## A second dev server for in-app checks

Inside Domo, run the check in a dev environment: it has its own stack. Outside
one, give the second server a compose stack of its own — its own Postgres,
Electric and volume — so code that is not trusted yet never holds a
connection to the real database:

```sh
COMPOSE_PROJECT_NAME=domo-<x> DOMO_PG_PORT=54331 DOMO_ELECTRIC_PORT=30010 \
  docker compose up -d postgres electric

DATABASE_URL=postgresql://postgres:password@localhost:54331/domo \
ELECTRIC_URL=http://localhost:30010 \
DOMO_DEV_PORT=3767 DOMO_HTTPS_ADDRESS=localhost:3766 \
NUXT_DATA_DIR=/tmp/<x> NUXT_DEV_ENV_RESOURCE_PREFIX=domo-<x>- \
NUXT_CLAUDE_CODE_OAUTH_TOKEN= NUXT_ANTHROPIC_API_BASE=http://127.0.0.1:1 \
NUXT_CODEX_ENTRY=$PWD/test/helpers/dead-adapter.mjs \
NUXT_CLAUDE_ACP_ENTRY=$PWD/test/helpers/dead-adapter.mjs \
pnpm dev
```

Then open `https://localhost:3766`, or add `--tunnel` to `pnpm dev` for a
public URL to open from a phone — public and unauthenticated, so only while you
are using it. The last four variables stop the usage poller and Claude Code
sessions from contacting real accounts. Remove them if the check needs a real
agent.

- Start from an empty database. Copy real data in only when the check needs
  something an empty one cannot show, and then never `dev_environments`: a
  server that believes it owns an environment will act on the real containers.
- `domo_test` and `domo_e2e` belong to the test layers, which reset them. They
  are not somewhere to run a dev server.
- When you are done, stop the server by its port and
  `docker compose -p domo-<x> down -v`. Then remove the `domo-<x>-runtime-*`
  and `domo-<x>-browser-*` volumes it built, and the `domo-<x>-port-helper`
  container and image if it started one.
