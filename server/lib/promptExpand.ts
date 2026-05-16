/**
 * Server-side prompt expansion. Run by the **entity** at execution time
 * (not by `sessions.prompt`) so the durable inbox / chat transcript keeps
 * exactly what the user typed (`/review`, `@file`) while the `claude`
 * child receives the resolved text. Two transforms, in order:
 *
 *  1. **Custom slash command** — if the whole prompt is `/name [args]` and
 *     a custom command file exists, replace it with the file body
 *     (`$ARGUMENTS` substituted). Built-ins / ordinary text pass through.
 *  2. **`@`-mentions** — `@file`, `@dir/`, `@git-changes`, `@<sha>`,
 *     `@https://…` are expanded inline to their actual contents / diff
 *     text so the CLI sees real context, not a chip token.
 *
 * Expansion never throws a turn: an unresolvable worktree or token leaves
 * the text (or that token) verbatim.
 */
import { realpath } from 'node:fs/promises'
import { expandSlashCommand } from './claudeCommands'
import { expandMentions } from './mentions'

export async function expandInWorktree(
  worktreePath: string,
  text: string,
): Promise<string> {
  let worktree: string
  try {
    // safeResolve compares against a canonical root, so realpath the
    // worktree first (matches resolveEnvWorktree's behavior).
    worktree = await realpath(worktreePath)
  } catch {
    return text
  }
  const slash = await expandSlashCommand(worktree, text)
  const base = slash ?? text
  return expandMentions(worktree, base)
}
