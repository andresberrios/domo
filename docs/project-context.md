# Domo — Project Context

> **Living document.** Keep in sync with `initial-design.md` (detailed
> design) and `tasks.md` (tracker). Update here when the high-level
> framing of what Domo is/isn't shifts, in the same change.

## What it is

A self-hosted **web app + server** (one Nuxt app) for running parallel
**Claude Code** agents across isolated dev environments. Three things in
one workspace:

1. **An AI chat interface** — a simpler analog to open-webui, scoped to
   one backend: the Claude Code CLI.
2. **A simple file workspace** — Obsidian-lite: markdown + syntax-only
   code view/edit (no autocomplete/LSP/AI-in-editor), agent-diff review
   as the approval surface, a VS Code-style Git changes panel.
3. **Parallel isolated environments** — each is a **dev container** (the
   `devcontainer.json` spec) with **rootless Docker-in-Docker** so the
   user's own `docker compose` runs isolated per env, attached to a
   per-env git worktree. Multiple agent sessions share an env's worktree.

Data model: **Project → Environment → Session**. A project is a git repo
with a `Domofile`; an environment is a dev container bound to a per-env
branch + worktree; a session is one agent conversation. Sessions outlive
environments and stay readable after teardown.

## What it is not

- Not a multi-LLM chat app. v1 backend is the Claude Code CLI; the UI
  transcript is the AI SDK `UIMessage` shape so other backends can be
  added as adapters, but there's no multi-provider abstraction now.
- Not a full IDE. No autocomplete, language server, or inline AI.
- Not a notes manager — just files on disk.
- Not a managed/cloud offering. Self-hosted only (VPS or laptop).
- Not its own heavyweight orchestration layer. It drives the standard
  **devcontainer** spec + Docker; it doesn't reimplement Kubernetes/Caddy.

## Core idea

Within each environment the chat side and the editor side share that
env's worktree. The agent reads/edits files; the user reviews each
proposed edit as a diff and accepts/rejects, then can keep editing
manually. Sessions are persistent and continue across devices; the UI is
responsive (desktop ≡ mobile; a Capacitor wrapper is post-v1).

## Shape

- One Nuxt app on the user's VPS/laptop. The **session engine, durable
  transcript, and reactivity are in-process over a single SQLite file**
  under `$DOMO_HOME` — no sidecar database or agent server.
- **Multi-user auth shipped** (`nuxt-auth-utils`, first-run admin,
  admin-approval, no email). Binds **localhost-only by default**
  (`DOMO_BIND` to widen); remote access via Tailscale / Tunnel / VPN /
  auth-proxy. See `docs/site/securing-your-install.md`.
- Each environment is a dev container; the user's `docker compose`
  describes the inner services; a `Domofile` declares the container
  source + the named ports Domo can expose (toggle per port; one
  canonical env owns the standard ports/hostname).
- Billing rides on the user's existing Claude subscription, not a
  per-token API key.

Runtime architecture, CLI integration, the engine, devcontainer +
port-forwarding design, and persistence live in `initial-design.md`.
Pre-2026-05 history (the superseded Electric Agents + Coast
implementation) is in `history.md`.
