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

Never point a second dev server at the `domo` database. Its boot marks every
session stopped while the user's agents are still running. Use the `electric`
test layer's database and Electric instead:

```sh
DATABASE_URL=postgresql://postgres:password@localhost:54321/domo_e2e \
ELECTRIC_URL=http://localhost:30001 \
DOMO_DEV_PORT=3767 DOMO_HTTPS_ADDRESS=localhost:3766 \
NUXT_DATA_DIR=/tmp/<x> NUXT_DEV_ENV_RESOURCE_PREFIX=domo-<x>- \
NUXT_CLAUDE_CODE_OAUTH_TOKEN= NUXT_ANTHROPIC_API_BASE=http://127.0.0.1:1 \
NUXT_CODEX_ENTRY=$PWD/test/helpers/dead-adapter.mjs \
NUXT_CLAUDE_ACP_ENTRY=$PWD/test/helpers/dead-adapter.mjs \
pnpm dev
```

Then open `https://localhost:3766`. The last four variables stop the usage
poller and Claude Code sessions from contacting real accounts. Remove them if
the check needs a real agent.

- Do not run `pnpm test:electric` at the same time. It resets the same
  database.
- When you are done, stop the server by its port. Then remove the
  `domo-<x>-runtime-*` and `domo-<x>-browser-*` volumes it built.
