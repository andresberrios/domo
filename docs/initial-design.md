# Domo — Initial Design

This document is the working design for Domo. It supersedes the earlier homegrown "parallel environments" subsystem, which has been replaced by **[Coasts](https://coasts.dev)**.

> **Living document.** When implementation surfaces a new decision, a contradicted assumption, or a scope change, update this doc (and `project-context.md` if the high-level framing shifts, and `tasks.md` for the work tracking) in the same change — not later. The three docs are meant to stay aligned.

## Reference projects (cloned alongside this repo)

- `../nuxt-chat-template/` — [`nuxt-ui-templates/chat`](https://github.com/nuxt-ui-templates/chat). Re-cloned in Phase 3 (was missing). Streaming AI chat built on Nuxt UI's `UChat*` components and the Vercel AI SDK. We borrow its layout shell, `UChat*` primitives, `MessageContent.vue` part-rendering pattern, and `Comark` markdown setup. We replace its transport and message-shape (Step 9).
- `../nuxt-editor-template/` — [`nuxt-ui-templates/editor`](https://github.com/nuxt-ui-templates/editor). Notion-style WYSIWYG editor built on TipTap. Out of scope for v1; we use **CodeMirror 6** instead for code/markdown editing and diffs. TipTap may return post-v1 as an optional markdown WYSIWYG mode.
- `../electric-source/` — Electric Agents source (`electric-sql/electric`). Re-cloned in Phase 3 as a blobless partial clone (full history; `git show 65f0cf0:packages/agents/src/agents/coding-session.ts` for the removed reference entity). HEAD matches our pinned npm versions (`agents-runtime@0.2.1`, `agents-server@0.4.2`). The reference shape for our `claude-code-cli` entity; the real runtime API lives in `packages/agents-runtime/src/` (`createEntityRegistry`/`registry.define`/`createRuntimeHandler`/`createPullWakeRunner`, `HandlerContext`).
- `../claudecode.nvim/` — reverse-engineered Claude Code IDE bridge protocol reference. We lift the WebSocket protocol structure from `lua/claudecode/server/` and rewrite in TypeScript. The canonical protocol writeup lives at `PROTOCOL.md` in that repo.
- `../coasts/` — Coast's own source. Their HTTP/SSE/WS API at `localhost:31415/api/v1/` (defined in `coast-daemon/src/api/`) is our Coast contract, and their `coast-guard/` React SPA is a working reference for the same client-side code we're writing in Vue. They also export `ts-rs` TypeScript bindings for every request/response type.
- `../claude-code-chat/` ([andrepimenta](https://github.com/andrepimenta/claude-code-chat)) and `../claude-code-chat-codeflow/` ([codeflow-studio](https://github.com/codeflow-studio/claude-code-chat)) — two VS Code Claude-Code-Chat extensions we mine for chat-UI patterns. See [Chat input affordances](#chat-input-affordances) below.

## What we want (recap)

Domo is a single self-hosted Nuxt app — server + web UI — that the user runs on their VPS (primary v1 target) or laptop. It has three surfaces sharing one workspace:

1. **Chat surface** — talk to one or more Claude Code CLI sessions per environment.
2. **Workspace surface** — browse / read / edit files in the selected environment's worktree; review agent diffs; stage/commit changes.
3. **Environment surface** — see and control the per-env Coast instance: services, ports, branch, worktree, checkout state, lifecycle.

All three are coordinated through a left-rail tree: **Project → Environment → Session**.

## High-level architecture

```
┌──────────── User's VPS (or laptop) ──────────────────────────────────────────┐
│                                                                              │
│  ┌──────────────── Domo (Nuxt server + UI) ─────────────────┐                │
│  │                                                          │                │
│  │   app/   pages, components, composables (Vue)            │                │
│  │   server/ nitro routes:                                  │                │
│  │     /api/projects        — list / add / init / remove    │                │
│  │     /api/envs            — list / create / start / stop  │                │
│  │     /api/sessions        — list / create / prompt        │                │
│  │     /api/workspace/...   — file tree / read / write      │                │
│  │     /api/git/...         — status / diff / stage / commit│                │
│  │     /api/terminal        — websocket: env shell          │                │
│  │     /_electric/builtin-agent-handler — entity webhook    │                │
│  │   lib/                                                   │                │
│  │     coast.ts             — HTTP/SSE/WS client for coastd │                │
│  │     ide-bridge/          — WebSocket server for claude   │                │
│  │     db.ts                — SQLite (projects/envs/        │                │
│  │                            sessions metadata + stream id)│                │
│  └────────────┬──────────────┬──────────────────┬───────────┘                │
│               │              │                  │                            │
│               │ spawns       │ HTTP/SSE/WS      │ webhooks                   │
│               ▼              ▼                  ▼                            │
│       ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐                 │
│       │ claude CLI  │  │   coastd    │  │ Electric Agents  │                 │
│       │ (per turn)  │  │ :31415/api  │  │ server (sidecar) │                 │
│       └─────┬───────┘  └──────┬──────┘  └────────┬─────────┘                 │
│             │ WS              │                  │                           │
│             │ (IDE bridge)    │ Docker + state   │ durable streams           │
│             ▼                 ▼                  ▼                           │
│       ┌──────────────────────────────────────────────────┐                   │
│       │  Coast instances (one DinD container per env)    │                   │
│       │  /workspace = host worktree bind mount           │                   │
│       │  inner compose: web / db / redis / etc.          │                   │
│       └──────────────────────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

The Nuxt app runs on the user's VPS. The user reaches it through whatever mechanism they chose (Tailscale, Cloudflare Tunnel, a private VPN, an auth-proxy in front of the public domain). v1 has no built-in auth — exposing the URL is exposing the app.

**Rendering is SPA-style.** The shell, the workspace, the terminal, and the chat surface all run client-side and bind to long-lived WebSockets / SSE streams (xterm.js, durable session subscriptions, coastd events). Server-rendering buys little here, so we set `routeRules: { '/**': { ssr: false } }`. Nitro is still up — it serves procedures (`nuxt-procedures`), SSE/WS proxies to coastd, and the Electric Agents webhook.

The `coast` CLI and its daemon (`coastd`) run **on the same host as Domo** — they have to, since Coast manages the local Docker daemon and the worktrees on the host filesystem. Coastd exposes both a unix socket and an HTTP/SSE/WebSocket API at `http://localhost:31415/api/v1/` (the same surface Coastguard, Coast's own web UI, uses). Domo talks to coastd directly over that HTTP API; the `coast` CLI is only used for one-shot operations outside the hot path (e.g. `coast --version` for version pinning, `coast doctor` for repair flows surfaced through the UI).

Electric Agents continues to be the runtime for durable session streams; we self-host its control plane as a sidecar process. See [Session runtime](#session-runtime-electric-agents-with-the-claude-code-cli-entity) for the full story.

## UI layout

A three-panel shell with an optional bottom panel:

```
┌────────────────┬─────────────────────────────────────────┬───────────────────┐
│                │  [project] / [env]                      │                   │
│  LEFT PANEL    │  ┌───────────────────────────────────┐  │   RIGHT PANEL     │
│                │  │ [session A]  [session B]  [file]  │  │                   │
│  Projects      │  └───────────────────────────────────┘  │  Tabs:            │
│   ▾ proj-1     │                                         │   • Files         │
│     ▾ env-x    │      ┌───────────────────────────────┐  │   • Git changes   │
│        • s1 ●  │      │                               │  │                   │
│        • s2 ◌  │      │       CENTER AREA             │  │                   │
│     ▾ env-y    │      │  (session OR editor)          │  │                   │
│   ▾ proj-2     │      │                               │  │                   │
│     ...        │      │                               │  │                   │
│                │      └───────────────────────────────┘  │                   │
│                │                                         │                   │
│ [show done ☐]  │                                         │                   │
│                ├─────────────────────────────────────────┼───────────────────┤
│                │                BOTTOM PANEL                                 │
│                │       Terminal (shell inside selected env)                  │
│                │                                                             │
└────────────────┴─────────────────────────────────────────────────────────────┘
```

### Left panel — Project / Env / Session tree

**Top-level navigation.** Always visible. The single source of "what am I looking at?".

- **Projects** at the top level. Each project shows its display name and a small "has Coastfile" / "missing Coastfile" indicator. Click to expand.
- **Environments** nested under each project. Each row shows the env name (= branch name = worktree name) and a state badge: `running`, `stopped`, `provisioning`, `error`. The checked-out env (canonical ports owner) is marked with a star.
- **Sessions** nested under each env. Each session row shows:
  - The session title (auto-generated from the first user message, editable later).
  - A **status indicator**: `active` (the agent is currently producing output), `waiting` (the agent finished its last turn and is waiting on the next prompt; equivalent to "idle"), `pending-approval` (a tool call needs the user — e.g. an `openDiff` is parked), `error`.
  - A **new-output dot** — small badge that lights up when there's new agent output since the user last viewed the session in this device. Cleared when the session is opened in the center area.
- **Mark session as done** action on each session row (e.g. right-click or hover menu). Done sessions are hidden by default; a **"show done"** toggle at the top of the left panel reveals them in a dimmed style. "Done" is purely a UX classification — it does not delete the session's durable stream; you can un-done a session and continue it.
- **Top-of-panel actions:**
  - **+ Project** — opens the "add project" flow (see [Project setup flow](#project-setup-flow)).
  - **Search** (post-v1) — across projects / envs / sessions.
- **Right-click / context menu** on each node opens lifecycle actions: rename env, stop/start env, check out env, delete env, delete session, etc.

### Center area — Session or Editor

The center area shows exactly one of:

- **A chat session** (the chat surface — see [Chat surface](#chat-surface)).
- **A file editor** (the workspace surface — see [Workspace surface](#workspace-surface)).
- **An environment overview** (when an env node is selected directly — see [Environment surface](#environment-surface)).
- **An empty / onboarding state** when nothing is selected.

**Center-area tabs**, just above the content, switch between the things you've opened in this center context — chat sessions and files. Opening a session from the left panel adds (or focuses) a session tab. Opening a file from the right panel adds (or focuses) an editor tab. Tabs are project-and-env-scoped: switching to another env shows that env's tab set. Tabs survive page reload (state persisted server-side).

**Center-area header** sits above the tabs and shows, prominently, **`[project name] / [environment name]`**. This is the persistent "where am I working" indicator — it changes when the user clicks across the left panel and is what the user reads to confirm context before sending a prompt or saving a file.

### Right panel — Files / Git changes

Tabbed:

- **Files tab** — the worktree's file tree for the currently-selected env. Honors `.gitignore`. Click a file → opens (or focuses) an editor tab in the center area. Right-click for context actions (open in chat as `@`-mention, reveal in terminal, etc.).
- **Git changes tab** — VS Code-style staged/unstaged lists with diffs, stage/unstage toggles, and a commit-message input + Commit button. The diffs reuse the same CodeMirror merge component used for agent diffs. Commits run on the host (the worktree is a host-side directory) via shell-out to `git` from Domo's server. Pushing is a button next to Commit.

The right panel can be **hidden** (collapses to a thin strip) or **expanded** (the center area shrinks to its minimum). Expanding is a "focus mode" for browsing files / reviewing changes.

### Bottom panel — Terminal

A websocket-backed xterm.js terminal connected to a shell **inside the currently-selected env's Coast instance**. Effectively `coast exec <env>` over a websocket — so the cwd is `/workspace` (the worktree) and commands have access to the full inner stack (compose services, etc.).

Like the right panel, the bottom can be hidden or expanded to fill the available vertical space. Multiple tabs (multiple shells in the same env) is post-v1 polish.

### Panel state and responsiveness

- Right and bottom panels independently hideable + expandable.
- Left panel is always visible on desktop; on mobile widths it collapses into a drawer.
- The whole shell is responsive; the mobile experience uses the same routes and components but reorganizes into a stack. (Capacitor wrapper for native push / share-sheet is post-v1.)

## Routing

URL structure (browser history-friendly, deep-linkable):

| Path | Shows |
|------|-------|
| `/` | Empty / onboarding state (or last-active session if any) |
| `/p/:project` | Project overview (env list + project info); auto-redirects to first env if any |
| `/p/:project/e/:env` | Env overview in the center area |
| `/p/:project/e/:env/s/:session` | Chat session in the center area |
| `/p/:project/e/:env/f/*path` | File open in the center area editor |

Tab open in the center area is whatever the URL says; switching tabs updates the URL.

## Project setup flow

Adding a project is a three-step flow triggered from "+ Project":

1. **Pick a directory on the server.** A directory-picker UI (server-side filesystem browser, scoped to a configured "projects root" by default but allowing browsing elsewhere) lets the user select an existing path. We don't support remote-clone-in-UI for v1 — the user provisions the project on the VPS however they want (clone over SSH, scp, bind mount from elsewhere), then points Domo at it.
2. **Git check.** Domo runs `git rev-parse --show-toplevel` (or equivalent) in the selected directory.
   - If the directory is already a git repo, continue.
   - If not, prompt: **"This directory is not a git repository. Initialize one, or cancel?"** Choosing "init" runs `git init` and makes an empty initial commit (or no commit; we'll figure out the cleanest shape during impl). Cancel aborts the add.
3. **Coastfile check.** Domo looks for a `Coastfile` or `Coastfile.toml` at the project root.
   - If found, continue.
   - If not, prompt: **"This project has no Coastfile. Initialize one, or cancel?"** Choosing "init" writes a starter Coastfile based on what Domo can detect (compose file at `./docker-compose.yml`? bare-services scaffold? a minimal `[coast] name = "<dir-name>"`). The starter is a best-effort — the user can edit before saving the project. We may surface Coast's own `coast installation-prompt` content as guidance / a copyable seed. Cancel aborts the add.

On success, Domo records the project in its SQLite DB (`projects` table) and runs `coast build` once to validate the Coastfile and produce a build artifact. (We surface build output in the UI; this can take 20+ seconds with cold caches.)

After add, the project appears in the left panel. The user typically goes next to **+ Environment**.

## Environment creation flow

Triggered from the project node (or from the project overview screen).

1. User clicks **+ Env**, types a **name**. This name is used for:
   - The git branch (`<name>` created off the project's current default branch, or off whichever base branch the user picks in the form — default-branch is the v1 default).
   - The worktree directory (`<project_root>/.worktrees/<name>` — Coast's default `worktree_dir`).
   - The Coast instance name (`<name>`).
2. Domo calls `coast run <name> -w <name>`. Per Coast's docs, this provisions the DinD container, starts the compose stack, allocates dynamic ports, and creates+assigns the worktree (which Coast does automatically if it doesn't exist). The branch is created off the current HEAD if needed.
3. Domo polls `coast lookup --json` / `coast ls` until the env is `Running`, then transitions the env in its DB to `running` and shows the env overview screen.

If `coast run` fails, Domo surfaces the error (typically: build artifact missing → run `coast build` first; or dangling container → offer `--force-remove-dangling`).

**Worktree location:** project-relative, at `<project_root>/.worktrees/<env-name>`, per Coast's default. We ensure `.worktrees` is in the project's `.gitignore` (if Coastfile init was on us, we add it; otherwise we surface a warning if it's missing).

## Environment surface (center area when an env is selected)

A scoped dashboard for the selected env. Sections:

- **Header.** Env name, branch name, checkout state badge, status (`running` / `stopped` / ...). Actions: **Stop**, **Start**, **Restart**, **Check out** (gives this env the project's canonical ports), **Release checkout** (`coast checkout --none`), **Delete**.
- **Services.** A table of services running inside the inner compose stack (from `coast ps <env>` / `coast ports <env>`). Each row: service name, status, canonical port, **dynamic port**, **clickable URL** built from the dynamic port (or canonical if checked out). The user can click a service URL to open it in a new browser tab — that URL goes through whatever exposure mechanism the user set up (Tailscale, the VPS's public IP + opened ports, etc.).
- **Worktree.** Branch name, worktree path on disk, "open files" button (focuses the right-panel Files tab).
- **Logs preview.** A small recent-output tile per service, with "open in terminal" / "follow logs" actions that route through `coast logs --follow`.

The env screen is where the user goes when they want to "look at the env" rather than work in a session.

## Service exposure to the browser

This is now Coast's job; Domo just surfaces what Coast provides.

- **Dynamic ports:** every running env has dynamic high ports per service (e.g. `localhost:62217`), always available. On a VPS, these are accessible by IP-and-port through whatever the user exposed (Tailscale node IP, Cloudflare Tunnel hostname forwarded to specific ports, or a firewall rule).
- **Canonical ports** via `coast checkout`: project's regular ports (e.g. `localhost:3000`) point to whichever env is checked out. Only one env at a time.
- **Subdomain routing** (`{env}.localhost:<port>`) is a Coast feature for cookie isolation; we expose Coast's toggle but default to off.

**We do not run Caddy ourselves**, and we do not template per-env subdomains in v1. Users who want a friendlier URL story can set up Caddy or another reverse proxy in front of Domo + the Coast dynamic ports themselves; documenting this is part of the docs we ship (see [Public documentation](#public-documentation)).

## Chat surface

We reuse the chat template's UI almost wholesale, swapping out the transport and message shape.

### Components reused from the chat template

- `UChatMessages` / `UChatPrompt` / `UChatPromptSubmit` / `UChatReasoning` / `UChatTool` / `UChatShimmer` — these are Nuxt UI primitives, not template-specific. They handle streaming, auto-scroll, indicator slots, etc.
- The `MessageContent.vue` pattern (`app/components/chat/message/MessageContent.vue`, lines 17–71): iterate over `message.parts` and render each part by type (`text`, `reasoning`, `tool`). We keep this exact shape.
- `Comark.ts` (lines 1–34) — markdown rendering with Shiki code highlighting. Kept for assistant text parts.
- The drag-drop overlay, edit/regenerate flow, and prompt UX.

### What we replace

The chat template uses the Vercel AI SDK's `Chat` class + `DefaultChatTransport` pointed at `/api/chats/:id`, which internally calls `streamText({ model, ... })`. We replace that with **an Electric Agents durable-stream subscription** projecting the entity's `events` collection into the `UIMessage.parts` shape `UChatMessages` already understands (see Decided #17). Sending a prompt is a `sessions.prompt` procedure (entity inbox `send`), not an AI-SDK transport.

The browser subscribes to the durable stream **directly** (not via a procedure), but the bytes still transit Domo's origin through a transparent reverse proxy (`/_agents/**` → agents-server, `server/routes/_agents/[...].ts`) — the same "browser → Domo → backend" shape as the coastd WS/SSE pass-throughs, so it works over Tailscale/Tunnel with no auth and nothing else exposed. `@electric-ax/agents-runtime`'s client resolves everything as `baseUrl + path`, so one catch-all proxy covers the `_electric` control GETs *and* the long-poll/SSE stream. `useSessionStream` wraps the framework-agnostic core (no Vue binding ships) and `projectSessionMessages` is the claude-cli **adapter** (Decided #17). See [Session runtime](#session-runtime-electric-agents-with-the-claude-code-cli-entity).

### Tool rendering

The chat template's pattern for custom tool UIs (`ChatToolChart`, `ChatToolWeather`) is the exact pattern we want for Claude Code tools:

- **Read / Glob / Grep** — collapsible chip showing the file/path, count of results.
- **Edit / Write** — diff preview using our diff component, with an "approve / reject" pair when the IDE bridge `openDiff` call is parked. Clicking the diff opens the full view in the workspace surface.
- **Bash** — render the command and output in a styled block.
- **TodoWrite** — render as a task list.

Generic tools fall back to `UChatTool` with the tool name and a JSON-rendered input/output. **UX inspiration here comes from existing open-source Claude Code wrappers (VS Code extensions, web UIs)** — we audit a handful and steal the rendering ideas that match our Vue/Nuxt stack.

### What we drop (vs the chat template)

- Multi-model selector (`ModelSelect.vue`, `useModels`) — one backend.
- File upload to blob storage — files come from the workspace, not from user uploads. May come back later as a way to attach a file path to a prompt.
- Auth (`nuxt-auth-utils`, GitHub OAuth, vote endpoints, public/private chat visibility) — v1 has no auth.
- AI Gateway / multi-provider config.
- Web search / chart / weather example tools.

### Chat input affordances

Mined from the two cloned VS Code extensions. Phase 3 chat-prompt component should support:

- **Slash-command popup** triggered by `/` at the start of the prompt. Arrow-key navigation, Tab/Enter to accept, Escape to dismiss. Filter as the user types.
  - **Built-in commands** (handed straight to the CLI): `/bug`, `/clear`, `/compact`, `/config`, `/cost`, `/doctor`, `/help`, `/init`, `/login`, `/logout`, `/memory`, `/pr_comments`, `/review`, `/status`, `/terminal-setup`, `/vim`. Source: `claude-code-chat-codeflow/src/utils/slash-commands.ts`.
  - **Custom commands** scanned from the env's worktree `.claude/commands/*.md` (project) and the host's `~/.claude/commands/*.md` (user). The filename (sans `.md`) is the command name, the first `# Heading` line is the description, and `$ARGUMENTS` in the body is substituted at send time. Project commands take precedence on name collisions. Source: `claude-code-chat-codeflow/src/service/customCommandService.ts`.
- **`@`-mention popup** for inline context references. Trigger by typing `@` mid-prompt. Categories from the codeflow extension worth keeping:
  - **File** / **Folder** — backed by the env's worktree file index.
  - **Git** — `@git-changes` (current uncommitted diff) and `@<short-sha>` (specific commit).
  - **URL** — `@https://...` passes the URL through.
  - **Problems** — surface env service errors / build diagnostics if we have any to surface. (Skip for v1 if not trivially available.)
- **At-mentions become inline chips** in the rendered prompt and are re-expanded server-side into actual file contents / diff text before being shipped to the CLI. *(Phase 3 ships these as plain-text `@token`s in the textarea, not contenteditable chips — functionally equivalent given the server-side expansion contract; a chip UI can layer on later without changing it. Expansion runs in the **entity** at execution time, not in `sessions.prompt`, so the durable transcript keeps the raw text the user typed.)*
- **Drag-and-drop** files from the right-panel file tree into the prompt (Nuxt chat template already has this pattern).
- **Edit-and-regenerate** on past user messages (Nuxt chat template pattern; pairs with our session-fork model on the durable stream). **Shipped as edit-and-*resend*** (Phase 3): the transcript's per-message pencil pulls the text back into the prompt for refinement; resending continues the *same* session (claude `--resume` keeps prior context — the normal way a correction is issued). True edit-and-*fork* — branching the durable stream and forking the native claude session at message N — stays deferred: it needs a durable-stream branch primitive and arbitrary-offset claude rewind we have not validated (see [Reconciling Claude's session file with the durable stream](#reconciling-claudes-session-file-with-the-durable-stream)).
- **Abort** button while a turn is in flight — sends inbox `abort`.

These are Phase 3 work; itemized in [`tasks/phase-3-sessions.md`](../docs/tasks/phase-3-sessions.md).

## Workspace surface

CodeMirror 6 owns the editor and diff view. We borrow the Shiki theme setup and layout from the editor template but **do not use** `UEditor`/TipTap for v1. CodeMirror gives us:

- Per-language syntax highlighting via `@codemirror/lang-*`, picked by file extension.
- Read-only mode (default for now) and edit mode.
- `@codemirror/merge` for diff view (inline + side-by-side).
- No AI/autocomplete unless we explicitly add it (we won't).

For **markdown preview** we reuse the chat template's `Comark` setup.

### Components

- `WorkspaceEditor.vue` — wraps CodeMirror. Props: `path`, `mode` (`view` | `edit` | `diff`), optional `against` ref for diff mode.
- `WorkspaceMarkdownView.vue` — uses `Comark` to render `.md` files.
- `WorkspaceFile.vue` — page-level component that picks editor / markdown view / diff view based on file type and mode, with a header showing path, mode toggle, save state, and "Open in chat" button.

### Diff visualization (two cases)

1. **Pending agent edit.** When the agent's `Edit`/`Write` tool fires through the IDE bridge's `openDiff` call, the entity parks the call and emits a `pending_diff_decision` event in the durable stream with `{ path, before, after, callId }`. The chat tool component renders an inline preview and links to the workspace surface in `diff` mode for the full view. The user clicks accept / reject; the UI posts a `diff_decision` inbox message; the entity resolves the parked WS call with `FILE_SAVED` or `DIFF_REJECTED`.
2. **Manual review** (Git changes tab). Uses the same merge component, against the index or HEAD.

### Future: optional WYSIWYG markdown mode (post-v1)

We design the file mode-toggle to leave room for `UEditor` (TipTap) as an optional WYSIWYG axis on markdown files only, but ship with CodeMirror only.

## Top-level metadata DB

Domo keeps its own small store (SQLite, single file under the user's data dir, e.g. `~/.domo/state.db`) of:

| Table | Columns (sketch) |
|-------|------------------|
| `projects` | id, name, root_path, default_branch, has_coastfile, created_at |
| `envs` | id, project_id, name, branch, worktree_path, coast_instance_name, status (cached), created_at |
| `sessions` | id, env_id, title, status (`active`/`waiting`/`pending-approval`/`error`/`done`), entity_id, durable_stream_url, native_claude_session_id, created_at, last_event_at, viewed_at_per_device (JSON) |
| `settings` | key, value |

**What's in here vs what's elsewhere:**

- The full session event log lives in **Electric Agents durable streams**, not in our DB. Our `sessions` row points at the stream and tracks UX-shaped metadata only (title, done-state, last-viewed-at per device, etc.).
- Coast owns runtime state — running/stopped, dynamic ports, branch on disk. We cache the last-seen status for fast UI rendering but always reconcile against `coast ls` / `coast lookup` on focus.
- Git state is on disk in the worktree. We don't mirror it.

The DB lets us answer "list projects/envs/sessions" without round-tripping Coast or Electric on every page load, and it owns the **session-done** flag (a Domo concept, not a Coast or Electric one).

## Session runtime: Electric Agents with the `claude-code-cli` entity

ElectricSQL describes a [Durable Sessions](https://electric.ax/blog/2026/01/12/durable-sessions-for-collaborative-ai) pattern built on [Durable Streams](https://electric.ax/blog/2026/04/08/data-primitive-agent-loop): a persistent, addressable, append-only stream per session that carries every chunk, tool call, presence event, and state mutation. Clients subscribe by URL, replay from any offset, and reactively materialize state via TanStack DB. Their followup, [Electric Agents](https://electric.ax/blog/2026/04/29/introducing-electric-agents), is the platform that gives us this: a runtime where each agent is an addressable durable stream, plus a self-hosted control plane and runtime server.

> **Note on the built-in `coder` entity.** Electric used to ship a built-in `coder` entity that wrapped the Claude Code / Codex CLIs ([source as of commit `65f0cf0`](https://github.com/electric-sql/electric/blob/65f0cf02074732dc312df62a69d949b29533581c/packages/agents/src/agents/coding-session.ts)). It has since been replaced by **Horton**, which uses `@anthropic-ai/sdk` directly — that path requires `ANTHROPIC_API_KEY` and bills per-token. We want **Claude Pro/Max subscription billing**, only available through the `claude` CLI. So:
>
> - Self-host the Electric Agents control plane (`@electric-ax/agents-server`) and runtime (`@electric-ax/agents-runtime`).
> - **Do not** use Horton.
> - Implement our own entity type, **`claude-code-cli`**, modelled closely on the removed `coding-session.ts`.

### How the custom `claude-code-cli` entity works

Adapted from `electric-source/packages/agents/src/agents/coding-session.ts` at commit `65f0cf0`. The shape:

```ts
import { createEntityRegistry, createRuntimeHandler } from '@electric-ax/agents-runtime'

const registry = createEntityRegistry()

registry.define('claude-code-cli', {
  description: 'A Claude Code CLI session, mirrored into a durable stream.',
  creationSchema: z.object({
    envId: z.string(),         // Domo's env id
    coastInstance: z.string(), // Coast instance name
    cwd: z.string(),           // host path to the env's worktree
  }),
  inboxSchemas: {
    prompt:         z.object({ text: z.string() }),
    diff_decision:  z.object({ callId: z.string(), decision: z.enum(['accept', 'reject']) }),
    abort:          z.object({}),
  },
  state: {
    sessionMeta:  { schema: sessionMetaRowSchema,  primaryKey: 'key' },
    inboxState:   { schema: inboxStateRowSchema,   primaryKey: 'key' },
    events:       { schema: eventRowSchema,        primaryKey: 'key' },
    pendingDiffs: { schema: pendingDiffRowSchema,  primaryKey: 'callId' },
  },
  async handler(ctx) {
    // 1. Boot the per-session IDE-bridge WebSocket server (write ~/.claude/ide/<port>.lock).
    // 2. Drain inbox of pending prompts since lastProcessedInboxKey.
    // 3. For each prompt:
    //    - Spawn the claude CLI for one turn (see CLI invocation below).
    //    - readline over child.stdout; NDJSON-parse each line into events_insert(...).
    //    - The first 'system' event carries session_id; on the first turn, persist as
    //      sessionMeta.nativeSessionId so subsequent turns use --resume <id>.
    //    - Tool calls hitting the bridge route through openDiff for Edit/Write; the
    //      bridge parks the WS request, writes a pendingDiffs row + emits a tool event;
    //      a diff_decision inbox message later resolves the parked call.
    //    - recordRun() brackets the invocation so observers get a runFinished wake.
    // 4. Update sessionMeta status (idle/running/error/pending-approval).
    // 5. Advance lastProcessedInboxKey.
  },
})
```

### CLI invocation

```
claude -p [--resume <id>]
  --permission-mode acceptEdits
  --output-format stream-json
  --input-format  stream-json
```

with env vars: `CLAUDE_CODE_SSE_PORT=<bridge-port>`, `ENABLE_IDE_INTEGRATION=true`, **`ANTHROPIC_API_KEY=` (scrubbed)**, optional `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`.

The prompt is sent to stdin as a stream-json `user` message envelope. Stdout is the only runtime event source; stdin carries user messages only.

**Where this process actually runs** is a pending decision — see [Where claude runs](#where-claude-runs-pending-decision).

### Decision: stdout `stream-json` is the only runtime event source

The reference `coding-session.ts` mirrored events by tailing the on-disk JSONL session file (`fs.watch` + 1.5s poll, normalized via `agent-session-protocol`). We use stdout `stream-json` instead:

- Officially-supported, documented protocol meant to be consumed by tools.
- Token deltas as they happen, no polling.
- OS-portable — no special-case path logic.
- The session id arrives in-band: Claude's stream-json emits a `system` event at the start of each turn containing `session_id`.

If the entity crashes mid-turn we mark the turn `interrupted` and lose only our event-log record of the in-flight tokens. The CLI's own session file is still on disk; the next prompt resumes correctly via `claude --resume <id>`. **Crucially, any file changes the agent already made during the lost turn are still on disk** — the workspace state is preserved.

Pre-existing terminal-session import is a separate one-shot operation that uses `agent-session-protocol`'s `loadSession` once; not on the hot path.

### IDE bridge

We use the **Claude Code IDE bridge protocol** — same WebSocket-based MCP variant the official VS Code/JetBrains extensions use, reverse-engineered and documented in [claudecode.nvim/PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md). Reference Lua implementation at `../claudecode-nvim/`.

**How it works:**

1. The entity boots a WebSocket server on `127.0.0.1:<random-port-10000-65535>`.
2. Writes `~/.claude/ide/<port>.lock` (user-state dir, not the workspace) containing `pid`, `workspaceFolders` (the env's worktree path), `ideName: "domo"`, `transport: "ws"`, and a random `authToken`.
3. Spawns the CLI with `CLAUDE_CODE_SSE_PORT=<port>` and `ENABLE_IDE_INTEGRATION=true`. The CLI reads the lock file and connects.
4. Editor-tool calls (Edit, Write, openFile, selections, diagnostics) route through our WebSocket server.

**The 12 IDE bridge tools** (8 we implement for v1):

| Tool | Purpose | v1 priority |
|------|---------|-------------|
| **`openDiff`** | Blocking approval channel for file edits. Render diff, respond `FILE_SAVED` or `DIFF_REJECTED`. No timeout. | **Required** |
| `openFile` | Open a file in our editor, optionally selecting a range | Required (basic) |
| `getCurrentSelection` | Current text selection in the active editor pane | Required (basic) |
| `getLatestSelection` | Most recent selection | Required |
| `getOpenEditors` | Currently open files | Required |
| `getWorkspaceFolders` | Workspace folders | Required (trivial — we know at spawn) |
| `getDiagnostics` | LSP / language diagnostics | Optional v1 — return empty |
| `checkDocumentDirty` | Has unsaved changes? | Required |
| `saveDocument` | Save a file | Required |
| `close_tab` | Close a tab by name | Optional |
| `closeAllDiffTabs` | Close all open diff tabs | Required (paired with `openDiff` cleanup) |
| `executeCode` | Jupyter kernel exec | Skip — out of scope |

**Bonus integrations** the bridge gives us for free: `selection_changed` and `at_mentioned` notifications (IDE→CLI) so the agent has live editor context.

**For tools without a bridge entry** (Bash, MultiEdit, etc.): we launch with `--permission-mode acceptEdits`. Edit/Write are reviewed via `openDiff` regardless; Bash auto-runs and we render the command + stdout/stderr in the chat UI for visibility. Post-v1 we may add a custom MCP `domo_safe_bash` for explicit gating.

#### Fallback: `--permission-prompt-tool` via custom MCP

If the IDE-bridge connection proves unreliable in practice, the same diff-approval semantics can be reached via Claude's `--permission-prompt-tool <name>` flag plus a custom MCP server exposing an `approval_prompt(tool_name, input, tool_use_id)` tool. Returning `{ behavior: "allow", updatedInput }` lets the tool run; returning `{ behavior: "deny", message }` blocks it. This pattern is implemented in andrepimenta's [claude-code-chat](https://github.com/andrepimenta/claude-code-chat) VS Code extension (`claude-code-chat-permissions-mcp/`), where the MCP server watches a request/response file pair and the extension's UI fills the response. We keep this as a backup; the IDE bridge remains primary because `openDiff` gives us the structured diff payload directly.

#### Smoke test findings (Phase 0)

The Phase 0 smoke script (`smoke/ide-bridge.mjs`) verified:

- `claude -p --input-format stream-json --output-format stream-json --permission-mode acceptEdits` emits a clean event stream on stdout (`system` init → `assistant` text/tool_use → `user` tool_result → `result`).
- The `system` init event reports `apiKeySource: "none"` when `ANTHROPIC_API_KEY` is scrubbed from the spawn env — confirming subscription / `~/.claude` keychain auth.
- Tool calls (`Edit`, `Write`, `Read`, `Bash`, etc.) appear in stream-json with full input args (`file_path`, `old_string`, `new_string`, …) **before** the CLI applies them, so we can intercept structurally even without the bridge.
- Bridge connection from a nested `claude` session (spawning `claude` from inside another `claude`) did not fire even with `--ide`, `CLAUDE_CODE_SSE_PORT`, `ENABLE_IDE_INTEGRATION=true`, `FORCE_CODE_TERMINAL=true`, and a properly-formatted lock file. The bridge protocol itself (lock file shape, `x-claude-code-ide-authorization` header, MCP-over-WebSocket message shape) is documented in `claudecode.nvim/PROTOCOL.md` and we will validate it from a standalone Nuxt server process in Phase 3, not from a nested-CLI smoke.

### Subscription billing & credential isolation

- **Always strip `ANTHROPIC_API_KEY`** from the spawned CLI's env. If the user has it set in their shell for unrelated reasons, both the CLI and SDK silently prefer it over OAuth — a documented footgun.
- Auth via the user's existing `~/.claude` keychain (implicit; user logs in once with the regular `claude` CLI on the host) or `CLAUDE_CODE_OAUTH_TOKEN` (explicit).
- Optionally set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` to harden against prompt-injection siphoning credentials out of subprocesses.

### Reconciling Claude's session file with the durable stream

Two append-only logs, different things:

| | Claude session file | Durable Session stream |
|---|---|---|
| **Owner** | The CLI | Domo / Electric Agents |
| **Contents** | Canonical conversation as Claude will see it on `--resume` | Everything around it: per-token chunks, presence, agent registration, UI state (approvals, focus), pending diffs, audit events |
| **Mutability** | Append-only; "edits" produce a forked session | Append-only; forks are first-class |
| **Source of truth for…** | "What will Claude see when we resume?" | "What did the room observe while this session ran?" |

When the CLI emits a finalized event (a complete message, a tool result), the entity writes a corresponding **structured event** into the durable stream — not byte-for-byte, but richer and UI-shaped, tagged with the corresponding Claude session offset so we can cross-walk back.

If the user "edits" a past message, we fork the Claude session and branch the Durable Stream — the stream's branch points back at its parent offset.

## Where claude runs (pending decision)

**Two options. The right call depends on a smoke test we should run as one of the first implementation steps.** Both keep the Electric Agents entity + IDE bridge architecture intact; they differ only in *where* the `claude` process lives.

### Option A — Host-side (matches Coast's own recommendation)

`claude` runs on the **VPS host** (the same machine as Domo and the Coast daemon).

- The worktree is on the host filesystem at `<project_root>/.worktrees/<env-name>` (Coast's filesystem-sharing model: same bytes both sides).
- For runtime tasks (tests, migrations, anything that needs the inner stack), Claude uses **`coast exec <env> -- <cmd>`** via its Bash tool.
- The IDE bridge WS, lock file, and stream-json subprocess all live on the host where Domo runs — no cross-container networking.
- Credentials stay in the host's `~/.claude` keychain. Nothing to mount.

**Pros:** simplest architecture; matches Coast's documented model; no OAuth concerns; the failure-mode docs ("a bind that fails", "the env is gone") become moot because we never had to cross a container boundary. We also keep the existing IDE bridge design intact.

**Cons:** the agent has to *remember* to use `coast exec` for runtime tasks. This is solvable: at env creation Domo writes a Domo-specific Coast skill into the worktree's `CLAUDE.md` / `.claude/skills/` (using the content from `coast skills-prompt`), which gives Claude the "run `coast lookup` first; use `coast exec` for runtime" rules. Coast designed this exact workflow for host-side agents.

### Option B — In-coast (the user's leaning UX)

`claude` runs **inside the env's DinD container**, with the worktree at `/workspace` and `~/.claude` mounted in.

- Claude's Bash tool inside the container can run tests, migrations, etc. directly — no `coast exec` indirection.
- We spawn the CLI via `coast exec <env> -- claude -p ...` from the entity, getting stream-json on the exec's stdout and stdin.
- The IDE bridge WS server must also run inside the container (the CLI connects to `localhost:<port>` and that's container-local). The bridge runs as another in-container process; the entity drives both via two `coast exec` invocations and proxies bridge events to/from Domo through stdio.
- Coast already supports this lifecycle pattern via `[agent_shell]`, but `[agent_shell]` runs a TUI under Coast's PTY, which is the wrong shape for stream-json. We bypass `[agent_shell]` and use raw `coast exec` instead.

**Pros:** the agent's runtime environment matches the user's services exactly — no chance of "forgot to use coast exec"; less cognitive overhead for the agent and for the user reading transcripts.

**Cons (real ones):**

- **OAuth.** Coast's docs flag this explicitly: a token issued for the host machine, replayed from inside a Linux container with a different user-agent and environment, may be flagged or revoked by Anthropic, producing intermittent auth failures that are hard to debug. The Coast docs recommend API-key billing for in-container agents — which conflicts with our subscription-billing goal.
- **Credential mounting** itself adds friction. We'd bind-mount `~/.claude` (or extract from macOS Keychain into a file mount — not relevant on a Linux VPS but worth knowing). On Linux VPS this is mostly fine.
- The IDE-bridge wiring is more involved (two `coast exec` channels, stdio proxying for the WS, an extra layer to debug if anything goes wrong).
- File watchers and inotify behavior across the bind mount have well-known edge cases.

### Recommendation

**Start with Option A (host-side)** for v1. It's simpler, matches Coast's recommended pattern, sidesteps the OAuth concern, and the "agent forgets" friction is mostly a documentation/skill setup problem that Coast has already solved. We auto-install the Domo-flavored Coast skill into each env's worktree on creation.

**Revisit in-coast if** real users find the `coast exec` indirection painful enough that the OAuth risk is worth taking. The architecture leaves room: switching the spawn from `spawn('claude', ...)` to `spawn('coast', ['exec', env, '--', 'claude', ...])` plus moving the bridge WS into the container is a few hundred lines of changes, not a redesign.

**Smoke tests to do first** (build-sequence step 0):
1. Verify `claude -p --output-format stream-json --input-format stream-json` composes with `ENABLE_IDE_INTEGRATION=true` + `CLAUDE_CODE_SSE_PORT` — i.e. the CLI both connects to the bridge and emits stream-json on stdout. This is the load-bearing assumption for both options.
2. Verify `--permission-mode acceptEdits` lets Edit/Write reach the bridge's `openDiff` instead of being silently auto-applied.
3. Verify subscription billing actually routes through the bridge's `system` event "billing source" indicator on the host.

## Server routes

The backend uses **[nuxt-procedures](https://www.npmjs.com/package/nuxt-procedures)** for every request/response endpoint, and classic Nitro handlers only for streaming (SSE/WS). Procedures live under `server/procedures/`; their input AND output are Zod-validated, and a typed `apiClient` is auto-imported in the UI (`apiClient.projects.add.call(...)` / `.useCall(...)`). Superjson handles serialization for Date/Map/etc.

Multi-step flows use **discriminated-union outputs** instead of HTTP status codes — see `projects.add`, which returns `{ status: 'missing-git' }` / `{ status: 'missing-coastfile', composeDetected, suggestedName }` / `{ status: 'missing-gitignore-worktrees' }` / `{ status: 'ok', project }` and the UI re-invokes with `confirm*` flags as the user accepts each prompt.

### Procedures (request/response)

| Procedure | Purpose |
|-----------|---------|
| `health` | Smoke: SQLite + `DOMO_HOME` resolution |
| `coastSmoke` | Smoke: coastd reachability + Zod-validated `/ls` |
| `fs.browse` | Directory picker for the project-add flow |
| `projects.list` / `projects.get` / `projects.delete` | Project read/write |
| `projects.add` | Multi-step add (discriminated union) — git init / Coastfile init / `.gitignore` patch / insert |
| `envs.list` / `envs.get` | Env read (joined with coastd `/ls` / `/lookup`) |
| `envs.create` | Insert env row; status `provisioning`. Follow-up `coast run` happens via the streaming endpoint below. |
| `envs.overview` | Env screen one-shot: env row + `coast ps` services + `coast ports` |
| `envs.stop` / `envs.start` / `envs.restart` | Lifecycle (coastd `/stop`, `/start`, stop+start) |
| `envs.checkout` | Take or release the project's checkout (`id: null` = release) |
| `envs.delete` | coastd `/rm` + remove env row |
| `sessions.*` (Phase 3) | `claude-code-cli` entity create / prompt / diff-decision / abort / done / delete |
| `workspace.*` (Phase 2) | File tree / read / write, scoped to the env's worktree |
| `git.*` (Phase 2) | Status / diff / stage / unstage / commit |

### Streaming endpoints (classic Nitro)

| Route | Purpose |
|-------|---------|
| `POST /_electric/builtin-agent-handler` | Webhook entrypoint for the Electric Agents runtime; delegates to `runtime.onEnter` |
| `POST /api/projects/build` | SSE pass-through to coastd `/stream/build` |
| `POST /api/envs/run` | SSE pass-through to coastd `/stream/run` for an existing env row |
| `WS   /api/terminal?envId=…` | xterm.js terminal websocket, proxied to coastd `WS /api/v1/exec` (Phase 2) |
| `WS   /api/logs?envId=…&service=…` | Logs follow, proxied to coastd `WS /api/v1/logs` (Phase 2) |
| `WS   /api/coast-events` | Pass-through of coastd `WS /api/v1/events` (`CoastEvent`) so the SPA can drive live tree + env-screen updates without polling |

The chat UI's stream consumption is **not** a Domo route — the client subscribes directly to the entity's durable-stream URL via the Electric runtime client / TanStack DB.

All workspace and git routes resolve paths relative to the env's worktree and reject any escape (`..`, absolute paths outside the worktree, symlink traversal).

## Stack & dependencies

Borrowed from the templates:

- `nuxt`, `@nuxt/ui` (4.x), `tailwindcss` 4 — both templates.
- `shiki`, `@shikijs/langs/*` — both templates.
- `@comark/nuxt` — chat template (markdown rendering with streaming).
- `@vueuse/core` — both templates.
- `@nuxt/eslint`, `eslint`, `typescript`, `vue-tsc` — both templates.

New for domo:

- **Electric Agents stack:**
  - `@electric-ax/agents-runtime` (entity registry, `createRuntimeHandler`, `HandlerContext`)
  - `@electric-ax/agents-server` (self-hosted control plane, sidecar)
  - `@electric-ax/durable-streams-state-beta`
  - `agent-session-protocol` — **only** for the optional one-shot importer for pre-existing terminal sessions; not on the live event path.
  - `@tanstack/db` for client-side reactive collections.
- `codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-*`, `@codemirror/merge` — editor + diffs.
- `xterm`, `xterm-addon-fit` (and similar) — the terminal pane.
- `better-sqlite3` (or `libsql`) — Domo's metadata DB.
- `zod` — schema definitions.
- `chokidar` — watch the worktree for external file changes (refresh file tree, react to git operations).

**Coast** is consumed via **coastd's HTTP+SSE+WebSocket API** at `http://localhost:31415/api/v1/` — the same surface Coastguard (Coast's own web UI) uses. We do **not** depend on any Coast package; the contract is the daemon's HTTP API, which is more complete and more structured than the CLI (the CLI is itself a thin client of these routes). Three transports:

- **REST** for snapshots and actions: `/ls`, `/ports`, `/ps`, `/stop`, `/start`, `/rm`, `/checkout`, `/secrets`, `/volumes`, `/images`, `/files/*` (tree, read, write, git-status, grep), etc.
- **SSE** under `/api/v1/stream/*` for long ops: `build`, `run`, `assign`, `unassign`, `rm-build`, `remote-build`, etc. Each emits `progress` / `complete` / `error` events.
- **WebSocket** at `/api/v1/events` broadcasting a typed `CoastEvent` enum: `instance.{created,started,stopped,assigned,status_changed,checked_out,…}`, `build.{started,completed,failed}`, `service.*`, `port.{primary,health}_changed`, `docker.status_changed`, etc. This is the live state-change stream the left-rail tree and env screen subscribe to — no polling.

The `coast` CLI binary stays installed on the host (`coast doctor`, `coast daemon install`, `coast --version` for version pinning) but Domo does not shell out to it on the hot path. We document the minimum supported Coast version and verify it at startup by hitting a versioned endpoint or reading the daemon's reported version.

Coast's source ships `ts-rs`-generated TypeScript bindings for every request/response type; we vendor the relevant `.ts` files (or regenerate them against a pinned Coast tag) so `lib/coast.ts` is fully typed.

Trimmed / not used yet (vs the earlier draft):

- The Docker engine API integration / Caddy ingress / per-env compose orchestration code — Coast does all of this. (Dropped for good.)
- **AI SDK runtime (`@ai-sdk/*`), AI Gateway, Anthropic/OpenAI/Google providers — not used in v1**, which talks to Claude only through the Claude Code CLI via the custom entity. This is *not* a permanent rejection: the AI SDK's `UIMessage` shape is now our canonical UI transcript (Decided #17) and `ai` is installed as a **types-only devDependency**; if/when we add other custom agent backends (opencode/Horton-style, which implement against the `ai` package), we expect to pull in the AI SDK runtime for those adapters. The claude-cli adapter just doesn't need it.
- `nuxt-auth-utils`, `@nuxthub/core`, `nuxt-charts`, `nuxt-csurf`, `drizzle-orm`, `@libsql/client`, `@vercel/blob`, `striptags`, `motion-v` — out of scope for v1.
- `@tiptap/*`, `tiptap-extension-code-block-shiki` — deferred. Plan to add `UEditor` back later as an optional WYSIWYG mode for markdown only.
- `y-partykit`, `yjs` — out of scope; not building real-time collab in v1.

## Build sequence

A pragmatic order:

0. **Smoke tests** (one-off scripts; not Nuxt yet):
   - Verify `claude -p --output-format stream-json --input-format stream-json` composes with `ENABLE_IDE_INTEGRATION=true` + `CLAUDE_CODE_SSE_PORT`. Write a stub WS server; confirm the CLI connects, the lock file is read, and stream-json flows on stdout.
   - Verify `--permission-mode acceptEdits` lets Edit/Write reach the bridge's `openDiff`.
   - Confirm subscription billing routes correctly (system event "billing source" indicator; verify against the user's account).
1. **Skeleton.** New Nuxt app, Nuxt UI, Tailwind, three-panel shell. SQLite + Drizzle (or `better-sqlite3` direct) for the metadata DB.
2. **Coast adapter (server-side).** `lib/coast.ts` wraps coastd's HTTP/SSE/WS API at `localhost:31415/api/v1/`: typed REST clients for `/ls`, `/ports`, `/ps`, `/run` (SSE), `/assign` (SSE), `/build` (SSE), `/stop`, `/start`, `/rm`, `/checkout`, `/exec` (WS), `/logs` (WS), `/files/*`; plus a WebSocket subscriber for `/api/v1/events` (`CoastEvent`) that broadcasts state changes into Domo's UI without polling. Reuse Coast's `ts-rs`-generated TypeScript bindings (vendored or regenerated from a pinned tag). Smoke-test against a real Coastfile.
3. **Project setup flow.** Add-project UI with the git-init / Coastfile-init prompts. `coast build` integration with progress UI.
4. **Env creation + env screen.** Create-env form, env list, env overview (services, ports, branch, worktree, lifecycle buttons). Live status via cached + periodic `coast ls` polls.
5. **Workspace surface.** File tree, CodeMirror viewer (read-only first, then editable), markdown via Comark.
6. **Terminal pane.** xterm.js ↔ websocket ↔ `coast exec <env>` interactive shell.
7. **Git changes pane.** `git status` → staged/unstaged lists; per-file diff using the CodeMirror merge component; stage/unstage/commit/push.
8. **Electric Agents bring-up.** Run `@electric-ax/agents-server` as a sidecar; mount `/_electric/builtin-agent-handler`; define and register the `claude-code-cli` entity (host-side spawn variant per [Where claude runs](#where-claude-runs-pending-decision)). Implement the 8 required IDE bridge tools, with `openDiff` wired to the workspace surface.
9. **Chat surface.** Subscribe to the entity's durable stream; project events into `UIMessage.parts`; reuse `UChatMessages`. Implement the tool renderers (Read/Edit/Write/Bash/TodoWrite, generic fallback).
10. **Session lifecycle UI.** Status indicators (active/waiting/pending-approval/error), new-output dot, mark-done + show-done toggle.
11. **Diff approval round-trip.** `openDiff` parks → `pendingDiffs` row → chat tool card + workspace `diff` view → user accept/reject → inbox `diff_decision` → bridge resolves → events_insert the result.
12. **Polish.** Aborts, keyboard shortcuts, dark mode, error states, loading skeletons, responsive mobile layout.

## Public documentation (deliverable)

Domo is self-hosted, so installing/operating it is part of the product. Docs live in `domo/docs/site/` as portable markdown.

Pages we know we'll need:

- **Getting started (VPS).** Five-minute path: prereqs (Docker, Coasts installed, Node, `socat`, `claude` logged in once on the host), install Domo, expose via Tailscale/Cloudflare Tunnel, add a project, create an env, send a first prompt.
- **Concepts.** Project / Environment / Session hierarchy; relationship to Coasts (env = Coast instance + worktree); why we don't have our own auth in v1.
- **Working with projects.** Add, init git, init Coastfile, edit Coastfile, validate (`coast build`), remove.
- **Working with environments.** Create, branch+worktree naming convention (`.worktrees/<name>`), start/stop/checkout/delete, services and ports, opening a service URL in the browser, logs.
- **Working with sessions.** Chat UX, diff approval flow, multi-session-per-env (filesystem-sharing implications), done/undone, abort.
- **Securing your Domo install.** Tailscale, Cloudflare Tunnel, putting Caddy with basic auth or OIDC in front, IP firewalls. Explicitly: **v1 has no auth**.
- **Subscription billing & credentials.** How `claude` CLI subscription auth flows (host-side login once, `~/.claude` keychain, stripping `ANTHROPIC_API_KEY`).
- **Exposing dev servers.** Coast dynamic ports vs canonical via `checkout`; how to make a per-env URL reachable from the user's browser through Tailscale/Tunnel/Caddy.
- **Troubleshooting.** `coast build` fails, env stuck `provisioning`, `claude` not authenticating, port not reachable.
- **Reference.** Coastfile minimum schema we expect, Domo's env vars, the `.worktrees` gitignore convention, supported Coast versions.

Every implementation step that lands in `domo/` should land its corresponding doc page in the same change. No "ship now, document later" trap.

## Decisions and open questions

### Decided

1. **Coasts owns env isolation.** No homegrown compose / Docker / Caddy / port-management code.
2. **VPS-first deployment.** Self-hosted on the user's VPS (or laptop). No managed offering.
3. **No auth in v1.** User secures via Tailscale, Cloudflare Tunnel, an auth-proxy, or a private network.
4. **One Coast instance per env, one worktree per env, multiple sessions per env.** Sessions share the env's worktree filesystem; we surface concurrent-edit signals via the bridge but don't prevent collisions.
5. **Worktrees at `<project_root>/.worktrees/<env-name>`.** Coast's default; project-relative; require `.worktrees` in `.gitignore`.
6. **Project add requires git + Coastfile.** Prompt to init either if missing; cancel aborts.
7. **Stdout `stream-json` is the only runtime event source** (file-tailing only used by the one-shot importer).
8. **IDE bridge is the approval channel.** `openDiff` is the blocking call for edits; we implement the 8 required bridge tools.
9. **Always strip `ANTHROPIC_API_KEY` from the spawned CLI.**
10. **Electric Agents owns the durable session stream.** Domo's SQLite owns the project/env/session metadata + the done flag.
11. **`claude` runs host-side (Option A) for v1.** Was Pending 1; decided during Phase 3 — simplest, matches Coast's model, sidesteps OAuth. Revisit in-coast only if `coast exec` friction outweighs the OAuth risk.
12. **agents-server requires Postgres; runs via docker-compose.** Implementation surfaced that `@electric-ax/agents-server` mandates a Postgres `DATABASE_URL` (throws without it) — contrary to the earlier "just a sidecar process" framing. Durable streams run **embedded** (no separate Electric sync service; local `STREAMS_DATA_DIR`). Footprint: `docker-compose.yml` runs Postgres + agents-server (decoupled from Nuxt's HMR lifecycle); agents-server auto-migrates Postgres on boot. See [Session runtime](#session-runtime-electric-agents-with-the-claude-code-cli-entity).
13. **Wake delivery is pull-wake, not the push webhook.** The runtime opens a long-lived pull-wake stream to agents-server (`createPullWakeRunner`) instead of agents-server POSTing to a `/_electric/builtin-agent-handler` Nitro route. Matches Electric's own `packages/agents` reference; avoids inbound-webhook/loopback hassle on a single self-hosted box; latency ≈ webhook (held-open stream, not interval polling). `createRuntimeHandler` still exposes `onEnter`/`handleWebhookRequest`, so the push webhook stays a drop-in alternative.
14. **Domo metadata stays in SQLite — NOT consolidated onto agents-server's Postgres.** That Postgres is agents-server's control-plane store (durable-stream/entity/wake registry, scheduler); sharing it would couple Domo's metadata lifecycle + failure domain to agents-server and force a large async-`pg` refactor of working Phase 0–2 code for no user benefit. If ever consolidated (post-v1): same Postgres *server*, separate database — never shared tables.
15. **IDE bridge is a standalone per-session `node:http` RFC 6455 server — NOT Nitro/crossws.** Was a Phase 3 step-8c fork. Nitro's WS support (`defineWebSocketHandler`/crossws) runs on the *single app HTTP listener* — fine for browser↔Domo channels (`/api/terminal`, `/api/coast-events`) but structurally wrong for the bridge: the `claude` child discovers the server itself via `~/.claude/ide/<port>.lock` + `CLAUDE_CODE_SSE_PORT` and connects to `ws://127.0.0.1:<port>/` (root path, no session id). Lock files are named `<port>.lock` and one carries one `authToken`, so parallel sessions need *distinct ephemeral ports* (⇒ multiple localhost listeners we spin up/tear down per turn), and there's no path/token escape hatch to multiplex onto Nitro's one port. Within "manage our own server," we hand-roll a minimal RFC 6455 server (`server/lib/electric/bridge.ts`) over adding `ws` or `crossws/adapters/node`: the protocol surface is tiny (one trusted localhost client, text frames, no compression), `../claudecode.nvim/lua/claudecode/server/` proves the exact framing against real `claude`, and it adds zero dependencies (consistent with the `@durable-streams` supply-chain-minimization call, Decided #12 era).

16. **Session entities spawn with an explicit per-entity runner dispatch policy; no type-level default.** Surfaced in Phase 3 step 8d. agents-server resolves a wake's effective dispatch policy as `entity.dispatch_policy ?? parent ?? entity-type.default_dispatch_policy` with **no** implicit "route to any enabled local runner" fallback (`agents-server/src/routing/dispatch-policy.ts`; an entity with no resolvable target gets no wake subscription linked, so its turns hang silently). We deliberately do **not** register a type-level `default_dispatch_policy` for `claude-code-cli` — matching electric-source's builtin-agents, which keeps the same entity type servable by other runtimes (`agents/test/builtin-pull-wake-registration.test.ts` asserts the local pull-wake runner is *not* a type default). Instead `sessions.create` passes `dispatch_policy: { targets: [{ type: 'runner', runnerId }] }` on every spawn, routing that session's wakes to Domo's in-process pull-wake runner. Recipe verified against `agents-server/test/horton-pull-wake-e2e.test.ts` and then **live end-to-end in Domo** (8d smoke: spawn → agents-server entity carries `dispatch_policy {runner: domo-runtime}` → `sessions.prompt` → wake claimed by the pull-wake runner → handler ran host `claude` → events mirrored, `apiKeySource: none`). Corollary: `startElectricRuntime()` must call `runtime.registerTypes()` on boot (control-plane POST `/_electric/entity-types`) — `registry.define` alone is in-process only and `spawnEntity` 404s without it. agents-server maps a `/send` body's `type` field onto the inbox row's `message_type`, which the entity handler branches on (`prompt` / `diff_decision` / `abort`).

17. **The UI transcript is standardized on the AI SDK `UIMessage` shape; each agent backend is an adapter.** Surfaced in Phase 3 step 9. `@nuxt/ui`'s `UChatMessages`/`UChatMessage`/`UChatPromptSubmit` type-couple to `import type … from 'ai'`, and `ai` is only a *devDependency* of `@nuxt/ui` (not installed for consumers) — so the original "reuse UChat\* wholesale, just swap the transport" plan needed a decision. We resolve it *toward* standardization (the user's call, anticipating future non-claude agents — opencode/Horton-style — implemented via the `ai` package): the canonical UI message vocabulary **is** AI SDK `UIMessage` (`{id, role, parts[]}`); every backend is an adapter that produces it. `ai` is installed as a **types-only devDependency** — we don't use the AI SDK *runtime* (`Chat`/transport/providers) yet because the claude-cli adapter doesn't need it (Claude is driven via the CLI entity), but this is explicitly *not* a rejection: a future `ai`-package-based backend would pull in the runtime for its own adapter. For now, do not import runtime values from `ai` in app code (type-only `import type` is fine). For claude-cli the projection is **per-adapter, client-side** (`app/utils/sessionMessages.ts`): the durable stream stays the rich *native* claude stream-json log; `projectSessionMessages` folds it into `UIMessage[]` (text→text, thinking→reasoning, tool_use→`dynamic-tool` patched to `output-available` on the matching `tool_result`). A future `ai`-based entity can emit `UIMessage`-shaped events directly; the only shared contract is "the UI consumes `UIMessage[]`." We do **not** couple the durable-stream schema to the AI SDK (rejected: entity emitting `UIMessage` server-side). Verified live end-to-end in the step-9 smoke (user prompt → `Read` tool card → assistant text, 0 console errors).

### Pending

1. ~~**Where `claude` runs — host-side vs in-coast.**~~ **Decided** → see Decided #11. (Detail retained in [Where claude runs](#where-claude-runs-pending-decision) for the in-coast revisit path.)
2. **Whether to auto-install a Domo-flavored Coast skill into the worktree on env creation.** If host-side (recommendation), yes — otherwise the agent will fight the `coast exec` requirement. The skill content is essentially `coast skills-prompt` plus a Domo-specific framing. Decide which exact files (`CLAUDE.md` vs `.claude/skills/coasts/SKILL.md`) to write, and whether to merge into existing files non-destructively.
3. **Coastfile init heuristics.** What does Domo write when the user picks "init Coastfile"? A minimal `[coast] name = …` + best-effort `compose = "./docker-compose.yml"` if a compose file is detected, plus an empty `[ports]`. Whether we surface Coast's `installation-prompt` content to the user as a "let your agent finish this" handoff.
4. **Coast version pinning / version check.** Which Coast versions we test against; what we do if the user's `coast` is too old.
5. **How aggressively we cache `coast ls` / `coast ps`.** Polling vs `coastd` events (the daemon streams runtime events to clients; we may be able to subscribe instead of polling).
6. **Multi-user / auth design.** Deferred. Likely shape: pluggable (passcode, OIDC, header-trust for reverse-proxy auth) plus per-user Electric Agents actors. Out of v1 scope.
7. **Mobile app.** Capacitor wrapper of the responsive web UI, with native push and biometric unlock. Post-v1.
8. **No-remote projects.** Currently we assume the user already has the project on the VPS. Cloning from a remote inside Domo is post-v1.
9. **Concurrent-edit conflict surfacing within an env.** What the UI shows when two sessions touch the same file. Lightweight badge in v1; soft locks later if needed.
10. **Whether `coast ls --json` exists** (or we have to parse the table). We treat the CLI as the contract; if a JSON flag is missing we contribute it upstream or wrap with structured parsing.

## Pending discussions for next session

1. ~~**Wire-level shape for the `claude-code-cli` entity.**~~ **Resolved** (Phase 3 step 8). Locked in `server/lib/electric/schemas.ts`: `eventRowSchema` `{ key, ts, type, callId?, payload }` (`payload` is `z.looseObject({})` — `z.record` emits JSON-Schema `propertyNames` which agents-server's validator rejects); `pendingDiffRowSchema` keyed by `callId`; `diff_decision` inbox carries `{ callId, decision }` referencing the parked `openDiff` by `callId`. Also `sessionMetaRowSchema` (singleton `current`) + `inboxStateRowSchema` (stream-json replaces the reference entity's file-tailing cursor).

2. **Where Domo writes its data dir** (default `~/.domo/`) — DB, logs, optional state for resumed-after-restart things; whether we expose this via an env var; whether the multi-user redesign would require schema changes here.

3. **Service-URL UX inside Domo.** "Open the env's web service" is the most common in-loop action. Where does the clickable URL surface (env screen, session header, terminal pane)? Do we open a new tab, or proxy through Domo's own origin to keep cookies sane? (Probably new tab.)
