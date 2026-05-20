# Getting started

Domo lets you run several AI coding agents at once — each in its own isolated copy of your project — and manage them all from one place. This guide gets it running and your first agent working in a few minutes.

## What you need

Domo installs as a small app on your machine (or VPS). Each per-env sandbox is a [**dev container**](https://containers.dev/) Domo manages for you.

On the host you need:

- **Docker** — on macOS or Windows/WSL, Docker Desktop. WSL counts as Linux.
- **git** — Domo creates a per-environment worktree off your project.
- A logged-in **Claude Code CLI**. The first time you open an environment's terminal, run `claude /login`. Domo bills to your Claude subscription, not an API key. (Authentication happens *inside* the env container — see Authenticating Claude below.)

On Linux, for the inner Docker each env runs to behave safely (your `docker compose` inside the sandbox), one of the following:

- **[sysbox](https://github.com/nestybox/sysbox)** — cleanest option. If sysbox-runc is registered with your Docker daemon, Domo will use it automatically. Linux-only.
- **rootless dind** — works on stock Docker on most modern distros. You need user namespaces enabled (`/proc/sys/kernel/unprivileged_userns_clone=1`), cgroup v2 with delegation, a subuid mapping for your user, and `fuse-overlayfs` installed. The installer probes these and warns about anything missing.

On macOS / Windows Docker Desktop, the VM handles all of this — no setup beyond installing Docker Desktop.

Prebuilt for Linux and macOS (x86-64 and arm64). Node ships inside the release — you don't need to install it.

## Install & run

```bash
curl -fsSL https://github.com/andresberrios/domo/releases/latest/download/install.sh | sh
domo up
```

The installer downloads the right build for your machine, verifies it, and adds a `domo` command. `domo up` starts the app at **http://localhost:7575**.

| command | what it does |
|---|---|
| `domo up` | start Domo → http://localhost:7575 |
| `domo down` | stop Domo (your data is kept) |
| `domo restart` | restart the app |
| `domo status` | show what's running |
| `domo logs` | tail the app log |
| `domo update` | update to the latest release and restart |
| `domo version` | show the installed version |

> Pin a specific version with `DOMO_VERSION=0.4.0 sh install.sh`, or install without internet using `DOMO_LOCAL_TARBALL=/path/to/domo-<os>-<arch>.tar.gz`.

## First visit: create your account

Open **http://localhost:7575**. The first time, Domo asks you to create an **admin account** (email + password — no email is sent). That's it; you're in.

When other people open Domo they can sign up too, but their account stays pending until you approve it. As admin, open the user menu (bottom-left) → **Manage users** to approve or remove people. This is how you control who can use your instance.

## Your first project, environment, and session

1. **Add a project** — point Domo at a git repo on your machine. If it has no `.devcontainer/devcontainer.json`, Domo offers to **scaffold a starter** (a basic ubuntu image with Docker-in-Docker for your inner `docker compose` and a hook that installs the Claude Code CLI on first build). If something else is missing (no git, no `.gitignore` entry for `.worktrees/`), Domo offers to fix that too. No git remote needed.
2. **Create an environment** — Domo creates a dedicated git branch + worktree and brings up its dev container. Each environment is isolated, so you can run several in parallel. The first time can take a minute or two while the image builds.
3. **Authenticate Claude once** — open the env's **Terminal** view and run `claude /login`. The OAuth credential lives in a Domo-managed folder that all environments share, so this is a one-time step per install.
4. **Start a session and send a prompt.** While the agent is working you can keep typing — your message is picked up at the next step, so you can steer it without interrupting.

## Sharing an instance with others

Open the user menu → **Manage users** to approve other people. By default they can use any project and any environment. v1 treats each session as single-author — multi-user collaboration in a single session (group chat with @agent, etc.) is a design we have but haven't built yet.

The Claude OAuth credentials (`~/.claude` inside env containers) are shared installation-wide — one `claude /login` covers every env on this Domo install.

## Exposing a service to the network

Each port declared in your `devcontainer.json`'s `forwardPorts` is automatically published to a random `localhost:<port>` on the host — visible only to you. On the env page, the **Ports** table lists each one with an "Expose externally" toggle: switch it on, pick a public port, and Domo opens a `0.0.0.0:<port>` listener that forwards to the container. Toggle off when you're done. No container restart either way.

## Optional: extra tools for the agent

If you need to add an environment variable or a `PATH` entry just for the agent (a token an MCP server needs, a binary path inside the container), create `~/.domo/config.json`:

```json
{
  "claude": {
    "env": { "SOME_TOOL_TOKEN": "…" },
    "extraPath": ["/opt/some-runtime/bin"]
  }
}
```

It's picked up on the next prompt — no restart. (For safety, this can't override Domo's credential handling, so your subscription billing stays intact.)

For project-level config (CLAUDE.md, slash commands under `.claude/commands/`, MCP servers), put them in the repo as usual — they're inside the dev container's `/workspaces` and the agent sees them with your project tooling.

## Updating

`domo update` fetches the latest release, swaps it in, and restarts Domo if it was running. Your projects, environments, and sessions are untouched.

## Your data & backups

Everything Domo keeps lives under `~/.domo`:

- `state.db` — projects, sessions, the chat transcripts, user accounts.
- `claude-home/` — the shared `~/.claude` (OAuth + slash commands + MCP), bind-mounted into every env container.
- `session-secret` — auto-managed cookie secret.

Back up: `domo down && tar czf domo-backup.tgz -C ~ .domo`. Start fresh: `domo down && rm -rf ~/.domo`. Change the location with `DOMO_HOME` if you like. Each environment's container is owned by your Docker daemon — `docker ps -a --filter label=domo.envId` lists them.

## Using Domo from other devices

The app listens on localhost only by default. To reach it from your phone or another computer, put a secure layer in front of it (Tailscale, a Cloudflare Tunnel, or your own HTTPS proxy) — see **[Securing your install](./securing-your-install.md)**.
