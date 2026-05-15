import { z } from 'zod'
import { Env } from '../../lib/schemas'
import { getProject } from '../../lib/projects'
import { defaultWorktreePath, getEnvByName, insertEnv } from '../../lib/envs'

/**
 * Create the env DB row. Does NOT call coastd. The follow-up
 * `POST /api/envs/run` streams Coast's `run` progress and flips the
 * row's status to `running` / `error` when it completes.
 *
 * Splitting create from run keeps the procedure shape clean (no
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
    const existing = getEnvByName(project.id, input.name)
    if (existing) {
      throw createError({ statusCode: 409, statusMessage: 'env already exists in this project' })
    }
    const row = {
      id: crypto.randomUUID(),
      projectId: project.id,
      name: input.name,
      branch: input.baseBranch ?? project.defaultBranch ?? null,
      worktreePath: defaultWorktreePath(project.rootPath, input.name),
      coastInstanceName: input.name,
      status: 'provisioning' as string | null,
      createdAt: Date.now(),
    }
    insertEnv(row)
    return row
  },
})
