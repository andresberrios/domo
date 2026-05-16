/**
 * Slash-command discovery + custom-command expansion for the chat prompt.
 *
 * Two kinds of slash command (design "Chat input affordances"):
 *  - **Built-in** — a fixed list handed straight to the `claude` CLI as
 *    literal text (`/clear`, `/compact`, …). Domo never expands these.
 *  - **Custom** — `*.md` files under the env worktree's `.claude/commands/`
 *    (project) and the host's `<claudeConfigDir>/commands/` (user). The
 *    filename (sans `.md`) is the command name; the first `#` heading is
 *    the description; `$ARGUMENTS` in the body is substituted at send time.
 *    Project commands win over user commands on a name collision.
 *
 * The popup lists builtin ∪ custom; `sessions.prompt` runs
 * `expandSlashCommand` so a custom invocation ships the file body (the CLI
 * only resolves custom commands in its interactive REPL, not in
 * `-p` stream-json mode, so Domo must expand).
 *
 * Mirrors the audited `claude-code-chat-codeflow` impl
 * (`utils/slash-commands.ts`, `service/customCommandService.ts`).
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SlashCommandDef {
  /** Includes the leading slash, e.g. `/review`. */
  command: string
  description: string
  source: 'builtin' | 'project' | 'user'
}

/** Source: `claude-code-chat-codeflow/src/utils/slash-commands.ts`. */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<{
  command: string
  description: string
}> = [
  { command: '/bug', description: 'Report bugs (sends conversation to Anthropic)' },
  { command: '/clear', description: 'Clear conversation history' },
  { command: '/compact', description: 'Compact conversation with optional focus' },
  { command: '/config', description: 'View/modify configuration' },
  { command: '/cost', description: 'Show token usage statistics' },
  { command: '/doctor', description: 'Check the health of your Claude Code install' },
  { command: '/help', description: 'Get usage help' },
  { command: '/init', description: 'Initialize project with a CLAUDE.md guide' },
  { command: '/login', description: 'Switch Anthropic accounts' },
  { command: '/logout', description: 'Sign out from your Anthropic account' },
  { command: '/memory', description: 'Edit CLAUDE.md memory files' },
  { command: '/pr_comments', description: 'View pull request comments' },
  { command: '/review', description: 'Request code review' },
  { command: '/status', description: 'View account and system statuses' },
  { command: '/terminal-setup', description: 'Install Shift+Enter newline binding' },
  { command: '/vim', description: 'Enter vim mode' },
]

/** Command names are filename-derived; lock them down to a safe charset so
 *  they can never escape the fixed `.claude/commands/` directory. */
const NAME_RE = /^[A-Za-z0-9_-]+$/

function claudeConfigDir(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim()
  return cfg ? cfg : join(homedir(), '.claude')
}

function commandsDir(kind: 'project' | 'user', worktree: string): string {
  return kind === 'project'
    ? join(worktree, '.claude', 'commands')
    : join(claudeConfigDir(), 'commands')
}

function firstHeading(content: string): string {
  const line = content.split('\n', 1)[0]?.trim() ?? ''
  return line.startsWith('#') ? line.replace(/^#+/, '').trim() : line
}

async function scanDir(
  dir: string,
  source: 'project' | 'user',
): Promise<Map<string, SlashCommandDef>> {
  const out = new Map<string, SlashCommandDef>()
  let files: string[]
  try {
    if (!(await stat(dir)).isDirectory()) return out
    files = await readdir(dir)
  } catch {
    return out // missing dir is normal
  }
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const name = file.slice(0, -3)
    if (!NAME_RE.test(name)) continue
    let description = name
    try {
      description = firstHeading(await readFile(join(dir, file), 'utf8')) || name
    } catch {
      /* unreadable — fall back to the name */
    }
    out.set(name, { command: `/${name}`, description, source })
  }
  return out
}

/**
 * Builtins ∪ custom commands for the popup. Precedence on a name collision:
 * project > user > builtin (a custom file shadows a builtin of the same
 * name because `expandSlashCommand` will expand it). Sorted by name.
 */
export async function listSlashCommands(
  worktree: string,
): Promise<SlashCommandDef[]> {
  const byName = new Map<string, SlashCommandDef>()
  for (const b of BUILTIN_SLASH_COMMANDS) {
    byName.set(b.command.slice(1), { ...b, source: 'builtin' })
  }
  const user = await scanDir(commandsDir('user', worktree), 'user')
  for (const [name, def] of user) byName.set(name, def)
  const project = await scanDir(commandsDir('project', worktree), 'project')
  for (const [name, def] of project) byName.set(name, def)
  return [...byName.values()].sort((a, b) =>
    a.command.localeCompare(b.command),
  )
}

async function readCommandBody(
  worktree: string,
  name: string,
): Promise<string | null> {
  for (const kind of ['project', 'user'] as const) {
    try {
      return await readFile(
        join(commandsDir(kind, worktree), `${name}.md`),
        'utf8',
      )
    } catch {
      /* try next location */
    }
  }
  return null
}

/**
 * If `text` is a custom slash-command invocation (`/name [args…]`), return
 * the command file body with `$ARGUMENTS` substituted; otherwise null
 * (built-ins and ordinary prompts pass through unchanged). Project file
 * wins over user file.
 */
export async function expandSlashCommand(
  worktree: string,
  text: string,
): Promise<string | null> {
  const m = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const name = m[1]!
  const args = (m[2] ?? '').trim()
  // A custom file with a builtin's name still shadows it (project intent);
  // if no file exists the builtin/raw text passes through to the CLI.
  const body = await readCommandBody(worktree, name)
  if (body == null) return null
  return body.includes('$ARGUMENTS')
    ? body.split('$ARGUMENTS').join(args)
    : body
}
