import { createProjectFromPath } from '../../lib/projects'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, repoPath?: string }>(event)
  if (!body?.repoPath?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Repository path is required.' })
  }
  try {
    return await createProjectFromPath({ name: body.name, repoPath: body.repoPath })
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Could not create project.'
    })
  }
})
