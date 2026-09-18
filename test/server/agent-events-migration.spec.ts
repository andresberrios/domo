import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'

import { getDb, query } from '../../server/lib/db'
import { databaseUnavailable, skipMessage } from '../helpers/database'

/**
 * Every install that ran Domo before streaming text was coalesced has a log
 * that is mostly deltas — thousands of rows per session. Booting folds each run
 * into the single row the app writes now, and the transcript has to come out
 * reading exactly the same, in the same order, with the same ids.
 *
 * This file starts from that old log and lets `server/lib/db.ts` boot onto it.
 */
const skip = !!databaseUnavailable()
if (skip) console.warn(`[test] ${skipMessage()}`)

/** `agent_events` as it was: one row per ACP `session/update`, chunks included. */
const LEGACY = /* sql */ `
create table agent_sessions (
  id text primary key,
  adapter text not null default 'claude-code',
  title text not null,
  cwd text not null,
  status text not null default 'idle',
  created_at text not null,
  updated_at text not null,
  archived boolean not null default false
);

create table agent_events (
  id text primary key,
  agent_session_id text not null references agent_sessions(id) on delete cascade,
  seq bigserial not null,
  type text not null,
  payload jsonb not null,
  created_at text not null
);

insert into agent_sessions (id, title, cwd, created_at, updated_at)
values ('ag_old', 'Auth refactor', '/srv/api', 'now', 'now'),
       ('ag_other', 'Docs', '/srv/docs', 'now', 'now');

-- Two agents talking at once, which is what makes this worth testing: seq is
-- global, so one session's run of deltas is not a stretch of consecutive
-- sequence numbers.
insert into agent_events (id, agent_session_id, type, payload, created_at) values
  ('ev_1', 'ag_old', 'user_message', '{"content":[{"type":"text","text":"fix the build"}]}', 't1'),
  ('ev_2', 'ag_old', 'agent_thought_chunk', '{"content":{"type":"text","text":"let me "}}', 't2'),
  ('ev_11', 'ag_other', 'agent_message_chunk', '{"content":{"type":"text","text":"Hi"}}', 't3'),
  ('ev_3', 'ag_old', 'agent_thought_chunk', '{"content":{"type":"text","text":"look"}}', 't4'),
  ('ev_4', 'ag_old', 'agent_message_chunk', '{"content":{"type":"text","text":"Check"}}', 't5'),
  ('ev_5', 'ag_old', 'agent_message_chunk', '{"content":{"type":"text","text":"ing."}}', 't6'),
  ('ev_12', 'ag_other', 'agent_message_chunk', '{"content":{"type":"text","text":" there"}}', 't7'),
  ('ev_6', 'ag_old', 'tool_call', '{"toolCallId":"c1","title":"Read"}', 't8'),
  ('ev_7', 'ag_old', 'agent_message_chunk', '{"content":{"type":"text","text":"Found "}}', 't9'),
  ('ev_8', 'ag_old', 'agent_message_chunk', '{"content":{"type":"image","data":"…"}}', 't10'),
  ('ev_9', 'ag_old', 'agent_message_chunk', '{"content":{"type":"text","text":"it."}}', 't11'),
  ('ev_10', 'ag_old', 'turn_end', '{"stopReason":"end_turn"}', 't12');
`

beforeAll(async () => {
  if (skip) return
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  await client.query(LEGACY)
  await client.end()
  await getDb()
})

interface Row { id: string, seq: number, type: string, payload: any, created_at: string }

async function events(agentSessionId: string): Promise<Row[]> {
  return query<Row>(
    'select id, seq, type, payload, created_at from agent_events where agent_session_id = $1 order by seq',
    [agentSessionId]
  )
}

describe.skipIf(skip)('booting on top of a per-delta event log', () => {
  it('folds each run of chunks into one row and keeps everything else', async () => {
    const rows = await events('ag_old')

    expect(rows.map(row => row.type)).toEqual([
      'user_message',
      'agent_thought',
      'agent_message',
      'tool_call',
      'agent_message',
      'turn_end'
    ])
  })

  it('joins the deltas back into the text the reader used to see', async () => {
    const rows = await events('ag_old')

    expect(rows[1]!.payload).toEqual({ text: 'let me look', streaming: false })
    expect(rows[2]!.payload).toEqual({ text: 'Checking.', streaming: false })
    // The image chunk in the middle of the run contributed no text, as it never did.
    expect(rows[4]!.payload).toEqual({ text: 'Found it.', streaming: false })
  })

  it('keeps the head row, so ids, timestamps and ordering survive', async () => {
    const rows = await events('ag_old')

    expect(rows.map(row => row.id)).toEqual(['ev_1', 'ev_2', 'ev_4', 'ev_6', 'ev_7', 'ev_10'])
    expect(rows.map(row => row.created_at)).toEqual(['t1', 't2', 't5', 't8', 't9', 't12'])
    expect(rows.map(row => row.seq)).toEqual([...rows.map(row => row.seq)].sort((a, b) => a - b))
  })

  it('folds a run per session, not a run per stretch of seq', async () => {
    const rows = await events('ag_other')

    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload).toEqual({ text: 'Hi there', streaming: false })
  })

  it('leaves no delta rows anywhere', async () => {
    const rows = await query(
      `select 1 from agent_events where type in ('agent_message_chunk', 'agent_thought_chunk')`
    )

    expect(rows).toEqual([])
  })

  it('is a no-op the second time, since there is nothing left to fold', async () => {
    const before = await events('ag_old')

    await query('select 1')
    const { closeDb } = await import('../../server/lib/db')
    await closeDb()
    await getDb()

    expect(await events('ag_old')).toEqual(before)
  })
})
