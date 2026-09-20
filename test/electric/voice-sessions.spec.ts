import { mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeAll, describe, expect, it } from 'vitest'

import HomePage from '~/pages/index.vue'

import { publishedTables, resetTestDatabase, withTestDatabase } from './harness'

/**
 * The seam no other layer covers: a page mounted in happy-dom, a click that
 * reaches the real Nitro server, a row written to real Postgres, and the row
 * arriving back in the mounted page through a real ElectricSQL.
 *
 * Nothing here refetches. Every assertion about the DOM is waiting on the
 * Electric stream and on nothing else.
 */

async function voiceSessions() {
  const { rows } = await withTestDatabase(client =>
    client.query<{ id: string, title: string, title_source: string }>(
      'select id, title, title_source from voice_sessions'
    )
  )
  return rows
}

beforeAll(async () => {
  await resetTestDatabase()
})

describe('starting a conversation from the home page', () => {
  it('reaches Postgres and comes back through Electric, with no refetch', async () => {
    const page = await mountSuspended(HomePage)

    // Nothing has been written yet, so the page has no conversation list.
    expect(page.text()).not.toContain('Recent conversations')

    // Electric adds a table to its publication the first time a shape asks for
    // one — membership is demand-driven, not schema-wide. Waiting for it here
    // means a later propagation failure cannot be misread as "happy-dom cannot
    // stream" when the real cause is a table that fell out of the publication.
    await expect.poll(publishedTables, { timeout: 30_000, interval: 100 })
      .toContain('voice_sessions')

    const talk = page.findAll('button').find(button => button.text().includes('Start talking'))
    expect(talk, 'the home page should offer a way to start talking').toBeTruthy()
    await talk!.trigger('click')

    // 1. It reached the real server, and 2. the row is in real Postgres.
    await expect.poll(voiceSessions, { timeout: 30_000, interval: 100 })
      .toEqual([expect.objectContaining({ title: 'New conversation', title_source: 'auto' })])

    // 3. …and Electric put it back into the mounted page's live query.
    await expect.poll(() => page.text(), { timeout: 30_000, interval: 100 })
      .toContain('Recent conversations')
    expect(page.text()).toContain('New conversation')

    // An update, not an insert — the path `REPLICA IDENTITY FULL` governs.
    // Renaming over the API stands in for the voice agent, or for a second tab.
    const [session] = await voiceSessions()
    await $fetch(`/api/voice-sessions/${session!.id}`, {
      method: 'PATCH',
      body: { title: 'Ship the invoices' }
    })

    await expect.poll(() => page.text(), { timeout: 30_000, interval: 100 })
      .toContain('Ship the invoices')
    expect(page.text()).not.toContain('New conversation')
  })
})
