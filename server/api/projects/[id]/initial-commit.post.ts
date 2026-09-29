import { createInitialCommit } from '../../../lib/dev-env/host-worktree'
import { getProject } from '../../../lib/repo'

/** Initialise the checkout if needed and commit everything `.gitignore` allows, so it can have environments. */
export default defineEventHandler(async (event) => {
  const project = await getProject(getRouterParam(event, 'id') ?? '')
  if (!project) throw createError({ statusCode: 404, statusMessage: 'Project not found.' })
  if (project.retiredAt) throw createError({ statusCode: 409, statusMessage: 'That project has been retired.' })
  try {
    return { commit: await createInitialCommit(project.repoPath) }
  } catch (error) {
    throw createError({ statusCode: 409, statusMessage: error instanceof Error ? error.message : String(error) })
  }
})
