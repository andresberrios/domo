import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { getDb, query } from '../lib/db'
import { dataDir } from '../lib/paths'
import { acpManager } from '../lib/acp/manager'
import { voiceManager } from '../lib/voice/runtime'

/**
 * Make sure the mesh MCP server exists on disk outside the bundle, so spawned
 * agents can run it no matter how the app itself was started.
 */
async function installMeshServer() {
  const target = join(dataDir(), 'agent-mesh.mjs')
  const candidates = [
    resolve(process.cwd(), 'server/mcp/agent-mesh.mjs'),
    resolve(process.cwd(), '../server/mcp/agent-mesh.mjs')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      await mkdir(dataDir(), { recursive: true })
      await copyFile(candidate, target)
      break
    }
  }
  if (existsSync(target)) process.env.NUXT_DOMO_MCP_ENTRY = target
}

export default defineNitroPlugin(async (nitro) => {
  try {
    await getDb()
    // Nothing survives a restart: adapters were child processes of the old
    // server, so any "running" row is a lie until it is started again.
    await query(
      `update agent_sessions set status = 'stopped'
       where status in ('starting', 'thinking', 'awaiting-permission')`
    )
    await query(`update voice_sessions set status = 'idle' where status <> 'idle'`)
    await query(
      `update agent_permissions set resolved_at = $1, resolved_by = 'auto'
       where resolved_at is null`,
      [new Date().toISOString()]
    )
  } catch (error) {
    console.error(`\n[domo] ${error instanceof Error ? error.message : error}\n`)
  }

  await installMeshServer().catch(error => console.error('[domo] mesh install failed', error))

  nitro.hooks.hook('close', async () => {
    await voiceManager.shutdown().catch(() => {})
    await acpManager.shutdown().catch(() => {})
  })
})
