import { mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeAll, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { useAgentEvents, useSessionsEvents } from '~/composables/useDomoData'

import { resetTestDatabase, withTestDatabase } from './harness'

/**
 * A long transcript is loaded a page at a time: the newest page first, through
 * an on-demand Electric collection, then each earlier page when the reader
 * scrolls up to it. The server says where a page begins and Electric brings
 * the rows, so this is the one layer where both halves are real.
 */

const SESSION = 'ag_pages'
const TOTAL = 900
/** Every seventh event opens a turn, so a page boundary rarely lands on one. */
const PROMPT_EVERY = 7

async function insertEvents(from: number, to: number) {
  await withTestDatabase(async (client) => {
    for (let index = from; index < to; index += 300) {
      const rows = Array.from({ length: Math.min(300, to - index) }, (_, offset) => index + offset)
      await client.query(
        `insert into agent_events (id, agent_session_id, type, payload, created_at)
         select 'ev_' || n, $1, case when n % ${PROMPT_EVERY} = 0 then 'user_message' else 'agent_message' end,
                jsonb_build_object('text', 'event ' || n), '2026-10-15T00:00:00.000Z'
           from unnest($2::int[]) as n order by n`,
        [SESSION, rows]
      )
    }
  })
}

/** The seqs the database holds for the session, oldest first. */
async function storedSeqs(): Promise<number[]> {
  return withTestDatabase(async (client) => {
    const { rows } = await client.query<{ seq: string }>(
      'select seq from agent_events where agent_session_id = $1 order by seq', [SESSION]
    )
    return rows.map(row => Number(row.seq))
  })
}

beforeAll(async () => {
  await resetTestDatabase()
  await withTestDatabase(client => client.query(
    `insert into agent_sessions (id, title, cwd, created_at, updated_at) values ($1, 'Paged', '/tmp', $2, $2)`,
    [SESSION, '2026-10-15T00:00:00.000Z']
  ))
  await insertEvents(0, TOTAL)
})

describe('a transcript loaded a page at a time', () => {
  it('starts on the newest page, on a whole turn, streams into it, and pages back to the start', async () => {
    let log!: ReturnType<typeof useAgentEvents>
    await mountSuspended(defineComponent({
      setup() {
        log = useAgentEvents(SESSION)
        return () => h('div')
      }
    }))

    const seqs = await storedSeqs()
    const loaded = () => log.events.value.map(event => event.seq)

    await expect.poll(() => log.isReady.value, { timeout: 30_000 }).toBe(true)
    // The newest 400 are events 500–899; the first prompt among them is 504.
    expect(loaded()).toEqual(seqs.slice(504))
    expect(log.events.value[0]!.type).toBe('user_message')
    expect(log.complete.value).toBe(false)

    // The live tail streams into the window.
    await insertEvents(TOTAL, TOTAL + 1)
    const withTail = await storedSeqs()
    await expect.poll(loaded, { timeout: 30_000, interval: 100 }).toEqual(withTail.slice(504))

    // The page below 504 holds events 104–503, and opens on 105.
    await log.loadEarlier()
    expect(loaded()).toEqual(withTail.slice(105))
    expect(log.complete.value).toBe(false)

    // Fewer than a page are left, so the next one is the rest of the log.
    await log.loadEarlier()
    expect(loaded()).toEqual(withTail)
    expect(log.complete.value).toBe(true)
  })

  /**
   * An assistant's page derives its list of sessions from every session row,
   * so the list is a new array whenever any session's status changes — every
   * message sent. Starting the log again for that emptied the transcript
   * while the page loaded again.
   */
  it('keeps its rows when it is handed the same sessions in a new list', async () => {
    const ids = ref([SESSION])
    let log!: ReturnType<typeof useSessionsEvents>
    await mountSuspended(defineComponent({
      setup() {
        log = useSessionsEvents(() => ids.value)
        return () => h('div')
      }
    }))
    await expect.poll(() => log.isReady.value, { timeout: 30_000 }).toBe(true)
    const loaded = log.events.value

    ids.value = [SESSION]
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(log.isReady.value).toBe(true)
    expect(log.events.value).toBe(loaded)
  })
})
