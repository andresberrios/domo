# Domo

**Self-hosted workspace for running parallel [Claude Code](https://www.anthropic.com/claude-code) agents across isolated [Coast](https://coasts.dev) environments.**

Domo is one app that combines three things:

- **An AI chat interface** — scoped to a single backend, the Claude Code CLI. Slash commands, `@`-mentions, mid-turn steering, and per-tool cards.
- **A file workspace** — Obsidian-style markdown + code viewer/editor (syntax highlighting only, no language tooling), a diff view that doubles as the **edit-approval surface**, and a VS Code–style Git staging/commit panel.
- **Parallel isolated environments** — the flagship workflow. Each environment is a Coast instance running your project's full service stack (DB, redis, dev server, …) in a Docker-in-Docker container, bound to a per-env git worktree. Multiple agent sessions can run in one environment.

The data model is **Project → Environment → Session**. Sessions outlive their environments and stay readable after teardown. Billing rides on your existing Claude subscription, not a per-token API key.

> Status: **v0.1.4** — feature-complete v1, actively developed. Self-hosted, single-user, no built-in auth (see [Security](#security)).

## Install

Domo is a host-installed app plus compose'd infra (Postgres + an agents server). Requirements: **Docker Compose, [Coast](https://coasts.dev), git, and the logged-in `claude` CLI**. Node is bundled — no system Node needed.

```bash
curl -fsSL https://github.com/andresberrios/domo/releases/latest/download/install.sh | sh
domo up        # starts infra + app → http://localhost:7575
```

`domo` CLI: `up` · `down` · `status` · `logs` · `update` · `version`. Pin a version with `DOMO_VERSION=0.1.4 sh install.sh`; install offline with `DOMO_LOCAL_TARBALL=/path/to/domo-<os>-<arch>.tar.gz`. Platforms: `linux-{x64,arm64}`, `darwin-{x64,arm64}` (WSL = linux). All data lives under `$DOMO_HOME` (default `~/.domo`) — one directory to back up or wipe.

See [docs/site/getting-started.md](docs/site/getting-started.md) for the full VPS walkthrough.

## Security

Domo has **no built-in authentication**. By default the app binds to **localhost only** (`127.0.0.1:7575`) — safe on a shared machine. For remote access, expose it via **Tailscale** or a **Cloudflare Tunnel** (these connect to localhost), or put it behind your own authenticating reverse proxy.

Binding to a wider interface is opt-in via `DOMO_BIND` (e.g. `DOMO_BIND=0.0.0.0`). Anyone who can reach the port gets full host file, git, terminal, and `claude` control — so **never bind to a public interface unauthenticated**. See [docs/site/securing-your-install.md](docs/site/securing-your-install.md). Multi-user and built-in auth are deferred.

## Develop from source

```bash
pnpm install            # pnpm 11
docker compose up -d    # Postgres + agents-server
pnpm dev                # http://localhost:7575
pnpm typecheck          # vue-tsc
pnpm lint               # eslint
pnpm build              # production build
```

Architecture and design live in [`docs/`](docs/): [`project-context.md`](docs/project-context.md) (what Domo is/isn't), [`initial-design.md`](docs/initial-design.md) (authoritative design), and [`docs/site/`](docs/site/) (operator docs). `CLAUDE.md` orients AI coding sessions.

## Contributing

Contributions are welcome — issues and pull requests. By submitting a contribution you agree to the **Developer Certificate of Origin** and the inbound license terms in [CONTRIBUTING.md](CONTRIBUTING.md). Sign off your commits with `git commit -s`.

## License

Domo is **source-available** under the **[Functional Source License v1.1](LICENSE.md)** with an Apache 2.0 future grant (`FSL-1.1-ALv2`).

In plain terms: you may use, modify, self-host, and redistribute Domo freely for **any purpose except a Competing Use** — you may not use it to build a product or service that substitutes for or offers substantially the same functionality as Domo. Two years after each release is published, that release automatically becomes available under the **Apache License 2.0**.

This is not an OSI-approved open-source license. See [`LICENSE.md`](LICENSE.md) for the exact terms.
