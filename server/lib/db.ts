import pg from 'pg'

/**
 * Postgres lives in Docker (see docker-compose.yml) and is the single source of
 * truth. ElectricSQL tails its logical replication stream and serves shapes to
 * the browser, so anything written here shows up in the UI without a refresh.
 */

export const DATABASE_URL
  = process.env.DATABASE_URL
    || process.env.NUXT_DATABASE_URL
    || 'postgresql://postgres:password@localhost:54321/domo'

// pg returns bigint/numeric as strings by default; seq columns are small enough
// to be safe as numbers and the UI sorts on them.
pg.types.setTypeParser(20, value => Number(value))

const SCHEMA = /* sql */ `
create table if not exists settings (
  key text primary key,
  value jsonb not null
);

create table if not exists voice_sessions (
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
alter table voice_sessions add column if not exists title_source text;
alter table voice_sessions add column if not exists resumption_fingerprint text;
-- Rows from before auto-titling: anything but the placeholder was a rename.
update voice_sessions
   set title_source = case when title = 'New conversation' then 'auto' else 'user' end
 where title_source is null;
alter table voice_sessions alter column title_source set default 'auto';
alter table voice_sessions alter column title_source set not null;

create table if not exists voice_messages (
  id text primary key,
  session_id text not null references voice_sessions(id) on delete cascade,
  -- A global sequence, not a per-session counter: concurrent appends must never
  -- collide, and ordering only ever matters within one session anyway.
  seq bigserial not null,
  role text not null,
  text text not null default '',
  tool_name text,
  meta jsonb,
  created_at text not null
);
create index if not exists voice_messages_session_seq on voice_messages(session_id, seq);

create table if not exists agent_sessions (
  id text primary key,
  voice_session_id text references voice_sessions(id) on delete set null,
  adapter text not null default 'claude-code',
  acp_session_id text,
  title text not null,
  cwd text not null,
  status text not null default 'idle',
  mode_id text,
  modes jsonb,
  last_error text,
  summary text,
  created_at text not null,
  updated_at text not null,
  last_activity_at text,
  archived boolean not null default false
);

create table if not exists agent_events (
  id text primary key,
  agent_session_id text not null references agent_sessions(id) on delete cascade,
  seq bigserial not null,
  type text not null,
  payload jsonb not null,
  created_at text not null
);
create index if not exists agent_events_session_seq on agent_events(agent_session_id, seq);

create table if not exists agent_permissions (
  id text primary key,
  agent_session_id text not null references agent_sessions(id) on delete cascade,
  tool_call_id text,
  title text not null,
  options jsonb not null,
  tool_call jsonb,
  created_at text not null,
  resolved_at text,
  resolved_option_id text,
  resolved_by text
);
create index if not exists agent_permissions_session on agent_permissions(agent_session_id);

create table if not exists mcp_servers (
  id text primary key,
  name text not null,
  transport text not null,
  command text,
  args jsonb not null default '[]'::jsonb,
  env jsonb not null default '{}'::jsonb,
  url text,
  headers jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  scope text not null default 'both',
  created_at text not null,
  updated_at text not null
);

-- Electric replays updates from the WAL: FULL replica identity makes sure a
-- changed row arrives complete, not just its key + changed columns.
alter table voice_sessions replica identity full;
alter table voice_messages replica identity full;
alter table agent_sessions replica identity full;
alter table agent_events replica identity full;
alter table agent_permissions replica identity full;
alter table mcp_servers replica identity full;
alter table settings replica identity full;
`

let pool: pg.Pool | null = null
let ready: Promise<pg.Pool> | null = null

async function connect(): Promise<pg.Pool> {
  const created = new pg.Pool({ connectionString: DATABASE_URL, max: 10 })
  created.on('error', error => console.error('[db] pool error', error))

  // Docker Postgres can take a few seconds on a cold start.
  let lastError: unknown
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await created.query('select 1')
      await created.query(SCHEMA)
      pool = created
      return created
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  await created.end().catch(() => {})
  throw new Error(
    `Could not reach Postgres at ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}. `
    + `Start it with \`docker compose up -d\`. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  )
}

export async function getDb(): Promise<pg.Pool> {
  if (pool) return pool
  if (!ready) {
    ready = connect().catch((error) => {
      ready = null
      throw error
    })
  }
  return ready
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const db = await getDb()
  const result = await db.query(sql, params)
  return result.rows as T[]
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

export async function closeDb(): Promise<void> {
  await pool?.end().catch(() => {})
  pool = null
  ready = null
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}
