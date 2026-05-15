import { z } from 'zod'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { Project } from '../../lib/schemas'
import {
  addWorktreesToGitignore,
  defaultProjectName,
  detectDefaultBranch,
  detectGitRoot,
  getProjectByRoot,
  gitInit,
  gitignoreCoversWorktrees,
  insertProject,
  inspectCoastfile,
  writeStarterCoastfile,
} from '../../lib/projects'

/**
 * Multi-step project add. Returns a discriminated union — each non-`ok`
 * variant tells the UI what to prompt next, and the UI re-invokes with the
 * corresponding `confirm*` flag set.
 *
 * Flow:
 *   1. `missing-git`             → user confirms `git init`
 *   2. `missing-coastfile`       → user confirms starter Coastfile write
 *   3. `missing-gitignore-worktrees` → user confirms `.worktrees/` in `.gitignore`
 *   4. `ok`                      → project inserted; UI can kick off `coast build` next
 *
 * `already-exists` short-circuits if the path is already registered. The
 * UI offers to focus the existing project.
 */
export default defineProcedure({
  input: z.object({
    rootPath: z.string(),
    /** Optional override for the coast project name; defaults to dir basename. */
    name: z.string().optional(),
    confirmGitInit: z.boolean().optional(),
    confirmCoastfileInit: z.boolean().optional(),
    confirmGitignoreAddWorktrees: z.boolean().optional(),
  }),
  output: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ok'),
      project: Project,
    }),
    z.object({
      status: z.literal('missing-git'),
      rootPath: z.string(),
    }),
    z.object({
      status: z.literal('missing-coastfile'),
      rootPath: z.string(),
      composeDetected: z.boolean(),
      suggestedName: z.string(),
    }),
    z.object({
      status: z.literal('missing-gitignore-worktrees'),
      rootPath: z.string(),
    }),
    z.object({
      status: z.literal('already-exists'),
      projectId: z.string(),
    }),
    z.object({
      status: z.literal('invalid-path'),
      reason: z.string(),
    }),
  ]),
  handler: async ({ input }) => {
    if (!isAbsolute(input.rootPath)) {
      return { status: 'invalid-path' as const, reason: 'path must be absolute' }
    }
    const rootPath = resolve(input.rootPath)
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      return { status: 'invalid-path' as const, reason: 'path is not an existing directory' }
    }

    const existing = getProjectByRoot(rootPath)
    if (existing) {
      return { status: 'already-exists' as const, projectId: existing.id }
    }

    // 1. Git
    let gitRoot = await detectGitRoot(rootPath)
    if (gitRoot !== rootPath) {
      if (!input.confirmGitInit) {
        return { status: 'missing-git' as const, rootPath }
      }
      await gitInit(rootPath)
      gitRoot = await detectGitRoot(rootPath)
      if (gitRoot !== rootPath) {
        return { status: 'invalid-path' as const, reason: 'git init did not produce a repo at this path' }
      }
    }

    // 2. Coastfile
    let coast = await inspectCoastfile(rootPath)
    if (!coast.path) {
      const suggestedName = input.name?.trim() || defaultProjectName(rootPath)
      if (!input.confirmCoastfileInit) {
        return {
          status: 'missing-coastfile' as const,
          rootPath,
          composeDetected: coast.composeDetected,
          suggestedName,
        }
      }
      await writeStarterCoastfile(rootPath, {
        name: suggestedName,
        composeDetected: coast.composeDetected,
      })
      coast = await inspectCoastfile(rootPath)
    }

    // 3. .gitignore
    const ignoreOk = await gitignoreCoversWorktrees(rootPath)
    if (!ignoreOk) {
      if (!input.confirmGitignoreAddWorktrees) {
        return { status: 'missing-gitignore-worktrees' as const, rootPath }
      }
      await addWorktreesToGitignore(rootPath)
    }

    // 4. Insert
    const coastName = coast.parsedName || input.name?.trim() || defaultProjectName(rootPath)
    const defaultBranch = await detectDefaultBranch(rootPath)
    const row = {
      id: crypto.randomUUID(),
      name: coastName,
      rootPath,
      defaultBranch,
      hasCoastfile: true,
      createdAt: Date.now(),
    }
    insertProject(row)
    return { status: 'ok' as const, project: row }
  },
})
