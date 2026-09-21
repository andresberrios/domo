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
-- The rolling summary of everything up to summary_through_seq: what a
-- reconnecting Live session is told instead of a transcript it cannot fit.
alter table voice_sessions add column if not exists summary text;
alter table voice_sessions add column if not exists summary_through_seq bigint;
alter table voice_sessions add column if not exists summary_updated_at text;
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

create table if not exists projects (
  id text primary key,
  name text not null,
  repo_path text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists dev_environments (
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
create index if not exists dev_environments_project on dev_environments(project_id);

alter table dev_environments add column if not exists container_id text;
alter table dev_environments add column if not exists config_source text not null default 'default';
alter table dev_environments add column if not exists config_path text;
alter table dev_environments add column if not exists remote_user text;
update dev_environments set remote_user = 'node'
where remote_user is null and container_id is null and workspace_path = '/workspace/repo';

create table if not exists dev_environment_ports (
  id text primary key,
  dev_environment_id text not null references dev_environments(id) on delete cascade,
  inner_port integer not null,
  protocol text not null default 'tcp',
  app_protocol text,
  label text,
  source text not null,
  host_port integer,
  listening boolean not null default false,
  forwarded boolean not null default false,
  created_at text not null,
  updated_at text not null,
  unique (dev_environment_id, inner_port, protocol)
);
create index if not exists dev_environment_ports_environment on dev_environment_ports(dev_environment_id);

create table if not exists agent_sessions (
  id text primary key,
  voice_session_id text references voice_sessions(id) on delete set null,
  adapter text not null default 'claude-code',
  acp_session_id text,
  title text not null,
  cwd text not null,
  dev_environment_id text references dev_environments(id) on delete set null,
  status text not null default 'idle',
  mode_id text,
  modes jsonb,
  model text,
  last_error text,
  summary text,
  created_at text not null,
  updated_at text not null,
  last_activity_at text,
  archived boolean not null default false
);

alter table agent_sessions add column if not exists dev_environment_id text references dev_environments(id) on delete set null;
-- The model this session runs on, so two agents can be on different ones at
-- once. Written back from what the adapter says it actually landed on.
alter table agent_sessions add column if not exists model text;

-- Mostly append-only: discrete ACP updates are inserted once, while a block of
-- streaming text is a single row rewritten in place until the block ends.
create table if not exists agent_events (
  id text primary key,
  agent_session_id text not null references agent_sessions(id) on delete cascade,
  seq bigserial not null,
  type text not null,
  payload jsonb not null,
  created_at text not null
);
create index if not exists agent_events_session_seq on agent_events(agent_session_id, seq);

-- Streaming text used to be one row per delta, which is most of the log on an
-- older install. Fold each run of consecutive chunks into the single row the
-- app writes now: the first row of the run keeps its id, seq and timestamp, so
-- the transcript reads exactly the same afterwards.
with ordered as (
  select id, agent_session_id, seq, type, payload,
         case
           when type in ('agent_message_chunk', 'agent_thought_chunk')
             and type is not distinct from lag(type) over (partition by agent_session_id order by seq)
           then 0 else 1
         end as opens_run
    from agent_events
   where agent_session_id in (
     select agent_session_id from agent_events
      where type in ('agent_message_chunk', 'agent_thought_chunk')
   )
),
runs as (
  select *, sum(opens_run) over (partition by agent_session_id order by seq) as run
    from ordered
),
folded as (
  select agent_session_id,
         run,
         min(seq) as head_seq,
         case type when 'agent_message_chunk' then 'agent_message' else 'agent_thought' end as folded_type,
         string_agg(coalesce(payload #>> '{content,text}', ''), '' order by seq) as text
    from runs
   where type in ('agent_message_chunk', 'agent_thought_chunk')
   group by agent_session_id, run, type
)
update agent_events e
   set type = f.folded_type,
       payload = jsonb_build_object('text', f.text, 'streaming', false)
  from folded f
 where e.agent_session_id = f.agent_session_id and e.seq = f.head_seq;
-- Whatever is left of those runs is the deltas the heads just absorbed.
delete from agent_events where type in ('agent_message_chunk', 'agent_thought_chunk');

-- Messages waiting for an agent, because Domo owns the queue rather than the
-- adapter. A second \`session/prompt\` sent while a turn runs is queued inside
-- the adapter, invisibly, and lost when it restarts; a row here is neither.
-- \`delivery\` records what was asked for, not what happened: a row only exists
-- because the message could not be handed over at once.
create table if not exists agent_inbox (
  id text primary key,
  agent_session_id text not null references agent_sessions(id) on delete cascade,
  -- Global, not per session, for the same reason voice_messages.seq is: two
  -- concurrent enqueues must never collide. Only the order within a session
  -- is ever read.
  seq bigserial not null,
  content jsonb not null,
  delivery text not null default 'queue',
  origin text not null default 'user',
  created_at text not null,
  delivered_at text
);
create index if not exists agent_inbox_session_seq on agent_inbox(agent_session_id, seq);

-- Who is told when an agent finishes a turn, needs a permission, or dies.
-- Both sides cascade: a subscription to a session that no longer exists is
-- not a thing that can be acted on.
create table if not exists agent_subscriptions (
  subscriber_id text not null references agent_sessions(id) on delete cascade,
  target_id text not null references agent_sessions(id) on delete cascade,
  created_at text not null,
  primary key (subscriber_id, target_id)
);
create index if not exists agent_subscriptions_target on agent_subscriptions(target_id);

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
alter table agent_inbox replica identity full;
alter table mcp_servers replica identity full;
alter table settings replica identity full;
alter table projects replica identity full;
alter table dev_environments replica identity full;
alter table dev_environment_ports replica identity full;
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
