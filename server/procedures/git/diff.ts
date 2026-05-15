import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { GitError, gitShow } from '../../lib/git'
import {
  MAX_READ_BYTES,
  languageForPath,
  looksBinary,
  resolveEnvWorktree,
  safeResolve,
} from '../../lib/workspace'

/**
 * Before/after text pair for one changed file, fed to the CodeMirror merge
 * component (the same one agent-diff review will reuse in Phase 3).
 *
 *   staged   → HEAD blob   vs index blob
 *   unstaged → index blob (or HEAD, or empty for untracked) vs working file
 */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    path: z.string(),
    staged: z.boolean(),
  }),
  output: z.object({
    path: z.string(),
    language: z.string(),
    binary: z.boolean(),
    original: z.string(),
    modified: z.string(),
  }),
  handler: async ({ input }) => {
    const { worktree } = await resolveEnvWorktree(input.envId)

    let original = ''
    let modified = ''
    try {
      if (input.staged) {
        original = (await gitShow(worktree, 'HEAD', input.path)) ?? ''
        modified = (await gitShow(worktree, '', input.path)) ?? '' // `:path` = index
      } else {
        const indexed = await gitShow(worktree, '', input.path)
        original = indexed ?? (await gitShow(worktree, 'HEAD', input.path)) ?? ''
        const abs = await safeResolve(worktree, input.path, { mustExist: false })
        try {
          const buf = await readFile(abs)
          if (buf.length > MAX_READ_BYTES || looksBinary(buf)) {
            return {
              path: input.path,
              language: languageForPath(input.path),
              binary: true,
              original: '',
              modified: '',
            }
          }
          modified = buf.toString('utf8')
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          modified = '' // deleted in the worktree
        }
      }
    } catch (e) {
      if (e instanceof GitError) {
        throw createError({ statusCode: 422, statusMessage: e.message })
      }
      throw e
    }

    const binary = original.includes('\0') || modified.includes('\0')
    return {
      path: input.path,
      language: languageForPath(input.path),
      binary,
      original: binary ? '' : original,
      modified: binary ? '' : modified,
    }
  },
})
