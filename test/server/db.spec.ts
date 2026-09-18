import { describe, expect, it } from 'vitest'

import { closeDb, getDb, newId, nowIso, query, queryOne } from '../../server/lib/db'
import { databaseUnavailable, skipMessage } from '../helpers/database'

/**
 * The schema bootstraps itself on first boot: `create table if not exists` plus
 * `alter table … add column if not exists` plus a backfill, all re-run on every
 * start. It has to be idempotent, and Electric depends on details of it that no
 * unit test can see.
 */
const skip = !!databaseUnavailable()
if (skip) console.warn(`[test] ${skipMessage()}`)

/** Every table the app writes to, and every one Electric syncs. */
const TABLES = [
  'settings',
  'voice_sessions',
  'voice_messages',
  'projects',
  'dev_environments',
  'dev_environment_ports',
  'agent_sessions',
  'agent_events',
  'agent_permissions',
  'mcp_servers'
]

const SYNCED_TABLES = TABLES.filter(table => table !== 'dev_environment_ports')

describe.skipIf(skip)('schema bootstrap', () => {
  it('creates every table the app needs', async () => {
    const rows = await query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`
    )

    expect(rows.map(row => row.table_name)).toEqual([...TABLES].sort())
  })

  it('is idempotent: booting again against an existing database changes nothing', async () => {
    await query(
      `insert into projects (id, name, repo_path, created_at, updated_at) values ($1, $2, $3, $4, $4)`,
      ['prj_boot', 'existing', '/srv/existing', nowIso()]
    )

    // A second boot re-runs the whole schema, backfill included.
    await closeDb()
    await getDb()

    await expect(queryOne('select name from projects where id = $1', ['prj_boot']))
      .resolves.toMatchObject({ name: 'existing' })
  })

  it('gives every synced table REPLICA IDENTITY FULL, or Electric sends partial rows', async () => {
    const rows = await query<{ relname: string, relreplident: string }>(
      `select relname, relreplident from pg_class
        where relname = any($1) and relkind = 'r' order by relname`,
      [SYNCED_TABLES]
    )

    expect(rows).toHaveLength(SYNCED_TABLES.length)
    expect(rows.filter(row => row.relreplident !== 'f')).toEqual([])
  })

  it('defaults new conversations to an auto-generated title', async () => {
    const column = await queryOne<{ column_default: string, is_nullable: string }>(
      `select column_default, is_nullable from information_schema.columns
        where table_name = 'voice_sessions' and column_name = 'title_source'`
    )

    expect(column).toMatchObject({ is_nullable: 'NO' })
    expect(column!.column_default).toContain('auto')
  })
})

describe.skipIf(skip)('sequence columns', () => {
  async function session(id: string) {
    await query(
      `insert into agent_sessions (id, adapter, title, cwd, created_at, updated_at)
       values ($1, 'claude-code', $1, '/tmp', $2, $2)`,
      [id, nowIso()]
    )
  }

  async function appendEvent(sessionId: string, index: number) {
    return queryOne<{ seq: number }>(
      `insert into agent_events (id, agent_session_id, type, payload, created_at)
       values ($1, $2, 'agent_message_chunk', '{}'::jsonb, $3) returning seq`,
      [newId('ev'), sessionId, nowIso()]
    ).then(row => ({ index, seq: row!.seq }))
  }

  it('hands out a distinct seq to concurrent appends', async () => {
    // `max(seq) + 1` used to collide here and scramble streamed text.
    await session('ag_seq_1')
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => appendEvent('ag_seq_1', index)))

    expect(new Set(results.map(result => result.seq)).size).toBe(50)
  })

  it('is global, not per session: ordering only ever matters within one', async () => {
    await session('ag_seq_2')
    await session('ag_seq_3')

    const [first, second] = await Promise.all([appendEvent('ag_seq_2', 0), appendEvent('ag_seq_3', 0)])

    expect(first!.seq).not.toBe(second!.seq)
  })

  it('comes back as a number, not the string pg returns for bigint', async () => {
    await session('ag_seq_4')
    const { seq } = await appendEvent('ag_seq_4', 0)

    expect(typeof seq).toBe('number')
  })
})

describe('id and timestamp helpers', () => {
  it('prefixes ids so a stray id is traceable to its table', () => {
    expect(newId('ag')).toMatch(/^ag_[0-9a-f]{20}$/)
  })

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('ev')))

    expect(ids.size).toBe(1000)
  })

  it('timestamps in UTC ISO 8601, which is also the sort order', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})
