import { repositoryState } from '../../../lib/dev-env/host-worktree'
import { getProject } from '../../../lib/repo'

/** Whether the project's checkout can have an environment's worktree cut from it yet. */
export default defineEventHandler(async (event) => {
  const project = await getProject(getRouterParam(event, 'id') ?? '')
  if (!project) throw createError({ statusCode: 404, statusMessage: 'Project not found.' })
  return repositoryState(project.repoPath)
})
