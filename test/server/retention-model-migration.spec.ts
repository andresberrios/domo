import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'

import { getDb, query } from '../../server/lib/db'

/**
 * Booting on top of the *two-state* shape that shipped before this one.
 *
 * That version stored `agent_sessions.retired_at` beside `archived` and called
 * an environment's tombstone `deleted_at`. Collapsing to one visibility state
 * plus a derived startability means both of those have to be carried forward on
 * a database that already holds them, and a previously-retired session has to
 * land somewhere sensible rather than being resurrected onto the live list.
 *
 * It lands archived, which is where it belongs: retiring set `archived` too, so
 * the flag is already right and dropping the column is all there is to do.
 */
const TWO_STATE = /* sql */ `
create table projects (
  id text primary key,
  name text not null,
  repo_path text not null,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);

create table dev_environments (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  container_name text not null unique,
  workspace_path text not null default '/workspace/repo',
  status text not null default 'creating',
  last_error text,
  created_at text not null,
  updated_at text not null,
  deleted_at text
);

create table agent_sessions (
  id text primary key,
  adapter text not null default 'claude-code',
  title text not null,
  cwd text not null,
  dev_environment_id text references dev_environments(id) on delete set null,
  status text not null default 'idle',
  created_at text not null,
  updated_at text not null,
  archived boolean not null default false,
  retired_at text,
  retired_reason text
);

insert into projects (id, name, repo_path, created_at, updated_at, deleted_at)
values ('prj_live', 'api', '/srv/api', 'now', 'now', null),
       ('prj_gone', 'spike', '/srv/spike', 'now', 'now', '2026-09-21T10:00:00.000Z');

insert into dev_environments (id, project_id, name, container_name, created_at, updated_at, deleted_at)
values ('env_live', 'prj_live', 'feature-auth', 'domo-dev-env_live', 'now', 'now', null),
       ('env_gone', 'prj_gone', 'spike', 'domo-dev-env_gone', 'now', 'now', '2026-09-21T10:00:00.000Z');

insert into agent_sessions (id, title, cwd, dev_environment_id, created_at, updated_at, archived, retired_at, retired_reason)
values ('ag_live', 'Working', '/srv/api', 'env_live', 'now', 'now', false, null, null),
       ('ag_shelved', 'Shelved', '/srv/api', 'env_live', 'now', 'now', true, null, null),
       ('ag_retired', 'Finished', '/srv/spike', 'env_gone', 'now', 'now', true, '2026-09-21T10:00:00.000Z', 'environment-deleted');
`

beforeAll(async () => {
  // Outside the pool, so booting is the first thing `server/lib/db.ts` does.
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  await client.query(TWO_STATE)
  await client.end()
  await getDb()
})

describe('collapsing the two session states into one', () => {
  it('drops the session columns and leaves the archived flag deciding', async () => {
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'agent_sessions'
          and column_name in ('archived', 'retired_at', 'retired_reason')`
    )
    expect(columns.map(row => row.column_name)).toEqual(['archived'])

    // Retiring used to set `archived` as well, so a session that was retired is
    // already flagged and comes through the collapse put away rather than live.
    const sessions = await query<{ id: string, archived: boolean }>(
      'select id, archived from agent_sessions order by id'
    )
    expect(sessions).toEqual([
      { id: 'ag_live', archived: false },
      { id: 'ag_retired', archived: true },
      { id: 'ag_shelved', archived: true }
    ])
  })

  it('carries deleted_at over to retired_at rather than losing it', async () => {
    // The column is renamed, not re-derived: an environment whose container was
    // destroyed under the old name has to stay unstartable under the new one,
    // and nothing else records that.
    const environments = await query<{ id: string, retired_at: string | null }>(
      'select id, retired_at from dev_environments order by id'
    )
    expect(environments).toEqual([
      { id: 'env_gone', retired_at: '2026-09-21T10:00:00.000Z' },
      { id: 'env_live', retired_at: null }
    ])

    const projects = await query<{ id: string, retired_at: string | null }>(
      'select id, retired_at from projects order by id'
    )
    expect(projects).toEqual([
      { id: 'prj_gone', retired_at: '2026-09-21T10:00:00.000Z' },
      { id: 'prj_live', retired_at: null }
    ])
  })

  it('leaves no trace of the old column names', async () => {
    const stale = await query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_name in ('projects', 'dev_environments') and column_name = 'deleted_at'`
    )
    expect(stale).toEqual([])
  })
})
