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

// A template literal: a backtick in a SQL comment below ends the string, and
// shows up as a TypeScript error several lines later. Escape it as \`.
const SCHEMA = /* sql */ `
create table if not exists settings (
  key text primary key,
  value jsonb not null
);

create table if not exists projects (
  id text primary key,
  name text not null,
  repo_path text not null,
  created_at text not null,
  updated_at text not null
);
-- Retiring a project takes its environments' containers and checkouts away and
-- keeps every row: the agent sessions that ran inside still name the
-- environment, and the environment names this. Nothing retired is restorable —
-- the containers, volumes and images really are gone. See server/lib/projects.ts.
alter table projects add column if not exists retired_at text;
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_name = 'projects' and column_name = 'deleted_at') then
    update projects set retired_at = coalesce(retired_at, deleted_at);
    alter table projects drop column deleted_at;
  end if;
end $$;

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
-- Retired: the container, the worktree and the image are gone and the
-- row is not. It is what makes every session that ran here unstartable, and it
-- is also the only record left of where those sessions ran.
alter table dev_environments add column if not exists retired_at text;
-- The Docker resources a cleanup could not remove, and why. Empty is the normal
-- state; each entry names what is blocking it, and the row is kept even once
-- nothing else references it so that a later cleanup can still find them.
alter table dev_environments add column if not exists leftovers jsonb not null default '[]'::jsonb;
-- When a sweep confirmed a retired environment owes nothing. From then on the
-- row claims nothing, so a path or a name derived from its id is never removed
-- again, whatever later appears there. Written once.
alter table dev_environments add column if not exists cleaned_at text;
-- The branch the worktree was created on, deleted at retirement once fully
-- merged, whether Domo made it or reused it.
alter table dev_environments add column if not exists branch text;
alter table dev_environments drop column if exists branch_created;
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_name = 'dev_environments' and column_name = 'deleted_at') then
    update dev_environments set retired_at = coalesce(retired_at, deleted_at);
    alter table dev_environments drop column deleted_at;
  end if;
end $$;

-- The adapter versions in the runtime volume the container mounted, by
-- adapter. Fixed at docker run, so written at creation and at each upgrade,
-- or the first time a running container is asked.
alter table dev_environments add column if not exists adapter_versions jsonb;
alter table dev_environments add column if not exists last_upgrade jsonb;

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
  updated_at text not null
);
create index if not exists dev_environment_ports_environment on dev_environment_ports(dev_environment_id);
-- Which container the port is in: empty for the environment itself, otherwise
-- the name of a container the environment started on the host daemon. Two
-- services of one stack may well both listen on 80, so it is part of the key.
-- The old key's name is what Postgres generated for it, cut to 63 bytes, which
-- is why it ends in protoco_key: spelled out in full it matches nothing.
alter table dev_environment_ports add column if not exists service text not null default '';
alter table dev_environment_ports
  drop constraint if exists dev_environment_ports_dev_environment_id_inner_port_protoco_key;
create unique index if not exists dev_environment_ports_identity
  on dev_environment_ports(dev_environment_id, service, inner_port, protocol);

create table if not exists agent_sessions (
  id text primary key,
  adapter text not null default 'claude-code',
  acp_session_id text,
  title text not null,
  cwd text not null,
  dev_environment_id text references dev_environments(id) on delete set null,
  status text not null default 'idle',
  mode_id text,
  modes jsonb,
  model text,
  config jsonb,
  config_options jsonb,
  steering boolean,
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
-- Context occupancy and session cost, from the ACP \`usage_update\` stream. A
-- column rather than an event: it arrives many times a turn, says nothing about
-- what the agent did, and only the latest reading is ever of interest.
alter table agent_sessions add column if not exists usage jsonb;
-- The adapter's own settings, which differ per adapter and per model: Claude
-- Code calls reasoning effort "effort" and codex-acp "reasoning_effort", and
-- each offers options the other has never heard of. Two columns, because they
-- answer different questions: config is what was asked for and is re-applied
-- on every attach, config_options is what the adapter last said it offers and
-- is only ever a record of its answer.
alter table agent_sessions add column if not exists config jsonb;
alter table agent_sessions add column if not exists config_options jsonb;
-- Whether the adapter advertised the steering extension on the last attach.
-- Recorded for the reason config_options is: the composer has to say what a
-- steer will really do, and asking the adapter would mean starting one. Null
-- is "never attached", which is not the same answer as false.
alter table agent_sessions add column if not exists steering boolean;
-- A session has one visibility state and it is archived. Whether it can be
-- started is never stored: it is a question about the place it ran — is its
-- environment still there, is its working directory still on disk — and a
-- column would only be a copy of that answer, wrong the moment the environment
-- is retired. See shared/retention.ts.
--
-- An install that ran the two-state version keeps its archived flag, which is
-- where those sessions belong under one state; the columns go.
drop index if exists agent_sessions_retired;
alter table agent_sessions drop column if exists retired_at;
alter table agent_sessions drop column if exists retired_reason;
-- The agent that spawned this one over the mesh, if one did. The ownership
-- edge that cross-agent powers (scheduling for it, answering its permission
-- requests, withdrawing its queued messages) are tied to.
alter table agent_sessions add column if not exists spawned_by text references agent_sessions(id) on delete set null;
-- The title is Domo's stand-in — the placeholder, or the first words of the
-- first message — and a generated one may replace it. Any title somebody set
-- clears it. Rows from before it: only the placeholder is a stand-in.
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_name = 'agent_sessions' and column_name = 'title_placeholder') then
    alter table agent_sessions add column title_placeholder boolean not null default false;
    update agent_sessions set title_placeholder = true where title = 'Coding session';
  end if;
end $$;

-- The live voice conversation is gone: talking happens in a coding session's
-- voice bar. Its tables go, the link to them goes first, and the settings
-- only it read go too. Its Gemini voice is the voice bar's now.
alter table agent_sessions drop column if exists voice_session_id;
drop table if exists voice_messages;
drop table if exists voice_sessions;
insert into settings (key, value)
  select 'agentVoice', jsonb_build_object('v', jsonb_build_object('geminiVoice', value->'v'))
    from settings where key = 'voiceName'
  on conflict (key) do update
    set value = jsonb_set(settings.value, '{v,geminiVoice}', excluded.value->'v'->'geminiVoice')
    where not (settings.value->'v' ? 'geminiVoice');
delete from settings where key in (
  'voiceProvider', 'liveModel', 'voiceName', 'openaiLiveModel', 'openaiVoiceName', 'openaiDelegation',
  'systemInstruction', 'proactiveNotifications', 'language', 'autoTitle'
);

-- Domo's own auto-approve is gone: the adapters' permission modes do the same
-- without a round trip through Domo. An install that had it on keeps agents
-- that do not ask, through those modes, wherever the mode was still the
-- adapter's own default; a mode somebody chose stays.
insert into settings (key, value)
  select 'defaultAgentModes', '{"v": {}}'::jsonb
    from settings where key = 'autoApprovePermissions' and value->'v' = 'true'::jsonb
  on conflict (key) do nothing;
update settings
   set value = jsonb_set(jsonb_set(value, '{v,claude-code}',
         case when coalesce(value->'v'->>'claude-code',
                            (select value->>'v' from settings where key = 'defaultAgentMode'), 'default') = 'default'
              then '"bypassPermissions"'::jsonb else value->'v'->'claude-code' end),
         '{v,codex}',
         case when coalesce(value->'v'->>'codex', 'agent') = 'agent'
              then '"agent-full-access"'::jsonb else value->'v'->'codex' end)
 where key = 'defaultAgentModes'
   and exists (select 1 from settings where key = 'autoApprovePermissions' and value->'v' = 'true'::jsonb);
insert into settings (key, value)
  select 'openCodePermission', '{"v": {"host": "allow", "environment": "allow"}}'::jsonb
    from settings where key = 'autoApprovePermissions' and value->'v' = 'true'::jsonb
  on conflict (key) do update set value = jsonb_set(settings.value, '{v,host}', '"allow"'::jsonb);
delete from settings where key = 'autoApprovePermissions';

-- An assistant: a named identity that outlives any one coding session. Its
-- sessions are ordinary agent_sessions rows chained by handoffs; this row says
-- who it is, what the next session starts on, and which session is current.
-- Streamed to the browser, so nothing secret: the avatar is a small data URL
-- the server shrinks to a 256px WebP on the way in, and the row is written
-- on edits and handoffs only, never per turn.
create table if not exists assistants (
  id text primary key,
  name text not null,
  avatar text,
  persona text not null default '',
  adapter text not null default 'claude-code',
  model text,
  mode_id text,
  cwd text not null,
  dev_environment_id text references dev_environments(id) on delete set null,
  -- Percent of the context window at which a finished turn triggers a
  -- handoff. Null is never.
  handoff_threshold integer,
  current_session_id text,
  -- A handoff under way: why, which session is writing the note, and the note
  -- once the agent has written it. Null when none is.
  handoff jsonb,
  archived boolean not null default false,
  created_at text not null,
  updated_at text not null
);

-- Who made it: 'user', or 'agent:<id>' for one made over the mesh. That agent
-- may change it later; so may the assistant itself, and the human always.
alter table assistants add column if not exists created_by text not null default 'user';
-- The voice the voice bar speaks as it with: an engine and one of its voices,
-- or 'clone:<id>' for a Pocket voice cloned from a sample. The sample itself
-- is a file under <data>/voices, never a row. Null is the bar's own voice.
alter table assistants add column if not exists voice jsonb;

-- The assistant a session belongs to; null for an ordinary session.
alter table agent_sessions add column if not exists assistant_id text references assistants(id) on delete set null;
create index if not exists agent_sessions_assistant on agent_sessions(assistant_id, created_at);

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

-- \`usage_update\` was appended like any other update before it became session
-- state, so an older install holds one row per reading — dozens per turn, none
-- of them rendered. Idempotent: nothing writes them any more.
delete from agent_events where type = 'usage_update';

-- Bursts of replayed history, from before Domo learned to ignore what an
-- adapter says while it is answering \`session/load\`. Both adapters restore a
-- session by reading its transcript back as ordinary session/update
-- notifications, so every reattach appended a second copy of the conversation
-- — several times an hour on a machine running Domo under pnpm dev.
--
-- A burst is recognised by what only a replay produces: a user_message_chunk
-- whose text is the session's own first prompt, which Domo already holds as a
-- user_message and never writes this way itself. From there the burst runs to
-- the first row of a kind a replay cannot contain (user_message, turn_end,
-- permission_request, model_changed, an error, the adapter exiting), which is
-- what keeps the deletion inside it. A session whose history was compacted, or
-- whose first prompt was an attachment with no text, matches nothing and keeps
-- its duplicates: leaving a mess is the failure to prefer here.
with first_prompt as (
  select distinct on (agent_session_id)
         agent_session_id,
         (select block ->> 'text'
            from jsonb_array_elements(
                   case when jsonb_typeof(payload -> 'content') = 'array'
                        then payload -> 'content' else '[]'::jsonb end
                 ) block
           where block ->> 'type' = 'text'
           limit 1) as text
    from agent_events
   where type = 'user_message'
   order by agent_session_id, seq
),
replayable as (
  select id, agent_session_id, seq, type, payload,
         type in (
           'user_message_chunk', 'agent_message', 'agent_thought',
           'tool_call', 'tool_call_update', 'plan', 'plan_update',
           'available_commands_update', 'session_info_update'
         ) as replayed_kind
    from agent_events
   where agent_session_id in (
     select agent_session_id from agent_events where type = 'user_message_chunk'
   )
),
runs as (
  select *,
         sum(case when replayed_kind then 0 else 1 end)
           over (partition by agent_session_id order by seq) as run
    from replayable
),
bursts as (
  select r.agent_session_id, r.run, min(r.seq) as from_seq
    from runs r
    join first_prompt f on f.agent_session_id = r.agent_session_id
   where r.type = 'user_message_chunk'
     and f.text is not null
     and r.payload #>> '{content,text}' = f.text
   group by r.agent_session_id, r.run
)
delete from agent_events e
 using runs r, bursts b
 where e.id = r.id
   and r.replayed_kind
   and r.agent_session_id = b.agent_session_id
   and r.run = b.run
   and r.seq >= b.from_seq;

-- Messages waiting for an agent, because Domo owns the queue rather than the
-- adapter. A second \`session/prompt\` sent while a turn runs is queued inside
-- the adapter, invisibly, and lost when it restarts; a row here is neither.
-- \`delivery\` records what was asked for, not what happened: a row only exists
-- because the message could not be handed over at once.
create table if not exists agent_inbox (
  id text primary key,
  agent_session_id text not null references agent_sessions(id) on delete cascade,
  -- Global, not per session: two concurrent enqueues must never collide. Only the order within a session
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
-- How many more turn ends the subscriber wants to hear about; the row goes
-- when it reaches zero. Null is indefinite, which is what every row made
-- before the column existed meant.
alter table agent_subscriptions add column if not exists remaining_turns integer;

-- An agent that sent a message and wants to hear about the turn that answers
-- it. Keyed by the message's own id, which the user_message of that turn names:
-- that event, not the send, turns the row into a subscription, so a message
-- queued behind other turns is not reported on when the first of them ends.
create table if not exists agent_message_watches (
  message_id text primary key,
  subscriber_id text not null references agent_sessions(id) on delete cascade,
  target_id text not null references agent_sessions(id) on delete cascade,
  remaining_turns integer,
  created_at text not null
);

-- Prompts that wake an existing agent on a recurring cron schedule or at one
-- specific instant. next_run_at is materialised so the scheduler only needs an
-- indexed due-time query; the expression is parsed when the row is written.
create table if not exists cron_jobs (
  id text primary key,
  agent_session_id text not null references agent_sessions(id) on delete cascade,
  name text not null,
  prompt text not null,
  schedule_type text not null,
  cron_expression text,
  timezone text not null default 'UTC',
  run_at text,
  enabled boolean not null default true,
  delivery text not null default 'queue',
  next_run_at text,
  last_run_at text,
  last_status text,
  last_error text,
  run_count integer not null default 0,
  created_by text not null default 'user',
  created_at text not null,
  updated_at text not null
);
create index if not exists cron_jobs_due on cron_jobs(next_run_at) where enabled = true;
create index if not exists cron_jobs_agent on cron_jobs(agent_session_id);

-- A schedule may wake an assistant instead of one session: it is delivered to
-- whichever session is current when it fires, so it survives every handoff.
-- Exactly one of the two targets is set.
alter table cron_jobs add column if not exists assistant_id text references assistants(id) on delete cascade;
alter table cron_jobs alter column agent_session_id drop not null;
alter table cron_jobs drop constraint if exists cron_jobs_one_target;
alter table cron_jobs add constraint cron_jobs_one_target
  check ((agent_session_id is null) <> (assistant_id is null));

-- One row per attempted firing makes failures inspectable and gives each
-- scheduled instant a unique durable claim across overlapping timer ticks.
create table if not exists cron_runs (
  id text primary key,
  cron_job_id text not null references cron_jobs(id) on delete cascade,
  scheduled_for text not null,
  started_at text not null,
  finished_at text,
  status text not null default 'running',
  outcome text,
  error text,
  unique (cron_job_id, scheduled_for)
);
create index if not exists cron_runs_job on cron_runs(cron_job_id, started_at desc);

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
  created_at text not null,
  updated_at text not null
);
-- Every server goes to every coding agent; a voice-only one was meant for the
-- voice agent, and coding sessions are where the talking happens now.
alter table mcp_servers drop column if exists scope;

-- What an agent wanted the human to see, kept until the human has seen it: a
-- line in one agent's transcript is somewhere nobody is looking. Attachments are copied under the data
-- directory and listed here by name and path, never inlined.
create table if not exists notifications (
  id text primary key,
  agent_session_id text references agent_sessions(id) on delete set null,
  agent_title text not null,
  message text not null,
  urgent boolean not null default false,
  attachments jsonb not null default '[]'::jsonb,
  created_at text not null,
  seen_at text
);
create index if not exists notifications_unseen on notifications(created_at) where seen_at is null;

-- One row per rate-limit window per provider, account-wide: the limits belong
-- to the developer rather than to any one session, and have to be readable when
-- nothing is running at all. Fed by the poller and, between polls, by what
-- rides in on a working agent's \`usage_update\`.
--
-- Nothing secret is allowed in here. The table is streamed to the browser
-- through Electric, so no token, no \`Authorization\` header and no raw
-- response body ever becomes a column.
create table if not exists usage_limits (
  provider text not null,
  -- \`five_hour\`, \`seven_day\`, \`extra_usage\`, or for Codex \`<limitId>:primary\`.
  limit_id text not null,
  label text not null,
  -- Always 0-100 and always ISO 8601, whatever scale the source reported in:
  -- Claude's endpoint answers percentages, its session events fractions, and
  -- resets arrive as epoch seconds from some sources and ISO strings from others.
  used_percent double precision,
  resets_at text,
  window_minutes integer,
  status text,
  -- Money rather than a percentage, for a credits row.
  amount_used double precision,
  amount_limit double precision,
  currency text,
  source text not null,
  updated_at text not null,
  primary key (provider, limit_id)
);

-- Whether each provider's poll works, kept apart from the readings themselves
-- so a failed poll leaves the last good numbers in place instead of rewriting
-- every row. It is also what lets the UI tell "no data yet" from "not
-- configured" from "the last attempt failed".
create table if not exists usage_providers (
  provider text primary key,
  state text not null,
  message text,
  checked_at text not null
);

-- Where an installed Domo stands against its update channel: one row, written
-- by the updater in the server (server/lib/updates.ts). Absent under pnpm dev.
create table if not exists app_update (
  id text primary key,
  installed_commit text not null,
  installed_at text not null,
  channel text not null,
  target_commit text,
  behind integer,
  commits jsonb not null default '[]'::jsonb,
  checked_at text,
  state text not null,
  blockers jsonb not null default '[]'::jsonb,
  last_error text,
  last_applied_at text,
  updated_at text not null
);

-- How full the disk under Docker is, and what the shared environment caches
-- on it hold: one row, written by server/lib/dev-env/cache-maintenance.ts
-- when something changed, never on a timer alone.
create table if not exists docker_disk (
  id text primary key,
  total_bytes double precision not null,
  free_bytes double precision not null,
  level text not null,
  caches jsonb not null default '[]'::jsonb,
  docker jsonb not null default '[]'::jsonb,
  reclaimable_bytes double precision not null default 0,
  measured_at text,
  checked_at text not null,
  cleaning boolean not null default false,
  last_cleanup_at text,
  last_cleanup_level text,
  last_freed_bytes double precision,
  last_error text,
  updated_at text not null
);

-- Electric replays updates from the WAL: FULL replica identity makes sure a
-- changed row arrives complete, not just its key + changed columns.
alter table agent_sessions replica identity full;
alter table assistants replica identity full;
alter table agent_events replica identity full;
alter table agent_permissions replica identity full;
alter table agent_inbox replica identity full;
alter table agent_subscriptions replica identity full;
alter table agent_message_watches replica identity full;
alter table cron_jobs replica identity full;
alter table mcp_servers replica identity full;
alter table settings replica identity full;
alter table projects replica identity full;
alter table dev_environments replica identity full;
alter table dev_environment_ports replica identity full;
alter table usage_limits replica identity full;
alter table usage_providers replica identity full;
alter table notifications replica identity full;
alter table app_update replica identity full;
alter table docker_disk replica identity full;
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
