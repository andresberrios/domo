import { z } from 'zod'
import { stat, writeFile } from 'node:fs/promises'
import { resolveEnvWorktree, safeResolve } from '../../lib/workspace'

/**
 * Save an edited file back into the env's worktree. Path-safe (no escape,
 * no symlink-out). We only overwrite existing files — the editor opens a
 * file then saves it; creating new files is a separate flow we don't need
 * for v1.
 */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    path: z.string(),
    content: z.string(),
  }),
  output: z.object({
    path: z.string(),
    size: z.number().int(),
  }),
  handler: async ({ input }) => {
    const { worktree } = await resolveEnvWorktree(input.envId)
    const abs = await safeResolve(worktree, input.path, { mustExist: true })

    const s = await stat(abs)
    if (!s.isFile()) {
      throw createError({ statusCode: 400, statusMessage: 'not a file' })
    }

    await writeFile(abs, input.content, 'utf8')
    const after = await stat(abs)
    return { path: input.path, size: after.size }
  },
})
