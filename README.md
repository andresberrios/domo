# Domo

**A voice-first control room for coding agents.**

You talk to a live voice agent — Gemini Live or OpenAI GPT-Live, whichever you
pick in Settings. It starts Claude Code, Codex and OpenCode
sessions over [ACP](https://agentclientprotocol.com), watches them work,
answers their permission prompts when you tell it to, and reports back out
loud. You can also type to any agent directly. Every session is saved, and the
UI updates in real time.

With Domo you can:

- Run coding agents on your machine, or in isolated dev environments
  (containers) made from a project checkout.
- Let agents talk to each other, start new agents, and follow each other's
  progress through a built-in `domo` MCP server. Agents can also leave you
  notifications, with files attached, that stay in the sidebar until you have
  seen them.
- Send a message to a busy agent. You choose how it arrives: *steer* it into
  the running turn, *queue* it until the turn ends, or *interrupt* the turn.
- Schedule prompts to agents, once or on a cron schedule.
- See context usage for each session, and your Claude, Codex and OpenCode Go
  plan limits.
- Choose which live voice model runs conversations, and — on GPT-Live, which
  delegates its thinking — whether an OpenAI model or one of your own coding
  agents does it. See [Choosing a voice model](#choosing-a-voice-model).

## Requirements

- Docker and git
- A Gemini API key ([AI Studio](https://aistudio.google.com/apikey)) for
  Gemini Live, or an OpenAI API key for GPT-Live
- At least one coding agent account. See [Authentication](#authentication).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/andresberrios/domo/release/scripts/install.sh | sh
```

This puts Domo under `~/.domo` with its own Node, pnpm and Caddy, builds it,
starts it as a login service (launchd on macOS, systemd on Linux) and opens
`https://localhost:3666`. Keys go in `~/.domo/.env` or in Settings. Then:

```bash
~/.domo/bin/domo status    # what is installed, and is it answering
~/.domo/bin/domo update    # build and switch to the newest commit; --check only looks
~/.domo/bin/domo restart   # after editing .env
~/.domo/bin/domo logs
~/.domo/bin/domo uninstall # stop starting at login; keeps ~/.domo
```

`DOMO_HOME` moves the directory. `DOMO_CHANNEL` picks the branch to follow
(default `release`). `DOMO_PORT` and `DOMO_HTTPS_ADDRESS` in `.env` change the
addresses. An update builds the new version beside the running one and
switches only once it starts, and a version that does not come up is rolled
back.

## Quick start (development)

Needs Node 22+, pnpm 10+ and [Caddy](https://caddyserver.com) on your `PATH`
(`brew install caddy`); browsers allow the microphone only on HTTPS.

```bash
cp .env.example .env     # add your Gemini or OpenAI key
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

A development environment is a long-lived container with its own git worktree
of a project, created beside your checkout in `.domo-worktrees/` and mounted
into the container. Several agents can share one environment.

- The environment's name is its branch, exactly as typed, made at your last
  commit. If you already have a branch of that name, the dialog warns you and
  the environment checks it out instead. Slashes group environments into
  folders in the sidebar (`handoff/speech` sits under `handoff`). Uncommitted changes stay on your
  machine. A project with no commits yet is offered its first one when you
  create an environment. Gitignored `.env` files are copied in.
  `node_modules`, `.venv` and other dependency folders never are: Domo
  installs by lockfile inside the environment (pnpm, npm, yarn, bun, uv), for
  the container's platform, unless the project turns that off.
- The worktree shares your repository's branches and commits. A branch an
  agent makes is in your checkout at once, and yours are visible to it, so
  there is nothing to export or import. It also means an agent can move your
  branches.
- Package caches (pnpm, npm, yarn, pip, uv, Go) are shared by every
  environment. pnpm keeps each package once for all of them: an
  environment's `node_modules` holds links, not copies. A package that finds
  your project's root from its own location on disk will look in the wrong
  place; install such tools on the system instead.
- **Retiring** an environment destroys its container, worktree and every
  container, network, volume and image tag it made on the Docker daemon. Its
  commits stay in your repository; commit anything you want to keep first.
  The branch Domo made for it is deleted if every commit on it is also on
  another branch, and kept otherwise. A branch it reused is never deleted.
  The agent transcripts and the environment's record are kept.
- **Stopping** an environment stops the containers it started.
- **Open in VS Code** attaches VS Code to the container. You need the Dev
  Containers extension. If VS Code runs on another machine, set **VS Code SSH
  host** in Settings.
- Ports listed in `forwardPorts`, and ports a Compose stack asks to publish,
  are forwarded to `127.0.0.1` automatically. Other listening ports can be
  forwarded from the environment card.

### Docker inside an environment

With `"docker": true`, agents can use `docker` and `docker compose`. What they
run goes to your **host's** Docker daemon, through a socket that belongs to the
environment. Pulled images and the build cache are shared, so they are not
copied into every environment. To the agent, the daemon still looks like its
own:

- It sees only its own containers, networks, volumes and built image tags,
  under the names it gave them. Two environments of one project can run the
  same Compose file at the same time, with the same `container_name:`, ports
  and image tags.
- `-p` and `ports:` publish on the environment's own `localhost`, so
  `psql -h localhost` works as usual.
- `host.docker.internal` inside a service means the environment. A service can
  call a dev server that the agent runs there, even one bound to `127.0.0.1`.
- A bind mount of the checkout, of a mounted login such as `~/.aws`, or of the
  Docker socket is translated to what the environment really has. A request
  that cannot be translated fails with an error that starts with `Domo:`.

This is a convenience, **not isolation**: an agent that can reach the host
daemon can take over the host. While Domo is restarting, `docker` commands in
an environment wait until it is back.

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

    // `docker` and `docker compose` on the host's daemon, through a socket
    // of the environment's own. Default false. Not privileged.
    "docker": true,

    "remoteUser": "dev",
    "containerEnv": { "API_URL": "http://localhost:3000" },
    "forwardPorts": [3000, "5432/tcp"],
    "portsAttributes": { "3000": { "label": "Web app", "protocol": "http" } },

    // A string runs through `sh -c`. An array is argv.
    "postCreateCommand": "pnpm db:migrate",

    // Domo's own install by lockfile (pnpm, npm, yarn, bun, uv), run before
    // postCreateCommand. Default: on, unless there is a postCreateCommand.
    "installDependencies": true,

    // Shared caches. Built-ins are on; turn one off with false (or all of
    // them with "caches": false), or add a volume shared by name.
    "caches": { "go": false, "gradle": "/home/dev/.gradle/caches" },

    // Gitignored files copied into each new worktree. Default: `.env` files.
    "copyIgnored": ["**/.env", "**/.env.*", "config/local.yml"]
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
| `NUXT_GEMINI_API_KEY` | Gemini key, for the Gemini voice provider |
| `NUXT_CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token` |
| `NUXT_ANTHROPIC_API_KEY` | Optional. Bills the API, not your subscription |
| `NUXT_OPENAI_API_KEY` | OpenAI key: required for the GPT-Live voice provider, and a Codex credential |
| `NUXT_CODEX_API_KEY` | Optional Codex credential |
| `NUXT_OPENCODE_API_KEY` | OpenCode console service-account key |
| `NUXT_OPENCODE_CONFIG_CONTENT` | Optional inline OpenCode configuration |
| `NUXT_GH_TOKEN` | GitHub token for environment sessions |
| `DATABASE_URL`, `ELECTRIC_URL` | Default to the compose services |
| `NUXT_GEMINI_LIVE_MODEL` | Default Live model id (also in Settings) |
| `NUXT_GEMINI_SUMMARY_MODEL` | Model that summarizes long conversations (default `gemini-flash-lite-latest`) |
| `NUXT_OPENAI_LIVE_MODEL` | Default GPT-Live model id (also in Settings) |
| `NUXT_OPENAI_SUMMARY_MODEL` | Summarizer on the OpenAI provider (default `gpt-5.6-luna`) |
| `NUXT_DEFAULT_CWD` | Default working directory for new agents |
| `NUXT_DATA_DIR` | Where uploads are stored (default `./.data`) |
| `NUXT_DEV_ENV_IMAGE` | Base image when a project has no `.domo.json` |
| `NUXT_DEV_ENV_RUNTIME_IMAGE` | Image that provides Node and the adapters to environments (default `node:22-bookworm-slim`) |
| `NUXT_DEV_ENV_HELPER_IMAGE` | Image that copies a checkout into its volume (default `busybox:1.37`) |
| `NUXT_DEV_ENV_RESOURCE_PREFIX` | Prefix for Docker resources Domo creates (default `domo-dev-`) |
| `NUXT_DEV_ENV_DOCKER_READY_MS` | How long Docker in a new environment has to answer before creation fails (default `30000`) |
| `NUXT_DOOD_SOCKET_DIR` | Where each environment's Docker socket is created (default `~/.domo/s/<install>`). Docker Desktop forwards a socket only if its path is at most 88 bytes, so set this if your home directory is longer than 53 characters. Do not use `/tmp`: macOS cleans it |
| `NUXT_CLAUDE_CONFIG_DIR` | Where the Claude config copied into a new environment is read from (default `~/.claude`). Only `CLAUDE.md`, `settings.json`, `skills/`, `commands/` and `agents/` are copied |
| `NUXT_CODEX_CONFIG_DIR` | Codex config mounted into environments (default `~/.codex`) |
| `NUXT_HOME_OVERLAY_DIR` | Home directory the environment mounts come from (default `$HOME`) |

### Choosing a voice model

**Settings → General → Voice model** picks which live model runs conversations.

**Gemini Live** is one model that listens, thinks, calls Domo's tools and
speaks. It takes a model id, a voice and a spoken language.

**GPT-Live** runs the conversation and delegates the thinking — it holds no
tools of its own. You choose who answers:

- **An OpenAI model** (default `gpt-6-sol`) — OpenAI calls it with every one of
  Domo's tools attached. Nothing else to set up.
- **A coding agent session** — each request goes to a Claude Code, Codex or
  OpenCode session, which answers with its own tools plus the whole agent mesh.
  Pick an existing session or let Domo make one. It takes as long as a coding
  agent takes, so the answer arrives as a spoken update. The
  conversation-only tools (naming a conversation, starting a new one, answering
  a permission out loud) belong to the live model's backend, and a coding agent
  is not one, so those stay on screen in this mode.

Typed messages are answered out loud too; the speaker button beside the text
box turns that off when you would rather read the reply. Model ids change
often on both providers — each dropdown is filled from your own key, and you
can type any id by hand.

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
- A dev environment is a trusted development machine, not a sandbox. With
  `"docker": true`, its agents drive the host's Docker daemon, which gives
  them the host.

## License

See [LICENSE.md](./LICENSE.md).
