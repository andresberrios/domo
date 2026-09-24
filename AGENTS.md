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

Domo is a self-hosted, single-user Nuxt 4 SPA. You talk to a Gemini Live agent,
and it runs coding agents (Claude Code, Codex, OpenCode) over ACP. Read
`README.md` for the product, setup and layout.

## Before you act

- **Editing `server/` under `pnpm dev` kills every running coding agent,
  including you.** Nitro reloads and shuts every adapter down. Make `server/`
  changes in a worktree and apply them when no turn is running.
- **Open the app only at `https://localhost:3666`** (Caddy). From inside a dev
  environment, use `https://host.docker.internal:3666` and ignore certificate
  errors. Port 3667 is plain HTTP. On it, Electric's long-polls use up the
  browser's connection limit, and every extra tab renders blank with no error.
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
- **The test suite must never write to the developer's `domo` database or start
  a real, billable agent.** Keep the guards that make sure of this (see
  `test/CLAUDE.md`). All checkouts on this machine share one `domo_test`
  database. Before a long run, check that no other run is active
  (`pgrep -f vitest`), or the two runs destroy each other's data.

## Working norms

- `docker compose up -d` must be running before `pnpm test`. `pnpm typecheck`,
  `pnpm lint`, `pnpm build` and `pnpm test` must pass.
- **Verify changes yourself.** For a visual change, open it in a browser. For a
  change that needs a coding agent, run one. You may spend subscription usage
  on this. Use the cheap models (`haiku`, `gpt-5.6-luna`,
  `opencode-go/glm-5.3-flash`) with single-turn prompts in a scratch session in
  `/tmp`, and archive the session when done. If you did not test something,
  say so.
- Use Nuxt UI components before custom markup. Put shared types in
  `shared/types`. Call Docker with argument arrays, not shell strings.

## Topic docs

- `docs/acp-adapters.md`: read before you change adapter versions, models,
  steering or permissions, or when an adapter acts in an unexpected way.
- `test/CLAUDE.md`: loads automatically when you work under `test/`.
