# ACP adapters: facts that are not in the code

Read this before you change adapter versions, models, steering or permissions,
or when an adapter acts in an unexpected way. Everything else is in
`server/lib/acp/`.

- **A new model reaches Domo only through an adapter version bump.** Each
  adapter's model list is built into its bundled CLI binary. Nothing fetches
  it. A bump must change both pin sites together: `package.json` for host
  sessions, and `ADAPTER_PACKAGES` in `server/lib/dev-env/runtime-volume.ts` for
  container sessions. If you change only one, host and container sessions offer
  different models. To confirm a bump, compare the model option
  *descriptions*. An alias id such as `opus[1m]` can stay the same while the
  model behind it changes.
- **A daily cron job wakes the host agent `adapter-version-watch` to check for
  adapter releases.** Do not archive that session: if you do, the job stops.
- **Do not set Claude Code's `availableModels` to widen the model list.** It is
  an allowlist. It freezes the list, and models added by later bumps stop
  appearing.
- **OpenCode 2 is the npm package `@opencode/cli`.** `opencode-ai` still
  publishes, but it is v1.
- **OpenCode cannot be steered over ACP.** This was checked on 2.0.14 and
  2.0.15, and a version bump does not change it. Its binary does not contain
  `_session/steering`. It sends no top-level `_meta` in `initialize`, and it
  refuses a second `session/prompt`. Do not investigate this again. A `steer`
  falls back to `interrupt`, which is the intended behavior.
- **OpenCode reports every MCP tool call as `title: "execute"` with an empty
  `rawInput`.** The tool name is not in the payload. Do not write an assertion
  or a UI feature that depends on tool names from OpenCode.
- **Without a credential, OpenCode disables priced models without an error.**
  Such a model answers `provider.no-route`. The only credential variable that
  works is `OPENCODE_API_KEY`. `OPENCODE_CONSOLE_TOKEN` does nothing. The key
  also adds the `opencode-go/*` models to the list.
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
