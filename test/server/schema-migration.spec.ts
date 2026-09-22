import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'

import { getDb, query } from '../../server/lib/db'

/**
 * The schema is also the migration: every boot re-runs it against whatever the
 * previous version left behind. This file starts from the *old* shape of two
 * tables and checks that booting brings them forward — the case a fresh
 * database can never exercise, and the one that breaks a real install.
 */

/** The tables as they were before `title_source` and the container columns. */
const LEGACY = /* sql */ `
create table voice_sessions (
  id text primary key,
  title text not null,
  status text not null default 'idle',
  model text not null,
  voice text not null,
  created_at text not null,
  updated_at text not null,
  last_activity_at text,
  archived boolean not null default false,
  resumption_handle text
);

create table projects (
  id text primary key,
  name text not null,
  repo_path text not null,
  created_at text not null,
  updated_at text not null
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
  updated_at text not null
);

insert into voice_sessions (id, title, model, voice, created_at, updated_at)
values ('vs_untouched', 'New conversation', 'm', 'v', 'now', 'now'),
       ('vs_renamed', 'Payments', 'm', 'v', 'now', 'now');

insert into projects (id, name, repo_path, created_at, updated_at)
values ('prj_1', 'api', '/srv/api', 'now', 'now');

insert into dev_environments (id, project_id, name, container_name, created_at, updated_at)
values ('env_legacy', 'prj_1', 'api', 'domo-dev-env_legacy', 'now', 'now');

insert into dev_environments (id, project_id, name, container_name, workspace_path, created_at, updated_at)
values ('env_custom', 'prj_1', 'api2', 'domo-dev-env_custom', '/workspaces/api2', 'now', 'now');
`

beforeAll(async () => {
  // Set the old shape up outside the pool, so booting is the first thing
  // `server/lib/db.ts` does to this database.
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  await client.query(LEGACY)
  await client.end()
  await getDb()
})

describe('booting on top of a pre-title_source database', () => {
  it('treats the untouched placeholder as Domo\'s to rename', async () => {
    const rows = await query<{ id: string, title_source: string }>(
      'select id, title_source from voice_sessions order by id'
    )

    expect(rows).toEqual([
      { id: 'vs_renamed', title_source: 'user' },
      { id: 'vs_untouched', title_source: 'auto' }
    ])
  })

  it('leaves no row without an owner', async () => {
    const rows = await query('select 1 from voice_sessions where title_source is null')

    expect(rows).toEqual([])
  })

  it('adds the columns the Dev Container work introduced', async () => {
    const rows = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'dev_environments'
          and column_name in ('container_id', 'config_source', 'config_path', 'remote_user')
        order by column_name`
    )

    expect(rows.map(row => row.column_name)).toEqual([
      'config_path', 'config_source', 'container_id', 'remote_user'
    ])
  })

  it('adds the per-session model column', async () => {
    // Two agents may be on different models at once, so it is a column and not
    // a setting. `add column if not exists` is what carries a real old install.
    const rows = await query<{ column_name: string, is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'agent_sessions' and column_name = 'model'`
    )

    expect(rows).toEqual([{ column_name: 'model', is_nullable: 'YES' }])
  })

  it('backfills the user only for environments built by the old node image', async () => {
    const rows = await query<{ id: string, remote_user: string | null, config_source: string }>(
      'select id, remote_user, config_source from dev_environments order by id'
    )

    expect(rows).toEqual([
      { id: 'env_custom', remote_user: null, config_source: 'default' },
      { id: 'env_legacy', remote_user: 'node', config_source: 'default' }
    ])
  })

  it('adds the retirement columns and leaves the sessions alone', async () => {
    // A session has one visibility state, and whether it can be started is
    // derived from these two rows rather than stored beside them.
    const retired = await query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_name in ('projects', 'dev_environments') and column_name = 'retired_at'
        order by table_name`
    )
    expect(retired.map(row => row.table_name)).toEqual(['dev_environments', 'projects'])

    const sessions = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'agent_sessions'
          and column_name in ('retired_at', 'retired_reason', 'archived')`
    )
    expect(sessions.map(row => row.column_name)).toEqual(['archived'])
  })

  it('leaves every pre-existing row live rather than retired', async () => {
    // A nullable column with no default: booting must not retire the projects
    // and environments an install still works in.
    await expect(query('select 1 from projects where retired_at is not null')).resolves.toEqual([])
    await expect(query('select 1 from dev_environments where retired_at is not null')).resolves.toEqual([])
  })

  it('creates the tables that did not exist yet', async () => {
    await expect(query('select 1 from dev_environment_ports')).resolves.toEqual([])
    await expect(query('select 1 from agent_events')).resolves.toEqual([])
  })
})
