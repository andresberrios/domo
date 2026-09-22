# Domo

**A voice-first control room for coding agents.**

Talk to a Gemini Live agent. It spawns Claude Code, Codex and OpenCode sessions over
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
- **Coding agents** — choose Claude Code, Codex or OpenCode for each session. Claude Code
  runs through Zed's official ACP adapter
  ([`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp),
  formerly `@zed-industries/claude-code-acp`); Codex runs through
  [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp),
  while OpenCode runs its native [`opencode acp`](https://opencode.ai/v2/docs/cli/acp/)
  server.
  Streaming messages, tool calls, diffs, plans, permission prompts and modes
  are all first class.
- **Agent inbox** — every message to an agent picks how it arrives: *steer* it
  into the turn that is running, *queue* it until that turn ends, or *interrupt*
  the turn first. Nothing is ever silently swallowed by a busy agent, and a
  queued message survives a restart. See
  [Talking to a busy agent](#talking-to-a-busy-agent).
- **Scheduled agent tasks** — wake an existing agent with a prompt at one exact
  time or on a standard five-field cron schedule in any IANA time zone. Jobs,
  next-run pointers, and run history live in Postgres. Agents can manage their
  own schedules through the built-in mesh tools.
- **Agent mesh** — every coding agent gets a built-in `domo` MCP server, served
  over HTTP by Domo itself, so agents can list each other, hand work over, spawn
  new peers, subscribe to each other's progress, and page the voice supervisor.
  Each session is handed its own bearer token, so a call can only ever act as
  the agent that made it.
- **Conversations that don't reset** — a Live socket lasts minutes; a
  conversation lasts as long as you want it to. Domo folds the older part of
  each conversation into a rolling summary on its row and replays the rest
  verbatim, so a reconnect, a tool change or a server restart picks the thread
  up mid-thought instead of starting over. See
  [Long conversations](#long-conversations).
- **Transcripts that outlive their containers** — retiring a development
  environment destroys its container and its copy of the checkout, and keeps
  every record: the environment, and the full transcript of each agent that ran
  in it. Those agents can no longer be started, which Domo works out from the
  environment rather than storing on them. See
  [Retiring, archiving and deleting](#retiring-archiving-and-deleting).
- **Custom MCP servers** — add stdio / HTTP / SSE servers in Settings and scope
  them to the voice agent, the coding agents, or both.
- **Usage and plan limits** — every coding session and every conversation shows
  how full its context window is (and what the session has cost); the home page
  and the sidebar show how much of your Claude and Codex plan limits are left,
  plus OpenCode Go limits when configured, kept current in the background. Ask by voice, too. See
  [Usage and plan limits](#usage-and-plan-limits).
- **Real-time UI** — Postgres is the source of truth, ElectricSQL streams
  changes, and TanStack DB keeps the browser in sync. No polling.

## Requirements

- Node 22+ and pnpm 10+
- Docker (for Postgres + Electric)
- A Gemini API key ([AI Studio](https://aistudio.google.com/apikey))
- Access to at least one coding agent: a `claude setup-token` token (see
  [Claude authentication](#claude-authentication)), a local Claude Code login,
  or `NUXT_ANTHROPIC_API_KEY`; and/or a local Codex login, `NUXT_CODEX_API_KEY`,
  or `NUXT_OPENAI_API_KEY`; and/or an OpenCode login (`opencode auth login`)

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

## Talking to a busy agent

A coding agent spends most of its life mid-turn, and "send it a message" has to
mean something specific when it is. Every message — typed into the composer,
spoken to the voice agent, or sent by another agent — picks one of three ways
to arrive:

| mode | while the agent is working | while it is idle |
| --- | --- | --- |
| **Steer** | goes into the turn it is running now, so it changes course without losing what it has done | starts the turn |
| **Queue** | waits for that turn to end, then starts the next one | starts the turn |
| **Interrupt** | stops the turn first, then starts a new one | starts the turn |

The composer shows the picker only while there is a turn to choose about, and
preselects **Steer** — which is what typing at a working agent usually means.
The voice agent defaults to Steer too (you are asking for something *now*); one
agent messaging another defaults to **Queue**, because a peer has no idea what
it would be cutting across. An agent whose harness cannot steer gets Interrupt
instead of Steer, never Queue.

**The queue belongs to Domo, not to the coding agent.** Anything waiting is
shown above the composer with where it came from, can be taken back with one
click, and is still there after a restart. Sending a second prompt to a busy
adapter would also "work" — both harnesses quietly queue it internally — but you
could not see it, could not cancel it, and it would vanish with the process.

### Agents keeping tabs on each other

An agent that hands work to a peer cannot wait for it: its own turn ends long
before the peer's does. So it can **subscribe**: when the agent it follows
finishes a turn, stops for a permission, or fails, Domo queues it a short note
with that agent's latest output. `spawn_agent` subscribes by default. Because
notes are queued, they never interrupt work of the agent's own.

### Retiring, archiving and deleting

An agent session is a record of work — what was tried, what was decided, what
broke — and it stays worth reading long after the container it ran in is gone.
So Domo has one destructive action and two harmless ones, and they are easy to
tell apart:

| | what it does | what is left |
| --- | --- | --- |
| **Retire** an environment or project | Destroys the container, its copy of the checkout and any Docker-in-Docker volume. | Every record. The environment, and the full transcript of each agent that ran in it. |
| **Archive** a session | Stops its adapter and takes it off the lists. | Everything; it is one switch away and can be started again. |
| **Delete permanently** a session | Destroys the session and every event in its transcript. | Nothing. Only offered on an archived session. |

**Whether a session can be started is never stored.** It is a question about the
place it ran: an agent in a retired environment cannot run, because the
container and the checkout are gone; an agent in a directory you deleted cannot
run either. Domo works that out from the environment and the filesystem each
time, so nothing can go stale, and the session's own page says which it is.

**Archiving and retiring are independent.** Retiring an environment archives
nothing — a session can be perfectly visible and simply not runnable, and
hiding it would answer the wrong question. The sidebar has a switch for each:
*Show archived sessions* and *Show retired environments*.

### Scheduled tasks

Open **Schedules** to target an existing coding agent with a prompt. A task can
run once at an ISO date/time or recur with a five-field cron expression such as
`0 9 * * 1-5`; recurring expressions are interpreted in the selected IANA time
zone. Delivery defaults to **Queue**, so a timer firing does not cut across work
already in progress. An idle or stopped agent is started automatically when its
development environment is running; if that environment is stopped, the run
fails and records the reason in the job's `last_error`.

Coding agents have four authenticated mesh tools for the same lifecycle:
`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, and
`delete_scheduled_task`. A mesh caller can only see or modify jobs targeting
its own session. The voice supervisor can schedule, list, and delete jobs for a
named agent too. Schedules and their next due time survive server restarts.

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
all ACP adapters into every environment from a shared, read-only volume, so the
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
- **It starts at your last commit.** Whatever you have uncommitted stays on your
  machine, so a branch coming back out of the environment contains the agent's
  work and nothing else. Ignored files are still copied — `node_modules` and
  your `.env` are there, which is what makes the copy worth having. Turn on
  **Carry uncommitted changes from the host** when creating one if you want to
  continue work in progress in it; those changes are then committed inside the
  environment, so you can see them in the branch instead of finding them mixed
  into the agent's.
- Multiple Claude Code and Codex ACP sessions can run against that same copy.
- With `"docker": true` the environment is privileged and has its own nested
  Docker daemon, so agents can use `docker compose` without sharing stacks with
  the host or other environments. Without it the container is unprivileged.
- The checkout and any nested containers persist across stop/start, and the
  container, both volumes and the image are destroyed when the environment is
  retired. **The checkout exists only in the volume**, so before retiring one,
  push what you want to keep — or bring the branch back with
  [Export branch](#getting-a-branch-out-of-an-environment).
- The agent sessions that ran in it are **kept, not deleted**: their transcripts
  stay readable for good. They can no longer be started, because the container
  and its copy of the checkout are gone — see
  [Retiring, archiving and deleting](#retiring-archiving-and-deleting).

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

### Getting a branch out of an environment

An environment's checkout lives in a Docker volume, so the usual way back to
your own copy is `git push` and `git pull`. **Export branch**, on a running
environment, is the direct route: your project's checkout fetches straight from
the container, with nothing published anywhere.

- Pick the branch in the environment (its checked-out one is preselected) and
  the local branch to land it on (the same name, by default). Leave the local
  branch blank to fetch without touching any branch.
- It always arrives at `refs/remotes/domo-env/<environment>/<branch>` — a
  remote-tracking ref, like any other remote's — and the modal lists the commits
  that came over.
- The local branch is only ever **fast-forwarded**, and it is created if it does
  not exist. Nothing is force-updated, merged, rebased or stashed: if your
  branch has commits the environment's does not, or if it is checked out with a
  dirty working tree, the export says so and leaves it alone. The commits are
  still at the tracking ref, so `git merge domo-env/<environment>/<branch>` is
  yours to run.

Under the hood it is one `git fetch` over git's `ext::` transport, running
`git-upload-pack` inside the container through `docker exec` — a real fetch, so
only the objects you are missing cross. The voice agent and the coding agents
can do it too: *"export main from the sidebar environment"*, or the
`export_branch` tool in the agent mesh.

### Getting a branch into an environment

**Import branch** is the same road travelled the other way: your project's
checkout pushes straight into the container. Use it to bring an environment's
`main` up to date after work lands on the host, to seed an environment with a
branch for an agent to carry on from, or — via the host — to move a branch from
one environment to another.

- Pick the branch on this machine to send and the branch to write in the
  environment (the same name, by default). A name the environment does not have
  yet is created.
- The environment's branch is only ever **fast-forwarded**. If it has commits
  yours does not — an agent has been working — the import says so and sends
  nothing; export it and merge here instead.
- **The branch the environment has checked out is refused.** That working tree
  and index belong to an agent and may hold changes that are not committed
  anywhere else, so Domo will not move the ref under it. Check out something
  else in the environment, or import into a different name.

It is one `git push` over the same `ext::` transport — git asks the same command
for `git-receive-pack` instead — and the voice agent and the agent mesh have it
too, as `import_branch`.

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
The settings sidebar gives General, Coding agents, Development environments and
MCP their own pages, with one nested page per ACP adapter. Plan limits for
configured providers are kept current automatically (see
[Usage and plan limits](#usage-and-plan-limits)).

| Variable | Purpose |
| --- | --- |
| `NUXT_GEMINI_API_KEY` | Gemini key for the voice agent (required) |
| `NUXT_CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; how Claude Code authenticates inside a development environment — see [Claude authentication](#claude-authentication) |
| `NUXT_ANTHROPIC_API_KEY` | Optional fallback; **bills the API, not your subscription**, and is passed only when there is no other credential |
| `NUXT_CODEX_API_KEY` | Optional; forwarded as `CODEX_API_KEY` to the Codex adapter |
| `NUXT_OPENAI_API_KEY` | Optional; forwarded as `OPENAI_API_KEY` to the Codex adapter |
| `NUXT_OPENCODE_AUTH_CONTENT` | Optional OpenCode `auth.json` content for a headless install; otherwise Domo reads the local store written by `opencode auth login` |
| `NUXT_OPENCODE_CONFIG_CONTENT` | Optional inline OpenCode configuration, forwarded to host and environment sessions |
| `NUXT_OPENCODE_GO_API_KEY` | Optional OpenCode Go key used by the plan-limit poller; otherwise the local OpenCode auth store is used |
| `DATABASE_URL` | Postgres, defaults to the compose service |
| `ELECTRIC_URL` | Electric, defaults to `http://localhost:30000` |
| `NUXT_GEMINI_LIVE_MODEL` | Default Live model id |
| `NUXT_GEMINI_SUMMARY_MODEL` | Text model that writes the rolling conversation summary (default `gemini-flash-lite-latest`) |
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
| `NUXT_ANTHROPIC_API_BASE` | Where plan-limit requests go (default `https://api.anthropic.com`); set it to point the usage poller somewhere else |
| `NUXT_CODEX_ENTRY` | Path to the Codex CLI the usage poller runs as `codex app-server` (defaults to the bundled `@openai/codex`) |

### Usage and plan limits

Two different things, in two places.

**Context windows** are per session. A coding agent's header shows how full its
context is and what the session has cost, both straight from the ACP
`usage_update` its adapter sends; a conversation's header shows the same for the
Gemini Live session. A conversation's number can go *down*, which is not a bug:
Domo runs Live with sliding-window compression, so the oldest turns are dropped
once the window fills.

**Plan limits** are account-wide — they are yours, not any session's — so they
are on the home page, in the sidebar footer, and inside each session's popover.
They are refreshed automatically in the background, soon after a turn ends,
and on demand from the refresh button.
Every row says how old it is, because the polls are minutes apart at best.

For **Claude** this needs `NUXT_CLAUDE_CODE_OAUTH_TOKEN` — the same
`claude setup-token` token everything else uses. Without one, the card says so
rather than showing zeroes. Domo reads the limits from the
`anthropic-ratelimit-unified-*` headers on one minimal API request, because the
richer `/api/oauth/usage` endpoint that Claude Code's own `/usage` reads needs a
`user:profile` scope that a headless setup token does not carry (it answers
`403 oauth_scope_insufficient`). That endpoint is still tried first, so a
differently-scoped token gets the better answer — including per-model weekly
windows and your usage-credit balance. Whenever an agent is actually working,
its own rate-limit events refresh the same rows for free.

Domo never reads or refreshes your own Claude login for this, for exactly the
reason it never copies one into a container (below).

For **Codex** it needs a local `codex login`. Domo asks the bundled Codex CLI
directly (`codex app-server`, `account/rateLimits/read`) — the same call the ACP
adapter makes for its `/status` output — and shuts the process down again as
soon as it has answered.

For **OpenCode Go**, Domo reads the key from `NUXT_OPENCODE_GO_API_KEY`, or
from the `opencode-go` entry written by `opencode auth login`, and polls the
rolling, weekly and monthly windows automatically. Without that credential it
is simply reported as unconfigured. The Go usage
endpoint is currently undocumented and may change.

Gemini publishes no plan-limit API, so a conversation shows its context window
and nothing else.

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

### Agent modes

A Claude Code or Codex **permission mode** decides how much it may do before it
stops to ask. OpenCode uses the same place in Domo for a different ACP concept:
selecting which visible OpenCode agent handles the session.

| Claude Code permission | Codex permission | OpenCode agent |
| --- | --- | --- |
| `default` — Manual, always ask | `read-only` — Ask for approval | `build` — all tools *(its default)* |
| `acceptEdits` — accept file edits | `agent` — Approve for me *(its default)* | `plan` — restricted planning |
| `plan` — plan before changing anything | `agent-full-access` — unrestricted | Any other visible agent OpenCode reports |
| `auto` — Claude decides | | |
| `bypassPermissions` — accept everything | | |

Each page under **Settings → Adapters** has its own default picker, and each
list is fetched from the adapter itself the same way the model
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
chosen becomes the Claude Code default, and the other adapters start on theirs.

### Long conversations

Nothing about a conversation lives in the socket. Gemini hands out a
`goAway` every few minutes, changing a tool or adding an MCP server
invalidates the resumption handle, and editing `server/` under `pnpm dev`
restarts Nitro — so a long conversation is rebuilt from Postgres many times
over, and what it is rebuilt *from* is the whole question.

Domo answers it with two halves that meet exactly:

- **a rolling summary** on the `voice_sessions` row, covering everything up to
  `summary_through_seq`, and
- **the tail after it, verbatim**, newest-first within a character budget.

The fold runs when a turn ends and again just before a connect (capped, and
never fatal), and it always leaves the last few exchanges alone — a paraphrase
of what you said thirty seconds ago is worse than the words. It is written by
a cheap text model, not the Live one — `gemini-flash-lite-latest`, which
summarised a 6.6 kB transcript in ~1.2 s in testing; set
`NUXT_GEMINI_SUMMARY_MODEL` to change it. If the summariser is unreachable the conversation carries on regardless,
and the instruction says in as many words that some messages were lost, so
Domo tells you rather than confabulating.

The transcript on screen is never touched: every message stays in
`voice_messages`, and the panel at the top of a folded conversation shows the
summary Domo is actually carrying. **New conversation** is still the way to
get a clean context — a new row, with no summary and no handle.

Coding agents are not part of this: Claude Code and Codex compact their own
context inside their own processes, and `agent_events` is a log Domo renders,
not a prompt it rebuilds.

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
  lib/voice/context.ts   summary + verbatim tail → what a connect is told
  lib/voice/compaction.ts folding old messages into the rolling summary
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
