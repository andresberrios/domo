import { z } from 'zod'
import { Env } from '../../lib/schemas'
import { getProject } from '../../lib/projects'
import { defaultWorktreePath, getEnvByName, insertEnv } from '../../lib/envs'

/**
 * Create the env DB row. Does NOT call the docker daemon. The
 * follow-up `POST /api/envs/run` streams `devcontainer up` progress
 * and flips the row's status to a live container state when it
 * completes.
 *
 * Splitting create from run keeps this procedure shape clean (no
 * streaming) while still letting the UI render the new node in the
 * left-rail tree the moment the user submits.
 */
export default defineProcedure({
  input: z.object({
    projectId: z.string(),
    name: z.string().min(1),
    /** Branch to base off of; defaults to the project's `default_branch`. */
    baseBranch: z.string().optional(),
  }),
  output: Env,
  handler: ({ input }) => {
    const project = getProject(input.projectId)
    if (!project) {
      throw createError({ statusCode: 404, statusMessage: 'project not found' })
    }
    // `'root'` is reserved for the auto-created per-project root env
    // (step 8) — it bind-mounts `project.rootPath` directly and is
    // inserted as part of `projects.add`. Refusing it here keeps the
    // (project_id, name) UNIQUE constraint coherent with the
    // reservation.
    if (input.name === 'root') {
      throw createError({
        statusCode: 409,
        statusMessage: '`root` is reserved for the project root env (already created automatically)',
      })
    }
    const existing = getEnvByName(project.id, input.name)
    if (existing) {
      throw createError({ statusCode: 409, statusMessage: 'env already exists in this project' })
    }
    // Each env gets its own branch — named after the env, forked from
    // the chosen base. The base goes in `baseBranch` so the run-step's
    // `git worktree add -b <branch> <path> <baseBranch>` is
    // restart-recoverable.
    const row = {
      id: crypto.randomUUID(),
      projectId: project.id,
      name: input.name,
      branch: input.name,
      baseBranch: input.baseBranch ?? project.defaultBranch ?? null,
      worktreePath: defaultWorktreePath(project.rootPath, input.name),
      containerId: null as string | null,
      devcontainerPath: null as string | null,
      devcontainerConfigHash: null as string | null,
      isRoot: false,
      status: 'provisioning' as string | null,
      createdAt: Date.now(),
    }
    insertEnv(row)
    return row
  },
})
