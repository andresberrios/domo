import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeCwd } from '../../lib/acp/manager'
import { getSettings } from '../../lib/settings'

async function listChildDirectories(path: string): Promise<Array<{ name: string, path: string }>> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

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
