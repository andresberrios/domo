# Domo — Project Context

> **Living document.** Keep this in sync with `initial-design.md` (detailed design) and `tasks.md` (work tracker). When implementation surfaces a high-level shift in what Domo is or isn't, update this file in the same change as the deeper-detail edits.

## What it is

Domo is a self-hosted **web app and server** for running parallel **Claude Code** agents across isolated **[Coast](https://coasts.dev) environments**. It combines three things in one workspace:

1. **An AI chat interface** — a simpler analog to [open-webui](https://github.com/open-webui/open-webui), scoped to a single backend: the **Claude Code CLI**.
2. **A simple file workspace** — a stripped-down [Obsidian](https://obsidian.md)-style file viewer/editor:
   - Markdown viewing/editing
   - Source code viewing/editing with syntax highlighting only (no autocomplete, no language tooling, no AI inside the editor itself)
   - Diff visualization for agent-proposed edits — also the approval surface
   - A Git changes panel for staging, unstaging, and committing (VS Code–style)
3. **Parallel isolated environments via Coasts** — the flagship workflow. Each environment is a [Coast instance](https://coasts.dev) running the project's full service stack (DB, redis, dev server, etc.) inside a Docker-in-Docker container, attached to a per-env git worktree. Multiple agent sessions can run inside one environment, sharing its worktree's filesystem.

The data model is **Project → Environment → Session**. A project is a git repo with a `Coastfile`; an environment is a Coast instance bound to a per-env branch + worktree, with the user's services running inside it; a session is one agent conversation. Sessions outlive their environments and remain readable after teardown.

## What it is not

- Not a multi-LLM chat app. The v1 backend is the Claude Code CLI; peers may follow, but there is no multi-provider abstraction.
- Not a full IDE. No autocomplete, no language server, no inline AI in the editor.
- Not a notes manager with graph view, plugins, or sync — just files on disk.
- Not a managed/cloud-hosted offering. Self-hosted only — on the user's VPS (primary v1 target) or laptop.
- Not its own container/orchestration layer. Coasts owns container lifecycle, port allocation, worktree mounting, and service exposure. Domo orchestrates Coasts via the `coast` CLI / daemon, doesn't reimplement what Coasts already gives us.

## Core idea

Within each environment, the chat side and the editor side share that env's worktree. The agent reads and edits files in the worktree; the user reviews each proposed edit as a diff and accepts or rejects it, then can keep editing manually. Sessions are persistent and continue seamlessly across devices — the web UI is responsive and works equivalently on desktop and mobile (a Capacitor mobile-app wrapper is a follow-up).

## Shape

- **Web app + server, packaged as one Nuxt app, running on the user's VPS** (primary v1 target) or laptop.
- **No auth in v1.** The user secures the deployment via Tailscale, Cloudflare Tunnel, a private network, or by binding to localhost behind their own auth proxy. Multi-user and built-in auth are deferred.
- Each environment is a Coast instance. The user's existing `docker-compose.yml` describes the services that run inside it; a `Coastfile` at the project root tells Coast how to compose them.
- Service exposure to the browser is whatever Coast provides — dynamic high ports per env, plus the user's project's canonical ports for whichever env is currently "checked out".
- Billing rides on the user's existing Claude subscription, not a per-token API key.

Implementation details — runtime architecture, CLI integration, editor wiring, Coast integration, session persistence — live in `initial-design.md`.
