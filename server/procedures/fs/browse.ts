import { z } from 'zod'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { FsEntry } from '../../lib/schemas'

/**
 * Server-side filesystem browser, backing the project-add directory picker.
 *
 * The picker only picks directories, so we return only dirs. Hidden entries
 * are flagged so the UI can dim them. If no path is given, falls back to
 * `DOMO_PROJECTS_ROOT` (when set), otherwise the OS home directory.
 *
 * v1 has no auth and is single-user — the user IS the box's owner. We
 * still reject relative paths so query-string traversal can't sneak in.
 */
export default defineProcedure({
  input: z.object({
    path: z.string().optional(),
  }),
  output: z.object({
    path: z.string(),
    parent: z.string().nullable(),
    entries: z.array(FsEntry),
  }),
  handler: async ({ input }) => {
    const defaultRoot = process.env.DOMO_PROJECTS_ROOT?.trim() || homedir()
    const target = input.path && input.path.length > 0 ? input.path : defaultRoot

    if (!isAbsolute(target)) {
      throw createError({ statusCode: 400, statusMessage: 'path must be absolute' })
    }

    const resolved = resolve(target)

    let stats
    try {
      stats = await stat(resolved)
    } catch (err) {
      throw createError({
        statusCode: 404,
        statusMessage: `cannot stat path: ${(err as Error).message}`,
      })
    }
    if (!stats.isDirectory()) {
      throw createError({ statusCode: 400, statusMessage: 'path is not a directory' })
    }

    let raw
    try {
      raw = await readdir(resolved, { withFileTypes: true })
    } catch (err) {
      throw createError({
        statusCode: 403,
        statusMessage: `cannot list directory: ${(err as Error).message}`,
      })
    }

    const entries = await Promise.all(
      raw.map(async (e) => {
        const full = join(resolved, e.name)
        let isDir = e.isDirectory()
        if (e.isSymbolicLink()) {
          try {
            const s = await stat(full)
            isDir = s.isDirectory()
          } catch {
            isDir = false
          }
        }
        return {
          name: e.name,
          path: full,
          isDir,
          hidden: e.name.startsWith('.'),
        }
      }),
    )

    const dirs = entries
      .filter((e) => e.isDir)
      .sort((a, b) => a.name.localeCompare(b.name))

    return {
      path: resolved,
      parent: resolved === dirname(resolved) ? null : dirname(resolved),
      entries: dirs,
    }
  },
})
