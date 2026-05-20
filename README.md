# Domo

**Run a whole fleet of AI coding agents at once — without them tripping over each other.**

Running more than one AI coding agent on the same project usually goes badly: they edit the same files, fight over the same branch, and clobber each other's running services. So you end up babysitting one agent at a time in a terminal tab, losing track of what each one changed. Domo fixes that. Every agent gets its own isolated, fully-running copy of your project, and you drive and review all of them from one self-hosted web app.

## What you get

- **Many agents, truly in parallel.** Each session runs in its own sandbox — your project's real services, on its own git branch — so agents never overwrite each other's work or step on each other's databases.
- **One place to drive and review.** Chat with each agent, watch what it's doing step by step, review and approve its file changes in a diff view, and stage and commit with Git — without leaving the app or juggling terminals.
- **Nothing gets lost.** Sessions stay readable even after you tear an environment down.
- **No surprise bills.** Agents run on your existing Claude subscription, not a metered API key.

Under the hood: Domo is self-hosted (one app you run on your own machine or server). The agents are [Claude Code](https://www.anthropic.com/claude-code); each isolated environment is a [dev container](https://containers.dev/) running on your local Docker. Your code and your credentials stay with you.

> **v0.4.0** — actively developed.

## Install

You'll need **Docker, git, and the `claude` CLI** (logged in once, from inside any env's terminal — see the setup guide). Node is bundled, so there's nothing else to set up. Linux hosts also benefit from a rootless inner-Docker runtime (`sysbox` or rootless dind) — the installer probes for it and points out what's missing.

```bash
curl -fsSL https://github.com/andresberrios/domo/releases/latest/download/install.sh | sh
domo up
```

Open **http://localhost:7575** and create your account on the first visit.

`domo` commands: `up` · `down` · `status` · `logs` · `update` · `version`. Everything Domo stores lives in one folder (`~/.domo`) — easy to back up or remove.

**[→ Full setup guide](docs/site/getting-started.md)**

## Accounts & access

The first person to open Domo becomes the **admin**. After that, new sign-ups wait for the admin to approve them, so you decide who gets in.

Domo listens on **localhost only** by default, which is safe on your own machine. To reach it from other devices, put it behind **Tailscale**, a **Cloudflare Tunnel**, or your own HTTPS proxy — see **[Securing your install](docs/site/securing-your-install.md)**.

## Develop from source

```bash
pnpm install
pnpm dev                # http://localhost:7576 (dev port; prod is 7575)
```

Also: `pnpm typecheck` · `pnpm lint` · `pnpm build`. Architecture and design notes live in [`docs/`](docs/).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Sign off your commits with `git commit -s`.

## License

[FSL-1.1-ALv2](LICENSE.md)
