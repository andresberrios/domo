# CLAUDE.md — orientation for future sessions

> Keep this file current in the *same* change that makes it stale.

## What this repo is

Domo: a self-hosted, single-user Nuxt app where you **talk** to a Gemini Live
agent that runs **Claude Code** sessions for you over ACP. Read `README.md`
first — it covers the product, the setup and the layout. This file records the
things that are easy to get wrong.

## Stack

- Nuxt 4 (SPA — `ssr: false`) + Nuxt UI 4, Tailwind 4 theme in
  `app/assets/css/main.css` + `app/app.config.ts`.
- Nitro server routes (`server/api`), plain `defineEventHandler` /
  `defineWebSocketHandler` (`nitro.experimental.websocket` is on).
- Postgres (docker compose) is the source of truth; ElectricSQL streams shapes;
  TanStack DB (`@tanstack/db` + `@tanstack/electric-db-collection` +
  `@tanstack/vue-db`) holds the client store and answers live queries.
- `@google/genai` for the Live API; `@agentclientprotocol/sdk` +
  `@agentclientprotocol/claude-agent-acp` for coding agents;
  `@modelcontextprotocol/sdk` for MCP clients.

## Architecture decisions that matter

- **The Gemini Live session lives on the server**, not the browser. The browser
  only ships microphone PCM up and plays PCM down over `/api/voice/ws`. That
  keeps the API key server-side, lets tools run in-process, makes persistence
  trivial, and means a reload doesn't kill the conversation.
- **Everything the UI renders is a table.** `agent_events` (append-only ACP
  `session/update` log) and `voice_messages` are the two durable logs;
  `buildTranscript()` in `app/utils/agentTranscript.ts` folds events into a
  render model. Never render from an in-memory server cache.
- **One adapter process per coding agent session**, spawned lazily
  (`server/lib/acp/manager.ts`) and reattached with `session/load` when the
  session already has an `acp_session_id`.
- **Projects own dev environments; dev environments own isolation.** A managed
  environment is a long-lived privileged container with a copied checkout in a
  named volume and a private DinD daemon. Multiple agent sessions may share one
  environment. Their ACP adapters run through `docker exec`; legacy sessions
  without `dev_environment_id` still run directly on the host.
- **Permission requests are rows, not callbacks.** `onPermission` writes a
  pending `agent_permissions` row, then parks on a promise. The UI, the voice
  agent (`answer_permission`) and the auto-approve setting all resolve the same
  row through `acpManager.answerPermission`.
- **The voice agent is told about agent activity through the bus**, not through
  imports: `server/lib/bus.ts` carries `agent-event` / `permission-changed`, and
  the runtime injects a spoken note (`injectNote`) when
  `settings.proactiveNotifications` is on.

## Gotchas (learned the hard way)

- **Scrub the environment when spawning the ACP adapter.** `adapterEnv()` in
  `server/lib/acp/manager.ts` passes an allow-list only. Inheriting a parent
  Claude Code session's `CLAUDE_*` / `CLAUDECODE` variables makes the nested CLI
  adopt the parent's flags — the symptom was `session/new` failing with a bare
  "Internal error" (really `--dangerously-skip-permissions cannot be used with
  root/sudo privileges`).
- **Resolve the adapter entry from `process.cwd()`.** The production bundle runs
  from a virtual module path, so `createRequire(import.meta.url).resolve(...)`
  fails there. `adapterEntry()` tries cwd first, then `import.meta.url`, then
  gives a human error. `NUXT_CLAUDE_ACP_ENTRY` overrides it.
- **Container ACP file callbacks must stay in the container.** Read/write ACP
  requests are proxied through Docker; never use the host filesystem for an
  environment-backed session. The built-in mesh server is copied to
  `/opt/domo/agent-mesh.mjs` in the environment image and reaches the host via
  `host.docker.internal`.
- **`UChatMessages` skips messages whose `parts` array is empty.** Rich items
  ride in `metadata` and render through the `#content` slot, but each message
  still needs a plain-text part (see `AgentTranscript.vue`).
- **Nuxt Icon falls back to the remote Iconify API when `ssr: false`.** The
  config pins `icon.provider: 'server'` + `clientBundle.scan`, so a local,
  offline install still has icons. Don't drop it.
- **Sequence columns are `bigserial`, not `max(seq)+1`.** Concurrent event
  appends collided and produced duplicate `seq` values within a session.
- **Electric needs `REPLICA IDENTITY FULL`** on every synced table (set in the
  schema) or updates arrive without the unchanged columns.
- **The shape proxy (`server/api/shape.get.ts`) must forward Electric's protocol
  params and drop `content-encoding`/`content-length`** after `fetch` has
  already decompressed the body, or the browser client cannot decode the stream.
- **A failed Live connect is cached for 10 s** (`connectError` in the runtime):
  the mic sends ~8 chunks a second and would otherwise turn one bad key into an
  error storm. The client stops the mic on the first fatal error.

## Verification notes

- `pnpm typecheck`, `pnpm lint`, `pnpm build` all run clean; keep them that way.
- The ACP path was verified end to end against a real Claude Code account:
  `session/new` with the agent-mesh MCP server attached, streaming
  `agent_message_chunk`s, `tool_call` / `tool_call_update` for Bash, Read and
  Write, a pending permission request, and `stopReason: end_turn`.
- The browser audio path was verified with a fake capture device: the worklet
  produces ~8 PCM16 chunks/second at 16 kHz and they arrive over the WebSocket.
- UI was checked with real rendered screenshots (desktop + mobile, light +
  dark) — the a11y tree alone will not tell you whether the CSS loaded.

## Conventions

- Components live flat in `app/components` with plain names; pages under
  `app/pages`; the dashboard shell is `app/layouts/default.vue`.
- Prefer Nuxt UI components (`UDashboard*`, `UChat*`, `UModal`, `UAlert`, …)
  over bespoke markup. Always give `UModal` both `title` and `description`.
- Server helpers go in `server/lib/<area>/`; anything that writes to the
  database goes through `server/lib/repo.ts` so the bus stays informed.
- Shared types are in `shared/types/index.ts` and imported as `~~/shared/types`.
- Keep environment lifecycle operations in `server/lib/dev-environments.ts`;
  invoke Docker with argument arrays, never interpolated shell commands.
