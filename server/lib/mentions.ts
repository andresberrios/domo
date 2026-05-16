/**
 * `@`-mention indexing + server-side expansion (design "Chat input
 * affordances"). The chat input shows a popup of candidates; the user's
 * text carries bare `@tokens`; `sessions.prompt` calls `expandMentions`
 * so the CLI receives real context instead of a chip token.
 *
 * Token kinds:
 *  - `@<path>` / `@<dir>/` — worktree file/folder (git-tracked or
 *    untracked-not-ignored); expands to a fenced contents / listing block.
 *  - `@git-changes` — combined uncommitted diff vs HEAD.
 *  - `@<sha>` — a commit-ish (7–40 hex); expands to `git show`.
 *  - `@http(s)://…` — passed through with the `@` stripped (the CLI /
 *    WebFetch handles fetching).
 *
 * Anything that doesn't resolve is left verbatim — expansion never errors
 * a send. Per-mention and per-prompt size caps keep context bounded.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { safeResolve, languageForPath } from './workspace'
import {
  gitListPaths,
  gitRecentCommits,
  gitDiffWorking,
  gitShowCommit,
} from './git'

export interface MentionItem {
  kind: 'file' | 'folder' | 'git' | 'commit'
  /** The token inserted after `@` (no leading `@`). */
  value: string
  label: string
  description?: string
}

const SHA_RE = /^[0-9a-f]{7,40}$/i
const URL_RE = /^https?:\/\//i
/** Per-mention embedded-content cap, and per-prompt expansion count cap. */
const MAX_EMBED_BYTES = 64 * 1024
const MAX_EXPANSIONS = 20

function clip(s: string): string {
  if (s.length <= MAX_EMBED_BYTES) return s
  return s.slice(0, MAX_EMBED_BYTES) + '\n… (truncated)'
}

/** Candidates for the `@` popup, ranked by a simple substring match. */
export async function searchMentions(
  worktree: string,
  query: string,
  limit = 25,
): Promise<MentionItem[]> {
  const q = query.toLowerCase()
  const items: MentionItem[] = [
    {
      kind: 'git',
      value: 'git-changes',
      label: 'git-changes',
      description: 'Current uncommitted changes',
    },
  ]

  const paths = await gitListPaths(worktree)
  const dirs = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  for (const d of dirs) {
    items.push({ kind: 'folder', value: `${d}/`, label: `${d}/` })
  }
  for (const p of paths) {
    items.push({ kind: 'file', value: p, label: p })
  }

  for (const c of await gitRecentCommits(worktree, 20)) {
    items.push({
      kind: 'commit',
      value: c.sha,
      label: c.sha,
      description: c.subject,
    })
  }

  const matched = q
    ? items.filter(
        (i) =>
          i.value.toLowerCase().includes(q) ||
          i.label.toLowerCase().includes(q) ||
          (i.description?.toLowerCase().includes(q) ?? false),
      )
    : items
  // Shorter paths (closer to root) rank first; specials stay on top.
  return matched
    .slice()
    .sort((a, b) => {
      if (a.kind === 'git' && b.kind !== 'git') return -1
      if (b.kind === 'git' && a.kind !== 'git') return 1
      return a.value.length - b.value.length
    })
    .slice(0, limit)
}

async function expandFileOrDir(
  worktree: string,
  rel: string,
): Promise<string | null> {
  let abs: string
  try {
    abs = await safeResolve(worktree, rel, { mustExist: true })
  } catch {
    return null
  }
  let st
  try {
    st = await stat(abs)
  } catch {
    return null
  }
  if (st.isDirectory()) {
    const entries = await readdir(abs, { withFileTypes: true })
    const lines = entries
      .filter((e) => e.name !== '.git')
      .sort((a, b) =>
        a.isDirectory() === b.isDirectory()
          ? a.name.localeCompare(b.name)
          : a.isDirectory()
            ? -1
            : 1,
      )
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return `Directory \`${rel.replace(/\/$/, '')}/\`:\n\n${clip(
      lines.join('\n'),
    )}`
  }
  let content: string
  try {
    content = await readFile(abs, 'utf8')
  } catch {
    return null
  }
  const lang = languageForPath(rel)
  return `File \`${rel}\`:\n\n\`\`\`${lang}\n${clip(content)}\n\`\`\``
}

/** Replace resolvable `@tokens` with their content; leave the rest as-is. */
export async function expandMentions(
  worktree: string,
  text: string,
): Promise<string> {
  const re = /(^|\s)@([^\s]+?)([.,;:!?]*)(?=\s|$)/g
  let out = ''
  let last = 0
  let count = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    const [full, lead, rawToken, trail] = m
    const token = rawToken!
    out += text.slice(last, m.index)
    last = m.index + full.length

    let replacement: string | null = null
    if (count < MAX_EXPANSIONS) {
      if (URL_RE.test(token)) {
        replacement = token // strip the '@', pass the URL through
      } else if (token === 'git-changes') {
        const diff = await gitDiffWorking(worktree)
        replacement = `Uncommitted changes:\n\n\`\`\`diff\n${clip(
          diff || '(no uncommitted changes)',
        )}\n\`\`\``
      } else {
        const fileBlock = await expandFileOrDir(worktree, token)
        if (fileBlock != null) {
          replacement = fileBlock
        } else if (SHA_RE.test(token)) {
          const show = await gitShowCommit(worktree, token)
          if (show != null) {
            replacement = `Commit \`${token}\`:\n\n\`\`\`\n${clip(
              show,
            )}\n\`\`\``
          }
        }
      }
    }

    if (replacement == null) {
      out += lead + '@' + token + (trail ?? '')
    } else {
      out += lead + replacement + (trail ?? '')
      count++
    }
  }
  out += text.slice(last)
  return out
}
