# Domo

**A voice-first control room for coding agents.**

Talk to a Gemini Live agent. It spawns Claude Code and Codex sessions over
[ACP](https://agentclientprotocol.com), watches them work, answers their
permission prompts when you tell it to, and reports back — out loud — while your
hands stay free. Every session is persisted, and the UI updates in real time
through ElectricSQL.

```
you ⇄ (voice) ⇄ Gemini Live agent ⇄ tools ⇄ coding agents (ACP)
                                              ↕ agent-mesh MCP
                                        agents talk to each other / spawn peers
```

## What's in the box

- **Voice agent** — Gemini Live over a WebSocket: 16 kHz PCM up, 24 kHz PCM
  back, barge-in supported, live transcripts on screen. The model session lives
  on the server, so a page refresh never drops the conversation.
- **Projects and dev environments** — register a local checkout, then make any
  number of isolated containers from it, described by one `.domo.json` in the
  project. Each environment has a copied checkout, can host several parallel
  agents, and can have a private Docker-in-Docker daemon for Compose stacks.
- **Coding agents** — choose Claude Code or Codex for each session. Claude Code
  runs through Zed's official ACP adapter
  ([`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp),
  formerly `@zed-industries/claude-code-acp`); Codex runs through
  [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp).
  Streaming messages, tool calls, diffs, plans, permission prompts and modes
  are all first class.
- **Agent mesh** — every coding agent gets a built-in `domo` MCP server, served
  over HTTP by Domo itself, so agents can list each other, hand work over, spawn
  new peers, and page the voice supervisor. Each session is handed its own
  bearer token, so a call can only ever act as the agent that made it.
- **Custom MCP servers** — add stdio / HTTP / SSE servers in Settings and scope
  them to the voice agent, the coding agents, or both.
- **Real-time UI** — Postgres is the source of truth, ElectricSQL streams
  changes, and TanStack DB keeps the browser in sync. No polling.

## Requirements

- Node 22+ and pnpm 10+
- Docker (for Postgres + Electric)
- A Gemini API key ([AI Studio](https://aistudio.google.com/apikey))
- Access to at least one coding agent: a local Claude Code login or
  `NUXT_ANTHROPIC_API_KEY`; or a local Codex login, `NUXT_CODEX_API_KEY`, or
  `NUXT_OPENAI_API_KEY`

## Quick start

```bash
cp .env.example .env     # then put your Gemini key in it
docker compose up -d     # Postgres :54321 + Electric :30000
pnpm install
pnpm dev                 # https://localhost:3666 (Caddy) → http://localhost:3667
```

`pnpm dev` runs the Nuxt dev server behind a [Caddy](https://caddyserver.com)
HTTPS proxy (`Caddyfile`), since browsers only allow the microphone on secure
origins. It needs `caddy` on your PATH (`brew install caddy`); run `caddy trust`
once so the browser accepts Caddy's local certificate. Set `DOMO_HTTPS_ADDRESS`
(default `localhost:3666`) or `DOMO_DEV_PORT` (default `3667`) to change the
addresses.

The schema is created automatically on first boot. Press **New conversation**,
hit the mic, and say *"start an agent in ~/code/my-project and have it fix the
failing tests"*.

For isolated work, open **Projects**, add a local checkout, create a
development environment, then select that environment when starting agents.

### `.domo.json`

An environment is described by a single file in the project root, `.domo.json`
(JSONC — comments and trailing commas are fine). A project that does not have
one gets Domo's built-in definition. A project's `.devcontainer/devcontainer.json`
is **not** read: Domo owns how the container runs, and a file it only half
honoured would be worse than no file at all. Unknown keys under `devEnvironment`
are an error, not something quietly ignored.

```jsonc
{
  "devEnvironment": {
    // Exactly one of "image" or "build".
    "image": "ghcr.io/acme/my-project-dev:latest",
    "build": {
      "dockerfile": "Dockerfile.dev",  // relative to the project root
      "context": ".",                  // default "."
      "args": { "MARK": "yes" },
      "target": "dev"
    },

    // Dev Container Features, baked into the image.
    "features": { "ghcr.io/devcontainers/features/python:1": {} },

    // A private, nested Docker daemon (docker-in-docker). Default false.
    // Only an environment with this runs privileged.
    "docker": true,

    "remoteUser": "dev",               // who agents and commands run as
    "containerEnv": { "API_URL": "http://localhost:3000" },
    "forwardPorts": [3000, "5432/tcp"],
    "portsAttributes": { "3000": { "label": "Web app", "protocol": "http" } },

    // A string runs through `sh -c`; an array is argv.
    "postCreateCommand": "pnpm install"
  }
}
```

The built-in definition, used when there is no `.domo.json`, is:

```jsonc
{
  "devEnvironment": {
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
    "features": { "ghcr.io/devcontainers/features/node:1": { "version": "22" } },
    "docker": true
  }
}
```

**The image must be glibc-based and have `git`.** Domo mounts its own Node and
both ACP adapters into every environment from a shared, read-only volume, so the
image does not need a Node of its own — but that Node is glibc-linked, so Alpine
and other musl images are not supported. Creation fails with exactly that
message rather than with something obscure later on.

#### Using the same Dockerfile as VS Code

A project that already has a `.devcontainer/Dockerfile` for VS Code can point
Domo at it instead of duplicating anything:

```jsonc
{
  "devEnvironment": {
    "build": { "dockerfile": ".devcontainer/Dockerfile", "context": "." },
    "docker": true
  }
}
```

### What an environment is

- The image is built once per environment by the Dev Container CLI, which is
  used **only** as an image builder — that is what makes Features available.
  Domo runs the container itself.
- The full source checkout (including its version-control metadata) is copied
  into a private Docker volume mounted at `/workspaces/<environment>`. Nothing
  bind-mounts your working tree, so file-heavy work (installs, test runs) runs
  at native container speed and an agent's edits never touch your checkout.
- Multiple Claude Code and Codex ACP sessions can run against that same copy.
- With `"docker": true` the environment is privileged and has its own nested
  Docker daemon, so agents can use `docker compose` without sharing stacks with
  the host or other environments. Without it the container is unprivileged.
- The checkout and any nested containers persist across stop/start, and the
  container, both volumes and the image are removed when the environment is
  deleted. **The checkout exists only in the volume**, so push what you want to
  keep (or `docker cp` it out) before deleting.

### Forwarding application ports

`forwardPorts` and `portsAttributes` in `.domo.json` are shown automatically in the environment card and bound to a random free
port on `127.0.0.1`. Domo also scans running environments for listening TCP
ports every five seconds. Undeclared ports appear in the same card and can be
forwarded with one click, without VS Code and without recreating the container.
The **Open** action launches the forwarded address in the host browser.

### Open an environment in VS Code

The checkout lives inside the container, so editing it means attaching an editor
to that container. **Open in VS Code** on a running environment does exactly
that: it opens a `vscode://vscode-remote/attached-container+…` URL, which is the
same thing as the Dev Containers command *Attach to Running Container*.

Requirements:

- VS Code with the **Dev Containers** extension installed;
- the environment running — the action is disabled while it is stopped;
- if VS Code runs on a different machine than Domo's Docker, set **VS Code SSH
  host** in Settings (for example `you@server`) so VS Code reaches that daemon
  over SSH. Leave it empty when they are the same machine.

## Configuration

Everything secret lives in `.env`; everything else is editable in **Settings**.

| Variable | Purpose |
| --- | --- |
| `NUXT_GEMINI_API_KEY` | Gemini key for the voice agent (required) |
| `NUXT_ANTHROPIC_API_KEY` | Optional; forwarded to the Claude Code adapter |
| `NUXT_CODEX_API_KEY` | Optional; forwarded as `CODEX_API_KEY` to the Codex adapter |
| `NUXT_OPENAI_API_KEY` | Optional; forwarded as `OPENAI_API_KEY` to the Codex adapter |
| `DATABASE_URL` | Postgres, defaults to the compose service |
| `ELECTRIC_URL` | Electric, defaults to `http://localhost:30000` |
| `NUXT_GEMINI_LIVE_MODEL` | Default Live model id |
| `NUXT_DEFAULT_CWD` | Default workspace for new coding agents |
| `NUXT_DATA_DIR` | Where uploads are stored (default `./.data`) |
| `NUXT_DEV_ENV_IMAGE` | Base image of the built-in environment definition |
| `NUXT_DEV_ENV_RUNTIME_IMAGE` | Image the shared runtime volume takes its Node and adapters from (default `node:22-bookworm-slim`) |
| `NUXT_DEV_ENV_HELPER_IMAGE` | Image used to copy a checkout into its volume (default `busybox:1.37`; set it for offline installs) |
| `NUXT_DEV_ENV_RESOURCE_PREFIX` | Prefix of the containers, images and volumes Domo creates (default `domo-dev-`) |
| `NUXT_DEV_ENV_DOCKER_READY_MS` | How long a nested Docker daemon gets to start before creation fails (default `30000`) |
| `NUXT_CLAUDE_CONFIG_DIR` | Claude config directory mounted into environments (defaults to `~/.claude`) |
| `NUXT_CODEX_CONFIG_DIR` | Codex config directory mounted into environments (defaults to `~/.codex`) |

### About the Live model id

Google's Live model ids move fast. Domo defaults to `gemini-3.8-live`
and lets you change it in **Settings → Live model**; the dropdown is populated
from `models.list` on your own API key, and you can type any id by hand. If a
session fails to connect with a model-not-found error, that's the knob to turn.

## How it fits together

```
app/                     Nuxt 4 SPA (Nuxt UI 4)
  composables/
    useVoiceChannel.ts   mic capture → PCM16 → WS, playback + barge-in
    useDomoData.ts       live queries over the TanStack DB collections
  lib/collections.ts     Electric-backed TanStack DB collections
  utils/agentTranscript  ACP event log → renderable transcript
server/
  lib/db.ts              Postgres pool + schema (source of truth)
  lib/voice/runtime.ts   Gemini Live session, tool dispatch, persistence
  lib/voice/tools.ts     the voice agent's tools over coding agents
  lib/acp/manager.ts     Claude Code / Codex ACP processes, one per session
  lib/dev-environments   Docker/DinD environment lifecycle
  lib/mesh/              the agent-mesh tools, MCP transport and tokens
  api/internal/mcp.ts    the agent-mesh MCP server every coding agent gets
  api/shape.get.ts       authorising proxy in front of Electric
  api/voice/ws.ts        the audio bridge
```

Two durable logs do the heavy lifting: `agent_events` (every ACP
`session/update`, append-only) and `voice_messages` (the spoken transcript plus
tool calls). The UI is a pure function of those tables, which is why a restart,
a second tab, or a phone all show the same thing.

## Development

```bash
pnpm dev         # dev server behind Caddy HTTPS (https://localhost:3666)
pnpm typecheck   # vue-tsc
pnpm lint        # eslint
pnpm build       # production build → .output
pnpm test        # the whole suite (needs `docker compose up -d`)
```

Tests are layered, and each layer is a Vitest project you can run on its own:
`pnpm test:unit` (pure logic, no services), `pnpm test:nuxt` (components and
composables in a Nuxt runtime), `pnpm test:integration` (the repository layer
against a real Postgres, plus the whole API over HTTP against a real Nitro
build), `pnpm test:electric` (a page mounted in happy-dom driving the real
server, with a real ElectricSQL streaming the change back into it) and
`pnpm test:docker` (needs a Docker daemon).

No test opens a browser or calls a real model. The services are a precondition:
with them stopped the suite fails rather than quietly skipping the layers that
need them. Tests run against separate `domo_test` and `domo_e2e` databases, so
your own `domo` database is never touched.

## Caveats

- Single user, no auth. Bind it to localhost.
- The coding agents run on your machine, with your files and your Claude or
  OpenAI account. "Auto-approve permission requests" in Settings really does mean the
  agent can edit and run things unattended.
- Dev environments require a Docker host that permits privileged containers.
  Treat an environment as a trusted development machine: its agents can fully
  control its private nested Docker daemon.
- Attachments are stored on disk under `<data dir>/uploads` and handed to agents as
  `file://` resource links.

## License

See [LICENSE.md](./LICENSE.md).
