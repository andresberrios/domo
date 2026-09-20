import { ShapeStream } from '@electric-sql/client'
import { beforeAll, describe, expect, it } from 'vitest'

import { TEST_SERVER_ORIGIN, resetTestDatabase } from './harness'

/**
 * The floor of this layer: does Electric's long-polling stream work at all
 * inside happy-dom, through the app's own proxy, against a real Electric?
 *
 * If this file fails, nothing above it can be trusted — a component test would
 * just look like a slow timeout with no explanation.
 */

beforeAll(async () => {
  await resetTestDatabase()
})

describe('the Electric client under happy-dom', () => {
  it('reaches the real Nitro server through a relative /api path', async () => {
    await expect($fetch('/api/health')).resolves.toMatchObject({ db: true, electric: true })
  })

  it('streams an insert made over HTTP, with no refetch', async () => {
    const stream = new ShapeStream({
      url: new URL('/api/shape', TEST_SERVER_ORIGIN).href,
      params: { table: 'voice_sessions' }
    })

    const seen = new Map<string, Record<string, unknown>>()
    const unsubscribe = stream.subscribe((messages) => {
      for (const message of messages) {
        if (!('value' in message)) continue
        const row = message.value as Record<string, unknown>
        if (message.headers.operation === 'delete') seen.delete(String(row.id))
        else seen.set(String(row.id), row)
      }
    })

    try {
      // Wait for the initial snapshot before writing, so what follows can only
      // have arrived over the live stream.
      await expect.poll(() => stream.isUpToDate, { timeout: 30_000 }).toBe(true)
      expect(seen.size).toBe(0)

      const created = await $fetch<{ id: string }>('/api/voice-sessions', { method: 'POST', body: {} })

      await expect
        .poll(() => seen.get(created.id)?.title, { timeout: 30_000, interval: 100 })
        .toBe('New conversation')

      await $fetch(`/api/voice-sessions/${created.id}`, { method: 'PATCH', body: { title: 'Renamed' } })

      // An update, not an insert: this is the path `REPLICA IDENTITY FULL` governs.
      await expect
        .poll(() => seen.get(created.id)?.title, { timeout: 30_000, interval: 100 })
        .toBe('Renamed')
      expect(seen.get(created.id)).toMatchObject({ title_source: 'user', status: 'idle' })
    } finally {
      unsubscribe()
    }
  })
})
