# Working on Domo from inside Domo

Read this before you change Domo while it is running your own session.

## Parallel tasks

Give each parallel task to an agent in a dev environment, with one environment
and one branch per task. The branch is in your checkout as soon as the agent
makes it: environments share the project's refs.

## Applying changes that restart the server

These edits in the running checkout kill every agent, including the one that
made the edit:

- `server/`, and anything it imports, such as `shared/`: Nitro rebuilds.
- `.env`: the whole dev server restarts, so a new key or token is also only
  read then.
- `nuxt.config.ts`, `.nuxtrc`, `.nuxtignore`: Nuxt reloads.

Apply such an edit only when no turn is running. If you have to apply it yourself, run it as a detached job that
starts after your own turn ends:

```sh
nohup sh -c '<wait for the turn to end>; <apply the change>' >/dev/null 2>&1 & disown
```

macOS has no `setsid`, and `nohup setsid …` does nothing and reports no error.

## Which database is for what

The main compose stack (`docker compose up -d`) holds three databases in one
Postgres. Only the first is somewhere to run Domo:

| database | Electric | used by |
| --- | --- | --- |
| `domo` | `electric`, port 30000 | the user's own Domo. Real data. |
| `domo_test` | none | the `integration` test layer, which drops its schema between runs |
| `domo_e2e` | `electric-e2e`, port 30001 | the `electric` and `voice-live` test layers, which reset it |

`pnpm test` resets both test databases. Neither is a place to run a dev server,
and a second dev server never points at `domo`: its boot marks every session
stopped while the user's agents are still running.

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
DOMO_DEV_PORT=3867 DOMO_HTTPS_ADDRESS=localhost:3866 DOMO_CADDY_ADMIN=off \
NUXT_DATA_DIR=/tmp/<x> NUXT_DEV_ENV_RESOURCE_PREFIX=domo-<x>- \
NUXT_CLAUDE_CODE_OAUTH_TOKEN= NUXT_ANTHROPIC_API_BASE=http://127.0.0.1:1 \
NUXT_CODEX_ENTRY=$PWD/test/helpers/dead-adapter.mjs \
NUXT_CLAUDE_ACP_ENTRY=$PWD/test/helpers/dead-adapter.mjs \
pnpm dev
```

Then open `https://localhost:3866`, or add `--tunnel` to `pnpm dev` for a
public URL to open from a phone — public and unauthenticated, so only while you
are using it. The last four variables stop the usage poller and Claude Code
sessions from contacting real accounts. Remove them if the check needs a real
agent.

- Start from an empty database. Copy real data in only when the check needs
  something an empty one cannot show, and then never `dev_environments`: a
  server that believes it owns an environment will act on the real containers.
  Copy by column name — the real tables grew their columns over time, so their
  order differs from a fresh schema.
- When you are done, stop the server by its port and
  `docker compose -p domo-<x> down -v`. Then remove the `domo-<x>-runtime-*`
  and `domo-<x>-browser-*` volumes it built, and the `domo-<x>-port-helper`
  container and image if it started one.
