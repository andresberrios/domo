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

export default defineNitroPlugin(async (nitro) => {
  try {
    await getDb()
    // Nothing survives a restart: adapters were child processes of the old
    // server, so any "running" row is a lie until it is started again.
    await query(
      `update agent_sessions set status = 'stopped'
       where status in ('starting', 'thinking', 'awaiting-permission')`
    )
    // A build runs in this process, so one still `creating` died with the old
    // server. Left alone it would read as in progress for ever.
    await query(
      `update dev_environments
          set status = 'error', updated_at = $1,
              last_error = 'Domo restarted while this environment was being created. Retire it and create it again.'
        where status = 'creating' and retired_at is null`,
      [new Date().toISOString()]
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
  })
})
