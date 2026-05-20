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
  inspectDevcontainer,
} from '../../lib/projects'
import { scaffoldDevcontainer } from '../../lib/devcontainer'

/**
 * Multi-step project add. Returns a discriminated union — each non-`ok`
 * variant tells the UI what to prompt next, and the UI re-invokes with
 * the corresponding `confirm*` flag set.
 *
 * Flow:
 *   1. `missing-git`                   → user confirms `git init`
 *   2. `missing-devcontainer`          → user confirms starter devcontainer.json
 *   3. `missing-gitignore-worktrees`   → user confirms `.worktrees/` in `.gitignore`
 *   4. `ok`                            → project row inserted
 *
 * `already-exists` short-circuits if the path is already registered.
 * The UI offers to focus the existing project.
 */
export default defineProcedure({
  input: z.object({
    rootPath: z.string(),
    /** Optional override for the project name; defaults to dir basename. */
    name: z.string().optional(),
    confirmGitInit: z.boolean().optional(),
    confirmDevcontainerInit: z.boolean().optional(),
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
      status: z.literal('missing-devcontainer'),
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

    // 2. devcontainer.json
    let devc = await inspectDevcontainer(rootPath)
    const suggestedName = input.name?.trim() || defaultProjectName(rootPath)
    if (!devc.path) {
      if (!input.confirmDevcontainerInit) {
        return {
          status: 'missing-devcontainer' as const,
          rootPath,
          composeDetected: devc.composeDetected,
          suggestedName,
        }
      }
      await scaffoldDevcontainer({
        workspaceFolder: rootPath,
        name: suggestedName,
        composeDetected: devc.composeDetected,
      })
      devc = await inspectDevcontainer(rootPath)
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
    const projectName = devc.parsedName || input.name?.trim() || defaultProjectName(rootPath)
    const defaultBranch = await detectDefaultBranch(rootPath)
    const row = {
      id: crypto.randomUUID(),
      name: projectName,
      rootPath,
      defaultBranch,
      hasDevcontainer: true,
      createdAt: Date.now(),
    }
    insertProject(row)
    return { status: 'ok' as const, project: row }
  },
})
