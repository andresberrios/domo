# ACP adapters: facts that are not in the code

Read this before you change adapter versions, models, steering or permissions,
or when an adapter acts in an unexpected way. Everything else is in
`server/lib/acp/`.

- **A new Claude Code or Codex model reaches Domo only through an adapter
  version bump.** Their model lists are built into the bundled CLI binaries.
  OpenCode fetches its list, so its models change without one. A bump must
  change the three pin sites together: `package.json` for `pnpm dev`,
  `agents/package.json` for an installed Domo (then `npm install
  --package-lock-only` in `agents/` to update its lockfile), and
  `ADAPTER_PACKAGES` in `server/lib/dev-env/runtime-volume.ts` for container
  sessions (a unit test fails when they differ). The Codex CLI is pinned the
  same way, through `overrides` in `pnpm-workspace.yaml` and `agents/package.json` and
  `ADAPTER_OVERRIDES`,
  because codex-acp's own range would install an older second copy. To confirm
  a bump, compare the model option *descriptions*: in claude-agent-acp 0.90.0,
  `sonnet` and `haiku` kept their ids and moved to Sonnet 5.5 and Haiku 5.5.
  An environment keeps the adapters it was created with until it is upgraded
  (`docs/dev-environments.md`).
- **A daily cron job wakes the host agent `adapter-version-watch` to check for
  adapter releases.** Do not archive that session: if you do, the job stops.
- **Do not set Claude Code's `availableModels` to widen the model list.** It is
  an allowlist. It freezes the list, and models added by later bumps stop
  appearing.
- **OpenCode 2 is the npm package `@opencode/cli`.** `opencode-ai` still
  publishes, but it is v1.
- **OpenCode cannot be steered over ACP.** This was checked on 2.0.14,
  2.0.15 and 2.0.29, and a version bump does not change it. Its binary does
  not contain `_session/steering`. It sends no top-level `_meta` in `initialize`, and it
  refuses a second `session/prompt`. Do not investigate this again. A `steer`
  falls back to `interrupt`, which is the intended behavior.
- **OpenCode reports every MCP tool call as `title: "execute"`.** The tool name
  appears only in a later update, inside `rawInput.code`. Do not write an
  assertion or a UI feature that depends on tool names from OpenCode.
- **Without a credential, OpenCode lists only its free models.** The only
  credential variable that works is `OPENCODE_API_KEY`.
  `OPENCODE_CONSOLE_TOKEN` does nothing. The key adds the priced and
  `opencode-go/*` models to the list.
- **If `session/new` fails with only "Internal error", check the adapter's
  environment first** (`adapterEnv()` in `server/lib/acp/adapter-process.ts`).
  Inherited `CLAUDE_*` variables or a host `TMPDIR` in a container have both
  caused this error, and the logs said nothing else.
- **An adapter can start a turn that nobody prompted.** This happens when the
  agent wakes on a schedule, when a background task it launched finishes, or
  when codex-acp is steered while idle (it ignores `idleBehavior`). No
  `session/prompt` is outstanding, and ACP v1 has no other end-of-turn
  message. `AgentRuntime` opens a turn in `this.turn` and ends it on codex-acp's
  thread status (`codexThreadStatus`), or else after a minute of quiet with no
  tool call open. An open tool call or an `active` Codex thread holds the turn
  with no deadline. Do not end these turns sooner: an early end drains the
  inbox into an adapter that is still working. claude-agent-acp's per-result
  `usage_update` with `cost` is not an end signal: a queued background-task
  notification gets a placeholder result before its follow-up runs. Its real
  one, a `state_update` that goes `idle`, is on its experimental ACP v2
  surface only (0.90).
- **claude-agent-acp answers a `session/prompt` only after every subagent the
  turn launched in the background is done** (still so on 0.90 over ACP v1).
  Domo ends its turn at that prompt's own result instead, the cost
  `usage_update` with origin `human`. A prompt sent while one is held settles
  the held one. A subagent's updates carry `_meta.claudeCode.parentToolUseId`.
- **Copilot (`@github/copilot`) is its own ACP server, `copilot --acp`.**
  Domo runs the platform package's executable directly: the package's `copilot`
  bin is a Node loader that does not pass a stop on. `--no-auto-update` keeps
  the pinned version; without it the CLI downloads newer ones into `~/.copilot`.
  A bump changes `package.json` and `ADAPTER_PACKAGES` together, as above.
- **Copilot publishes no model option over ACP** (copilot-cli#4880, still so on
  1.0.98). Domo adds one (`server/lib/acp/copilot.ts`) from the account's
  `/models` picker list and sets it with `session/set_model`. On Copilot Free
  the picker is empty and the CLI refuses any named model, so the list is
  `auto` alone. Setting a named model is unverified on a paid plan.
- **Copilot refuses stdio MCP servers given over ACP**, with only a log line.
  They go in at launch through `--additional-mcp-config`.
- **Copilot cannot be steered.** A second `session/prompt` cancels the running
  turn, so `steer` falls back to `interrupt` as for OpenCode.
