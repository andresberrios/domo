import { getDb, query } from '../lib/db'
import { acpManager } from '../lib/acp/manager'
import { startSubscriptionNotifier } from '../lib/acp/subscriptions'
import { voiceManager } from '../lib/voice/runtime'
import { usagePoller } from '../lib/usage/poller'
import { cronScheduler } from '../lib/cron/scheduler'
import {
  rebuildEnvironmentForwarders,
  stopAllEnvironmentForwarders
} from '../lib/dev-environment-ports'
import { healRetiredEnvironments, restoreDockerProxies } from '../lib/dev-environments'
import { stopAllDoodProxies } from '../lib/dood/manager'

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

  // Subscriptions are rows, so they outlive the process that made them.
  await startSubscriptionNotifier().catch(error => console.error('[domo] subscriptions', error))

  // Before the ports: detecting a stack's services goes through the daemon,
  // and an environment's agent may be mid-`docker compose` right now.
  // Not awaited: removing leftovers can take a while, and nothing waits on it.
  void healRetiredEnvironments().catch(error => console.warn('[domo] retired environment cleanup failed', error))
  await restoreDockerProxies().catch(error => console.error('[domo] docker proxy restore failed', error))
  await rebuildEnvironmentForwarders().catch(error => console.error('[domo] port restore failed', error))
  cronScheduler.start()

  // Plan limits are account-wide, so they have to be current on a dashboard
  // nobody has run an agent on today. What a working agent reports is the other
  // half, and it arrives without this.
  usagePoller.start()

  nitro.hooks.hook('close', async () => {
    usagePoller.stop()
    cronScheduler.stop()
    await voiceManager.shutdown().catch(() => {})
    await acpManager.shutdown().catch(() => {})
    stopAllEnvironmentForwarders()
    await stopAllDoodProxies().catch(() => {})
  })
})
