# Domo — Initial Design

This document is an initial design pass based on exploration of the two reference templates we cloned alongside this project:

- `../nuxt-chat-template/` — [`nuxt-ui-templates/chat`](https://github.com/nuxt-ui-templates/chat). Streaming AI chat built on Nuxt UI's `UChat*` components, the Vercel AI SDK (`@ai-sdk/vue` `Chat` class + `DefaultChatTransport`), Drizzle/SQLite for persistence, file uploads, markdown rendering via `@comark/nuxt` with Shiki highlighting, GitHub OAuth via `nuxt-auth-utils`, and tool calling (charts, weather, web search).
- `../nuxt-editor-template/` — [`nuxt-ui-templates/editor`](https://github.com/nuxt-ui-templates/editor). Notion-style WYSIWYG editor built on Nuxt UI's `UEditor` (a TipTap wrapper) with `tiptap-extension-code-block-shiki` for syntax-highlighted code blocks, slash commands, drag handle, bubble toolbar, image upload, mentions, emoji, and AI completions.

The goal of this document is to map what we want to build to what each template gives us, decide what to keep, what to replace, and what to add.

## What we want (recap)

Domo is a single Nuxt app with two surfaces:

1. **Chat surface** — talk to a single agent backend (Claude Code CLI in JSONL streaming mode).
2. **Workspace surface** — browse / read / edit files in a configured workspace directory, with syntax highlighting and diff visualization but no autocomplete or AI assistance inside the editor itself.

Both surfaces share the same workspace. The agent reads/writes files; the editor lets the user inspect and tweak those files manually.

## High-level architecture

```
┌──────────────── Nuxt app (domo) ────────────────┐    ┌───── Electric Agents server (sidecar) ─────┐
│                                                  │    │                                             │
│   app/                                           │    │   self-hosted control plane:                │
│   ├─ pages/  (index, chat/[id], files/*path)     │    │   - manages durable streams                 │
│   ├─ components/  (chat / editor / workspace)    │◀──▶│   - routes prompts to entity handlers       │
│   ├─ composables/                                │    │   - exposes stream subscription URLs        │
│   │   ├─ useDomoSession.ts (TanStack DB sub)     │    │   - publishes Horton/Worker by default;     │
│   │   ├─ useWorkspace.ts / useDiff.ts            │    │     we DO NOT register them                 │
│   │                                              │    └────────────────┬────────────────────────────┘
│   server/                                        │                     │
│   ├─ api/  (sessions, workspace, ide-bridge)     │                     │  webhooks
│   ├─ runtime/                                    │                     ▼
│   │   ├─ registry.ts (defines `claude-code-cli`) │    ┌── /_electric/builtin-agent-handler ─────────┐
│   │   └─ webhook.ts  (mounts runtime.onEnter)    │    │ Nitro route → runtime.onEnter(req, res)     │
│   └─ lib/                                        │    │                                             │
│       ├─ workspace.ts (safe FS access)           │    │ `claude-code-cli` handler:                  │
│       └─ ide-bridge/                             │    │   1. start WebSocket server (random port)   │
│           ├─ ws-server.ts                        │    │   2. write ~/.claude/ide/<port>.lock        │
│           ├─ tools.ts (openDiff, openFile, ...)  │    │   3. spawn `claude -p --output-format       │
│           └─ lockfile.ts                         │    │      stream-json --input-format stream-json │
└──────────────────────────────────────────────────┘    │      --permission-mode acceptEdits` with    │
                       │                ▲               │      env { CLAUDE_CODE_SSE_PORT,            │
                       │                │               │            ENABLE_IDE_INTEGRATION=true,     │
                       │ stream-json    │ WS bridge     │            ANTHROPIC_API_KEY="" }           │
                       │ stdin/stdout   │ (openDiff,    │   4. parse stream-json → events_insert()    │
                       │                │  selections,  │   5. respond to WS tool calls (openDiff     │
                       ▼                │  diagnostics) │      blocks until UI accepts/rejects)       │
                ┌────────────┐          │               └─────────────────────────────────────────────┘
                │ claude CLI │──────────┘
                │ (binary)   │
                └────────────┘
                       │
                       ▼
       ~/.claude/projects/<…>/<id>.jsonl   ◀── canonical Claude session state on disk (we don't read it)
```

The Nuxt app + the Electric Agents server run side-by-side locally (in v1, two processes; later, possibly one). The Nuxt app hosts our entity's webhook handler; the agents server brokers the durable streams and the chat UI subscribes directly to them. When a prompt arrives, the entity handler boots an IDE-bridge WebSocket server, writes the lock file under `~/.claude/ide/`, spawns the `claude` CLI binary with the bridge env vars, and parses stream-json output into the entity's events stream. The CLI connects back to the WebSocket for editor operations, calling `openDiff` for file edits — those calls block until the user reviews the diff in the workspace surface. No workspace pollution, no hooks file, no env-var gates, no timeout. There is no external AI gateway, no third-party DB, no OAuth — this is meant to run locally against a workspace directory the user owns, billing through the user's existing Claude subscription.

## Layout

We adopt the chat template's `UDashboardGroup` + `UDashboardSidebar` shell from `app/layouts/default.vue` (lines 73–187 in the chat template), but with a different sidebar:

- **Top:** New session, search.
- **Middle (tabs or two sections):**
  - **Sessions** — list of saved Claude Code sessions, like the chat template's chat list.
  - **Files** — collapsible file tree of the workspace.
- **Footer:** Workspace path indicator, settings.

The main panel is route-driven:

- `/` — landing with "Good $time_of_day" greeting + prompt (mirrors chat template `app/pages/index.vue`). On submit, create a session and navigate to `/chat/:id`.
- `/chat/:id` — chat surface (mirrors chat template `app/pages/chat/[id].vue`).
- `/files/*path` — workspace surface for a specific file.

We may also support a side-by-side mode where the chat is on the left and a focused file (with diff) is on the right — Nuxt UI's `UDashboardPanel` supports this naturally.

## Chat surface

We reuse the chat template's UI almost wholesale, swapping out the transport and message shape.

### Components reused from the chat template

- `UChatMessages` / `UChatPrompt` / `UChatPromptSubmit` / `UChatReasoning` / `UChatTool` / `UChatShimmer` — these are Nuxt UI primitives, not template-specific. They handle streaming, auto-scroll, indicator slots, etc.
- The `MessageContent.vue` pattern (`app/components/chat/message/MessageContent.vue`, lines 17–71): iterate over `message.parts` and render each part by type (`text`, `reasoning`, `tool`). We will keep this exact shape.
- `Comark.ts` (lines 1–34) — markdown rendering with Shiki code highlighting. We keep this for assistant text parts.
- The drag-drop overlay, edit/regenerate flow, and prompt UX.

### What we replace

The chat template uses the Vercel AI SDK's `Chat` class + `DefaultChatTransport` pointed at `/api/chats/:id`, which internally calls `streamText({ model, ... })` with provider-specific options. We replace that with:

- A **`useClaudeChat`** composable that owns: messages list, status, abort, and an EventSource/`ReadableStream` reader pointed at `/api/sessions/:id/messages`.
- A **`/api/sessions/:id/messages.post`** server route that:
  1. Spawns the `claude` CLI with the JSONL streaming flags (the spec from Claude Code's `--output-format stream-json --input-format stream-json` mode).
  2. Pipes the user message in as JSONL.
  3. Reads JSONL events from stdout line by line.
  4. Translates each event into UI message stream parts that match what Nuxt UI's `UChatMessages` already understands:
     - `assistant` text deltas → `text` parts.
     - `thinking` blocks → `reasoning` parts (rendered by `UChatReasoning`).
     - `tool_use` → `tool` parts. Claude Code's built-in tools (Read, Edit, Write, Bash, etc.) become tool invocations the UI already knows how to render via `UChatTool` or our own components.
     - `tool_result` → attached to the matching tool part.
  5. Streams those parts to the client (Server-Sent Events or chunked NDJSON works; we'll match whatever shape `@ai-sdk/vue`'s `Chat` expects so we can keep using it as the message-state primitive — alternatively roll our own composable since our message shape is fixed).
- **Session persistence** — Claude Code CLI already manages session state on disk under `~/.claude/projects/...`. We can either:
  - Let the CLI own session state and pass `--resume <session-id>` on each turn (simplest, no DB needed), or
  - Mirror the chat template's Drizzle/SQLite store for session metadata (titles, timestamps) and keep history in CLI-managed JSONL.

  Initial choice: **let the CLI own the conversation state**, keep a tiny SQLite (or just a JSON file) on our side for session id ↔ title ↔ workspace path. Simpler and avoids divergence.

### Tool rendering

The chat template's pattern for custom tool UIs (`ChatToolChart`, `ChatToolWeather`) is the exact pattern we want for Claude Code tools. For our case the most valuable ones to render specially are:

- **Read / Glob / Grep** — render as a collapsible chip showing the file/path, count of results, etc.
- **Edit / Write** — render as a diff preview using our diff component (links into the workspace surface).
- **Bash** — render the command and output in a styled block.
- **TodoWrite** — render a task list.

Generic tools fall back to `UChatTool` with the tool name and a JSON-rendered input/output.

### What we drop

- Multi-model selector (`ModelSelect.vue`, `useModels`) — we have one backend.
- File upload to blob storage (`@nuxthub/core`, `useFileUpload`, `ChatFiles`, drag-drop) — files in domo come from the workspace, not from the user's filesystem via upload. We may keep drag-drop later as a way to *attach a file path* to a prompt, but the v1 cuts it.
- Auth (`nuxt-auth-utils`, GitHub OAuth, vote endpoints, public/private chat visibility) — single-user local app.
- AI Gateway / multi-provider config.
- Web search and chart/weather tool examples.

## Workspace surface

The editor template is built around `UEditor`, which is a **TipTap WYSIWYG markdown editor**. For v1 that's a poor fit for our needs:

- We want plain markdown editing where the user sees and edits the actual `.md` source.
- We want code editing with syntax highlighting and **no** language tooling (no autocomplete, no inline AI, no slash commands).
- We want to render diffs (additions/deletions side-by-side or inline).

So for v1 we'll borrow ideas from the editor template (the Nuxt UI shell, the Shiki theme setup, the layout) but **use [CodeMirror 6](https://codemirror.net/)** as the actual file editor. CodeMirror 6 gives us:

- Per-language syntax highlighting via `@codemirror/lang-*` packages, fed by file extension.
- A clean read-only mode and edit mode toggle.
- A solid foundation for diff view via `@codemirror/merge`.
- No AI/autocomplete unless we explicitly add it (we won't).

For **markdown preview** we reuse the chat template's `Comark` setup so rendered markdown looks identical to assistant messages.

#### Future: optional WYSIWYG mode for markdown (post-v1)

We expect to add a second editing mode for markdown files using `UEditor` (TipTap) from the editor template. The shape we're planning for:

- CodeMirror is always the editor for code files and the **Source** mode for markdown. It also owns diff view for any text file.
- TipTap is an **optional WYSIWYG mode** available only for markdown files, exposed as a "Source / WYSIWYG" toggle in the file header alongside the existing "View / Edit" toggle. The file on disk stays plain `.md` — TipTap's `content-type="markdown"` round-trips to markdown text on save.
- Tradeoff to handle: TipTap's markdown round-trip is **lossy** for constructs outside its supported nodes (raw HTML blocks, footnotes, frontmatter, custom directives, exotic table syntax, etc.). When a file contains unsupported constructs, the WYSIWYG toggle is disabled and we keep the user in CodeMirror. Detection: parse on load and flag unsupported nodes, or round-trip and diff.
- The agent never writes through TipTap — it only ever produces text edits, which CodeMirror and our diff view already handle natively.

This is a v1.x or v2 feature, not part of the initial scope. We design the `WorkspaceFile.vue` mode-toggle structure to leave room for it but ship with CodeMirror only.

### Components

- `WorkspaceTree.vue` — file tree fed by `/api/workspace/tree`. Click navigates to `/files/*path`.
- `WorkspaceEditor.vue` — wraps CodeMirror. Props: `path`, `mode` (`view` | `edit` | `diff`), optional `against` ref for diff mode.
- `WorkspaceMarkdownView.vue` — uses `Comark` to render `.md` files.
- `WorkspaceFile.vue` — page-level component that picks between editor / markdown view / diff view based on file type and current mode toggle, with a header showing path, mode toggle, save state, and "Open in chat" button.

### Diff visualization

Two cases to support:

1. **Pending agent edit.** When the agent's `Edit`/`Write` tool fires, the server stores the proposed change as a pending diff (in memory or on disk) and emits a tool part with `{ path, before, after }`. The chat tool component renders an inline preview and links to the workspace surface in `diff` mode for the full view.
2. **Filesystem vs. last-saved-by-user.** A user-driven diff against the last committed (git) version, useful for reviewing manual edits. Lower priority.

CodeMirror 6's `@codemirror/merge` gives us both inline and side-by-side diff views out of the box.

## Session storage & runtime: self-hosted Electric Agents with a custom Claude Code entity

ElectricSQL describes a [Durable Sessions](https://electric.ax/blog/2026/01/12/durable-sessions-for-collaborative-ai) pattern built on [Durable Streams](https://electric.ax/blog/2026/04/08/data-primitive-agent-loop): a persistent, addressable, append-only stream per session that carries every chunk, tool call, presence event, and state mutation. Clients subscribe by URL, replay from any offset, and reactively materialize state via TanStack DB. Their followup, [Electric Agents](https://electric.ax/blog/2026/04/29/introducing-electric-agents), is the platform that gives us this: a runtime where each agent is an addressable durable stream, plus a self-hosted control plane and runtime server.

> **Note on the built-in `coder` entity.** Electric used to ship a built-in `coder` entity that wrapped the Claude Code / Codex CLIs ([source as of commit `65f0cf0`](https://github.com/electric-sql/electric/blob/65f0cf02074732dc312df62a69d949b29533581c/packages/agents/src/agents/coding-session.ts)). It has since been removed in favor of their own agent implementation, **Horton**, which uses `@anthropic-ai/sdk` directly — that path requires an `ANTHROPIC_API_KEY` and bills per-token via the API. We want **Claude Pro/Max subscription billing**, which is only available through the `claude` CLI. So we will:
>
> - Self-host the Electric Agents control plane (`@electric-ax/agents-server`) and runtime (`@electric-ax/agents-runtime`).
> - **Not** use Horton.
> - Implement our own entity type, called **`claude-code-cli`**, that wraps the `claude` CLI, modelled closely on the removed `coding-session.ts` from commit `65f0cf0`. That file is the reference implementation we'll adapt.

> **On naming and future entity types.** The first entity is named after what it does (`claude-code-cli`), not after the product. We expect to add more entity types over time:
> - **`codex-cli`** — wraps the OpenAI Codex CLI the same way `claude-code-cli` wraps Claude Code. OpenAI doesn't restrict subscription API-key reuse the way Anthropic does, so a dedicated CLI wrapper still buys us Codex's own tools and prompt instructions. Post-v1 — the architecture accommodates it as a peer entity type, and each entity gets to pick its own preferred protocol (Codex's CLI has its own structured output mode; we don't have to share a parser with Claude).
> - **`vercel-sdk-agent`** (or similar) — a generic LLM agent built on the Vercel AI SDK with configurable model, system prompt, and tools. This *would* legitimately use `ctx.useAgent()` (or a thin wrapper around the AI SDK) and serve as the "bring your own provider" path for users without a Claude subscription.
> - **`domo`** — a first-party agent we may eventually build with whatever opinionated capabilities make domo distinctive. The name is reserved for that.
>
> Keeping each entity type narrowly scoped and named after its mechanism makes the registry easy to reason about, lets the chat UI render an entity-type chip / icon naturally, and means each backend can pick the integration shape that fits it best. The shared abstraction sits at the **events collection schema** — the row shape that lands in `ctx.db.collections.events` — not at the parser layer.

### Why this is the right call now

I had previously suggested rolling our own minimal Durable-Sessions-shaped event log. With the entity available as a clean reference, the calculus flips: Electric Agents gives us, out of the box, more than we'd reasonably hand-roll —

- **Per-entity durable streams** with replay from any offset and live tail subscriptions.
- **TanStack DB collections** materializing the stream client-side as typed, queryable state — the chat UI gets reactivity for free.
- **Inbox / outbox / wake events** so clients can push prompts without owning the agent's lifecycle.
- **Fork tree** for sessions (matches Claude Code's fork-on-edit semantics natively).
- **Multi-user collaboration** (presence, shared subscription) is already a primitive, not something we'd bolt on.
- **A self-hosted runtime server** that handles webhooks, idle timeouts, and subscriptions.

The cost is a real but bounded dependency on the Electric Agents stack. Mitigations: the control plane and runtime are open-source and self-hostable; the entity definition API is small; if we ever needed to leave, the JSONL session file is still on disk and is the canonical Claude Code state.

### How the custom `claude-code-cli` entity works

Adapted from `electric-source/packages/agents/src/agents/coding-session.ts` at commit `65f0cf0` (cloned alongside this project at `../electric-source/`). The shape:

```ts
import { createEntityRegistry, createRuntimeHandler } from '@electric-ax/agents-runtime'
import {
  loadSession, tailSession, resolveSession,
  serializeCursor, deserializeCursor, discoverSessions,
} from 'agent-session-protocol'

const registry = createEntityRegistry()

registry.define('claude-code-cli', {
  description: 'A Claude Code CLI session, mirrored into a durable stream.',
  creationSchema: z.object({ cwd: z.string().optional() }),
  inboxSchemas: { prompt: z.object({ text: z.string() }) },
  state: {
    sessionMeta: { schema: sessionMetaRowSchema, primaryKey: 'key' },
    cursorState: { schema: cursorStateRowSchema, primaryKey: 'key' },
    events:      { schema: eventRowSchema,       primaryKey: 'key' },
  },
  async handler(ctx) {
    // 1. On first wake: seed sessionMeta + inboxState rows.
    // 2. Drain inbox of pending prompts (since lastProcessedInboxKey).
    // 3. For each prompt:
    //    - Spawn `claude -p [--resume <id>] --dangerously-skip-permissions
    //      --output-format stream-json --input-format stream-json
    //      --mcp-config <session-mcp-config>` with the prompt sent as a
    //      stream-json user message on stdin.
    //    - readline over child.stdout, parse each NDJSON line, write
    //      a corresponding row into the `events` collection.
    //      The very first line is a `system` event carrying
    //      `session_id`; capture it on the first turn and persist
    //      to sessionMeta.nativeSessionId.
    //    - Wrap `recordRun()` around the invocation so observers
    //      get a `runFinished` wake; attach assistant text as the
    //      run's response payload.
    // 4. Update sessionMeta status (idle/running/error).
    // 5. Advance lastProcessedInboxKey to the prompt we just handled.
  },
})
```

Key details:

- **CLI invocation:** `claude -p [--resume <id>] --permission-mode acceptEdits --output-format stream-json --input-format stream-json` with these env vars set: `CLAUDE_CODE_SSE_PORT=<our-ws-port>`, `ENABLE_IDE_INTEGRATION=true`, `ANTHROPIC_API_KEY=` *(scrubbed)*. Prompt is sent to stdin as a stream-json `user` message envelope. The IDE bridge WebSocket handles approvals via the blocking `openDiff` tool; `--permission-mode acceptEdits` keeps the CLI from trying interactive prompts for things outside the bridge. See the "Approval flow & editor integration" section for the full picture.
- **Event source:** `readline` over `child.stdout`, NDJSON-parse each line, `ctx.db.actions.events_insert({ row })`. No fs.watch, no polling, no path discovery, no `agent-session-protocol` on the live path.
- **Session id capture:** the first stream-json line of every turn is a `system` event carrying `session_id`. On the *first* turn of a fresh session, that's where we learn the id Claude generated. We persist it via `sessionMeta_update` so subsequent turns can pass `--resume <id>`.
- **Idempotency / dedup:** stream-json events have stable per-event ids; we use them as the row primary key, so retries on the same turn (e.g. a wake replay) are naturally idempotent. (Content-hash keys, like the reference uses for the JSONL path, are unnecessary here.)
- **Bypassing `ctx.useAgent` is the critical pattern.** `ctx.useAgent()` is for entities where the runtime drives the LLM loop via pi-agent-core: you supply a model config + tools and pi-ai dispatches everything, projecting each step into the stream automatically. We don't want that — the `claude` CLI runs its own LLM loop using the user's subscription credentials and its own tool ecosystem. Using `useAgent` would (a) force pi-ai's API-key-only billing, defeating the whole point; (b) put two competing LLM loops in flight; (c) require us to re-implement Claude Code's tool surface inside pi-ai. We use the entity primitives directly (`ctx.db.collections`, `ctx.db.actions`, inbox, `setTag`, `spawn`, etc.) and explicitly call **`ctx.recordRun()`** to bracket each CLI invocation so observers get `runFinished` wakes — that's the one piece of automatic accounting `useAgent` would otherwise have done for us.
- **IDE bridge integration:** the entity hosts a local WebSocket server, writes `~/.claude/ide/<port>.lock`, and sets `CLAUDE_CODE_SSE_PORT` + `ENABLE_IDE_INTEGRATION=true` so the CLI auto-connects. Editor operations (Edit, Write, file open, diffs, selections) route through that channel; approvals happen via the blocking `openDiff` tool in our UI. See the "Approval flow & editor integration" section for the full design.

- **Optional custom MCP tools** (post-v1): if we want app-specific tools (e.g. `domo_workspace_search`) beyond what the IDE bridge offers, pass `--mcp-config <path-to-tmp-file>` pointing at a JSON config we write to a temp dir (not the workspace). The IDE bridge and `--mcp-config` are independent channels and compose cleanly.

### Decision: stdout `stream-json` is the only runtime event source

The reference `coding-session.ts` mirrors events by tailing the on-disk JSONL session file (`fs.watch` + 1.5s poll, normalized via `agent-session-protocol`). The Anthropic-recommended approach is `--output-format stream-json --input-format stream-json`, where the CLI emits NDJSON events on stdout. We go with stdout.

**Reasons not to tail files at runtime**

- The on-disk format and path layout (`~/.claude/projects/<sanitized-cwd>/<id>.jsonl`, the field names, the macOS realpath quirks where `/tmp` becomes `/private/tmp`) are **internal CLI state**, not a public contract. Anthropic could change them in any release.
- File-tailing pays a few hundred ms of jitter per tick because `fs.watch` alone is unreliable across platforms; the reference adds a 1.5s poll fallback to compensate.
- First-prompt session-id discovery requires a pre-run / post-run directory diff to find the freshly-written file.
- There's a flush race between the CLI exit and the JSONL becoming readable in full.

**What stdout `stream-json` gives us**

- An officially-supported, documented protocol meant to be consumed by tools.
- Token deltas as they happen, no polling.
- OS-portability — no special-case path logic.
- The session id is delivered to us in-band: Claude's stream-json emits a `system` event at the start of each turn containing `session_id`. We capture it on the first event of the first turn, persist it in `sessionMeta.nativeSessionId`, and never need to discover it from the filesystem.

#### Why we do not keep file-tailing as a "backstop"

An earlier draft of this doc proposed file-tailing as a backstop for two cases. Both turn out to either reintroduce the fragility we're trying to escape, or to be solvable without disk access:

- **Crash recovery.** If our entity dies mid-run, file-tailing on next wake would let us reconstruct missed events. We considered whether the CLI itself could replay session history to stdout on resume (e.g. a `--replay` / `--include-history` flag) — that would have been the cleanest fix. **Verified against the docs: no such flag exists.** The only mechanical paths to prior history are reading the JSONL transcript directly (the thing we're avoiding) or `/export` (human-readable, not machine-parseable). So: keeping `agent-session-protocol` plus all the path-discovery logic in the steady-state code path defeats the point of going stdout. Better: **accept that an interrupted turn loses its in-flight events from our side**; mark it `interrupted` in our events stream and let the user continue. Claude itself owns the session state on disk; the next prompt resumes correctly via `claude -r <id> -p` regardless of what we missed. Crucially, **any file changes the agent made during the lost turn are still on disk** — the workspace state is preserved; only our event log's record of *what happened* is incomplete. The UI surfaces this with an "interrupted turn — file changes (if any) are on disk; review with `git diff`" indicator.
- **Pre-existing terminal session import.** This stays an explicit, **one-shot** user-invoked operation: a "Import session" button or CLI subcommand that calls `loadSession(id)` once via `agent-session-protocol`, seeds the entity's events collection, and exits. The fragility is contained to that opt-in path, runs at most once per imported session, and never executes on the hot path. If `agent-session-protocol` breaks against a new CLI release, only the importer breaks — the live experience is unaffected.

#### What this means for the entity implementation

We **adapt** the reference `coding-session.ts` rather than copy it:

- **Keep:** the entity skeleton, `state` shape (`sessionMeta`, `cursorState`, `events`), inbox / `lastProcessedInboxKey` cursor pattern, `recordRun()` bracketing, multi-user prompt wrapping, the `creationSchema` / `inboxSchemas` definitions.
- **Replace:** the `runWithLiveMirror` file-watching dance becomes a `readline`-on-`child.stdout` NDJSON consumer that calls `events_insert` per line. The first `system` event of each turn populates `nativeSessionId` if it isn't set yet.
- **Drop entirely from the live path:** `agent-session-protocol`'s `resolveSession` / `loadSession` / `tailSession`, `discoverSessions`, the `getClaudeProjectDirs` realpath helpers, `findNewSessionAfterRun`'s pre/post directory diff. These move to a separate `lib/import-claude-session.ts` module used only by the one-shot importer.
- **Cursor state:** simplifies. We no longer persist a `SerializedSessionCursor` (which is a file-position cursor); `cursorState` keeps only `lastProcessedInboxKey`. (We could rename it to `inboxState` to reflect the narrower role.)
- **`cliRunner` shape:** changes from "run, return final stdout/stderr" to "run, expose a stdout event stream + a final exit code". Test fakes inject a generator of stream-json events.

#### Things to verify when implementing

- Exact field names in Claude's stream-json `system` event for session id capture (smoke run + verify via context7).
- Exact stream-json `user` message envelope for stdin (there's a `type` discriminator).
- **Whether `claude -p --output-format stream-json --input-format stream-json` composes with `ENABLE_IDE_INTEGRATION=true` + `CLAUDE_CODE_SSE_PORT`.** They're orthogonal concerns — output formatting vs. tool-routing channel — so this should work, but it's the load-bearing assumption of our design and warrants a quick smoke test before committing code. **Fallback if it doesn't compose:** run the CLI in interactive mode (no `-p`), feed prompts via stdin, and parse stdout ourselves. Less elegant but well-trodden by VS Code etc.
- Confirm `--permission-mode acceptEdits` lets Edit/Write reach the IDE bridge's `openDiff` (rather than being silently auto-applied without prompting). Per the protocol, IDE mode routes Edit/Write through `openDiff` regardless of permission mode, but the interaction with `acceptEdits` warrants a smoke test.
- Confirm `CLAUDE_CODE_OAUTH_TOKEN` (or empty `ANTHROPIC_API_KEY` + a logged-in `~/.claude` keychain) routes to subscription billing. The "billing source" indicator in the CLI's `system` event tells us; we can also verify by spending and watching the user's account.

### Reconciling the two paradigms

We have two append-only logs in play, and they store **different things**:

| | Claude Code session file (`~/.claude/projects/.../<id>.jsonl`) | Durable Session stream |
| --- | --- | --- |
| **Owner** | The CLI | Our app |
| **Contents** | Canonical conversation as Claude will see it on `--resume`: user messages, assistant messages, tool calls, tool results | Everything around it: per-token chunks, presence, agent registration, user identities, UI state (approvals, file pane focus), pending diffs, audit events |
| **Mutability** | Append-only; "edits" produce a forked session | Append-only; forks are first-class |
| **Granularity** | Whole messages / events | Token-level chunks + structured events |
| **Purpose** | Determinism on resume — what does the model see next? | Collaboration, replay, observability — what does the *room* see? |

Both are append-only and fork-on-edit, so the paradigms line up cleanly. They are not competing; they are layered.

### Source of truth, split by question

- **"What will Claude see when we resume this session?"** → The Claude Code session file is source of truth. We never edit it; we only feed Claude through `--resume <id>` and let the CLI append to it.
- **"What did the room observe while this session ran?"** → The Durable Stream is source of truth. UI clients subscribe to it, replay from offsets, and materialize state. Token chunks during streaming, presence, who clicked "approve" on a tool — all live here and **not** in the Claude session file.

Reconciliation rule: when the CLI emits a finalized event (a complete message, a tool result), the server writes a corresponding **structured event** into the Durable Stream — but it doesn't mirror the raw JSONL byte-for-byte. The stream entry is a richer, UI-shaped event tagged with the corresponding Claude session offset/message id, so we can always cross-walk back to what Claude saw.

If the user "edits" a past message, we fork the Claude session (`claude --resume <id>` with a rewritten prefix produces a new session id) **and** branch the Durable Stream — the stream's branch points back at its parent offset, mirroring how Electric Agents model their fork tree.

### Multi-user: yes, with explicit attribution to the model

Multiple humans + the agent in one session works the same way Electric describes for collaborative AI, with one extra concern unique to us: Claude needs to know who said what.

- Each human user gets a stable `actorId` and display name in the stream's presence schema.
- When user A sends a prompt, the stream gets a `user_message` event tagged with `actorId = A` (this is what the UI renders, with avatar/color).
- The server, before forwarding to Claude, **wraps** the text:
  ```
  [from @alice]: <message text>
  ```
  Possibly with a one-time system preamble at the top of the session: "This is a multi-user session. Messages are prefixed with `[from @username]:`. Address replies to the named user where appropriate." Tool results and agent messages don't need wrapping.
- The Claude session file therefore records the *wrapped* text — which is correct for resume semantics. The Durable Stream records the *unwrapped* text plus the `actorId`, which is correct for UI rendering.

Edge case: if user A and user B send messages near-simultaneously, we serialize on the server (the stream is the ordering authority) and feed Claude in stream order, each prefixed.

### Self-hosted topology

Three processes, all locally:

1. **Domo Nuxt app** (`nuxt dev`) — serves the UI, hosts our `/_electric/builtin-agent-handler` webhook (mounted from a Nitro server route that delegates to `runtime.onEnter`), and exposes our own workspace endpoints (file tree, file read/write, diff). Registers the `claude-code-cli` entity at startup via `runtime.registerTypes()`.
2. **Electric Agents server** (`@electric-ax/agents-server`) — the control plane. Routes inbound prompts to entity handlers via webhook, manages durable streams, exposes subscription URLs. Self-hosted; runs as a sidecar.
3. **Durable Streams backend** — the storage layer the agents server depends on. Self-hosted via the [Durable Streams open protocol](https://electric-sql.com/primitives/durable-streams) implementations; we'll start with the reference one and revisit if performance is an issue.

In production deployment we'd colocate (1) and (2) in the same process or container; for v1 dev they can run side-by-side via a single `pnpm dev` orchestrator.

### Event flow at a glance

```
User types in domo chat UI
  → POST /api/sessions/:id/prompt (Nuxt route)
  → runtime client `.send(entityUrl, { text })` to Electric Agents server
  → server appends `inbox` event to entity's durable stream
  → server triggers wake via webhook → /_electric/builtin-agent-handler
  → our `claude-code-cli` handler runs:
       spawns claude CLI, fs.watches JSONL,
       calls actions.events_insert(...) with each normalized event
       (every action is an append to the entity's durable stream)
  → chat UI is subscribed to the entity's durable stream;
    TanStack DB live-queries the `events` collection;
    new rows reactively render in <UChatMessages>
```

The chat UI binding looks roughly like the existing `Chat` class from the chat template, but the transport is replaced by an Electric Agents subscription. The shape we project from `events` (one row per `text_delta` / `tool_call` / `tool_result` / `assistant_message`) maps cleanly onto the `UIMessage.parts` shape that `UChatMessages` already understands.

### Multi-user, revisited

Electric Agents already gives us shared subscription. The only domo-specific concern is **attributing user messages to Claude**. The plan from the prior section still holds, with a small refinement:

- The chat UI sends a `prompt` inbox message tagged with `actorId` (and the user's display name, captured at session join).
- The `claude-code-cli` handler, before piping to stdin, **wraps** the prompt: `[from @alice]: <text>`. The wrapped text is what lands in the JSONL session file (and therefore what Claude sees on resume).
- The unwrapped text + actor id is what's already in the `events` collection (because we log the inbox event into the stream as a normalized `user_message` event before invoking the CLI). UI rendering uses that, not the wrapped form.
- For sessions with a single human user (the common case), we skip the prefix to keep prompts clean.

A one-time system preamble at the very first prompt of a multi-user session — "This is a multi-user session. Messages are prefixed with `[from @username]:`. Address replies to the named user where appropriate." — is appended to the first wrapped prompt only, since Claude Code itself has no separate system-prompt slot we can rely on through the CLI.

### What this means for the build sequence

Build step 5 changes substantively: instead of "spawn the CLI from a Nitro route", we wire up Electric Agents end-to-end and define the `claude-code-cli` entity. The chat UI subscribes to the entity's durable stream rather than to our own SSE route. See the updated build sequence below.

## Server routes

Most "session" responsibilities move from our routes to the Electric Agents stack: session = `claude-code-cli` entity, history = its durable stream, send = inbox `prompt` message via the runtime client, subscribe = the stream subscription URL.

| Route | Purpose |
| --- | --- |
| `POST /_electric/builtin-agent-handler` | Webhook entrypoint for the Electric Agents runtime; delegates to `runtime.onEnter`. Internal — the agents-server hits this. |
| `POST /api/sessions` | Spawn a new `claude-code-cli` entity (calls `runtimeClient.spawn('claude-code-cli', id, { cwd })`), returns id + entity URL |
| `GET  /api/sessions` | Enumerate `claude-code-cli` entities (proxies to agents-server entity listing) |
| `POST /api/sessions/:id/prompt` | Send an inbox `prompt` message to the entity (`runtimeClient.send(entityUrl, { text }, { messageType: 'prompt' })`); attaches `actorId` from the request session |
| `POST /api/sessions/:id/stop` | Best-effort abort: ask the entity to terminate its current run (initially we may not support this and just let the prompt finish) |
| `DELETE /api/sessions/:id` | Delete the entity (and optionally the underlying Claude JSONL session file) |
| `GET /api/workspace/tree` | List workspace files (with `.gitignore` honored) |
| `GET /api/workspace/file?path=...` | Read a file |
| `PUT /api/workspace/file?path=...` | Write a file |
| `GET /api/workspace/diff?path=...` | Pending diff for a file (if any) |

The chat UI's stream consumption is **not** a route on our server — the client subscribes directly to the entity's durable stream URL via the Electric runtime client / TanStack DB.

All workspace routes resolve paths relative to a configured workspace root and reject any escape (`..`, absolute paths outside root, symlink traversal).

## Claude Code CLI integration details

The CLI is invoked **from inside the `claude-code-cli` entity handler**, not from a Nitro route. The flags and shape come straight from the reference `coding-session.ts`:

- `claude -p` (non-interactive print mode).
- `claude -r <session-id> -p` to resume.
- `--dangerously-skip-permissions` is required because `-p` mode runs autonomously and any tool call would otherwise block on an interactive approval and exit 1. Domo enforces approvals at its own UI layer (the chat surface shows pending tool calls and lets the user approve/reject before applying file writes), so this flag is safe in our context.
- The prompt goes on **stdin**, not argv.
- `cwd` is the workspace dir; the CLI writes its JSONL to `~/.claude/projects/<sanitized-cwd>/<id>.jsonl`.

The handler does **not** parse CLI stdout/stderr — those are kept only as truncated buffers for error messages. The canonical event source is the JSONL file on disk, read via `agent-session-protocol`'s `loadSession` / `tailSession`. We `fs.watch` the file plus poll every 1.5s while the CLI runs, deduping events by content hash before inserting into the entity's `events` collection.

For the **first** prompt of a brand-new session, the CLI generates the session id itself and emits it in the `system` event at the start of the stream-json output. We capture that id from the first event, persist it in `sessionMeta.nativeSessionId`, and use `-r <id>` for every subsequent prompt. (We do **not** use the reference's pre/post directory-diff hack — that was needed only because the reference doesn't read stream-json output.)

## Custom tools for the Claude Code CLI

Two channels, used for different things:

**1. The IDE bridge (primary, used in v1).** Editor-level operations — file edits, diffs, file opens, selections, diagnostics — route through the WebSocket-based MCP variant detailed in the "Approval flow & editor integration" section. The bridge is what gives us the diff-approval UX, the selection awareness, and the no-timeout blocking call shape. We implement the 8 required tools listed in that section.

**2. Custom MCP servers (`--mcp-config`, optional, post-v1).** For app-specific tools that aren't editor operations — e.g. `domo_workspace_search`, `domo_request_user_decision` for free-form approvals, or future integrations with external services. We write a JSON config to a temp dir (not the workspace) and pass `--mcp-config <path>` on the CLI invocation. Custom MCP servers can run as in-process stdio servers (we spawn an MCP-capable child for the duration of the session) or as HTTP servers (we mount a route on the Nuxt app). The IDE bridge and `--mcp-config` compose cleanly — they're independent channels.

When either channel's tools fire, the call appears as `tool_use` / `tool_result` events in the CLI's stream-json output, so they show up in our chat UI exactly the same way as built-in tools (Read, Glob, Grep). The chat UI renders them with type-specific components.

Crucially, **stdin is not the channel for tool results**. In `--input-format stream-json` mode, stdin carries *user messages* (the next prompt, replies). Tool execution happens out-of-band over the IDE bridge or MCP. Trying to round-trip tool results through stdin would fight the protocol.

### Approval flow & editor integration: the Claude Code IDE bridge

We use the **Claude Code IDE bridge protocol** — the same WebSocket-based MCP variant that the official VS Code/JetBrains extensions use, fully reverse-engineered and documented in [claudecode.nvim/PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md). The reference Lua implementation is cloned alongside this project at `../claudecode-nvim/` for direct cross-checking.

**Why this is the right approach** (and why we explicitly rejected `PreToolUse` hooks): mature wrappers (VS Code, JetBrains, Neovim) all converge on this protocol because it cleanly avoids every workaround the hooks-based approach forced us into — no settings.json files in the user's workspace, no env-var gates to scope the hook to "our session only", no 600s timeout on user decisions, and a first-class diff-review UX instead of a pre-call gate.

**How the bridge works:**

1. **WebSocket server.** The entity handler boots a local WebSocket server on `127.0.0.1:<random-port-10000-65535>`.
2. **Lock file at `~/.claude/ide/<port>.lock`** (user-state directory, **not** the workspace) containing:
   ```json
   {
     "pid": 12345,
     "workspaceFolders": ["/path/to/workspace"],
     "ideName": "domo",
     "transport": "ws",
     "authToken": "<random-uuid>"
   }
   ```
3. **CLI invocation.** Spawn `claude` with two extra env vars: `CLAUDE_CODE_SSE_PORT=<port>` and `ENABLE_IDE_INTEGRATION=true`. The CLI reads the lock file, finds the matching port, opens a WebSocket connection with `x-claude-code-ide-authorization: <authToken>` header.
4. **Tool routing in IDE mode.** When the CLI is in IDE mode, it routes built-in editor operations (Edit, Write, file diffs, selection queries) through tools registered by our WebSocket server, instead of executing them directly.

**The 12 IDE bridge tools** the protocol expects us to implement:

| Tool | Purpose | v1 priority |
| --- | --- | --- |
| **`openDiff`** | **Approval channel for file edits.** Blocking call: we render the diff and respond with `FILE_SAVED` or `DIFF_REJECTED` whenever the user decides — no timeout. | **Required** |
| `openFile` | Open a file in our editor, optionally selecting a range | Required (basic) |
| `getCurrentSelection` | Current text selection in the active editor pane | Required (basic) |
| `getLatestSelection` | Most recent selection | Required |
| `getOpenEditors` | List of currently open files | Required |
| `getWorkspaceFolders` | Workspace folders | Required (trivial — we know the answer at spawn) |
| `getDiagnostics` | LSP / language diagnostics | Optional v1 — we don't have an LSP integration yet, so return empty |
| `checkDocumentDirty` | Has unsaved changes? | Required |
| `saveDocument` | Save a file | Required |
| `close_tab` | Close a tab by name | Optional |
| `closeAllDiffTabs` | Close all open diff tabs | Required (paired with `openDiff` cleanup) |
| `executeCode` | Jupyter kernel exec | Skip — out of scope |

The blocking nature of `openDiff` is the key approval mechanism. The CLI calls it, the WebSocket request stays open. We pop a diff into the workspace surface, the user clicks accept or reject, we send the response. The CLI then either applies the edit (on `FILE_SAVED`) or feeds the rejection message back to the model so it can adjust.

**Bonus integrations we get for free:**

- `selection_changed` notifications (IDE → CLI): when the user highlights code in our editor, Claude sees it as context.
- `at_mentioned` notifications: explicit "send this selection as context" UX.
- File-open / diagnostics context: the agent has live IDE state without us doing anything.

**For tools without a dedicated bridge entry — Bash, MultiEdit, etc.:**

- v1: launch with `--permission-mode acceptEdits`. Edit/Write are reviewed via `openDiff` (so "auto-accept" is fine — the diff still goes through approval). Bash auto-runs; we render the command and stdout/stderr in the chat UI for full visibility, and the user can interrupt the session if anything looks wrong.
- Post-v1: if Bash auto-execution causes friction, we can add a custom MCP server (via `--mcp-config <tmp-file>`) that exposes a `domo_safe_bash` tool and a system-prompt nudge to prefer it. This is additive and keeps Bash gating optional.

**No more `--dangerously-skip-permissions`.** With `--permission-mode acceptEdits` and the IDE bridge handling the editor side, the CLI doesn't try to prompt interactively for the things we care about, and the diff-approval channel is its own UX.

#### Subscription billing & credential isolation

The CLI binary is allowed for subscription billing per Anthropic's terms (individual use). The Agent SDK is API-key-only per the same terms — we don't use it. To make subscription billing actually happen and not fall back to API-key billing silently:

- **Always strip `ANTHROPIC_API_KEY` from the spawned CLI's env.** If the user has it in their shell for unrelated reasons, both the CLI and SDK silently prefer it over OAuth. There's a real-world Nimbalyst incident where a user got billed $100+ on their personal Anthropic account this way; their post-mortem is in their CLAUDE.md.
- Auth via `CLAUDE_CODE_OAUTH_TOKEN` (explicit) or by relying on the user's existing `~/.claude` keychain (implicit). v1 default: implicit, since the user logs in via the regular `claude` CLI once and we inherit their session.
- Optionally set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` to harden against prompt-injection siphoning credentials out of subprocesses.

#### What our entity needs to implement

A small WebSocket server (a few hundred lines of Node — we can lift the protocol structure directly from `../claudecode-nvim/lua/claudecode/server/`), plus handlers for the 8 required tools above. The handlers integrate with our workspace surface (CodeMirror diffs for `openDiff`, the file tree for `getOpenEditors`, etc.) and our chat UI (selection events feed into Claude's context).

The `@anthropic-ai/claude-agent-sdk` npm package is *not* a runtime dependency — but we may import its TypeScript message types as a convenience for typing our own stream-json parser. That's a build-time-only use and doesn't trigger any of the SDK's API-key-only enforcement.

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
  - `@electric-ax/agents-server` (self-hosted control plane, run as a sidecar)
  - `@electric-ax/durable-streams-state-beta` (the durable streams state primitive used by the runtime)
  - `agent-session-protocol` (`loadSession` only — used by the optional one-shot importer for pre-existing terminal sessions; **not** on the live event path, which uses stream-json stdout directly)
  - `@tanstack/db` (or whatever the Electric runtime expects) for client-side reactive collections projected from the entity stream
- `codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-*` (markdown, javascript, json, css, html, python, etc.), `@codemirror/merge` — for the file editor and diffs.
- `zod` — schema definitions for the entity (already a transitive dep but we use it directly).
- `chokidar` (optional) — watch workspace for external file changes (NB: the entity already does this for the JSONL session file via `agent-session-protocol`; this is for the workspace tree).

Dropped (vs. chat template):

- AI SDK (`ai`, `@ai-sdk/*`), AI Gateway, Anthropic/OpenAI/Google providers — replaced by Claude Code CLI via the custom entity.
- `nuxt-auth-utils`, `@nuxthub/core`, `nuxt-charts`, `nuxt-csurf`, `drizzle-orm`, `@libsql/client`, `@vercel/blob`, `striptags`, `motion-v` — out of scope for v1. (Session metadata storage is no longer an issue for us — the entity stream is the durable store.)

Dropped from v1 (vs. editor template):

- `@tiptap/*`, `tiptap-extension-code-block-shiki` — deferred. We plan to add `UEditor` back later as an optional WYSIWYG mode for markdown only (see "Future: optional WYSIWYG mode for markdown" above).
- `y-partykit`, `yjs` — out of scope; we are not building real-time collaboration.

## Build sequence

A pragmatic order to get to a usable v1:

1. **Skeleton.** New Nuxt app, Nuxt UI, Tailwind, dashboard layout. Sidebar with stub sessions and stub file tree.
2. **Workspace plumbing.** Workspace root via env var. `/api/workspace/tree` and `/api/workspace/file` endpoints with proper path-safety. Tree renders, click loads file content.
3. **Read-only file viewer.** CodeMirror in read-only mode with language detection by extension; markdown files use the Comark renderer instead.
4. **Editable file viewer.** Mode toggle, save (PUT), unsaved-state indicator, keyboard shortcut.
5. **Electric Agents bring-up + `claude-code-cli` entity + IDE bridge.**
   1. Run `@electric-ax/agents-server` locally (sidecar). Verify the dashboard / API responds.
   2. In the Nuxt app, mount the runtime webhook: a Nitro route at `/_electric/builtin-agent-handler` that delegates to `runtime.onEnter(req, res)`.
   3. Define the `claude-code-cli` entity (skeleton adapted from `coding-session.ts` at commit `65f0cf0`, run-loop replaced with the SDK-free direct-CLI invocation described above), register it on the runtime, call `runtime.registerTypes()` once the server is listening.
   4. **Smoke test the IDE bridge composition first** (the load-bearing assumption): write a one-off script that spawns `claude -p --output-format stream-json --input-format stream-json` with `CLAUDE_CODE_SSE_PORT` + `ENABLE_IDE_INTEGRATION=true` and a stub WebSocket server that just logs incoming connections. Verify the CLI connects and that stream-json output still flows on stdout. If yes → continue. If no → fall back to interactive-mode invocation.
   5. Implement the IDE bridge WebSocket server in the entity (lift the protocol structure from `../claudecode-nvim/lua/claudecode/server/`; rewrite in TypeScript). Implement the 8 required tools, with `openDiff` wired to the workspace surface's diff component.
   6. Wire the chat UI to subscribe to the entity's durable stream and project the `events` collection into the existing `UChatMessages` rendering.
   7. Send a prompt via the runtime client; verify the CLI runs in the workspace, stream-json events flow into the durable stream, the UI updates live, and an Edit tool call routes through `openDiff` and lands in the workspace surface for approval.
6. **Rich message rendering.** Wire up `MessageContent.vue` pattern: text via Comark, reasoning via `UChatReasoning`, tools via `UChatTool` with custom components for Read/Edit/Write/Bash.
7. **Diff visualization.** Edit/Write tool parts render an inline diff preview; clicking opens the workspace surface in diff mode (`@codemirror/merge`).
8. **Session persistence.** Resume sessions, list them in the sidebar, title generation (first user message → short title), delete.
9. **Polish.** Loading states, errors, abort, keyboard shortcuts, dark mode (free from Nuxt UI).

## Parallel isolated environments

Beyond the single-workspace UI we've been describing, domo's flagship workflow is **launching parallel isolated Docker environments**, each running an independent copy of the user's repo plus their full service stack (DB, redis, electricsql, dev server, etc.), with one or more agent sessions per env. This is the "cloud Claude Code agents" experience, but available locally, on a user's VPS, or in our managed cloud — same codebase, different deployment profile.

### Goals (paraphrased from product spec)

- Run agents in parallel on **fully separate** environments (not just git worktrees in one repo).
- Each env runs the user's `docker-compose.yml` services + dev server, accessible via mapped ports / per-env subdomains in a browser.
- Per-env names map to per-env URLs (private to the user where possible, public where necessary; follow modern cloud-dev-env best practices).
- Lifecycle controls: start, stop, create, delete.
- Multiple agent sessions per env. Sessions are **persistent across env deletion** for historical viewing.
- All agents (across envs and types) have tools for searching/reading other sessions in the system.
- Start a session on desktop, continue on mobile, or vice versa — seamlessly.
- Cleanly support **both self-hosted and managed** deployment, sharing one codebase.
- Mobile app = Capacitor wrapper of the responsive web UI, with native push.

### Project → Environment → Session hierarchy

The data model has three levels:

- **Project** (top): a git repo. Identified by its remote URL (and a display name). Owns defaults: branch, env templates, auth metadata, etc. Multiple envs per project.
- **Environment** (middle): a docker-compose project + a per-env clone of the project's repo at a specific branch. Maps to "a feature/branch I'm working on". Multiple per project.
- **Session** (bottom): an agent conversation. Multiple per env. **Sessions within an env share the env's filesystem** — they all see the same code on disk and can read/edit the same files. Use case: keep separate conversation threads (different problems, different context) without forking the work.

The filesystem-sharing-within-env model is a deliberate design choice. The user's intent for multiple sessions per env is conversation-context isolation, not work isolation — different agents working on aspects of the same feature, with the option to start fresh-context conversations without losing the current state of the code. Concurrent file edits across sessions on the same env *can* trample each other; we surface this in the UI (e.g. "session B just modified this file") via the IDE bridge's existing notifications, but we don't try to prevent it. If a user wants real isolation, they create a new env.

### The "environment" abstraction

An env is:

- A **docker-compose project** that includes:
  - Whatever services the user's `docker-compose.yml` defines (DB, redis, dev server, etc.)
  - A **session host sidecar** (a container we add to the project) with the `claude` CLI binary, Node.js, our IDE-bridge WebSocket implementation, and the runner that spawns CLI subprocesses for each session
- A **persistent named volume** holding the cloned working copy of the project's repo at the env's branch
- An **isolated network** (Docker bridge, per env)
- **Metadata** in the control plane: env id, display name, parent project id, branch, created/updated, current state (running/stopped/idle/error), env vars/secrets, owner

**One session-host container per env, multiple sessions inside.** The session host runs an internal "session runner" daemon (a small Node process) that the entity handlers in the control plane communicate with over a per-env durable stream. When a session is started, the runner spawns a fresh `claude` CLI subprocess in the env's repo dir. All sessions on this env share the IDE-bridge WebSocket server (also running inside the session-host container) — the bridge is a per-env service.

Each session is bound 1:1 to an Electric Agents entity. The entity's durable stream owns the session's full event log; the session-host runner is the workhorse that drives the CLI but doesn't own the persistent state.

### Architecture: control plane + execution plane

Two planes, sharing the same codebase but factored cleanly so they can run in one process (local mode) or split across hosts (VPS, managed):

**Control plane** — the persistent "brain":

- Nuxt app (web UI + API)
- Electric Agents server + runtime (durable streams, entity registry, multi-user collab)
- Durable Streams backend (event log per session/entity)
- Postgres (or SQLite locally) for env metadata, user accounts, settings
- The cross-session-search MCP server (mounted on the Nuxt app, exposed over HTTP to entities)
- Auth (OIDC / OAuth / single-user passcode depending on mode)
- Optionally: Caddy for ingress to per-env subdomains

**Execution plane** — where envs and sessions actually run:

- A Docker daemon. The control plane talks to it via the Docker engine API (over a unix socket locally, or over TLS for remote).
- The set of running compose projects, one per env.
- The session host containers within each env, each running an agent process bound to a specific entity in the control plane's runtime.

The two planes communicate via:

1. **Docker engine API** — control plane creates / starts / stops / deletes envs and session-host containers.
2. **Webhook-routed entity wakes** — when a prompt arrives, the control plane's runtime fires a webhook at the session host's runtime endpoint (or the session host polls / connects out, depending on networking constraints — see below).
3. **Durable stream subscription** — session host writes events; control plane and clients subscribe.
4. **MCP HTTP** — the agent inside the container calls our cross-session-search MCP server on the control plane.

### Authenticating Claude Code inside the env container

We adopt the patterns the [`agent-of-empires`](https://github.com/njbrake/agent-of-empires) sandbox uses, since they solve exactly the in-container subscription-auth problem cleanly:

- **Bind-mount `~/.claude/` from host to container at `/root/.claude/`**, excluding `projects/` (large, per-project session files we don't need in the sandbox) and `sandbox/` (which we own).
- **macOS Keychain → `.credentials.json`.** On macOS the OAuth tokens live in the Keychain (`Claude Code-credentials`), not on disk. Before starting the container, we read the Keychain entry and write it as `.credentials.json` into our mounted dir. The in-container CLI finds it and authenticates — no token paste, no env-var injection.
- **`IS_SANDBOX=1`** env var: the Claude CLI recognizes this and legitimately permits `--dangerously-skip-permissions` in a sandbox context. Even though our v1 design uses `--permission-mode acceptEdits`, having `IS_SANDBOX=1` set is the right signal to the CLI about the execution context.
- **`GIT_CONFIG_GLOBAL=/root/.sandbox-gitconfig`** with a credential helper that reads `GH_TOKEN` from env. The helper script handles `git push` to GitHub via the user's forwarded GitHub token without needing `gh auth setup-git` inside the container. (Other remote hosts fall through to normal git behavior — important so unrelated remotes aren't accidentally hijacked.)
- **Always strip `ANTHROPIC_API_KEY`** from the container env at start. The host user might have it set in their shell for unrelated work; if it's present in the container, the CLI silently routes to API-key billing instead of subscription, which is the documented Nimbalyst footgun.

The session-host image inherits from a base sandbox image that includes the `claude` binary, Node.js (for the IDE bridge WebSocket server), git, ripgrep, and standard build tools. We can either pull from `ghcr.io/njbrake/aoe-sandbox:latest` (slim, just the AI CLIs and basics) or build our own that's domo-specific. We start by reusing aoe-sandbox and switch to our own image only if/when we need extras.

### IDE bridge WebSocket: lives in the env container, not the control plane

The bridge runs inside the env's session-host container, on `127.0.0.1:<random-port>`, with the lock file at `/root/.claude/ide/<port>.lock`. The Claude CLI inside the same container reads the lock file and connects to localhost. This is what the protocol expects.

The control plane never speaks the WebSocket protocol directly. Instead:

- **Editor-state notifications IDE → CLI** (`selection_changed`, `at_mentioned`, `getOpenEditors`-style requests): the UI sends them as messages to the entity's inbox; the entity relays them to the in-container bridge over the per-env runner stream; the bridge issues the corresponding WebSocket notification to the CLI.
- **Tool calls CLI → IDE** (`openFile`, `getCurrentSelection`, `openDiff`, ...): the bridge handles the read-only ones locally (cache + last-known editor state from the inbox messages it received). For the **blocking `openDiff`** call, the bridge writes a `pending_diff_decision` event into the entity's durable stream, parks the WebSocket request, and waits. The UI sees the event, renders the diff in the workspace surface, the user clicks accept/reject, the UI sends a `diff_decision` message into the inbox. The entity wakes, the runner forwards the decision to the bridge, the bridge resolves the parked WebSocket request with `FILE_SAVED` or `DIFF_REJECTED`.

This factoring keeps the IDE-bridge protocol exactly as documented (CLI → localhost WebSocket) and uses durable streams as the cross-network primitive — which is what they're for. It also means the control plane and execution plane can run on different machines without any extra plumbing: anything the UI needs to know about an env's editor state is in the durable stream; anything the env's CLI needs to know about UI selections is in the inbox.

### Networking & ingress

Each env's compose project runs services on container-internal ports (e.g. Nuxt dev on `:3000`, Postgres on `:5432`). These need to be exposed to the user's browser. The exposure mechanism varies by deployment mode:

| Mode | Mechanism |
| --- | --- |
| Solo local | Allocate host ports per env/service (e.g. env "feat-x" Nuxt dev on `localhost:35001`); the env detail page lists clickable `http://localhost:<port>` links |
| Self-hosted VPS | Caddy in front, dynamic config: wildcard DNS `*.envs.<user-domain>` with on-demand TLS, route `<service>.<env>.envs.<user-domain>` to the right container:port |

**Auth on private envs:** Caddy `forward_auth` into the control plane validates the user's session cookie before letting traffic through. Local mode doesn't need this (you're on your machine).

**Why Caddy.** Wildcard DNS + on-demand TLS in a few lines of config; well-understood; works in containers; easy to template per-env routes from the control plane. Traefik is the alternative (more featureful but heavier); we'd need to evaluate but Caddy is the lean default.

> **Pending detailed design — next session.** The table above sketches the user-visible mechanism, but the exact runtime architecture for exposing each env's compose-stack services is the next major design discussion. Things to work through:
>
> - How the control plane discovers each env's exposed compose ports (parse the user's `docker-compose.yml`? require a hint in `.domo/env.yaml`? expose-by-default vs. opt-in?).
> - How port allocation works in solo-local mode (host-port range, collision handling, persistence across restarts).
> - The exact Caddyfile / Caddy admin-API templating for VPS mode — wildcard cert provisioning, route reload semantics on env start/stop, websocket and SSE pass-through (dev servers and HMR rely on this).
> - CORS and auth for the env's services as seen by the user's browser (e.g. front-end at `nuxt.feat-x.envs.user.com` calling API at `api.feat-x.envs.user.com` — same-site? subdomain cookies? forward-auth gotchas).
> - How the chat UI links into open services (clickable per-service URLs in the env detail page; "open in browser" affordance).
> - Service health detection (port reachability check before exposing; dev-server warm-up race).
> - Dev-server hot-reload across the proxy (HMR over websockets through Caddy; should "just work" but warrants explicit verification).
>
> Don't expand this in implementation until we've designed it as a concrete unit. For now the build sequence treats env service exposure as "step exists" without committing to the internals.

### Remote access for self-hosted (laptop or VPS)

For multi-device use (start session on laptop, continue on phone), the control plane must be reachable from the device the user is currently on. Three options, all supported, picked by the user:

1. **Cloudflare Tunnel (built-in helper).** A free option for laptop hosting that gives you a stable URL without owning a domain. We ship a one-click setup in the control plane settings: it walks the user through `cloudflared tunnel login`, creates a named tunnel, writes a config that points `<chosen-name>.<their-cf-domain>` (or a `*.trycloudflare.com` hostname for the no-domain case) at the control plane port, and runs the tunnel as a child process or systemd unit. This is the path for users who want multi-device but don't have a VPS.
2. **Tailscale (DIY).** We document how to put the host on a tailnet and access the control plane via the tailnet IP. No code from us — just a guide. Best for users already on Tailscale.
3. **Direct exposure (VPS or self-hosted with a domain).** User runs the control plane on a server with a public IP and a DNS record. We provide a Caddy template for the wildcard env routes plus the control plane host. This is the most flexible option and the natural choice for VPS deployments.

These compose with the Networking & ingress table above: the env subdomains and the control plane both ride whatever exposure mechanism the user picked.

We are explicitly **not building a managed/cloud-hosted offering** in this scope. The product is self-hosted only (laptop or user's VPS).

### Sessions, history, and multi-device continuation

Sessions are Electric Agents entities. Their entire event log lives in durable streams (in the control plane). The session-host container holds only the *running process* — the in-flight CLI invocation, the IDE bridge state, the cwd. **All persistent state is in the control plane.**

Consequences:

- **Session outlives env.** Deleting the env tears down containers and volumes; the entity's durable stream is unaffected (or marked "env deleted" but still readable).
- **Multi-device works for free.** Desktop UI and Capacitor mobile app both subscribe to the same entity stream via the durable streams subscription URL. They are equivalent views. Type a prompt on phone, see the agent run in the still-active env, see the events flow on both clients.
- **Read-only historical mode.** When env is deleted, the entity is still in the registry, the stream is still subscribable; the UI shows it as archived but readable.
- **Resumption.** A session whose env still exists can resume normally. A session whose env was deleted can be "rehydrated" into a fresh env (clone of the same source repo) — this is essentially "fork from this point" in the durable-streams sense.

### Cross-session search and shared agent memory

All agents in the system get a custom MCP tool, served by the control plane:

- `domo_search_sessions` — semantic search across all entities' message + tool-call histories that the user has access to. Returns matching session ids, snippets, links.
- `domo_read_session` — pull full text of another session's transcript (subject to perms).
- `domo_list_envs` — list envs the user owns and their current state.

These are exposed via a single `--mcp-config` JSON pointing at the control plane's HTTP MCP endpoint. The control plane implements the MCP server using our existing entity-stream access.

This is also the natural place for agent-introspection tools later (search by tool calls, by file paths touched, etc.).

### Deployment modes

Two modes, one codebase, configured by a deployment-mode profile:

#### 1. Solo local

- Control plane runs on the user's laptop (`pnpm dev` in the domo repo, or a single-binary distribution later).
- Execution plane = local Docker (Docker Desktop / OrbStack).
- Ingress = host port allocation; UI lists `localhost:<port>` links.
- Auth = optional single-user passcode.
- Multi-device = available via the Cloudflare Tunnel built-in helper or via Tailscale (see "Remote access for self-hosted" above).

#### 2. Self-hosted VPS

- User installs domo via a `docker compose up -d` recipe on their VPS. The recipe ships:
  - Control plane (Nuxt + Electric Agents + Postgres + durable streams)
  - Caddy with wildcard-domain config templated from the user's chosen domain
  - Docker socket bind-mount so the control plane can manage envs as compose projects on the same host
- Auth = OIDC against the user's IdP, or built-in user accounts.
- Multi-device = first class (the VPS is always reachable on its public IP / domain).
- Backups, updates, scaling = user's responsibility.

The deployment-mode profile is a small config object the control plane reads at startup. Same code paths; different defaults for ingress, auth, env vars passed to the session-host container. **A managed (cloud-hosted) offering is explicitly out of scope.**

### Mobile app

A Capacitor wrapper around the same Nuxt app:

- The web UI is responsive and works on phone-sized viewports first-class — same pages, same routes.
- Native shell adds: push notifications, biometric unlock, native keychain for stored auth, shortcuts/share-sheet integration.
- App config screen accepts: the URL of the user's control plane (whatever they exposed it at — Cloudflare Tunnel hostname, Tailscale IP, public domain, etc.) + their auth credentials.
- Same auth mechanism as web.

The Capacitor app does not contain its own copy of the agent runtime — it's a thin client that subscribes to the user's self-hosted control plane.

### Decisions and open questions

#### Decided

1. **One session-host container per env; multiple sessions inside.** Sessions within an env share filesystem; the project → env → session hierarchy is the source of isolation (a new env if you want isolation, a new session if you just want a fresh conversation context). Concurrent edits across sessions can step on each other; we surface the situation in the UI but don't prevent it.
2. **Always git-clone-from-origin.** Envs clone from the project's configured remote at create time. The user `git push` to sync work back. No bind-mount of host directories; no push-from-local sync agents in v1. (Working with projects that don't have a remote yet is a real ask but defers to v2 — we haven't decided the right shape for it.)
3. **Tunneling supported as a built-in helper.** Cloudflare Tunnel one-click setup for laptop self-hosters who want multi-device without a VPS. Tailscale documented but no special integration. Direct exposure (VPS with public IP/domain) is the most flexible path. See "Remote access for self-hosted".
4. **No managed mode.** Self-hosted only — laptop or user's VPS. The mobile app points at the user's chosen control plane URL.
5. **Code only against the Docker engine API, never shell out to the `docker` CLI.** Lets us swap the connection between local socket and remote daemon without changing call sites.
6. **Docker-in-Docker is out of scope for v1.** Some user services (testcontainers, etc.) want to spawn their own containers — documented as a limitation; users with this requirement can configure DIND themselves on a VPS.
7. **Env templates live in the repo as `.domo/env.yaml`.** Compose-file path, default env vars, post-clone setup commands. Version-controlled with the project. The control plane reads it at env-create time.
8. **Secrets per env are encrypted at rest in the control plane DB**, injected as env vars per the user's compose-file mapping at container start.
9. **Explicit start/stop lifecycle.** Stop = compose `down` (volumes preserved). Start = compose `up` from the same volumes. Idle envs auto-stop after configurable inactivity (default off in solo local; on in VPS with a long timeout).

#### Open

- **No-remote projects (post-v1).** Users who want to start working before pushing to a remote. Possible shapes: an internal hosted git remote that we run inside the control plane (simple, gives the same git-clone-from-origin pathway); or initial bind-mount with a "promote to remote" step; or push-from-local sync agent. To revisit when v1 is in users' hands.
- **Concurrent-edit conflict surfacing within an env.** What does the UI show when two sessions on the same env are about to edit the same file? Lightweight: a "session B touched this file 3s ago" badge. Heavier: a soft lock. Open until we have user behavior data; the IDE bridge already gives us the signals we need to implement either.
- **Cross-env tool perms.** The `domo_search_sessions` / `domo_read_session` tools span envs. Do we let agents read sessions from envs they're not running in by default, or require explicit access? Lean default-allow within a single user's data, but worth thinking about when we add multi-user support.

## Public documentation (deliverable, written alongside implementation)

Domo is a self-hosted product, so the experience of installing, configuring, and operating it is part of the product. We write the public docs as we build, not after, in `domo/docs/site/` as plain markdown files ready to be rendered as a docs website later (Nuxt Content / Astro Starlight / VitePress — TBD when we get to it; the markdown format stays portable across choices).

Pages we know we'll need:

- **Getting started.** Five-minute path to a running domo on a laptop: prerequisites (Docker Desktop / OrbStack), install the control plane, log in to the `claude` CLI once on the host, create a first project, create a first env, send a first prompt.
- **Installation: laptop.** macOS/Linux details, Docker setup, `claude` CLI install + login, optional Cloudflare Tunnel for remote access.
- **Installation: VPS.** `docker compose up -d` recipe, DNS records, Caddy config, OIDC/auth setup, persistence directories, backups guidance, update process.
- **Concepts.** Project / Environment / Session hierarchy explained at user level; what each is for; when to make a new env vs. a new session.
- **Working with environments.** Creating, starting, stopping, deleting; configuring `.domo/env.yaml`; how the user's `docker-compose.yml` is consumed; secrets and env vars; viewing logs; accessing services in a browser.
- **Working with sessions.** Starting, the chat UI, the workspace surface, diff approval flow, multi-session-per-env semantics and the concurrent-edit caveat, cross-session search.
- **Remote access for self-hosted.** The three paths (Cloudflare Tunnel, Tailscale, direct exposure) with concrete setup steps for each. Use cases for each. The trade-offs.
- **Subscription billing & credentials.** How `claude` CLI subscription auth flows from the host into the env containers (`~/.claude/` mount, macOS Keychain extraction). What `IS_SANDBOX=1` does. What happens with `ANTHROPIC_API_KEY` and why we strip it. Recovering from auth failures.
- **Configuring runtime dependencies.** This is one of the trickiest pages — explain how user services declared in their `docker-compose.yml` participate in an env, how networks compose with the session host, port-allocation behavior, what a typical "Nuxt + Postgres + Redis" config looks like end-to-end. Include the gotchas (DIND not supported in v1, host port collisions on solo-local, etc.).
- **Mobile app.** Pointing it at a self-hosted control plane URL, auth flow, push-notification setup.
- **Troubleshooting.** "My env won't start", "Claude isn't authenticating in the container", "I can't see my dev server in the browser", "Cloudflare Tunnel disconnected", common errors and fixes.
- **Reference.** Configuration files (`.domo/env.yaml` schema, control plane settings.json), CLI flags, env vars, supported Docker versions.

Every implementation step that lands in `domo/` should land its corresponding doc page in the same change. We avoid the "ship now, document later" trap.

## Pending discussions for next session

Items deferred to the next working session, with enough context for the next session's start:

1. **Per-env service exposure architecture (detailed design).** See the "Pending detailed design — next session" callout in the *Networking & ingress* section above. The user-visible mechanism is sketched (port-mapping in solo-local, Caddy wildcard subdomains in VPS); the runtime internals are not. This is the next thing to design as a self-contained unit before we start writing exposure code.

2. **Auth and multi-user.** The doc currently assumes single-user self-hosted. We need to design the multi-user story end to end:
   - Account model (single-user vs. team vs. org), invitations, roles.
   - Auth options per deployment mode: passcode (solo-local), OIDC against external IdP (VPS), built-in user accounts (VPS).
   - Session sharing and visibility — who can see whose sessions, and how that intersects with cross-session search tools and the project/env hierarchy.
   - Multi-user-in-one-session flows (the Durable Sessions promise: humans collaborating with the agent in real time) — UI, presence, prompt attribution wrapping (`[from @alice]:` already designed), conflict semantics.
   - Auth for env subdomains via Caddy `forward_auth` into the control plane — how the cookie/JWT flows.
   - Mobile app auth: token storage, device approval, revocation.
   - This affects the data model (entity ACLs in Electric Agents, the durable streams, the events collection schema), so it's worth designing before adding heavy multi-user assumptions to code.

3. **UI layout and screens.** The *Layout*, *Chat surface*, and *Workspace surface* sections describe the in-session two-pane shell, but we have not designed the surrounding navigation: the project picker / dashboard, the env list and per-env entry screen, the session list within an env, settings (workspace path, Claude auth, exposed services, deployment-mode-specific knobs), and the empty/onboarding states for solo-local vs. VPS. We need to enumerate the screens, decide the primary navigation model (sidebar, top-level routes, command palette), and lock how the Project → Environment → Session hierarchy maps onto URLs and breadcrumbs — including how the mobile app collapses this. Worth doing before we wire pages, since it affects route structure and which Nuxt UI primitives we lean on.

4. (Carry-over) The smaller open questions still listed under *Decisions and open questions* in the env section — no-remote projects, concurrent-edit conflict surfacing, cross-env tool perm defaults — are not blocking and can be picked up opportunistically.

When the next session starts, the natural order is **(1) → (2)**: settle ingress first because auth is layered on top of it (Caddy `forward_auth` is the integration point), then design auth on the now-concrete ingress. (3) can slot in alongside or after, since UI design is largely independent of the ingress/auth internals.

## Open questions

- Do we resume sessions via `claude --resume <id>` and let the CLI own history, or do we mirror history in our DB? **Resolved:** both, with split source-of-truth — Claude session file owns "what Claude sees on resume", our Durable-Sessions-shaped event log owns "what the room sees". See "Session storage" section.
- Do we need a "workspace switcher" in v1, or is a single workspace per app instance fine? Probably the latter; multi-workspace can be a follow-up.
- For the editor: is `view` vs. `edit` mode toggle right, or should we just always be in edit mode for non-`.md` files and have a separate "preview" toggle for markdown? Lean toward the latter. Whatever we pick should leave room for a future "Source / WYSIWYG" axis on markdown files (see post-v1 note above).
- How do we surface agent edits *while the agent is still running* — block the user from editing the same file, or merge?
