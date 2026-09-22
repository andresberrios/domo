import { updateDevEnvironment } from '../../../lib/repo'

/**
 * Rename a dev environment. Only the display name: the container, its workspace
 * volume and the Docker-in-Docker volume are all named from the id at creation
 * and are never renamed with it.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ name?: string }>(event)
  const name = body?.name?.trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: 'A name is required' })

  const environment = await updateDevEnvironment(id, { name })
  if (!environment) throw createError({ statusCode: 404, statusMessage: 'Dev environment not found' })
  return environment
})
