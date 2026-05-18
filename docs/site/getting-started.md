# Getting started

Domo lets you run several AI coding agents at once — each in its own isolated copy of your project — and manage them all from one place. This guide gets it running and your first agent working in a few minutes.

## What you need

Domo installs as a small app on your machine (or VPS) plus a couple of helper containers it manages for you. On the host you need:

- **Docker** (with Compose) — on macOS or WSL, Docker Desktop. WSL works as Linux.
- **[Coast](https://coasts.dev)**, installed and running — Domo uses it to spin up each environment's sandbox.
- **The Claude Code CLI**, logged in once: run `claude`, then `/login`. Domo bills to your Claude subscription, not an API key.
- **git**.

Prebuilt for Linux and macOS (x86-64 and arm64). Node ships inside the release — you don't need to install it.

## Install & run

```bash
curl -fsSL https://github.com/andresberrios/domo/releases/latest/download/install.sh | sh
domo up
```

The installer downloads the right build for your machine, verifies it, and adds a `domo` command. `domo up` starts everything and serves the app at **http://localhost:7575**. The very first `domo up` builds a helper image once (~1–2 min).

| command | what it does |
|---|---|
| `domo up` | start Domo → http://localhost:7575 |
| `domo down` | stop Domo (your data is kept) |
| `domo status` | show what's running |
| `domo logs` | tail the app log |
| `domo update` | update to the latest release and restart |
| `domo version` | show the installed version |

> Pin a specific version with `DOMO_VERSION=0.2.0 sh install.sh`, or install without internet using `DOMO_LOCAL_TARBALL=/path/to/domo-<os>-<arch>.tar.gz`.

## First visit: create your account

Open **http://localhost:7575**. The first time, Domo asks you to create an **admin account** (email + password — no email is sent). That's it; you're in.

When other people open Domo they can sign up too, but their account stays pending until you approve it. As admin, open the user menu (bottom-left) → **Manage users** to approve or remove people. This is how you control who can use your instance.

## Your first project, environment, and session

1. **Add a project** — point Domo at a git repo on your machine that has a `Coastfile`. If something's missing, Domo offers to set it up for you (init the repo, write a starter Coastfile, ignore the worktrees folder). No git remote needed.
2. **Create an environment** — Domo spins up a sandbox and a dedicated git branch/worktree for it. Each environment is isolated, so you can run several in parallel.
3. **Start a session and send a prompt.** While the agent is working you can keep typing — your message is picked up at the next step, so you can steer it without interrupting.

## Optional: extra tools for the agent

`claude` already inherits your shell environment and your `~/.claude` setup (including any MCP servers). If you need to add an environment variable or a `PATH` entry just for the agent, create `~/.domo/config.json`:

```json
{
  "claude": {
    "env": { "SOME_TOOL_TOKEN": "…" },
    "extraPath": ["/opt/some-runtime/bin"]
  }
}
```

It's picked up on the next prompt — no restart. (For safety, this can't override Domo's credential handling, so your subscription billing stays intact.)

## Updating

`domo update` fetches the latest release, swaps it in, and restarts Domo if it was running. Your projects, environments, and sessions are untouched.

## Your data & backups

Everything Domo keeps lives under `~/.domo` — your projects/sessions database and the session history. It's one folder, so:

- **Back up:** `domo down && tar czf domo-backup.tgz -C ~ .domo`
- **Start fresh:** `domo down && rm -rf ~/.domo`

(Change the location with `DOMO_HOME` if you like.) Each environment's sandbox is managed by Coast separately.

## Using Domo from other devices

The app listens on localhost only by default. To reach it from your phone or another computer, put a secure layer in front of it (Tailscale, a Cloudflare Tunnel, or your own HTTPS proxy) — see **[Securing your install](./securing-your-install.md)**.
