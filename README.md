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
- Access to at least one coding agent: a `claude setup-token` token (see
  [Claude authentication](#claude-authentication)), a local Claude Code login,
  or `NUXT_ANTHROPIC_API_KEY`; and/or a local Codex login, `NUXT_CODEX_API_KEY`,
  or `NUXT_OPENAI_API_KEY`

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
    "features": {
      "ghcr.io/devcontainers/features/node:1": { "version": "22" },
      "ghcr.io/devcontainers/features/github-cli:1": { "version": "latest" }
    },
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

### Git, SSH and CLI logins inside environments

An environment is a parallelism and namespace mechanism, not a security
boundary: it runs on your machine, for you. So Domo **bind-mounts your login
state into the environment's home directory**, and an agent in there can push,
open a PR and talk to the clouds you are already signed in to.

What is mounted is a list in **Settings → Development environments → Home
directory mounts**, one path per line, relative to your home directory. The
default is:

```
.ssh
.gitconfig
.config/gh
.config/gcloud
.aws
.kube
```

- Entries are **read-write** (gh and gcloud refresh their tokens in place), and
  an entry you do not have is skipped silently.
- `.claude`, `.claude.json` and `.codex` are refused — see
  [Claude authentication](#claude-authentication) for the first two; Codex has
  its own mount already.
- **`.docker` is not there on purpose.** Docker Desktop writes
  `"credsStore": "desktop"` into `~/.docker/config.json`, and that helper only
  exists on your machine: with the file mounted, every `docker pull` inside the
  environment fails with `docker-credential-desktop: executable file not found`.
- Mounts are fixed when the container is created, so a change applies to
  environments you create afterwards.

**Your `~/.gitconfig` is included, not replaced.** It is mounted read-only at
`~/.gitconfig-host`, and Domo writes the environment's own `~/.gitconfig` with
an `[include]` of it. Your identity therefore follows you, but the environment
gets its own credential helper (`gh auth git-credential`, replacing an
`osxkeychain` or similar that does not exist in there), its own
`safe.directory`, and commit signing off — the signing key is on your machine,
not in the container. It also means VS Code's *Attach to Running Container*,
which writes its own helper into the container's global git config, cannot
reach back into yours.

**Your `~/.ssh` is wrapped, not mounted in place** — for a blunter reason than
the git one. A macOS `~/.ssh/config` almost always contains `UseKeychain yes`,
and that keyword exists only in Apple's OpenSSH: Linux OpenSSH treats an unknown
option as **fatal**, so every `ssh` in the container would die with
`Bad configuration option: usekeychain` before connecting, and `git push` would
report it as "Please make sure you have the correct access rights". So your
directory is mounted at `~/.ssh-host`, and the environment's own `~/.ssh/config`
is written by Domo:

```
IgnoreUnknown UseKeychain
Include ~/.ssh-host/config
```

`IgnoreUnknown` has to come first (ssh dies on the unknown keyword before it
would reach it, and `/etc/ssh/ssh_config` is read *after* your file, so a
system-wide setting cannot help). Everything else in your `~/.ssh` — keys,
`known_hosts`, certificates — is symlinked into `~/.ssh` under its own name, so
an `IdentityFile ~/.ssh/id_ed25519` in your config still resolves, and
`known_hosts` is shared both ways.

**The SSH agent is forwarded**, so keys in a keychain, in 1Password or behind a
passphrase work too; `SSH_AUTH_SOCK` is set in every session. On Docker Desktop
this uses Docker Desktop's own agent forwarding, elsewhere the socket the Domo
process itself is using. On Linux, note that `ssh` refuses a key file it does
not own — if the container user's uid differs from yours, the linked keys are
unusable and the agent is what does the signing.

**GitHub comes through `gh`.** The built-in environment definition installs the
`github-cli` Feature, and Domo passes `GH_TOKEN` into every environment session:
`NUXT_GH_TOKEN` if you set it, otherwise whatever `gh auth token` answers on
your machine (on macOS the token lives in the Keychain, so the mounted
`~/.config/gh` alone would not be enough). That is what makes both `gh` and
`git push` over HTTPS work in there. A project with its own `.domo.json` should
add the Feature if it wants `gh`.

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
| `NUXT_CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; how Claude Code authenticates inside a development environment — see [Claude authentication](#claude-authentication) |
| `NUXT_ANTHROPIC_API_KEY` | Optional fallback; **bills the API, not your subscription**, and is passed only when there is no other credential |
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
| `NUXT_CLAUDE_CONFIG_DIR` | Where the Claude config *copied* into a new environment is read from (defaults to `~/.claude`) |
| `NUXT_CODEX_CONFIG_DIR` | Codex config directory mounted into environments (defaults to `~/.codex`) |
| `NUXT_HOME_OVERLAY_DIR` | Home directory the environment mounts are read from (defaults to `$HOME`) |
| `NUXT_GH_TOKEN` | GitHub token given to environment sessions; falls back to `gh auth token` on this machine |
| `NUXT_CLAUDE_MODEL` / `NUXT_CODEX_MODEL` | Default model for new sessions of that adapter, when the session names none |

### Claude authentication

**Run `claude setup-token` once and put the token in `.env` as
`NUXT_CLAUDE_CODE_OAUTH_TOKEN`.** It is a one-year token, billed to your Claude
subscription, and it is how Claude Code authenticates inside a development
environment.

Domo deliberately **never copies your Claude login into a container.** Anthropic
rotates the OAuth refresh token every time Claude Code refreshes, and the
previous one stops working — so two Claude Codes sharing one credential log each
other out. If the copy in a long-lived container refreshed first, the loser
would be your own machine, and the only fix is an interactive `/login`. (Widely
reported, though not documented by Anthropic:
[#88583](https://github.com/anthropics/claude-code/issues/88583),
[#48786](https://github.com/anthropics/claude-code/issues/48786),
[#78020](https://github.com/anthropics/claude-code/issues/78020).) A setup token
has no refresh chain to fork, which is why it is the supported answer for
headless and CI use.

What an environment *does* get is a copy, taken at creation, of the harmless
parts of `~/.claude`: `CLAUDE.md`, `settings.json`, `skills/`, `commands/` and
`agents/`. Never `.credentials.json`, and never `projects/`, `todos/`, `history`
or `sessions` — those are transcripts of everything else you have ever asked
Claude Code. Because it is a snapshot, editing your global `CLAUDE.md` afterwards
does not reach an environment that already exists.

Precedence, which Claude Code defines and Domo follows: `ANTHROPIC_API_KEY` beats
`CLAUDE_CODE_OAUTH_TOKEN`, which beats a stored `/login`. An API key in the
environment is used **with no prompt** in non-interactive mode, so Domo passes
`NUXT_ANTHROPIC_API_KEY` only when there is no OAuth token and no host login —
otherwise your work would quietly bill the API instead of your subscription.

Codex is different and needs none of this: its `~/.codex` directory is mounted,
and `auth.json` there is one shared copy rather than a forked chain.

The same reasoning is why `.claude` and `.claude.json` are refused as
[home directory mounts](#git-ssh-and-cli-logins-inside-environments), whatever
you put in the setting.

### Permission modes

A coding agent's **permission mode** decides how much it may do before it stops
to ask. The modes are the agent's own, and the two agents share none of them:

| Claude Code | Codex |
| --- | --- |
| `default` — Manual, always ask | `read-only` — Ask for approval |
| `acceptEdits` — accept file edits | `agent` — Approve for me *(its default)* |
| `plan` — plan before changing anything | `agent-full-access` — unrestricted |
| `auto` — Claude decides | |
| `bypassPermissions` — accept everything | |

So **Settings → Coding agents → Default permission mode** has one picker per
agent, and each list is fetched from the agent itself the same way the model
list is — by starting a throwaway session and reading what it answers with
(cached for an hour). If an agent cannot be asked — not logged in, not
installed — the picker says so and you can type an id by hand. A brand-new mode
that shipped after this Domo goes in the same way.

Each new session starts in its agent's default and can be given a different one
in the **New coding agent** dialog, or changed from the agent's own page at any
time. The mode lives on the session, not in Settings, so two agents can run in
different modes at once — and it is re-applied every time Domo reattaches to a
session, because the agent comes back in whatever mode *it* defaults to.

Domo upgrades an install that predates the split: whatever single mode you had
chosen becomes the Claude Code default, and Codex starts on its own.

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
