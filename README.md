# Domo

**A voice-first control room for coding agents.**

You talk to a Gemini Live agent. It starts Claude Code, Codex and OpenCode
sessions over [ACP](https://agentclientprotocol.com), watches them work,
answers their permission prompts when you tell it to, and reports back out
loud. You can also type to any agent directly. Every session is saved, and the
UI updates in real time.

With Domo you can:

- Run coding agents on your machine, or in isolated dev environments
  (containers) made from a project checkout.
- Let agents talk to each other, start new agents, and follow each other's
  progress through a built-in `domo` MCP server.
- Send a message to a busy agent. You choose how it arrives: *steer* it into
  the running turn, *queue* it until the turn ends, or *interrupt* the turn.
- Schedule prompts to agents, once or on a cron schedule.
- See context usage for each session, and your Claude, Codex and OpenCode Go
  plan limits.

## Requirements

- Node 22+ and pnpm 10+
- Docker
- [Caddy](https://caddyserver.com) on your `PATH` (`brew install caddy`).
  Browsers allow the microphone only on HTTPS.
- A Gemini API key ([AI Studio](https://aistudio.google.com/apikey))
- At least one coding agent account. See [Authentication](#authentication).

## Quick start

```bash
cp .env.example .env     # add your Gemini key
docker compose up -d     # Postgres :54321, Electric :30000
pnpm install
caddy trust              # once, so the browser accepts Caddy's certificate
pnpm dev                 # open https://localhost:3666
```

Domo creates the database schema on first boot. Press **New conversation**,
turn on the mic, and say *"start an agent in ~/code/my-project and have it fix
the failing tests"*.

To use isolated environments, add a project from the sidebar, create a
development environment for it, and choose that environment when you start an
agent.

To change the addresses, set `DOMO_HTTPS_ADDRESS` (default `localhost:3666`) or
`DOMO_DEV_PORT` (default `3667`). Always open the HTTPS address.

## Authentication

**Claude Code.** Run `claude setup-token` once and put the token in `.env` as
`NUXT_CLAUDE_CODE_OAUTH_TOKEN`. Claude Code needs it to run inside development
environments, and Domo needs it to show your Claude plan limits. Host sessions
can also use your local Claude login.

Domo never copies your Claude login into a container. Claude Code rotates its
refresh token every time it refreshes, so two copies of one login log each
other out, and the one that loses can be your own machine. For the same
reason, `.claude` and `.claude.json` cannot be mounted into an environment.

`NUXT_ANTHROPIC_API_KEY` is optional. It **bills the API, not your
subscription**, so Domo passes it only when there is no other Claude
credential.

**Codex.** Run `codex login`, or set `NUXT_CODEX_API_KEY` or
`NUXT_OPENAI_API_KEY`. Domo mounts `~/.codex` into environments.

**OpenCode.** Host sessions use your `opencode auth login`. A development
environment needs an OpenCode console service-account key in
`NUXT_OPENCODE_API_KEY` or on the OpenCode settings page (for the same
refresh-token reason as Claude). The key also enables the OpenCode Go plan
limits. Without a credential, only OpenCode's free models work. Priced models
fail as unroutable.

Check the model prefix before you run OpenCode. `openai/*` models bill your
ChatGPT login, and `opencode/*` models bill OpenCode console usage per token.
Some model names exist under both prefixes.

## Development environments

A development environment is a long-lived container with its own copy of a
project's checkout, stored in a Docker volume. Several agents can share one
environment.

- The copy starts at your last commit. Uncommitted changes stay on your
  machine, unless you turn on **Carry uncommitted changes from the host** when
  you create the environment. Ignored files such as `node_modules` and `.env`
  are copied.
- To bring work back, use **Export branch**, or the `export_branch` tool. It
  fetches the branch into your checkout and only fast-forwards your local
  branch. **Import branch** sends a branch from your checkout into the
  environment.
- **Retiring** an environment destroys its container and volumes, including
  the checkout. Push or export anything you want to keep first. The agent
  transcripts are kept.
- **Open in VS Code** attaches VS Code to the container. You need the Dev
  Containers extension. If VS Code runs on another machine, set **VS Code SSH
  host** in Settings.
- Ports listed in `forwardPorts` are forwarded to `127.0.0.1` automatically.
  Other listening ports can be forwarded from the environment card.

### `.domo.json`

An environment is described by `.domo.json` in the project root (JSONC). Domo
does not read `.devcontainer/devcontainer.json`, and an unknown key is an
error.

```jsonc
{
  "devEnvironment": {
    // Exactly one of "image" or "build".
    "image": "ghcr.io/acme/my-project-dev:latest",
    "build": {
      "dockerfile": ".devcontainer/Dockerfile",  // relative to the project root
      "context": ".",
      "args": { "MARK": "yes" },
      "target": "dev"
    },

    // Dev Container Features, built into the image.
    "features": { "ghcr.io/devcontainers/features/python:1": {} },

    // A private, nested Docker daemon. Default false.
    // Only an environment with this runs privileged.
    "docker": true,

    "remoteUser": "dev",
    "containerEnv": { "API_URL": "http://localhost:3000" },
    "forwardPorts": [3000, "5432/tcp"],
    "portsAttributes": { "3000": { "label": "Web app", "protocol": "http" } },

    // A string runs through `sh -c`. An array is argv.
    "postCreateCommand": "pnpm install"
  }
}
```

Without a `.domo.json`, Domo uses
`mcr.microsoft.com/devcontainers/base:ubuntu-24.04` with the Node 22 and
GitHub CLI Features and `"docker": true`. The image must be glibc-based and
must have `git`. Alpine and other musl images are not supported. The bundled
browser that agents use needs glibc 2.36 or newer.

### Logins inside environments

An environment is not a security boundary. It runs on your machine, for you.
Domo mounts your login files into the container's home directory, so agents
can push, open pull requests and use your cloud CLIs. The list is in
**Settings → Development environments → Home directory mounts**. The default
is `.ssh`, `.gitconfig`, `.config/gh`, `.config/gcloud`, `.aws` and `.kube`.

- Mounts are read-write, and a change applies only to environments created
  after it.
- Domo includes your `~/.gitconfig` rather than replacing it, uses `gh` as
  the credential helper, and turns commit signing off.
- Domo wraps your `~/.ssh/config` so macOS-only options such as `UseKeychain`
  do not break Linux `ssh`. Your SSH agent is forwarded.
- Environment sessions get `GH_TOKEN` from `NUXT_GH_TOKEN`, or from
  `gh auth token` on your machine.
- `.docker` is not mounted by default. Docker Desktop's credential helper does
  not exist in the container, so every `docker pull` there would fail.

## Configuration

Secrets go in `.env`. Everything else is in **Settings**. `.env.example` lists
the common variables.

| Variable | Purpose |
| --- | --- |
| `NUXT_GEMINI_API_KEY` | Gemini key for the voice agent (required) |
| `NUXT_CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token` |
| `NUXT_ANTHROPIC_API_KEY` | Optional. Bills the API, not your subscription |
| `NUXT_CODEX_API_KEY`, `NUXT_OPENAI_API_KEY` | Optional Codex credentials |
| `NUXT_OPENCODE_API_KEY` | OpenCode console service-account key |
| `NUXT_OPENCODE_CONFIG_CONTENT` | Optional inline OpenCode configuration |
| `NUXT_GH_TOKEN` | GitHub token for environment sessions |
| `DATABASE_URL`, `ELECTRIC_URL` | Default to the compose services |
| `NUXT_GEMINI_LIVE_MODEL` | Default Live model id (also in Settings) |
| `NUXT_GEMINI_SUMMARY_MODEL` | Model that summarizes long conversations (default `gemini-flash-lite-latest`) |
| `NUXT_DEFAULT_CWD` | Default working directory for new agents |
| `NUXT_DATA_DIR` | Where uploads are stored (default `./.data`) |
| `NUXT_DEV_ENV_IMAGE` | Base image when a project has no `.domo.json` |
| `NUXT_DEV_ENV_RUNTIME_IMAGE` | Image that provides Node and the adapters to environments (default `node:22-bookworm-slim`) |
| `NUXT_DEV_ENV_HELPER_IMAGE` | Image that copies a checkout into its volume (default `busybox:1.37`) |
| `NUXT_DEV_ENV_RESOURCE_PREFIX` | Prefix for Docker resources Domo creates (default `domo-dev-`) |
| `NUXT_DEV_ENV_DOCKER_READY_MS` | How long a nested Docker daemon has to start (default `30000`) |
| `NUXT_CLAUDE_CONFIG_DIR` | Where the Claude config copied into a new environment is read from (default `~/.claude`). Only `CLAUDE.md`, `settings.json`, `skills/`, `commands/` and `agents/` are copied |
| `NUXT_CODEX_CONFIG_DIR` | Codex config mounted into environments (default `~/.codex`) |
| `NUXT_HOME_OVERLAY_DIR` | Home directory the environment mounts come from (default `$HOME`) |

If a voice session fails with a model-not-found error, change the Live model in
**Settings**. Google's Live model ids change often.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test        # needs `docker compose up -d`
```

See `AGENTS.md` and `test/AGENTS.md`.

## Caveats

- Single user, no auth. Bind Domo to localhost.
- Coding agents run with your files and your accounts. **Auto-approve
  permission requests** in Settings lets an agent edit and run things with no
  one watching.
- Environments with `"docker": true` need a Docker host that allows privileged
  containers. Agents there fully control that environment's nested daemon.

## License

See [LICENSE.md](./LICENSE.md).
