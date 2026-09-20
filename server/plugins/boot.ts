import { getDb, query } from '../lib/db'
import { acpManager } from '../lib/acp/manager'
import { voiceManager } from '../lib/voice/runtime'
import {
  rebuildEnvironmentForwarders,
  stopAllEnvironmentForwarders
} from '../lib/dev-environment-ports'

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

  await rebuildEnvironmentForwarders().catch(error => console.error('[domo] port restore failed', error))

  nitro.hooks.hook('close', async () => {
    await voiceManager.shutdown().catch(() => {})
    await acpManager.shutdown().catch(() => {})
    stopAllEnvironmentForwarders()
  })
})
