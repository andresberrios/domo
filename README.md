# Domo

**A self-hosted home for your [Claude Code](https://www.anthropic.com/claude-code) agents.** Run several of them in parallel — each in its own isolated environment — from one clean web app.

## What you get

- **Chat with Claude Code** — full agent sessions with slash commands, `@`-mentions, per-tool cards, and the ability to nudge a running agent mid-task.
- **A built-in workspace** — browse and edit files, review changes in a diff view, and stage and commit with Git, without leaving the app.
- **Isolated environments** — give each piece of work its own sandbox running your project's real services (on its own git branch, via [Coast](https://coasts.dev)). Run multiple agents at once without them stepping on each other.

Work is organised as **Projects → Environments → Sessions**. Sessions stay readable even after their environment is torn down. Domo uses your existing Claude subscription — no per-token API key needed.

> **v0.2.0** — actively developed. Self-hosted, with built-in accounts (email + password).

## Install

You'll need **Docker, [Coast](https://coasts.dev), git, and the `claude` CLI** (logged in once). Node is bundled, so there's nothing else to set up.

```bash
curl -fsSL https://github.com/andresberrios/domo/releases/latest/download/install.sh | sh
domo up
```

Open **http://localhost:7575** and create your admin account on the first visit.

`domo` commands: `up` · `down` · `status` · `logs` · `update` · `version`. Everything Domo stores lives in one folder (`~/.domo`) — easy to back up or remove.

**[→ Full setup guide](docs/site/getting-started.md)**

## Accounts & access

The first person to open Domo becomes the **admin**. After that, new sign-ups wait for the admin to approve them, so you decide who gets in.

By default Domo listens on **localhost only**, which is safe on your own machine. To reach it from other devices, put it behind **Tailscale**, a **Cloudflare Tunnel**, or your own HTTPS proxy — see **[Securing your install](docs/site/securing-your-install.md)**.

## Develop from source

```bash
pnpm install
docker compose up -d    # Postgres + agents server
pnpm dev                # http://localhost:7575
```

Also: `pnpm typecheck` · `pnpm lint` · `pnpm build`. Architecture and design notes live in [`docs/`](docs/).

## Contributing

Issues and pull requests are welcome. By contributing you agree to the **Developer Certificate of Origin** and the inbound terms in [CONTRIBUTING.md](CONTRIBUTING.md) — sign off your commits with `git commit -s`.

## License

Source-available under the **[Functional Source License v1.1](LICENSE.md)** (`FSL-1.1-ALv2`): use, modify, self-host, and share Domo freely for any purpose **except** building a competing product or service. Two years after each release ships, that release becomes available under the **Apache License 2.0**. This is not an OSI-approved open-source license; see [`LICENSE.md`](LICENSE.md) for the exact terms.
