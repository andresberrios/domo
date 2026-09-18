import { access, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { normalizeCwd } from '../../lib/acp/manager'
import { createProject } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, repoPath?: string }>(event)
  if (!body?.repoPath?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Repository path is required.' })
  }
  const repoPath = normalizeCwd(body?.repoPath ?? '')
  try {
    if (!(await stat(repoPath)).isDirectory()) throw new Error('not a directory')
    await access(join(repoPath, '.git'))
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Repository path must be a local Git checkout.' })
  }
  return createProject({
    name: body?.name?.trim() || basename(repoPath),
    repoPath
  })
})
