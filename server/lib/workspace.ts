/**
 * Workspace helpers — resolve an env's worktree on the host filesystem and
 * enforce path-safety for every file operation.
 *
 * The worktree is a host-side directory (`<project_root>/.worktrees/<env>`,
 * Coast's default) so Domo reads/writes it directly with `node:fs` rather
 * than round-tripping coastd. Every path the UI sends is *relative to the
 * worktree root*; `safeResolve` is the single chokepoint that rejects
 * absolute paths, `..` escapes, and symlinks that point outside the tree.
 */
import { realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { getEnv, defaultWorktreePath, type EnvRow } from './envs'
import { getProject, type ProjectRow } from './projects'

export interface ResolvedEnv {
  env: EnvRow
  project: ProjectRow
  /** Absolute, symlink-resolved worktree root. */
  worktree: string
}

/**
 * Look up the env + project and the canonical worktree path. Throws a 404
 * if the env/project is gone, or 409 if the worktree doesn't exist on disk
 * yet (env created but never provisioned).
 */
export async function resolveEnvWorktree(envId: string): Promise<ResolvedEnv> {
  const env = getEnv(envId)
  if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
  const project = getProject(env.projectId)
  if (!project) throw createError({ statusCode: 500, statusMessage: 'project missing' })

  const wt = env.worktreePath ?? defaultWorktreePath(project.rootPath, env.name)
  let worktree: string
  try {
    worktree = await realpath(wt)
  } catch {
    throw createError({
      statusCode: 409,
      statusMessage: `worktree not found at ${wt} — provision the env first`,
    })
  }
  return { env, project, worktree }
}

/**
 * Resolve a worktree-relative path to an absolute path, rejecting any
 * escape. `mustExist: false` (default for writes) realpath-checks the
 * parent directory instead of the target so brand-new files are allowed.
 */
export async function safeResolve(
  worktree: string,
  relPath: string,
  opts: { mustExist?: boolean } = {},
): Promise<string> {
  const cleaned = String(relPath ?? '').replace(/^[/\\]+/, '')
  const segments = cleaned.split(/[/\\]+/).filter(Boolean)
  if (segments.some((s) => s === '..')) {
    throw createError({ statusCode: 400, statusMessage: 'path escapes the worktree' })
  }

  const resolved = resolve(worktree, cleaned)
  if (resolved !== worktree && !resolved.startsWith(worktree + sep)) {
    throw createError({ statusCode: 400, statusMessage: 'path escapes the worktree' })
  }

  // Symlink-traversal guard: the resolved target (or, for new files, its
  // parent) must still realpath inside the worktree.
  const guard = async (p: string) => {
    const real = await realpath(p)
    if (real !== worktree && !real.startsWith(worktree + sep)) {
      throw createError({ statusCode: 400, statusMessage: 'path escapes the worktree via symlink' })
    }
  }
  try {
    await guard(resolved)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      if (opts.mustExist) {
        throw createError({ statusCode: 404, statusMessage: 'file not found' })
      }
      await guard(dirname(resolved))
    } else {
      throw e
    }
  }
  return resolved
}

/** 1 MiB — files larger than this are returned as a `tooLarge` stub. */
export const MAX_READ_BYTES = 1024 * 1024

/** Heuristic binary sniff: a NUL byte in the leading bytes. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/**
 * Map a file name to a short language id. The client turns this id into a
 * CodeMirror language extension (`app/utils/language.ts`); keeping the map
 * here too lets git-diff reuse it without a round trip.
 */
export function languageForPath(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? ''
  const lower = name.toLowerCase()
  const byName: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    'coastfile': 'toml',
    'coastfile.toml': 'toml',
  }
  if (byName[lower]) return byName[lower]
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  const byExt: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', json5: 'json', jsonc: 'json',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    html: 'html', htm: 'html', vue: 'vue', svelte: 'html',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    py: 'python', pyi: 'python',
    rs: 'rust', go: 'go',
    c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
    java: 'java', kt: 'java',
    php: 'php',
    sql: 'sql',
    yaml: 'yaml', yml: 'yaml',
    xml: 'xml', svg: 'xml',
    toml: 'toml', ini: 'toml', cfg: 'toml',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    txt: 'text', log: 'text', env: 'text',
  }
  return byExt[ext] ?? 'text'
}

export function isMarkdownPath(path: string): boolean {
  return languageForPath(path) === 'markdown'
}

export async function pathKind(abs: string): Promise<'file' | 'dir' | 'other'> {
  const s = await stat(abs)
  if (s.isDirectory()) return 'dir'
  if (s.isFile()) return 'file'
  return 'other'
}
