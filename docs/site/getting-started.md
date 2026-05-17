# Getting started (VPS, five-minute path)

Domo runs parallel Claude Code agents over [Coast](https://coastdev.com) environments. It is **self-hosted and single-user** — there is no auth in v1 (see [Securing your install](./securing-your-install.md)).

## How Domo is shipped

Domo is **a host-installed app plus a small Docker-Compose infra stack** — *not* a Docker-only product. The app drives the `claude` CLI in its own process environment, shells host `git`, reads/writes your project worktrees on the host filesystem, and talks to the host Coast daemon — so it must run on the host, where it inherits your `~/.claude` login and tools. Only the session-runtime infra (Postgres + the Electric Agents server) runs in containers.

> Design rationale: `initial-design.md` → **Decided #19 (Distribution & release)** and **Decided #11 (claude runs host-side)**.

## Prerequisites

On the host (your VPS or workstation):

- **Docker + Docker Compose** — runs the infra stack (and Coast's per-env containers).
- **[Coast](https://coastdev.com)** installed and its daemon running (`coast --version`; Domo talks to `coastd` on `127.0.0.1:31415`). Tested against Coast `0.1.53`.
- **Claude Code CLI**, logged in once on the host: `claude` then `/login` (subscription auth lands in `~/.claude`). Domo deliberately strips `ANTHROPIC_API_KEY` from the spawn — billing is your Claude subscription.
- **git**.
- **Node 22+** (until the installer bundles it).

## Install & run

> The `curl … | sh` installer and the `domo` CLI (`domo up` / `update` / `logs` / `status`) are the intended one-command path and are **specced but not yet built** (`initial-design.md` → Distribution & release). Until then, run from a checkout:

```bash
git clone <repo> domo && cd domo
pnpm install
docker compose up -d        # Postgres + agents-server (infra)
pnpm build                  # production build (Nitro node-server)
PORT=7575 node .output/server/index.mjs
```

Domo listens on **http://localhost:7575** (its canonical port; `pnpm dev` also uses 7575). Expose it over Tailscale / Cloudflare Tunnel / a front proxy — see [Securing your install](./securing-your-install.md). Do **not** put it on a public interface unauthenticated.

For development, replace the last two lines with `pnpm dev`.

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

Intended: `domo update` — verify the release, atomically swap the app dir, `docker compose pull && up -d` the pinned infra, restart. App version, infra image tags, and the `@durable-streams` build are pinned together in a release manifest. Until the CLI exists: `git pull`, `pnpm install`, `docker compose pull && up -d`, rebuild, restart.

## Where state lives

- **`<DOMO_HOME>/state.db`** (default `~/.domo/state.db`) — Domo's SQLite: projects, envs, sessions metadata. Override the data dir with `DOMO_HOME` (XDG-aware: `$XDG_DATA_HOME/domo` when set).
- **Postgres + the streams volume** (compose volumes) — the Electric Agents control plane and durable session streams.
- Coast owns each env's container + worktree lifecycle.

## See also

- [Securing your install](./securing-your-install.md) — Tailscale / Tunnel / front-proxy; the explicit "no auth in v1" stance.
- `initial-design.md` — full architecture and decision log.
