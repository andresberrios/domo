# Domo

**A voice-first control room for coding agents.**

You talk out loud to Claude Code, Codex and OpenCode sessions running over
[ACP](https://agentclientprotocol.com). The agent you talk to can start other
agents, watch them work and report back; whichever one you are talking to reads
out the others' permission prompts and notes, and takes your answers. You can
also type to any agent directly. Every session is saved, and the UI updates in
real time.

With Domo you can:

- Run coding agents on your machine, or in isolated development environments
  (containers) made from a project checkout.
- Let agents talk to each other, start new agents, and follow each other's
  progress through a built-in `domo` MCP server. Agents can also leave you
  notifications, with files attached, that stay in the sidebar until you have
  seen them.
- Send a message to a busy agent. You choose how it arrives: *steer* it into
  the running turn, *queue* it until the turn ends, or *interrupt* the turn.
- Keep assistants: named agents with a picture, a persona and a voice of their
  own that you talk to
  for as long as you like. When one's context fills up, or you ask it to start
  fresh, it writes itself a note and carries on in a new session; its page
  reads as one conversation, and its journal lists the sessions underneath.
- Schedule prompts to agents or assistants, once or on a cron schedule.
- See context usage for each session, and your Claude, Codex and OpenCode Go
  plan limits.
- Talk to any agent from its page. One engine hears you and one speaks the
  replies, chosen in Settings: Gemini, OpenAI, open models on your CPU
  (Pocket TTS among them, which can clone a voice), macOS's own on a Mac, or
  your device's dictation and voices.

## Requirements

- Docker and git
- At least one coding agent account: a Claude, ChatGPT or OpenCode plan.
  See [Signing in](#signing-in).
- For the default speech engines, a Gemini API key
  ([AI Studio](https://aistudio.google.com/apikey)). The open models, Pocket TTS
  and the Mac's voices need no key, and speak when there is none.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/andresberrios/domo/release/scripts/install.sh | sh
```

This puts Domo under `~/.domo` with its own Node, pnpm and Caddy, builds it,
starts it as a login service (launchd on macOS, systemd on Linux) and opens
`https://localhost:3666`, where a setup guide checks each coding agent and
voice and tells you what is missing. Then:

```bash
~/.domo/bin/domo status    # what is installed, and is it answering
~/.domo/bin/domo update    # build and switch to the newest commit; --check only looks
~/.domo/bin/domo restart
~/.domo/bin/domo trust     # if the browser warns about the certificate; asks for your password
~/.domo/bin/domo logs
~/.domo/bin/domo uninstall # stop starting at login; keeps ~/.domo
```

`DOMO_HOME` moves the directory and `DOMO_CHANNEL` picks the branch to follow
(default `release`); other server overrides are in
[docs/configuration.md](docs/configuration.md).

Domo looks at its branch every hour and says in the sidebar how many commits
behind it is. **Settings → Updates** shows what is new, updates on request,
and can update by itself: it builds the new version beside the running one
and restarts onto it when no agent is working, no environment is being created
and no schedule is about to fire, no more often than you choose. A version that does
not start is rolled back.

## Quick start (development)

Needs the Node and pnpm in `.tool-versions` and [Caddy](https://caddyserver.com) on your `PATH`
(`brew install caddy`); browsers allow the microphone only on HTTPS.

```bash
docker compose up -d     # Postgres :54321, Electric :30000
pnpm install
pnpm dev                 # open https://localhost:3766
caddy trust --address unix//tmp/domo-dev-caddy.sock   # once, while it runs: the browser accepts Caddy's certificate
```

An installed Domo and `pnpm dev` run side by side: the install is at `:3666`
with the `domo-prod` stack (54322, 30002), development at `:3766` with the
`domo` stack above, and each names its Docker resources under its own prefix
(`domo-prod-`, `domo-dev-`).

Domo creates the database schema on first boot. Press **Talk**, turn on the
mic, and say *"start an agent in ~/code/my-project and have it fix the failing
tests"*.

To use isolated environments, add a project from the sidebar, create a
development environment for it, and choose that environment when you start an
agent.

To change the addresses, set `DOMO_HTTPS_ADDRESS` (default `localhost:3766`) or
`DOMO_DEV_PORT` (default `3767`). Always open the HTTPS address.

## Signing in

The setup guide (it opens on a new install, and is under **Settings → Setup
guide** after that) checks each coding agent: is it installed, is it signed in
and on what, and, when you ask, can it answer one tiny request on a cheap
model. It says what to do for anything missing. Each agent's settings page
holds its own keys. The steps that run a command happen in a terminal on the
computer Domo runs on; pasting a key works from a phone too.

**Claude Code.** Run `claude setup-token` once and paste the token on the
Claude Code settings page. Claude Code signs in with it, development
environments included, and Domo reads your Claude plan limits with it. Without
it, sessions on this computer use your own Claude login.

Domo never copies your Claude login into a container. Claude Code rotates its
refresh token every time it refreshes, so two copies of one login log each
other out, and the one that loses can be your own machine. For the same
reason, `.claude` and `.claude.json` cannot be mounted into an environment.

An Anthropic API key is optional. It **bills the API, not your subscription**,
and inside Claude Code it overrides a subscription, so Domo passes it only when
there is no other Claude credential.

**Codex.** Run `codex login`. Domo mounts `~/.codex` into environments. An
OpenAI API key on the Codex page bills the API, so Domo passes it to Codex
only when there is no ChatGPT login.

**Image generation** (assistant pictures, and the `generate_image` tool every
agent has) uses Codex's built-in image tool on your ChatGPT login, so it counts
against your Codex plan limits and bills nothing per image. Domo never uses an
OpenAI API key for it; without a ChatGPT `codex login` it is unavailable.

**OpenCode.** Sessions on this computer use your `opencode auth login`. A
development environment needs a console key from the
[OpenCode console](https://opencode.ai/console), pasted on the OpenCode
settings page (for the same refresh-token reason as Claude). The key also
enables the OpenCode Go plan limits. Without a credential, only OpenCode's free
models work.

Check the model prefix before you run OpenCode. `openai/*` models bill your
ChatGPT login, and `opencode/*` models bill OpenCode console usage per token.
Some model names exist under both prefixes.

**Voice.** The Gemini key goes on the Voice settings page. The OpenAI speech
engine uses the same OpenAI key as Codex, and bills per token.

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
  Its branch, whether Domo made it or reused an existing one, is deleted if
  every commit on it is also on another branch, and kept otherwise.
  The agent transcripts and the environment's record are kept.
- **Stopping** an environment stops the containers it started.
- **Upgrading** an environment gives it a new container, with Domo's current
  agent adapters, its image rebuilt from `.domo.json`, and your current
  settings. The worktree, installed dependencies and the home directory, where
  each agent keeps its session history, carry over, and the sessions resume
  on their next message. A turn running in it is interrupted, the containers
  it started are stopped, anything installed in the container outside the
  worktree and the home is lost, and `postCreateCommand` runs again.
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

- Mounts are read-write, and a change applies to environments created or
  upgraded after it.
- Domo includes your `~/.gitconfig` rather than replacing it, uses `gh` as
  the credential helper, and turns commit signing off.
- Domo wraps your `~/.ssh/config` so macOS-only options such as `UseKeychain`
  do not break Linux `ssh`. Your SSH agent is forwarded.
- Environment sessions get a GitHub token from `gh auth token` on your
  machine.
- `.docker` is not mounted by default. Docker Desktop's credential helper does
  not exist in the container, so every `docker pull` there would fail.

## Configuration

Everything is set in the app, and keys are saved in Domo's database. A
developer can override settings with server variables; see
[docs/configuration.md](docs/configuration.md).

## Development

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test        # needs `docker compose up -d`
```

See `AGENTS.md` and `test/AGENTS.md`.

## Caveats

- Single user, no login: anyone who can reach this machine's Domo ports can
  drive your agents. Keep them off networks you do not trust.
- Coding agents run with your files and your accounts. A permission mode
  that does not ask (Claude Code's bypass, Codex's full access) lets an agent
  edit and run things with no one watching.
- A development environment is a trusted development machine, not a sandbox. With
  `"docker": true`, its agents drive the host's Docker daemon, which gives
  them the host.

## License

See [LICENSE.md](./LICENSE.md).
