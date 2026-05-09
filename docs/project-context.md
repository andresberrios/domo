# Domo — Project Context

## What it is

Domo is a Nuxt app (built with Nuxt UI) that combines two things in one workspace:

1. **An AI chat interface** — a simpler analog to [open-webui](https://github.com/open-webui/open-webui), but scoped to a single backend: the **Claude Code CLI**, invoked in JSONL streaming mode and wrapped by our app. No multi-provider abstraction, no plugin marketplace — just a clean chat UI talking to `claude` over its JSONL protocol.
2. **A simple file workspace** — a stripped-down [Obsidian](https://obsidian.md)-style editor for browsing, reading, and editing files in a project directory. It supports:
   - Markdown viewing/editing
   - Source code viewing/editing with **syntax highlighting only** (no autocomplete, no LSP, no AI assistance inside the editor itself)
   - **Diff visualization** for changes (e.g. proposed by the chat agent, or staged edits)

## What it is not

- Not a multi-LLM chat app. The only backend is Claude Code CLI (JSONL mode).
- Not a full IDE. No autocompletion, no language server integration, no inline AI assist in the editor.
- Not a notes manager with graph view, plugins, sync, etc. — just files on disk.

## Core idea

The chat side and the editor side share the same workspace (a project directory). The agent can read and edit files; the user can review those edits as diffs, accept/reject them, and continue editing manually. It's a thin, opinionated shell over the Claude Code CLI plus a file workspace.

## Stack

- **Framework:** Nuxt (latest)
- **UI:** Nuxt UI
- **Agent backend:** Claude Code CLI in JSONL mode, spawned as a child process from a Nuxt server route
- **File access:** Nuxt server routes operating on a configured workspace directory
