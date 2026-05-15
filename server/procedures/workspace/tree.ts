import { z } from 'zod'
import { readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import { gitCheckIgnore } from '../../lib/git'
import { resolveEnvWorktree, safeResolve } from '../../lib/workspace'

const Entry = z.object({
  name: z.string(),
  /** Worktree-relative, POSIX-separated. */
  path: z.string(),
  isDir: z.boolean(),
})

/**
 * One directory level of the env's worktree, `.gitignore`-aware. Lazy by
 * design — the UI expands a node and asks for that node's `dir`, so big
 * repos never get walked. `.git` is always hidden; everything else is
 * filtered through `git check-ignore` so the tree matches what git tracks.
 */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    /** Worktree-relative dir to list; '' / omitted = worktree root. */
    dir: z.string().optional(),
  }),
  output: z.object({
    dir: z.string(),
    entries: z.array(Entry),
  }),
  handler: async ({ input }) => {
    const { worktree } = await resolveEnvWorktree(input.envId)
    const relDir = (input.dir ?? '').replace(/^[/\\]+|[/\\]+$/g, '')
    const absDir = await safeResolve(worktree, relDir, { mustExist: true })

    const raw = await readdir(absDir, { withFileTypes: true })
    const candidates = raw
      .filter((e) => !(relDir === '' && e.name === '.git'))
      .map((e) => {
        const rel = relDir ? posix.join(relDir, e.name) : e.name
        let isDir = e.isDirectory()
        if (e.isSymbolicLink()) {
          // Symlinks are listed but never expandable — keeps the tree
          // inside the worktree (safeResolve guards reads anyway).
          isDir = false
        }
        return { name: e.name, path: rel, isDir }
      })

    const ignored = await gitCheckIgnore(
      worktree,
      candidates.map((c) => (c.isDir ? `${c.path}/` : c.path)),
    )
    const entries = candidates
      .filter((c) => !ignored.has(c.isDir ? `${c.path}/` : c.path) && !ignored.has(c.path))
      .sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
      )

    return { dir: relDir, entries }
  },
})
