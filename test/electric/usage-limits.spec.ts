import { mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeAll, describe, expect, it } from 'vitest'

import HomePage from '~/pages/index.vue'

import { publishedTables, resetTestDatabase, withTestDatabase } from './harness'

/**
 * A limit row written on the server, reaching a mounted page.
 *
 * `usage_limits` is the first synced table with **no `id` column** — it is keyed
 * on `(provider, limit_id)`, because that is what a limit is — so the client
 * supplies its own `getKey`. That is exactly the kind of thing that works in
 * every other layer and then silently syncs nothing, so it is worth one case
 * against a real ElectricSQL.
 */

async function insertLimit(patch: { limitId: string, label: string, percent: number }) {
  await withTestDatabase(client => client.query(
    `insert into usage_limits
       (provider, limit_id, label, used_percent, window_minutes, source, updated_at)
     values ('claude', $1, $2, $3, 300, 'endpoint', $4)
     on conflict (provider, limit_id) do update set
       used_percent = excluded.used_percent, updated_at = excluded.updated_at`,
    [patch.limitId, patch.label, patch.percent, new Date().toISOString()]
  ))
}

beforeAll(async () => {
  await resetTestDatabase()
})

describe('plan limits on the home page', () => {
  it('streams a row keyed on something other than `id`', async () => {
    const page = await mountSuspended(HomePage)

    await expect.poll(publishedTables, { timeout: 30_000, interval: 100 })
      .toContain('usage_limits')

    await insertLimit({ limitId: 'five_hour', label: '5-hour limit', percent: 52 })

    await expect.poll(() => page.text(), { timeout: 30_000, interval: 100 })
      .toContain('5-hour limit')
    expect(page.text()).toContain('52%')

    // An update, not an insert — the path `REPLICA IDENTITY FULL` governs, and
    // the one a wrong `getKey` would turn into a duplicate row instead.
    await insertLimit({ limitId: 'five_hour', label: '5-hour limit', percent: 94 })

    await expect.poll(() => page.text(), { timeout: 30_000, interval: 100 })
      .toContain('94%')
    expect(page.text()).not.toContain('52%')
    expect(page.text().match(/5-hour limit/g)).toHaveLength(1)
  })
})
