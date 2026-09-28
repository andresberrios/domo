# Handoff: make Domo's agent-facing tools sufficient on their own

Branch `handoff/domo-tool-gaps`, cut from `tool-gaps`. Nothing here has been
merged or exported to the host's `main`; Andres decides when to land it
(`server/` changes restart the host's Nitro and kill running agents).

## The ask

Agents working on Domo kept bypassing the agent mesh (the `domo` MCP server,
`server/lib/mesh/tools.ts`) with the HTTP API, SQL and `docker`. Agents in
other projects have only the tools, so every bypass is a missing tool. Close
the gaps; write tool descriptions for an agent that knows nothing about
Domo; keep output compact; do not grow `AGENTS.md`. Audit `server/api/**`
route by route, implement with tests, test with real agents, work on a branch,
report. Also fix stale `server/` comments pointing at deleted `AGENTS.md`
sections. Full original list of observed bypasses (all addressed): async
environment creation, environment details and adapter versions, spawn with
adapter and mode, scheduling for other agents plus run history plus run-now,
viewing others' permission requests, listing own subscriptions, usage and
context, `list_agents` filters and a single-agent getter, transcript paging,
durable notifications to the human, bounded subscriptions (default one turn
end) and dropping subscriptions on archive, environment ports, start/stop,
branches, cancel a turn, view and withdraw queued messages, share files.

## State: done

Commits on top of host `main` (`64ca3cb`, imported last via Domo's
`import_branch`):

- `8281a73` stale `server/` comments.
- `cccead2` the mesh work (details in its message).
- `e4c3e29` notification toast fix and README.
- `f98a6fb`, `e1a5283` merges of host `main` (host-daemon/DooD architecture,
  retirement leftovers, GPT-Live voice, docs trim).
- `dc47b7e` a stale pointer to deleted spike docs.

Mesh now has 33 tools. New: `get_agent`, `cancel_agent_turn`,
`withdraw_queued_message`, `answer_permission_request`, `list_subscriptions`,
`get_dev_environment`, `list_environment_ports`, `forward_environment_port`
(both take `service` for containers an environment started on the host
daemon), `run_scheduled_task`, `get_usage_limits`, plus upstream's
`retry_environment_cleanup`. MCP `instructions` orient an agent new to Domo.
Results are compact JSON.

Schema additions (`server/lib/db.ts`): `agent_sessions.spawned_by`,
`agent_subscriptions.remaining_turns` (null = indefinite; old rows stay
indefinite), `dev_environments.adapter_versions`, table `notifications`
(synced to the browser; attachments stored under
`<data dir>/notifications/<id>/<index>`, served by
`server/api/notifications/[id]/attachments/[index].get.ts` with a sandbox CSP;
HTML/SVG only as downloads).

UI: sidebar Notifications button/slideover with unseen count and toasts
(`app/components/NotificationsButton.vue`); "Spawned by" badge on the agent
page.

Decision already approved by Andres: answering another agent's permission
requests, managing its schedules and withdrawing others' queued messages are
allowed only for agents the caller spawned, directly or transitively
(`assertOwns` / `isSpawnedBy`). Reads are open to all agents.

## Verified, and how

- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (121 files, 1804
  tests) pass at `dc47b7e`.
- `pnpm test:docker`: 171/175 pass. The 4 failures (`dood-images.live`
  ×3, `dev-environment.live` "keeps its Postgres…") fail identically on
  pristine upstream in this nested environment: the DooD proxy cannot reach a
  daemon when Domo itself runs inside a Domo environment. Not caused by this
  branch; not proven on a real host either.
- Tests that were broken on purpose to prove they fail: transcript paging
  edge logic, ownership guard, subscription countdown, toast rule.
- Live, with Haiku through a dev server of this branch in the environment
  (own Postgres): spawn with adapter/model/mode, answer a spawned child's
  permission, schedule + run-now + run history for the child, notification
  with host-file attachment, subscription note ending after one turn;
  async environment creation with ready note; inside an environment,
  adapter versions read from the container, port forward, container-file
  attachment. After the host-daemon merge: async create through the
  lifecycle queue, `docker: host`, adapter versions current. Browser:
  notifications panel, mark seen, Spawned-by badge.

## Not verified

- Codex and OpenCode as mesh callers (schemas avoid mixed-type fields for
  Codex, untested).
- Speech of a notification into a live voice session (Gemini or GPT-Live).
- The boot-time marking of a `creating` environment as failed after a
  restart (`server/plugins/boot.ts`).
- Branch listing/export in an environment: here it fails on a circular
  `.gitconfig` include, an artifact of running Domo nested in a Domo
  environment; needs a check on a real host.
- The DooD image features on a real host (see the 4 test failures).

## Open decisions for Andres, with recommendations

1. **Retiring mid-build waits for the build.** `beginEnvironment` runs the
   build inside the per-environment `lifecycle` queue (so it cannot race a
   start or retirement). A `retire_dev_environment` call issued during a cold
   build blocks for minutes. Recommend: add build cancellation (abort the
   build and let retirement proceed), or make retire itself asynchronous with
   a note, like creation.
2. **GPT-Live's thinking agent owns what it spawns.** Under the approved rule
   it can answer those agents' permission requests without the human hearing,
   whereas the voice agent asks out loud. Recommend: exclude sessions titled
   with `THINKING_TITLE_PREFIX` (or mark them) from `answer_permission_request`,
   or require it to relay the question via the live conversation.
3. **Voice `create_dev_environment` still blocks** until the build finishes
   (only the mesh tool was made async). Recommend: use `beginEnvironment`
   there too and speak the result when it lands.
4. **Tool list size** grew from ~15.6k to ~23k characters of source (~2k
   tokens per session). Claude Code defers MCP tools via ToolSearch so the
   cost is mostly on other harnesses. Recommend: accept; revisit if Codex or
   OpenCode sessions show context pressure.
5. Minor: a thinking agent calling `notify_supervisor` speaks into the
   conversation it serves as well as saving a notification. Harmless; leave.

## Next steps

1. Andres reviews the branch and the decisions above.
2. On approval, land it on the host (apply `server/` changes when no turn is
   running; see `docs/working-on-domo.md`), then on the host: run
   `pnpm test:docker` and one live mesh session per harness (Codex,
   OpenCode), and check `export_branch`/branch listing works outside the
   nested setup.
3. Act on the decisions (items 1–3 are small, contained changes in
   `server/lib/dev-environments.ts`, `server/lib/mesh/tools.ts` and
   `server/lib/voice/tools.ts`).

## Gotchas

- The browser tool loses its page load when Docker adds a network
  (`ERR_NETWORK_CHANGED`); reload after an environment build starts.
- `pgrep -f vitest` matches its own shell; read the output rather than
  trusting a nonzero count.
- In this nested setup the host `main` reaches the environment only through
  Domo's `import_branch` (it lands on `domo-import/<branch>` while a turn is
  running); refs visible in the environment's own git can be stale.
- `pnpm test:docker` inside a VS Code dev container needs `DOCKER_CONFIG`
  pointing at a scratch dir holding `{}`.

## Outside git

Nothing that matters. `/tmp` holds only logs of test and dev runs. The
environment's own Postgres has scratch rows from the live tests (all agents
archived, environments and projects retired). No dev server is running.
