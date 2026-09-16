import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { normalizeCwd } from '../../lib/acp/manager'
import { listChildDirectories } from '../../lib/voice/tools'
import { getSettings } from '../../lib/settings'

export default defineEventHandler(async (event) => {
  const { path } = getQuery(event)
  const settings = await getSettings()
  const target = normalizeCwd((path as string) || settings.defaultCwd || homedir())
  try {
    return {
      path: target,
      parent: dirname(target) === target ? null : dirname(target),
      directories: await listChildDirectories(target)
    }
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Cannot read directory'
    })
  }
})
