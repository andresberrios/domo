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
import { insertEnv } from '../../lib/envs'

/**
 * Multi-step project add. Returns a discriminated union — each non-`ok`
 * variant tells the UI what to prompt next, and the UI re-invokes with
 * the corresponding `confirm*` flag set.
 *
 * Flow (post step 8):
 *   1. `missing-git`                   → user confirms `git init`
 *   2. `missing-gitignore-worktrees`   → user confirms `.worktrees/` in `.gitignore`
 *   3. `ok`                            → project row inserted, root env auto-created
 *
 * `devcontainer.json` is **no longer required** — Domo ships a default
 * config used when the project has none (step 8). The
 * `scaffoldDevcontainer` helper stays available for a deferred
 * "Customize devcontainer" button on the root env overview, but is no
 * longer wired into this flow.
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

    // 2. .gitignore
    const ignoreOk = await gitignoreCoversWorktrees(rootPath)
    if (!ignoreOk) {
      if (!input.confirmGitignoreAddWorktrees) {
        return { status: 'missing-gitignore-worktrees' as const, rootPath }
      }
      await addWorktreesToGitignore(rootPath)
    }

    // 3. Insert. `inspectDevcontainer` only used here to pull a `name`
    // from a user-provided devcontainer.json if one exists; absence is
    // fine — Domo's default config handles it.
    const devc = await inspectDevcontainer(rootPath)
    const projectName = devc.parsedName || input.name?.trim() || defaultProjectName(rootPath)
    const defaultBranch = await detectDefaultBranch(rootPath)
    const row = {
      id: crypto.randomUUID(),
      name: projectName,
      rootPath,
      // `hasDevcontainer` retained for legacy/UI use, but no longer
      // gates project creation. True iff the project has a
      // devcontainer.json on disk at add time; informational only.
      hasDevcontainer: !!devc.path,
      defaultBranch,
      createdAt: Date.now(),
    }
    insertProject(row)

    // 4. Auto-create the root env (step 8 — every project has one).
    // Bind-mounts `project.rootPath` directly: no worktree, no branch
    // of its own (tracks the host's checked-out branch), can't be
    // deleted (only "torn down"). Lazy first `up` — the row exists,
    // the container doesn't, until the user clicks Start on the env
    // overview. Reserved name `'root'`.
    insertEnv({
      id: crypto.randomUUID(),
      projectId: row.id,
      name: 'root',
      branch: null,
      baseBranch: null,
      worktreePath: rootPath,
      containerId: null,
      devcontainerPath: null,
      devcontainerConfigHash: null,
      isRoot: true,
      status: 'waiting',
      createdAt: Date.now(),
    })

    return { status: 'ok' as const, project: row }
  },
})
