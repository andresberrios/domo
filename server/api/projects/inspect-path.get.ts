import { inspectProjectPath } from '../../lib/project-path'

/** What adding a project at `path` would take: nothing, `git init`, or creating the folder too. */
export default defineEventHandler(async (event) => {
  const { path } = getQuery(event)
  if (typeof path !== 'string' || !path.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'A path is required.' })
  }
  return inspectProjectPath(path)
})
