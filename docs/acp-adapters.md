# ACP adapters: facts that are not in the code

Read this before you change adapter versions, models, steering or permissions,
or when an adapter acts in an unexpected way. Everything else is in
`server/lib/acp/`.

- **A new Claude Code or Codex model reaches Domo only through an adapter
  version bump.** Their model lists are built into the bundled CLI binaries.
  OpenCode fetches its list, so its models change without one. A bump must
  change both pin sites together: `package.json` for host sessions, and
  `ADAPTER_PACKAGES` in `server/lib/dev-env/runtime-volume.ts` for container
  sessions (a unit test fails when they differ). The Codex CLI is pinned the
  same way, through `overrides` in `pnpm-workspace.yaml` and `ADAPTER_OVERRIDES`,
  because codex-acp's own range would install an older second copy. To confirm
  a bump, compare the model option *descriptions*: in claude-agent-acp 0.90.0,
  `sonnet` and `haiku` kept their ids and moved to Sonnet 5.5 and Haiku 5.5.
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
