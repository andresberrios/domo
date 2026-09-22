import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'

import { getDb, query } from '../../server/lib/db'

/**
 * Every install that ran Domo before `session/load` replays were ignored holds
 * a duplicated conversation — one extra copy of the agent's side per reattach,
 * and under `pnpm dev` that is several an hour. Booting removes the bursts.
 *
 * The log below is what one of those installs really looks like: a real turn,
 * the adapter exiting, the replay the next attach appended, a second real turn,
 * and a second replay covering both. It also holds the two things the repair
 * must not touch — an agent that legitimately repeats itself, and a session
 * that was never reattached at all.
 */

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
values ('ag_replayed', 'Auth refactor', '/srv/api', 'now', 'now'),
       ('ag_clean', 'Docs', '/srv/docs', 'now', 'now'),
       ('ag_compacted', 'Long one', '/srv/web', 'now', 'now');

insert into agent_events (id, agent_session_id, type, payload, created_at) values
  -- A real turn.
  ('r01', 'ag_replayed', 'user_message', '{"content":[{"type":"text","text":"fix the build"}]}', 't01'),
  ('r02', 'ag_replayed', 'agent_message', '{"text":"Looking.","streaming":false}', 't02'),
  ('r03', 'ag_replayed', 'tool_call', '{"toolCallId":"c1","title":"Read"}', 't03'),
  ('r04', 'ag_replayed', 'tool_call_update', '{"toolCallId":"c1","status":"completed"}', 't04'),
  ('r05', 'ag_replayed', 'agent_message', '{"text":"Done.","streaming":false}', 't05'),
  ('r06', 'ag_replayed', 'turn_end', '{"stopReason":"end_turn"}', 't06'),
  -- Nitro reloaded.
  ('r07', 'ag_replayed', 'adapter-exit', '{"code":0}', 't07'),
  -- …and the next attach appended the adapter's own transcript.
  ('r08', 'ag_replayed', 'user_message_chunk', '{"content":{"type":"text","text":"fix the build"}}', 't08'),
  ('r09', 'ag_replayed', 'agent_message', '{"text":"Looking.","streaming":false}', 't09'),
  ('r10', 'ag_replayed', 'tool_call', '{"toolCallId":"c1","title":"Read"}', 't10'),
  ('r11', 'ag_replayed', 'tool_call_update', '{"toolCallId":"c1","status":"completed"}', 't11'),
  ('r12', 'ag_replayed', 'agent_message', '{"text":"Done.","streaming":false}', 't12'),
  ('r13', 'ag_replayed', 'available_commands_update', '{"availableCommands":[]}', 't13'),
  ('r14', 'ag_replayed', 'model_changed', '{"modelId":"sonnet"}', 't14'),
  -- A second real turn, in which the agent happens to say the same thing again.
  ('r15', 'ag_replayed', 'user_message', '{"content":[{"type":"text","text":"now the tests"}]}', 't15'),
  ('r16', 'ag_replayed', 'agent_message', '{"text":"Looking.","streaming":false}', 't16'),
  ('r17', 'ag_replayed', 'turn_end', '{"stopReason":"end_turn"}', 't17'),
  ('r18', 'ag_replayed', 'adapter-exit', '{"code":0}', 't18'),
  -- The next attach replays both turns.
  ('r19', 'ag_replayed', 'user_message_chunk', '{"content":{"type":"text","text":"fix the build"}}', 't19'),
  ('r20', 'ag_replayed', 'agent_message', '{"text":"Looking.","streaming":false}', 't20'),
  ('r21', 'ag_replayed', 'tool_call', '{"toolCallId":"c1","title":"Read"}', 't21'),
  ('r22', 'ag_replayed', 'user_message_chunk', '{"content":{"type":"text","text":"now the tests"}}', 't22'),
  ('r23', 'ag_replayed', 'agent_message', '{"text":"Looking.","streaming":false}', 't23'),
  ('r24', 'ag_replayed', 'model_changed', '{"modelId":"sonnet"}', 't24'),

  -- A session nothing was ever replayed into: untouched, and not even looked at.
  ('c01', 'ag_clean', 'user_message', '{"content":[{"type":"text","text":"write the docs"}]}', 't01'),
  ('c02', 'ag_clean', 'agent_message', '{"text":"On it.","streaming":false}', 't02'),
  ('c03', 'ag_clean', 'turn_end', '{"stopReason":"end_turn"}', 't03'),

  -- A session whose adapter compacted before it was reattached, so the replay
  -- starts from a summary and matches nothing. It keeps its duplicates.
  ('p01', 'ag_compacted', 'user_message', '{"content":[{"type":"text","text":"the original ask"}]}', 't01'),
  ('p02', 'ag_compacted', 'agent_message', '{"text":"Sure.","streaming":false}', 't02'),
  ('p03', 'ag_compacted', 'turn_end', '{"stopReason":"end_turn"}', 't03'),
  ('p04', 'ag_compacted', 'user_message_chunk', '{"content":{"type":"text","text":"[summary of earlier work]"}}', 't04'),
  ('p05', 'ag_compacted', 'agent_message', '{"text":"Sure.","streaming":false}', 't05');
`

beforeAll(async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  await client.query(LEGACY)
  await client.end()
  await getDb()
})

interface Row { id: string, seq: number, type: string }

async function events(agentSessionId: string): Promise<Row[]> {
  return query<Row>(
    'select id, seq, type from agent_events where agent_session_id = $1 order by seq',
    [agentSessionId]
  )
}

describe('booting on top of a log a session/load replay duplicated', () => {
  it('removes each replay burst and nothing around it', async () => {
    const rows = await events('ag_replayed')

    expect(rows.map(row => row.id)).toEqual([
      'r01', 'r02', 'r03', 'r04', 'r05', 'r06',
      'r07',
      // r08–r13 were the first replay.
      'r14',
      'r15', 'r16', 'r17',
      'r18',
      // r19–r23 were the second.
      'r24'
    ])
  })

  it('keeps the agent repeating itself, which is a thing agents do', async () => {
    // "Looking." is in the log four times: once per real turn and once per
    // replay. Identical text is not evidence of anything, so both real ones
    // stay — this is why the repair brackets a burst instead of deduplicating.
    const rows = await query<{ id: string }>(
      `select id from agent_events
        where agent_session_id = 'ag_replayed' and payload ->> 'text' = 'Looking.'
        order by seq`
    )

    expect(rows.map(row => row.id)).toEqual(['r02', 'r16'])
  })

  it('leaves a session that was never reattached exactly as it was', async () => {
    expect((await events('ag_clean')).map(row => row.id)).toEqual(['c01', 'c02', 'c03'])
  })

  it('leaves a burst it cannot prove alone, rather than guessing', async () => {
    // The adapter compacted, so the replay opens on a summary instead of the
    // session's first prompt. Nothing here is provably a copy, so nothing goes.
    expect((await events('ag_compacted')).map(row => row.id))
      .toEqual(['p01', 'p02', 'p03', 'p04', 'p05'])
  })

  it('is a no-op the second time, with nothing left to recognise', async () => {
    const before = await events('ag_replayed')

    const { closeDb } = await import('../../server/lib/db')
    await closeDb()
    await getDb()

    expect(await events('ag_replayed')).toEqual(before)
  })
})
