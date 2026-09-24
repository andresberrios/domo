# AGENTS.md

> `CLAUDE.md` is a symlink to this file.
>
> **What belongs here.** Every session loads this file before it does anything,
> so it holds only what *every* session needs to know first, whatever the task.
> The test for each line: would an agent working on something unrelated be hurt
> by not knowing it? Knowledge that only matters for specific work goes in a
> short doc under `docs/`, and only if reading the code or hitting the failure
> would not recover it. Most knowledge needs no doc: the code is the better
> answer and it cannot go stale. Do not restate the code. Do not keep
> changelogs, histories of what was tried, or verification logs; git keeps
> those. When a change makes a doc wrong, fix the doc in the same change, and
> prefer deleting a line to qualifying it.

Domo is a self-hosted Nuxt 4 SPA. You talk to a Gemini Live agent, and it runs
coding agents (Claude Code, Codex, OpenCode) over ACP. Read `README.md` for the
product and setup. Domo has one user today and will have more. Build features
for the people who run Domo, not for the people who develop it. Maintainer
needs, such as tracking adapter releases, belong in agents, cron jobs or docs,
not in the UI.

## Before you act

- **Editing `server/` under `pnpm dev` kills every running coding agent,
  including you.** Nitro reloads and shuts every adapter down. Make `server/`
  changes in a worktree, and apply them only when no turn is running (see
  `docs/working-on-domo.md`). Changes that touch only `app/` are safe in the
  main checkout, because Vite hot reload does not kill agents.
- **Never run a second dev server against the `domo` database.** When it
  boots, it marks every session stopped while the user's agents are still
  running. For an in-app check from a worktree, see `docs/working-on-domo.md`.
- **Open the app only at `https://localhost:3666`** (Caddy). From inside a dev
  environment, use `https://host.docker.internal:3666` and ignore certificate
  errors. Port 3667 is plain HTTP. On it, Electric's long-polls use up the
  browser's connection limit, and every extra tab renders blank with no error.
- **Operate Domo through Domo's own tools** (the `domo` MCP tools) when you
  manage agents, environments, schedules, messages or permissions. Do not use
  the HTTP API, SQL or `docker` for this. Agents in other projects have only
  these tools, so if you have to work around them, a tool is missing: report
  it. Debugging Domo's own code is different. There, you may read the database.
- **Your own session is probably a row in `agent_sessions`.** A `thinking` row
  titled after your task is likely you. Check this before you report that
  "another agent" is working on the same thing.
- **Postgres is the source of truth. The UI renders only what Electric streams
  from it**, including text that is still arriving. Never render from an
  in-memory server cache. Database writes go through `server/lib/repo.ts`.
- **Synced tables stream to the browser**, so never put a secret in one.
  They are `REPLICA IDENTITY FULL`, so each write sends the whole row again.
  Do not write them on every delta.

## Things that fail silently and cost real damage

- **Never mount `~/.claude` in a container, and never copy a Claude or OpenCode
  login into one.** Both rotate the refresh token each time it is used. Two
  holders log each other out, and the one that loses is the developer's own
  machine. Containers use `claude setup-token` (`NUXT_CLAUDE_CODE_OAUTH_TOKEN`)
  and an OpenCode console key (`NUXT_OPENCODE_API_KEY`).
- **`ANTHROPIC_API_KEY` overrides a Claude subscription login and moves the work
  onto API billing without a prompt.** Pass it only when no subscription
  credential exists.
- **Never remove the provider prefix from a model id** (`openai/…` against
  `opencode/…`). The same bare name can bill two different accounts.
- **The default `pnpm test` must stay fast, offline and unattended.** It must
  never write to the developer's `domo` database or start a real agent. Tests
  with real agents go in the live layer (`pnpm test:agents`). All checkouts on
  this machine share one `domo_test` database. Before a long run, check that no
  other run is active (`pgrep -f vitest`), or the two runs destroy each other's
  data. See `test/AGENTS.md`.

## Working norms

- `docker compose up -d` must be running before `pnpm test`. `pnpm typecheck`,
  `pnpm lint`, `pnpm build` and `pnpm test` must pass.
- **Test live, and use a browser to do it.** On the host, use your browser
  tools. Inside a dev environment, use the bundled `browser` MCP server. Run
  real agents too, through `pnpm test:agents` or by hand in the app or the API.
  The subscription covers the usage. The cheap models are a sensible default:
  `haiku`, `gpt-5.6-luna`, `opencode-go/glm-5.3-flash`. For a manual session,
  work in a scratch directory under `/tmp` and archive the session when done.
  If you did not test something, say so.
- Use Nuxt UI components before custom markup. Put shared types in
  `shared/types`. Call Docker with argument arrays, not shell strings.

## Topic docs

- `docs/working-on-domo.md`: read before you change Domo from inside Domo
  (parallel tasks, applying `server/` changes, a second dev server).
- `docs/acp-adapters.md`: read before you change adapter versions, models,
  steering or permissions, or when an adapter acts in an unexpected way.
- `test/AGENTS.md`: read before you work under `test/`.
