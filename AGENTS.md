# AGENTS.md

Nuxt 4 app using **Electric Agents** (`@electric-ax/agents-runtime`). The agents server runs in Docker; this Nuxt app registers agent types and hosts the webhook the server calls back to run handlers.

## Dev

- `pnpm dev` runs Nuxt (port 4001) + Caddy proxy concurrently. Caddy exposes HTTP/2 endpoints; if a stray `caddy`/`nuxt` process holds a port, `pnpm dev` fails with `ELIFECYCLE` — kill leftovers first.
- Agents server (Docker): `pnpm agents` (= `ELECTRIC_AGENTS_SERVER_IMAGE_TAG=0.6.3-wakefix pnpm electric agents start`) → Postgres + Electric + agents server on `http://localhost:4437`. Uses the pinned local CLI (`electric-ax@0.2.23`, whose default server image is `0.6.3`) and the locally-built patched image (see gotcha 4). Prefer the local `pnpm electric …` over `pnpx electric-ax@latest …` — `@latest` is a moving target that can bump the default image off `0.6.3` and desync from the `agents-runtime@0.6.3` patch. Plain `pnpm electric agents start` runs the unpatched `0.6.3` image.
- **Dev UI: open `https://localhost:4438`** (Caddy, HTTP/2). Not `http://localhost:4437`.
- Agent definitions: [server/plugins/register-agents.ts](server/plugins/register-agents.ts). Webhook route: [server/routes/webhooks/electric-agents.post.ts](server/routes/webhooks/electric-agents.post.ts).

## Setup gotchas (learned the hard way)

1. **Bind Nuxt to all interfaces (`devServer.host: '0.0.0.0'` in [nuxt.config.ts](nuxt.config.ts)).** The agents server is in Docker and calls the run webhook back over the Docker host boundary; Nuxt's default loopback-only bind is unreachable from the container, so the agent spawns but never responds — with **no error logged anywhere**. This 0.0.0.0 bind is the actual fix. The `serveEndpoint` host itself can be `localhost` *or* `host.docker.internal`: the server rewrites loopback hosts (`localhost`/`127.0.0.1`/`::1`) to `host.docker.internal` automatically (via `ELECTRIC_AGENTS_REWRITE_LOOPBACK_WEBHOOKS_TO`, set by the CLI compose). [server/plugins/register-agents.ts](server/plugins/register-agents.ts) writes `host.docker.internal` explicitly just to keep the URL unambiguous. (Filed upstream as a docs PR: [electric-sql/electric#4721](https://github.com/electric-sql/electric/pull/4721).)

2. **`pnpm electric agents types` shows "No entity types found" even when types are registered.** `GET /_electric/entity-types` is scoped by the `Electric-Principal` header. The CLI defaults to `user:<whoami>@<hostname>` (no grants → empty); the dev UI uses `system:dev-local`. A raw `curl` with no header returns everything. Workaround:
   ```
   ELECTRIC_AGENTS_PRINCIPAL=system:dev-local pnpm electric agents types
   ```
   This is an upstream bug/doc-gap — the walkthrough implies the default CLI invocation lists your types, but it doesn't.

3. **User messages reached the agent as JSON `{"source":"..."}` — patched.** Bug in `@electric-ax/agents-runtime@0.6.3`: the timeline projection drops `message_type`, so `projectInboxPayload` can't recognize `composer_input` and falls back to `JSON.stringify(payload)`. Fixed by re-adding `message_type` in `dist/use-chat-*.js` (buildInboxMessages + two live-query selects) via [patches/@electric-ax__agents-runtime@0.6.3.patch](patches/@electric-ax__agents-runtime@0.6.3.patch), wired in [pnpm-workspace.yaml](pnpm-workspace.yaml). Remove the patch once upstream ships a fix.

4. **Parallel sub-agent spawn dropped a parent wake — patched via a local Docker image.** Server-side bug in `agents-server@0.6.3`: when a parent spawns 2+ sub-agents in one turn, only one child's `runFinished` wakes the parent; the others are silently dropped (cache-clobber race in `wake-registry.ts`). Fix is in the Docker image, not an npm dep, so the pnpm patch above can't reach it. Built a patched image `electricax/agents-server:0.6.3-wakefix` from a sibling checkout of the `electric` repo (branch `fix/wake-registry-parallel-spawn-clobber`, PR [electric-sql/electric#4720](https://github.com/electric-sql/electric/pull/4720)):
   ```
   docker build -f packages/agents-server/Dockerfile -t electricax/agents-server:0.6.3-wakefix .
   ```
   The `pnpm agents` script points the CLI at it via `ELECTRIC_AGENTS_SERVER_IMAGE_TAG`; `compose up -d` runs without `--pull`, so the local tag is used (never pulled). Drop the env override (and rebuild image only if needed) once upstream ships a release with the fix.
