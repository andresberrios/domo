# Domo

**A voice-first control room for coding agents.**

Talk to a Gemini Live agent. It spawns Claude Code sessions over
[ACP](https://agentclientprotocol.com), watches them work, answers their
permission prompts when you tell it to, and reports back — out loud — while your
hands stay free. Every session is persisted, and the UI updates in real time
through ElectricSQL.

```
you ⇄ (voice) ⇄ Gemini Live agent ⇄ tools ⇄ Claude Code agents (ACP)
                                              ↕ agent-mesh MCP
                                        agents talk to each other / spawn peers
```

## What's in the box

- **Voice agent** — Gemini Live over a WebSocket: 16 kHz PCM up, 24 kHz PCM
  back, barge-in supported, live transcripts on screen. The model session lives
  on the server, so a page refresh never drops the conversation.
- **Projects and dev environments** — register a local Git checkout, then make
  any number of isolated dev containers from it. Each environment has a copied
  checkout, can host several parallel agents, and includes a private
  Docker-in-Docker daemon for Compose stacks.
- **Coding agents** — each one is a real Claude Code session driven through
  Zed's official ACP adapter
  ([`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp),
  formerly `@zed-industries/claude-code-acp`). Streaming messages, tool calls,
  diffs, plans, permission prompts and modes are all first class.
- **Agent mesh** — every coding agent gets a built-in `domo` MCP server, so
  agents can list each other, hand work over, spawn new peers, and page the
  voice supervisor.
- **Custom MCP servers** — add stdio / HTTP / SSE servers in Settings and scope
  them to the voice agent, the coding agents, or both.
- **Real-time UI** — Postgres is the source of truth, ElectricSQL streams
  changes, and TanStack DB keeps the browser in sync. No polling.

## Requirements

- Node 22+ and pnpm 10+
- Docker (for Postgres + Electric)
- A Gemini API key ([AI Studio](https://aistudio.google.com/apikey))
- Claude Code access — either you are logged in locally (`claude /login`) or you
  set `NUXT_ANTHROPIC_API_KEY`

## Quick start

```bash
cp .env.example .env     # then put your Gemini key in it
docker compose up -d     # Postgres :54321 + Electric :30000
pnpm install
pnpm dev                 # http://localhost:3000
```

The schema is created automatically on first boot. Press **New conversation**,
hit the mic, and say *"start an agent in ~/code/my-project and have it fix the
failing tests"*.

For isolated work, open **Projects**, add a local Git checkout, create a
development environment, then select that environment when starting agents.
Domo resolves the environment definition in this order:

1. `.devcontainer/devcontainer.json` or `.devcontainer.json` — the standard
   Dev Container definition, launched with the official Dev Container CLI.
2. `.domo.json` — a small fallback for projects that only need to select a
   prebuilt image.
3. Domo's built-in Ubuntu Dev Container definition.

For example, a repository can use a prebuilt image without adding a full
Dev Container definition:

```json
{
  "devEnvironment": {
    "image": "ghcr.io/acme/my-project-dev:latest",
    "remoteUser": "vscode",
    "forwardPorts": [3000],
    "portsAttributes": {
      "3000": { "label": "Web app", "protocol": "http" }
    }
  }
}
```

Domo preserves the project's Dev Container image/build/Compose definition,
Features, mounts, environment variables, lifecycle commands, and user. It adds
Node, Docker-in-Docker, its agent adapter, and the labels and mounts needed to
manage the environment.

Each environment:

- copies the full source checkout (including its Git metadata) into Domo's data
  directory and bind-mounts that copy at `/workspaces/<environment>`;
- can run multiple Claude Code ACP sessions against that same copy;
- runs privileged with its own nested Docker daemon, so agents can use
  `docker compose` without sharing stacks with the host or other environments;
- persists its checkout and nested containers across stop/start, and removes
  both when the environment is deleted.

### Forwarding application ports

`forwardPorts` and `portsAttributes` in `devcontainer.json` (or `.domo.json`)
are shown automatically in the environment card and bound to a random free
port on `127.0.0.1`. Domo also scans running environments for listening TCP
ports every five seconds. Undeclared ports appear in the same card and can be
forwarded with one click, without VS Code and without recreating the container.
The **Open** action launches the forwarded address in the host browser.

## Configuration

Everything secret lives in `.env`; everything else is editable in **Settings**.

| Variable | Purpose |
| --- | --- |
| `NUXT_GEMINI_API_KEY` | Gemini key for the voice agent (required) |
| `NUXT_ANTHROPIC_API_KEY` | Optional; forwarded to the Claude Code adapter |
| `DATABASE_URL` | Postgres, defaults to the compose service |
| `ELECTRIC_URL` | Electric, defaults to `http://localhost:30000` |
| `NUXT_GEMINI_LIVE_MODEL` | Default Live model id |
| `NUXT_DEFAULT_CWD` | Default workspace for new coding agents |
| `NUXT_DATA_DIR` | Where copied dev environments and uploads are stored (default `./.data`) |
| `NUXT_DEV_ENV_IMAGE` | Override Domo's built-in fallback Dev Container image |
| `NUXT_CLAUDE_CONFIG_DIR` | Claude config directory mounted into environments (defaults to `~/.claude`) |

### About the Live model id

Google's Live model ids move fast. Domo defaults to `gemini-3.8-live-preview`
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
  lib/acp/manager.ts     Claude Code adapter processes, one per session
  lib/dev-environments   Docker/DinD environment lifecycle
  mcp/agent-mesh.mjs     zero-dependency MCP server handed to coding agents
  api/shape.get.ts       authorising proxy in front of Electric
  api/voice/ws.ts        the audio bridge
```

Two durable logs do the heavy lifting: `agent_events` (every ACP
`session/update`, append-only) and `voice_messages` (the spoken transcript plus
tool calls). The UI is a pure function of those tables, which is why a restart,
a second tab, or a phone all show the same thing.

## Development

```bash
pnpm dev         # dev server
pnpm typecheck   # vue-tsc
pnpm lint        # eslint
pnpm build       # production build → .output
```

## Caveats

- Single user, no auth. Bind it to localhost.
- The coding agents run on your machine, with your files and your Claude
  account. "Auto-approve permission requests" in Settings really does mean the
  agent can edit and run things unattended.
- Dev environments require a Docker host that permits privileged containers.
  Treat an environment as a trusted development machine: its agents can fully
  control its private nested Docker daemon.
- Attachments are stored on disk under `.data/uploads` and handed to agents as
  `file://` resource links.

## License

See [LICENSE.md](./LICENSE.md).
