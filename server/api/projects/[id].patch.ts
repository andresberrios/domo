import { updateProject } from '../../lib/repo'

/**
 * Rename a project. The repository path is not patchable: a project *is* its
 * checkout, and pointing an existing one somewhere else would leave its
 * environments copied from a directory it no longer names.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ name?: string }>(event)
  const name = body?.name?.trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: 'A name is required' })

  const project = await updateProject(id, { name })
  if (!project) throw createError({ statusCode: 404, statusMessage: 'Project not found' })
  return project
})
