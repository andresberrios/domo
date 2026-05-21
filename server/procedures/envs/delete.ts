import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

import * as dc from '../../lib/devcontainer'
import { deleteEnv, getEnv, resolveContainerId } from '../../lib/envs'
import { getProject } from '../../lib/projects'

const execFile = promisify(execFileCb)

/**
 * Tear down the env: force-remove the container (if any), drop the
 * git worktree from the project repo, then delete the env row.
 *
 * Unlike Coast, the devcontainer CLI doesn't own the on-disk worktree
 * — Domo created it with `git worktree add`, so Domo cleans it up
 * with `git worktree remove`. Best-effort; a stale worktree dir
 * doesn't block deleting the env row.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) return { deleted: false }
    // Root env is per-project and undeletable (step 8). The UI uses
    // `envs.teardown` instead, which stops + removes the container
    // but leaves the row + the project files alone.
    if (env.isRoot) {
      throw createError({
        statusCode: 409,
        statusMessage: 'root env cannot be deleted; use Tear down instead',
      })
    }

    const cid = await resolveContainerId(env)
    if (cid) {
      await dc.remove(cid).catch(() => {
        // Already gone or daemon unreachable — soft no-op; the env row
        // delete below still runs so the UI clears the entry.
      })
    }

    const project = getProject(env.projectId)
    if (project && env.worktreePath) {
      try {
        await execFile('git', ['-C', project.rootPath, 'worktree', 'remove', '--force', env.worktreePath])
      } catch {
        // The worktree may already be detached or absent — not fatal.
      }
    }
    // Also drop the env's own branch so re-creating an env with the same
    // name doesn't trip "fatal: a branch named '<env>' already exists"
    // on the next `git worktree add -b`. The branch is per-env (env.name
    // == env.branch in the post-2026-05-20 branch model) so deleting it
    // is the right cleanup — its history merges into the user's regular
    // workflow (or doesn't), independent of the env lifecycle.
    if (project && env.branch) {
      try {
        await execFile('git', ['-C', project.rootPath, 'branch', '-D', env.branch])
      } catch {
        // Branch missing/unborn — safe to ignore.
      }
    }

    deleteEnv(env.id)
    return { deleted: true }
  },
})
