import { z } from 'zod'
import { readFile, stat } from 'node:fs/promises'
import {
  MAX_READ_BYTES,
  languageForPath,
  looksBinary,
  resolveEnvWorktree,
  safeResolve,
} from '../../lib/workspace'

/**
 * Read one file from the env's worktree for the editor / markdown view.
 * Binary files and anything over `MAX_READ_BYTES` come back as a stub
 * (no `content`) so the SPA can show a placeholder instead of choking on
 * a megabyte of bytes it can't render.
 */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    path: z.string(),
  }),
  output: z.object({
    path: z.string(),
    language: z.string(),
    size: z.number().int(),
    binary: z.boolean(),
    tooLarge: z.boolean(),
    content: z.string().nullable(),
  }),
  handler: async ({ input }) => {
    const { worktree } = await resolveEnvWorktree(input.envId)
    const abs = await safeResolve(worktree, input.path, { mustExist: true })

    const s = await stat(abs)
    if (!s.isFile()) {
      throw createError({ statusCode: 400, statusMessage: 'not a file' })
    }

    const language = languageForPath(input.path)
    const base = {
      path: input.path,
      language,
      size: s.size,
    }

    if (s.size > MAX_READ_BYTES) {
      return { ...base, binary: false, tooLarge: true, content: null }
    }

    const buf = await readFile(abs)
    if (looksBinary(buf)) {
      return { ...base, binary: true, tooLarge: false, content: null }
    }

    return {
      ...base,
      binary: false,
      tooLarge: false,
      content: buf.toString('utf8'),
    }
  },
})
