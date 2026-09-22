import type { WorkingTreeMode } from '../../../shared/types'
import { createEnvironment } from '../../lib/dev-environments'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ projectId?: string, name?: string, workingTree?: string }>(event)
  if (!body?.projectId || !body?.name?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Project and environment name are required.' })
  }
  // Only the two honest states, and the safe one is what an absent value means:
  // an environment that quietly carries the host's uncommitted work back out is
  // the failure this defaults against.
  if (body.workingTree !== undefined && body.workingTree !== 'discard' && body.workingTree !== 'carry') {
    throw createError({ statusCode: 400, statusMessage: 'workingTree must be "discard" or "carry".' })
  }
  try {
    return await createEnvironment({
      projectId: body.projectId,
      name: body.name.trim(),
      workingTree: body.workingTree as WorkingTreeMode | undefined
    })
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not create development environment.'
    })
  }
})
