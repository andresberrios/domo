# Domo — Design

Authoritative forward design. **Living document** — when implementation
surfaces a decision, a contradicted assumption, or a scope change,
update this doc (and `project-context.md` if the high-level framing
shifts, `tasks.md` for tracking) in the *same* change.

Pre-2026-05 implementation (Electric Agents session engine + Coast
environments) shipped but is being **replaced**; that history and its
resolved gotchas live in [`history.md`](./history.md).

## What Domo is

A single self-hosted Nuxt app (server + web UI) the user runs on a VPS
or laptop to drive parallel **Claude Code CLI** agents over isolated dev
environments. Three surfaces share one workspace:

1. **Chat** — one or more `claude` sessions per environment.
2. **Workspace** — browse/read/edit the env's worktree, review agent
   diffs, stage/commit (host-side files + `git`).
3. **Environment** — control the per-env container: services, ports,
   lifecycle.

Coordinated by a left-rail tree: **Project → Environment → Session**.
Sessions outlive environments and stay readable after teardown.

## Architecture (target)

```
┌── User's VPS / laptop ───────────────────────────────────────────────┐
│  ┌── Domo (one Nuxt process) ───────────────────────────────────┐    │
│  │ app/    SPA (ssr:false): shell, chat, workspace, terminal     │    │
│  │ server/ Nitro:                                                │    │
│  │   procedures/  projects · envs · sessions · workspace · git   │    │
│  │   api/live     one SSE: change-bus + chat seq-tail            │    │
│  │   api/terminal WS → docker exec                               │    │
│  │   lib/ db (better-sqlite3: metadata + session_events log)     │    │
│  │        sessionEngine (single-flight per-session `claude`,     │    │
│  │                       spawned via `docker exec`)              │    │
│  │        changeBus · portForwarder · devcontainer client        │    │
│  └───────┬───────────────────────────────┬──────────────────────┘    │
│          │ docker exec claude             │ devcontainer up/exec      │
│          ▼                                ▼                           │
│   host worktree            ┌── env dev container (rootless DinD) ──┐  │
│   <root>/.worktrees/<env>  │ /workspace = host worktree bind mount │  │
│   <DOMO_HOME>/claude-home/ │ ~/.claude  = shared per-user bind mt  │  │
│     <userId>/ (shared OAuth│ claude CLI (devcontainer Feature)     │  │
│      + MCP across envs)    │ user's `docker compose` (inner)       │  │
│                            │ -p 127.0.0.1:0:<inner> per fwd port   │  │
│                            └───────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

No agents-server, no Postgres, no durable-stream sidecar, no coastd. The
session engine, the event log, and reactivity are **in-process over the
existing SQLite**. Environments are devcontainers the app drives via
`@devcontainers/cli`.

Binds **localhost-only by default** (`bin/domo` sets `HOST`/`NITRO_HOST`
from `DOMO_BIND`, default `127.0.0.1`). Remote access is the user's
choice (Tailscale / Cloudflare Tunnel / VPN / auth-proxy). SPA-style:
`routeRules: { '/**': { ssr: false } }`; Nitro serves procedures + SSE/WS
+ the per-env TCP forwarders.

## Session engine (own, in-process)

A **long-lived per-session `claude` process**, owned by a single-flight
per-session manager (`server/lib/sessionEngine/{engine,claude,store}.ts`,
landed in step 1). `Map<sessionId, { proc, queue, steer, diffWaiters }>`.
One persistent process serves all turns of a session over one stdin
(turns demuxed by the `result` envelope), idle-reaped (~15 min → close
stdin → clean exit → next prompt respawns with `--resume`). This is
**behavioral fidelity to the official VS Code extension** (which keeps
one process per panel) — not just convenience: spawning hundreds of
short-lived `claude-vscode` clients is exactly what Anthropic telemetry
could flag as spoofing. Spike-proven viable
(`smoke/persistent-session-spike.mjs`: one process, multi-turn, context
continuity, clean exit). The deadline-critical billing live-verify of
this on the new engine is tasks.md step 7 — **still pending**.

- **Durable transcript = SQLite.** `session_events(session_id, seq,
  type, payload, created_at)`, monotonic `seq` per session, in the
  existing `state.db`. This *is* the log — append is atomic, no external
  store, no intermediary to desync.
- **Spawn mirrors the official VS Code 2.1.142 extension EXACTLY (no
  `-p`) — this is a billing requirement, not a style choice (Decided
  #3).** Set `CLAUDE_CODE_ENTRYPOINT=claude-vscode` (scrubbed for
  nested-claude hygiene, then re-pinned) and pass the extension's exact
  argv: `--output-format stream-json --verbose --input-format
  stream-json --max-thinking-tokens 31999 --permission-prompt-tool
  stdio [--resume <id>] --setting-sources=user,project,local
  [--permission-mode <default|acceptEdits> | omit for passthrough]
  --include-partial-messages --debug --debug-to-stderr
  --enable-auth-status --no-chrome --replay-user-messages`.
  `ANTHROPIC_API_KEY` scrubbed; first `system` event's `session_id`
  persisted for `--resume`. `--include-partial-messages` emits
  incremental `stream_event` deltas → throttled (~10 Hz) into
  **live-only** `partial` frames on the change bus (NOT persisted), so
  the chat renders text/thinking as it streams without touching the
  durable log; the complete `assistant` event arrives as its own
  durable row and supersedes the partial bubble in the adapter (joined
  by Anthropic `message.id`). A reconnecting browser that missed a
  partial just doesn't see it until the next flush or the final
  `assistant` row — partials are transient by design.
- **Side-channels stay in-process** (they already are): edit approval
  (`--permission-prompt-tool stdio` → non-edit auto-allow, edit-family →
  durable `pending_diffs` row + approval card, resolved by
  `sessions.diffDecision` against the live child) and mid-turn steering
  (`--replay-user-messages`, message to the child's stdin, durable
  `steer_sent` event). No runner means no deadlock concern — these get
  *simpler*, not just smaller.
- **Restart semantics — no corruption mode.** On boot no children are
  live (the process died); every transcript is intact in SQLite. One
  reconcile pass: any turn still `running` → mark `interrupted`,
  auto-reject its `pending` diff rows, the next prompt resumes via
  `claude --resume`. There is no external stateful service whose memory
  can diverge from durable state, so the entire corrupted-session class
  the Electric stack had **does not exist** here.

## Reactivity (one spine)

Single in-process **change bus** + one auth-gated SSE replaces the four
mechanisms the old stack used (durable stream + coast WS + 4 s rail poll
+ build/run SSE).

- Every DB mutation funnels through `server/lib/*`; a single post-write
  chokepoint emits `{ table, id, op }`. Wired through every helper-layer
  insert/update/delete in `lib/{sessions,envs,projects}.ts` — including
  the engine's per-turn `updateSession` for status + `lastEventAt`.
- `GET /api/live` — one auth-gated SSE per browser tab; the browser
  singleton `app/composables/liveBus.ts` owns the single connection and
  refocuses it on `focusSession(id)`. `?sessionId=` is optional —
  omit it on pages with no chat and the connection carries only the
  coarse channel.
- **Coarse path:** low-frequency UI (sessions list, env status, port
  toggles, new-output dots) → `table-change` notification → re-`.call()`
  the affected procedure via `useLiveRefresh(refresh, { tables })`
  (150 ms trailing debounce). Reads stay through procedures, so Zod +
  superjson + per-user auth filtering are unchanged. The rail's
  polling tick is deleted.
- **Fine path (chat) — two SSE event types:**
  - `session-event` — every durable `session_events` INSERT (no
    UPDATEs). Emits `{ session_id, seq }`; the open transcript appends
    rows past `lastSeq`. Reconnect with `?since=<lastSeq>`
    (+ one idempotent refetch of live queries). Seq-cursored +
    idempotent ⇒ no missed-update corruption.
  - `partial` — **live-only** coalesced streaming assistant deltas
    (throttled ~10 Hz, NOT persisted). Carries `{messageId, text,
    thinking}` cumulative state. Superseded by the complete `assistant`
    row matched on `message.id`. Not replayed on reconnect — partials
    are transient by design.
- Coast-style env events fold into the bus. Build/run stay streaming-log
  SSE (genuinely a stream; fold later if worth it).

**Why not ElectricSQL.** Domo is one writer (the Nitro server), a thin
client with no replica, all reads through procedures. That invariant
deletes ~95% of Electric (logical replication, client-side SQLite,
offline optimistic writes, partial-sync shapes, the sync service /
Postgres). What's left to build is a small change-bus + invalidation —
a *generalization of the `useCoastEvents` pattern already in the
codebase*. Electric "shapes" would also make the browser read tables
directly, **bypassing the procedure auth boundary** (a regression for
multi-user, Decided #12/#13) and reintroduce a stateful sync daemon —
the exact category of thing being removed. Revisit only for
offline-local-first clients or thousand-client fan-out; Domo is neither.

## Environments (devcontainers + rootless DinD) — designed, built after the engine

Replaces Coast. The surface to replace is small: per the host-side move,
Coast was only container lifecycle + terminal exec + port exposure +
events.

- **Lifecycle:** `@devcontainers/cli` (`devcontainer up`/`exec`). The
  user brings a `devcontainer.json` (image, features, `postCreate`,
  mounts, `forwardPorts`, `portsAttributes`) → reproducible and familiar
  (same spec as VS Code devcontainers / Codespaces; **no `Domofile`** —
  the spec already covers everything we'd put in one). Worktree at
  `<root>/.worktrees/<env>` bind-mounted to `/workspace` (host-side
  files unchanged → workspace + `git` stay host-side exactly as today).
  Project-add scaffolds a starter `.devcontainer/devcontainer.json` if
  none exists (sensible base image + Domo's claude Feature + empty
  `forwardPorts`); detects `docker-compose.yml` and writes a
  compose-based devcontainer.json instead.
- **Inner Docker = rootless DinD** inside each env container so the
  user's own `docker compose` is isolated per env (not socket-mount /
  DooD, which would collide and is a security hole for multi-user).
  **Baseline:** prefer `sysbox-runc` if registered with the host Docker
  daemon, else fall back to rootless `dind`, else (with warning)
  privileged `dind`. Selected at runtime per-host, not at install.
- **Terminal:** `WS /api/terminal` becomes a `docker exec` /
  `devcontainer exec` pass-through; the client xterm frame protocol is
  unchanged.
- **`claude` runs INSIDE the env container** (via `docker exec`), not
  host-side. Delivered by a Domo-owned **devcontainer Feature**
  (`ghcr.io/<us>/devcontainer-features/claude`) that the scaffolder
  adds to `devcontainer.json` (user can opt out; user-supplied
  devcontainers must include it themselves). Pinned to the
  `CLAUDE_AGENT_SDK_VERSION` literal Domo ships against. This is
  fidelity to the VS Code Dev Containers extension, which also runs
  `claude` inside the container, and unlocks hook/CLAUDE.md/MCP
  portability with the user's project tooling.
- **Shared `~/.claude` per Domo user.** `<DOMO_HOME>/claude-home/
  <userId>/` bind-mounted into every env container's `~/.claude`. The
  user runs `claude /login` once from inside any env's terminal; the
  OAuth credential + slash-commands + MCP definitions then apply to
  every env that user opens. OAuth fingerprint stays consistent across
  envs (same image → same User-Agent / libc / OS) — sidesteps the
  cross-system token-revoke risk the Coast docs flag for host→container
  credential replay.

### Port forwarding (the mechanism)

`devcontainer.json`'s `forwardPorts` + `portsAttributes` is the
declared-port source of truth (label, protocol). **TCP-only, no HTTP
reverse-proxy, no vhost routing, no canonical env** (deferred). Users
reach services by the host port shown in the UI.

- **Declared ports:** at `devcontainer up`, Domo injects `runArgs:
  ["-p", "127.0.0.1:0:<inner>", …]` programmatically per `forwardPorts`
  entry. Docker assigns a random free host port; Domo reads it back via
  `docker port <container> <inner>` and stores it in SQLite. The UI
  lists each port as `localhost:<random>` with the `portsAttributes`
  label. Cross-platform (Linux + macOS Docker Desktop + Windows) — no
  Linux-bridge dependency.
- **"Expose externally" toggle (per port):** start/stop a small TCP
  forwarder process listening on `0.0.0.0:<chosen>` (user-picked or
  next-free) piping to `127.0.0.1:<random>`. No container recreate.
  Toggle = spawn or kill the listener.
- **Ad-hoc runtime ports** (process opened a port not in
  `forwardPorts`): a userland forwarder process on
  `127.0.0.1:<chosen>` piping to `docker exec <container> socat -
  TCP:localhost:<inner>` (same mechanism VS Code uses for its
  auto-detected ports). User adds them via the UI; auto-detection
  (polling `ss -tlnp` inside the container) is a v1.5 idea.
- **SQLite forward table** is the single source of truth:
  `{env_id, name, inner_port, protocol, host_port, mode:
  'published'|'userland', external_port|null}`. Rebuild
  published-port discovery + external listeners on boot from this table
  (stateless, idempotent — same restart-safe property as the session
  engine).
- **DinD stays single-hop.** The user's inner compose publishes to the
  env container's own netns; Domo only ever forwards host→`127.0.0.1`
  loopback (Docker's published-port plumbing handles the
  host→container leg).
- **No canonical env in v1.** Out of scope; revisit if multi-env
  stable-port UX becomes a pain point.

## UI

Three-panel UDashboard shell. Left rail = Project/Env/Session tree
(env status badge, per-session status dot + per-device new-output dot,
mark-done + show-done, context actions).
Center = one of: chat session / file editor / env overview / terminal /
empty. Center tabs are project+env-scoped, URL-driven, persisted
server-side. Right panel = Files / Git changes (hideable/expandable).
Responsive: panels swap component by breakpoint (inline `UDashboardPanel`
≥lg ↔ `USlideover` <lg; left rail = Nuxt UI mobile drawer) — the
dashboard group can't stack, so it's component-swap not CSS-hide.

Routes: `/`, `/p/:project`, `/p/:project/e/:env`,
`…/e/:env/s/:session`, `…/e/:env/f/*path`, `…/e/:env/terminal`.

**Project add** (3-step discriminated-union procedure): pick a host dir
→ git check (offer `git init`) → `devcontainer.json` check (offer to
scaffold a starter with the Domo claude Feature + sensible base; detect
a `docker-compose.yml` and offer a compose-based template). **Env
create:** name → branch + worktree `<root>/.worktrees/<name>` +
`devcontainer up` (with `-p 127.0.0.1:0:<inner>` per `forwardPorts`) →
poll ready.

## Chat surface (carried over, valid against the new engine)

Reuse Nuxt UI `UChat*` primitives. **UI transcript = AI SDK `UIMessage`
shape; each backend is an adapter** (Decided #10): `app/utils/
sessionMessages.ts` folds native stream-json events + prompts + `chat`/
`steer_sent` events → `UIMessage[]`. `ai` is a **types-only devDep** (do
not import its runtime in app code). Render: `DomoChat` (`UChatMessages`
+ sticky `UChatPrompt`) → `DomoChatMessageContent` → `DomoChatToolCard`
(per-tool, reuses `DomoDiffView`) / `DomoComark` (markdown).

Input (`DomoChatInput` + shared `DomoChatAutocomplete`): `/`
slash-command popup (16 builtins ∪ custom `<worktree>/.claude/commands/*.md`
+ user dir, project precedence) and `@`-mention popup (worktree index,
`@git-changes`, `@<sha>`, `@url`). **Expansion runs in the session
engine at execution time, not in `sessions.prompt`** — the transcript
keeps the raw text the user typed. Nav keys intercepted at
keydown-capture so they never reach `UChatPrompt`'s Enter/Esc.

**Edit approval modes** (per-session, `session.approvalMode ??
config.claude.approvalMode ?? 'manual'`, plain read — applies next turn,
no round-trip): `manual` (park every edit as a diff card), `auto`
(`--permission-mode acceptEdits`), `passthrough` (don't pass
`--permission-mode`; user's `~/.claude/settings.json` decides). Only
`manual` parks → `auto`/`passthrough` are inherently restart-safe. Diff
card reuses `DomoDiffView` (`@codemirror/merge`; split ≥md, inline
below). **Mid-turn steering** (Decided #11): sending while a turn runs
injects into the live child (queued, consumed at the next boundary;
`queued→delivered` matched by `uuid` off the `--replay-user-messages`
echo). **Edit-and-resend** pulls a past user message back into the
prompt (same session, `--resume` keeps context; true durable fork
deferred).

## Workspace surface (host-side, unchanged)

CodeMirror 6 (view/edit, `@codemirror/merge` diffs, lang by extension,
no AI). `Comark` for markdown. Files/`git` are host-side: `workspace.*`
uses `node:fs`, `git.*` shells `git -C <worktree>` on the host; every
path worktree-relative through `safeResolve` (rejects `..`, abs-outside,
symlink-out). Two diff cases: pending agent edit (approval card) and
manual review (Git changes tab) — same merge component.

## Server routes

**Procedures** (`nuxt-procedures`, Zod in+out, superjson, auto-imported
`apiClient`; multi-step flows use discriminated-union outputs):
`health`, `fs.browse`, `projects.*`, `envs.*` (incl. `envs.ports`
expose/unexpose, `envs.setCanonical`), `sessions.*`
(`create`/`list`/`get`/`prompt`/`diffDecision`/`abort`/`steer`/`rename`/
`done`/`delete`/`setApprovalMode`/`streamInfo`), `workspace.*`, `git.*`,
`auth.*` (+ `auth/admin/*`). A `defineProcedure` handler gets `{ input,
event }`; auth/admin procs use `event` for `requireUserSession`/
`requireAdmin` (others are gated by the middleware).

**Streaming/classic Nitro:** `GET /api/live` (the change-bus + chat
seq-tail SSE), `WS /api/terminal?envId=` (→ `docker exec`), the per-env
TCP forwarders (port exposure — Docker's published `-p` plumbing for
declared ports + Node net listeners piping through `docker exec socat`
for ad-hoc/external), `POST /api/projects/build` & `/api/envs/run`
(devcontainer build/up progress SSE). All
workspace/git paths reject worktree escape.

## Subscription billing & credentials (governs)

Always **strip `ANTHROPIC_API_KEY`** from the spawned `claude` env (the
CLI/SDK silently prefer it over OAuth — a footgun that flips
subscription→API billing). Optional `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`.
**`claude` runs INSIDE the env container** (via `docker exec`, see
Environments). The argv + 5 pinned env vars (`CLAUDE_CODE_ENTRYPOINT=
claude-vscode` + `MCP_CONNECTION_NONBLOCKING` + `CLAUDE_CODE_ENABLE_TASKS=0`
+ `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` + `CLAUDE_AGENT_SDK_VERSION`)
move into the `docker exec --env …` wrapping; argv mirrors the VS Code
2.1.142 extension exactly (Decided #3). Auth lives in a **shared
`~/.claude` bind-mount per Domo user** (`<DOMO_HOME>/claude-home/<userId>/`
→ container `~/.claude`); `claude /login` runs once from inside an env's
terminal and the token reuses across every env that user opens.
OAuth fingerprint stays consistent across instances (same image →
same User-Agent / libc / OS), sidestepping the host→container
replay risk. Confirmed parity target: `apiKeySource:"none"` in the
`system` event when scrubbed. `<domoHome>/config.json`
`claude.env`/`claude.extraPath` merge **before** the scrub re-applies
in the exec env (the scrub stays the final word).

## Multi-user & collaboration

**Auth — shipped (Decided #12).** `nuxt-auth-utils`, email+password
(scrypt, sealed cookie), **no email ever sent**. First app open →
`/setup` creates the admin (active, logged in); later signups →
`role=member, status=pending`, parked on `/pending` until an admin
approves at `/admin/users`. **The sealed cookie is identity-only**
(`{id,email,name}`); `role`/`status` are re-read from the `users` table
in every server guard, so approve/reject lands on the next request with
no re-login. **The real boundary is `server/middleware/auth.ts`** —
gates `/procedures/**` + Domo's `/api/*` SSE/WS, allow-lists only
bootstrap/setup/register/login/me; it must **not** gate the broad
`/api/` prefix (framework endpoints live there). Session secret
auto-managed under `$DOMO_HOME/session-secret` (operator sets nothing;
`NUXT_SESSION_PASSWORD` overrides). SPA: `useAuth()` +
`app/middleware/auth.global.ts`; `DomoAppShell` (the dashboard chrome)
mounts only for a signed-in active user so its procedures never fire
pre-auth.

**Collaboration — designed, not built (Decided #13).** A chat message
does **not** trigger the agent; only an `@agent` mention or a "Send to
agent" button does. A durable `chat` event type carries `{text,
author:{userId,userName}}`; the engine records every chat message to
`session_events` (group-visible, authored) and runs a turn only on
`@agent`/`trigger:true`, folding the un-consumed chat backlog into the
synthesized prompt (raw events stay in the transcript; trigger detection
lives in the engine, like `@`/slash expansion). Mid-turn `@agent` reuses
the steering side-channel. Identity is injected by the authenticated
procedure and trusted in-process. Single source of truth = the SQLite
event log (no separate table / channel). v1 access: any active user
participates in all sessions; per-session ACLs deferred.

## Distribution

Host-installed app + (now minimal) infra — the app is a host-side
orchestrator (spawns `claude` via `docker exec` into per-env
devcontainers, shells host `git`, reads/writes host worktrees, manages
per-Domo-user OAuth + MCP under `<DOMO_HOME>/claude-home/<userId>/`
bind-mounted into env containers), so containerising *it* would
reintroduce credential and Docker-control complexity. **The new engine
deletes the Postgres + agents-server compose stack entirely** — there
is no session-engine infra. Per-env DinD is created/owned by the app on
demand. **The pivot mostly *deletes* distribution complexity**
(it does not migrate it): gone are `release/docker-compose.yml`,
`release/Dockerfile.agents-server`, the boot-relink patch,
`scripts/apply-patches.sh`, the `@electric-ax/*`+`@durable-streams/*`
pins/overrides, and the entire restart-resume saga (`bin/domo`'s
app-only-vs-teardown dance evaporates — no infra to keep up). `bin/domo`
collapses to managing the one Nitro process (`up`/`down`/`restart` =
start/stop the app; per-env devcontainers are runtime, not `domo up`);
`install.sh` prereqs drop the infra compose (Docker is now only for
devcontainers/DinD); `build-release.sh`/`release.yml` drop the
agents-server image build, keep the tarball matrix + bundled Node.
Pieces (kept, slimmed): `scripts/install.sh` (curl|sh, OS/arch-detecting,
checksum-verified, `DOMO_LOCAL_TARBALL` for offline), `bin/domo`,
`scripts/build-release.sh`, `.github/workflows/release.yml` (tag `v*` →
matrix build + attach).
Tarballs per `{linux,darwin}-{x64,arm64}` (WSL=linux), **bundled Node**
(no system Node req). All data under `$DOMO_HOME` (`state.db`,
`app/<ver>`+`current`, run/). Host reqs: Docker (+ a rootless-DinD-capable
setup), git, the logged-in `claude` CLI. Canonical port **7575**,
`127.0.0.1` by default (`DOMO_BIND=0.0.0.0` to widen). Last shipped
release on the *old* stack is **v0.3.0** (history.md); the next release
line ships the new engine. CI-runner reality: `darwin-x64` on
`macos-15-intel` (last x86_64 macOS image, until 2027-08).

## Decisions

### Still governing

1. **Self-hosted only, no managed offering.** FSL-1.1-ALv2 blocks
   competing managed use; a future first-party SaaS stays possible.
2. **Localhost-bind by default**; user owns remote exposure.
3. **Subscription billing — spawn `claude` exactly like the official VS
   Code 2.1.142 extension (deadline-critical, ~2026-06-15).** Post-
   2026-06-15 (Anthropic support 15036540) the `-p`/Agent-SDK path drops
   off the full subscription onto a small capped credit; interactive
   (no `-p`) stays on the subscription. The classifier reads the
   outbound `x-anthropic-billing-header cc_entrypoint=`, derived from
   `CLAUDE_CODE_ENTRYPOINT` (preserved if set, else forced `sdk-cli`).
   So: set `CLAUDE_CODE_ENTRYPOINT=claude-vscode` (Domo's scrub strips
   it for nested-claude hygiene → must re-pin after), pass the
   extension's exact argv **without `-p`** (`-p` is a billing/lifecycle
   red herring — spike-proven, `smoke/no-print-lifecycle-spike.mjs`),
   and run a long-lived per-session process (fidelity, not spoofing —
   see Session engine). Always strip `ANTHROPIC_API_KEY` (the CLI
   silently prefers it → flips subscription→API billing) + optional
   subprocess scrub. **`claude` runs INSIDE the env container** (via
   `docker exec`, post step-3); same VS Code Dev Containers extension
   behavior. Memory: `project-agent-sdk-billing`.
4. **Stdout `stream-json` is the only runtime event source.** No file
   tailing.
5. **`--permission-prompt-tool stdio`** (part of the extension argv,
   Decided #3) is the edit-approval mechanism (CLI applies the file on
   allow; Domo never writes in the live path; bridge `openDiff` is
   dead). Per-session approval modes drive `--permission-mode`:
   `manual`→`default` (ask → diff card), `auto`→`acceptEdits`,
   `passthrough`→omit the flag (user's `~/.claude` decides); resolved by
   a plain DB+config read each turn (no round-trip; restart-safe).
6. **SQLite owns everything** — project/env/session metadata, the
   `session_events` transcript log, the port-forward table, settings,
   users. One file under `$DOMO_HOME`.
7. **Own in-process session engine** — single-flight per-session
   manager + SQLite event log + `claude --resume`. A **long-lived
   per-session process** (one process serves all turns; idle-reaped) —
   matches the VS Code extension's one-process-per-panel (billing
   fidelity, Decided #3) and is spike-proven
   (`smoke/persistent-session-spike.mjs`); spawn-per-turn is the
   interim. Replaces Electric Agents; removes the stateful-intermediary
   corruption class. Restart = one SQLite reconcile pass.
8. **Unified reactivity** — one change bus + one `/api/live` SSE +
   procedure-refetch (coarse) / seq-tail (chat). Replaces durable-stream
   + coast WS + rail poll. **ElectricSQL rejected** (single-writer /
   thin-client / reads-through-procedures makes ~95% of it dead weight;
   it would bypass the procedure auth boundary and re-add a stateful
   sync daemon).
9. **Environments = devcontainers + rootless DinD; `claude` runs inside
   the env container via a devcontainer Feature; shared `~/.claude`
   per Domo user.** `devcontainer.json` is the single source of truth
   (`forwardPorts`/`portsAttributes` replace the earlier `Domofile`).
   Port forwarding is TCP-only and cross-platform: each declared port
   is published `-p 127.0.0.1:0:<inner>` (random host port shown in the
   UI); ad-hoc runtime ports use a userland forwarder through `docker
   exec` (same mechanism VS Code uses); an **"expose externally"
   toggle** spawns/kills a TCP forwarder on `0.0.0.0:<chosen>` →
   `127.0.0.1:<random>` without recreating the container. **No HTTP
   reverse-proxy, no vhost/path routing, no canonical env in v1** (the
   earlier HTTP+canonical design was Linux-bridge-bound and inverted on
   cross-platform reality). SQLite forward table is the source of
   truth. Replaces Coast. **Designed now, built after the engine.**
10. **UI transcript standardized on AI SDK `UIMessage`; each backend an
    adapter.** `ai` is a types-only devDep; the durable log stays the
    rich native stream-json; projection is per-adapter client-side.
11. **Mid-turn steering = in-process side-channel +
    `--replay-user-messages`;** event-stream-durable, best-effort across
    restart, no `@`/slash expansion for steered text.
12. **Multi-user auth** = `nuxt-auth-utils` email+password, no email,
    first-run admin + admin-approval, identity-only cookie, one Nitro
    middleware as the boundary.
13. **Group-chat collaboration** = a message doesn't trigger the agent;
    only `@agent`/button does; durable `chat` events as the single
    source of truth. Designed, not built.
14. **Distribution** = host-installed app, **no engine infra** (the new
    engine deletes the Postgres/agents-server stack); per-env DinD owned
    by the app; bundled Node; all data under `$DOMO_HOME`.

### Superseded (rationale in `history.md`)

Electric Agents owns the stream · agents-server/Postgres/docker-compose
· pull-wake vs push webhook · IDE bridge as the approval channel
(`openDiff`, 8 bridge tools, RFC 6455 server) · per-entity runner
dispatch policy · restart-resume via boot-relink patch · Coast owns env
isolation / coastd HTTP contract / `coast checkout` · Postgres+agents
compose in distribution.

### Open

- Exact restart UX for an `interrupted` turn (auto-resume vs prompt the
  user).
- Scaffolder behavior when a `docker-compose.yml` exists but no
  `.devcontainer/` — compose-based devcontainer.json template details
  (which service is primary, how `forwardPorts` is seeded).
- Auto-detection of runtime-opened ports (poll `ss -tlnp` inside the
  container) vs strictly user-driven adds — v1.5.
- Concurrent-edit signalling when two sessions touch one file
  (lightweight badge v1).
- No-remote projects (clone-in-UI) — post-v1.
- Per-session ACLs (collaboration v2).
- Canonical-env / stable-host-port UX — deferred from v1 (revisit if
  multi-env workflow hits friction without it).

## Build sequence

The Electric/Coast phases 0–4 + auth Part A **shipped** (see
`history.md`); they are being replaced from the inside.

1. **Session engine swap — LANDED.** `server/lib/sessionEngine/{engine,
   claude,store}.ts` (single-flight manager, **long-lived per-session
   process** — see Session engine / Decided #3,#7) + `session_events` +
   `pending_diffs` SQLite tables + `sessions.*` procedures re-pointed
   off the entity/driver onto the engine. Host `claude` spawn moved
   verbatim from `electric/claude.ts` (carries the billing fix: no `-p`,
   `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, exact VS Code argv,
   stdio-permission, steering, partial-stream coalescer). Boot reconcile
   pass: stale `active`/`pending-approval` → `waiting`, orphan
   `pending` diffs auto-rejected with `diff_decision { reason:'runtime
   restarted' }`. The chat fine path of the reactivity spine landed
   here too (`server/api/live.ts` + `server/lib/changeBus.ts` +
   `useSessionStream` rewritten) — without it the chat is unusable, so
   it had to ship with step 1. Deleted: `electric/*`, `/_agents` proxy,
   agents-server compose + patch + `apply-patches.sh`, pkg.pr.new pins.
   Release/CLI cleanup: slimmed `bin/domo` (no compose), `install.sh`
   prereqs, `build-release.sh` / `local-update.sh` (drop the
   agents-server image build); `release.yml` unchanged (it just calls
   `scripts/build-release.sh`). **Outstanding:** the deadline-critical
   billing live-verify (step 7).
2. **Reactivity spine (remainder) — LANDED.** Coarse `{table,id,op}`
   channel on `server/lib/changeBus.ts` + `server/api/live.ts` (the
   endpoint now also accepts no `?sessionId=` and serves `table-change`
   only). Tab-wide browser singleton `app/composables/liveBus.ts`
   multiplexes the three event types over one EventSource — chat
   surface focuses via `liveBus().focusSession(id)`,
   `useLiveRefresh(refresh, { tables: [...] })` binds a `useCall`
   refresh to coarse notices with a 150 ms trailing debounce. The 4 s
   `sessionTick` setInterval in `LeftRailTree.vue` is deleted; the
   rail's session status dot, new-output dot, and env list are
   push-live. Coast events still drive the env runtime overlay
   (`liveStatus`/checkout) until step 3.
3. **Devcontainer environment engine.** Two sub-steps in one phase:
   **3a** — `@devcontainers/cli` lifecycle, rootless-DinD baseline
   (sysbox → rootless dind → privileged-warn), project-add /
   env-create reworked off `devcontainer.json` directly (no Domofile),
   scaffolder writes a starter `.devcontainer/devcontainer.json` when
   absent (with the Domo claude Feature + sensible base), terminal →
   `docker exec`, Coast adapter removed. **3b** — `claude` spawn
   moves from host-side into `docker exec` inside the env container;
   Domo-owned devcontainer Feature
   (`ghcr.io/<us>/devcontainer-features/claude`, pinned to
   `CLAUDE_AGENT_SDK_VERSION`) ships the binary inside; shared
   `<DOMO_HOME>/claude-home/<userId>/` → container `~/.claude`
   bind-mount carries OAuth + slash-commands + MCP across envs for one
   Domo user; path translation `/workspace/…` ↔ worktree-relative in
   the pending-diffs + tool-call renderers.
4. **Port forwarding.** TCP-only, cross-platform. Read
   `forwardPorts`/`portsAttributes` from `devcontainer.json`; inject
   `runArgs` for `-p 127.0.0.1:0:<inner>` at `devcontainer up`;
   discover assigned host ports via `docker port`. Userland forwarders
   for ad-hoc/runtime ports (Node net listener → `docker exec socat`).
   `envs.ports` exposes the **"expose externally" toggle** (spawn/kill
   a `0.0.0.0:<chosen>` → `127.0.0.1:<random>` TCP forwarder). SQLite
   forward table is the source of truth; rebuild listeners on boot.
   No HTTP proxy, no canonical-env wiring (deferred).
5. **Collaboration (Decided #13).** Durable `chat` events, record-without-
   running + trigger detection, authored bubbles.
6. **Re-polish + docs/site rewrite** to the new model once it's live.

## Public docs

`docs/site/*` (getting-started, securing-your-install, releasing)
currently describe the **shipped Coast/Electric product** and stay
accurate to the last release until the new engine ships — rewritten in
step 6, in the same change as the build. No "ship now, document later."
