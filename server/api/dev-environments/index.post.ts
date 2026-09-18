import { createEnvironment } from '../../lib/dev-environments'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ projectId?: string, name?: string }>(event)
  if (!body?.projectId || !body?.name?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Project and environment name are required.' })
  }
  try {
    return await createEnvironment({ projectId: body.projectId, name: body.name.trim() })
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not create development environment.'
    })
  }
})
