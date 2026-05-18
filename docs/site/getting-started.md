# Getting started (VPS, five-minute path)

Domo runs parallel Claude Code agents over [Coast](https://coastdev.com) environments. It is **self-hosted and single-user** — there is no auth in v1 (see [Securing your install](./securing-your-install.md)).

## How Domo is shipped

Domo is **a host-installed app plus a small Docker-Compose infra stack** — *not* a Docker-only product. The app drives the `claude` CLI in its own process environment, shells host `git`, reads/writes your project worktrees on the host filesystem, and talks to the host Coast daemon — so it must run on the host, where it inherits your `~/.claude` login and tools. Only the session-runtime infra (Postgres + the Electric Agents server) runs in containers.

> Design rationale: `initial-design.md` → **Decided #19 (Distribution & release)** and **Decided #11 (claude runs host-side)**.

## Prerequisites

**Platforms:** prebuilt for **Linux** and **macOS**, x86-64 and arm64. **WSL** counts as Linux (works as-is; enable Docker Desktop's WSL integration). Other targets: build from source.

On the host (your VPS or workstation):

- **Docker + Docker Compose** — runs the infra stack (and Coast's per-env containers). On macOS / WSL use **Docker Desktop**.
- **[Coast](https://coastdev.com)** installed and its daemon running (`coast --version`; Domo talks to `coastd` on `127.0.0.1:31415`). Tested against Coast `0.1.53`.
- **Claude Code CLI**, logged in once on the host: `claude` then `/login` (subscription auth lands in `~/.claude`). Domo deliberately strips `ANTHROPIC_API_KEY` from the spawn — billing is your Claude subscription.
- **git** — Domo shells host `git` for env worktrees.

**Node is bundled** in the release (the app runs on a pinned Node 22 LTS shipped in the tarball) — no system Node needed. `git` and the `claude` CLI remain host requirements *by design*: Domo orchestrates them host-side (it's a host-side orchestrator, not a black box — see `initial-design.md` Decided #11), so they can't be containerised away.

## Install & run

```bash
curl -fsSL https://github.com/andresberrios/domo/releases/latest/download/install.sh | sh
domo up
```

`install.sh` detects your OS/arch, downloads the matching release (`domo-<os>-<arch>.tar.gz`), verifies its checksum, installs to `~/.domo/app/<version>`, and drops a `domo` CLI on your PATH. `domo up` then builds + starts the infra (Docker) and the app:

| command | does |
|---|---|
| `domo up` | start infra + app → **http://localhost:7575** |
| `domo down` | stop app + infra (volumes kept) |
| `domo status` | app + infra state |
| `domo logs` | tail the app log (`domo logs infra` → compose logs) |
| `domo update` | fetch + install the latest release, restart if running |
| `domo version` | installed version |

The first `domo up` builds the agents-server image from a pinned Dockerfile (one-time, ~1–2 min). Expose `:7575` over Tailscale / Cloudflare Tunnel / a front proxy — see [Securing your install](./securing-your-install.md). Do **not** put it on a public interface unauthenticated.

Pin a version with `DOMO_VERSION=0.1.4 sh install.sh`; install offline with `DOMO_LOCAL_TARBALL=/path/to/domo-<os>-<arch>.tar.gz`.

### From source (development)

```bash
git clone https://github.com/andresberrios/domo && cd domo
pnpm install
docker compose up -d        # dev infra (Postgres + agents-server)
pnpm dev                    # http://localhost:7575
```

## First project, env, session

1. Open Domo, **Add a project** — point it at a git repo on the host that has a `Coastfile` (Domo offers to `git init` / write a starter Coastfile / add `.worktrees/` to `.gitignore` if missing). A remote is **not** required.
2. **Create an environment** — Domo provisions a Coast instance + a git worktree at `<project>/.worktrees/<env>`.
3. Open a **session** and send a prompt. While the agent works you can **steer it** — send another message and it's picked up at the next step (it doesn't interrupt or wait for the turn to end).

## Customising the `claude` environment

Because `claude` runs in Domo's process, it already inherits the host service environment and `~/.claude` (including configured MCP servers). For extra environment variables or `PATH` entries (e.g. a language runtime an MCP server needs) without touching the service unit, create `<DOMO_HOME>/config.json` (default `~/.domo/config.json`):

```json
{
  "claude": {
    "env": { "SOME_TOOL_TOKEN": "…" },
    "extraPath": ["/opt/some-runtime/bin"]
  }
}
```

It's read fresh per turn (no restart needed). The security scrub still wins: this **cannot** reintroduce `ANTHROPIC_API_KEY` or other stripped credentials (Decided #9) — that invariant is non-negotiable so subscription billing can't be silently flipped to API billing.

## Updating

`domo update` fetches + verifies the latest release, atomically swaps the app dir (`~/.domo/app/<version>` + a `current` symlink), and restarts if it was running. Versions are pinned together in the release `manifest.json` (app, Postgres image, `@electric-ax/agents-server`, the `@durable-streams` build).

## Where state lives — and backup / cleanup

**Everything is under `<DOMO_HOME>` (default `~/.domo`)** — one dir to back up or wipe:

```
~/.domo/
  state.db            Domo's SQLite (projects / envs / sessions metadata)
  app/<version>/      installed release   (current → symlink)
  run/                domo.pid, domo.log
  data/postgres/      Postgres data        (bind-mounted into the container)
  data/streams/       durable session streams
```

Postgres and the durable streams are **bind-mounted** here (not Docker named volumes) on purpose, so there's nothing scattered in Docker's volume store. Override the location with `DOMO_HOME` (XDG-aware: `$XDG_DATA_HOME/domo` when set).

- **Back up:** `domo down && tar czf domo-backup.tgz -C ~ .domo`
- **Wipe completely:** `domo down && rm -rf ~/.domo` (and `docker image rm domo-agents-server:local` to drop the built image)

Coast owns each env's container + worktree lifecycle separately (outside `~/.domo`).

## See also

- [Securing your install](./securing-your-install.md) — Tailscale / Tunnel / front-proxy; the explicit "no auth in v1" stance.
- `initial-design.md` — full architecture and decision log.
