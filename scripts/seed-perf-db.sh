#!/bin/sh
# Copy the developer's sessions into a separate compose stack, so a checkout
# whose code is not trusted yet can be run against data the size of the real
# thing without ever holding a connection to the real database.
#
#   COMPOSE_PROJECT_NAME=domo-perf DOMO_PG_PORT=54331 DOMO_ELECTRIC_PORT=30010 \
#     docker compose up -d postgres electric
#   # boot the dev server against it once, so the schema exists
#   sh scripts/seed-perf-db.sh
#
# The source is only ever read (`COPY … TO STDOUT`). What is copied is the
# record of the work — sessions, transcripts, conversations — and nothing that
# lets the server under test act on the world:
#
# - no `dev_environments` (and sessions lose their link to one): a server that
#   believes it owns an environment will start, stop, retire and clean up the
#   real containers and volumes behind it;
# - no `cron_jobs`: they would fire;
# - no `settings` or `mcp_servers`: they hold credentials.
set -e

SOURCE=${SEED_SOURCE_CONTAINER:-domo-postgres-1}
TARGET=${SEED_TARGET_CONTAINER:-domo-perf-postgres-1}

if [ "$SOURCE" = "$TARGET" ]; then
  echo "refusing to seed $TARGET from itself" >&2
  exit 1
fi

from() { docker exec -e PGPASSWORD=password "$SOURCE" psql -h localhost -U postgres -d domo "$@"; }
into() { docker exec -i -e PGPASSWORD=password "$TARGET" psql -h localhost -U postgres -d domo "$@"; }

if ! into -tAc "select 1 from agent_sessions limit 0" >/dev/null 2>&1; then
  echo "$TARGET has no schema yet: boot the dev server against it once first" >&2
  exit 1
fi
if [ "$(into -tAc 'select count(*) from agent_sessions')" != "0" ]; then
  echo "$TARGET already has sessions; seed a fresh stack instead" >&2
  exit 1
fi

copy() {
  # By name, never by position: the real database grew its columns one
  # `alter table` at a time, so their order there is not the order a fresh
  # schema has, and a positional copy lands values in the wrong columns.
  # `$2`, when given, is a column to copy as null.
  columns=$(into -tAc "
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      from information_schema.columns
     where table_schema = 'public' and table_name = '$1'")
  selected=$(into -tAc "
    select string_agg(case column_name when '${2:-}' then 'null' else quote_ident(column_name) end, ', ' order by ordinal_position)
      from information_schema.columns
     where table_schema = 'public' and table_name = '$1'")
  from -c "copy (select $selected from $1) to stdout" | into -c "copy $1 ($columns) from stdin" >/dev/null
  echo "  $1: $(into -tAc "select count(*) from $1")"
}

echo "seeding $TARGET from $SOURCE:"
copy projects
copy voice_sessions
# Sessions keep everything but their environment; see the note at the top.
copy agent_sessions dev_environment_id
copy voice_messages
copy agent_events
copy agent_inbox
copy agent_permissions

# The rows kept their `seq`, but the sequences behind them did not move: a row
# written after this would sort before everything copied.
into -tAc "select setval(pg_get_serial_sequence('agent_events', 'seq'), (select max(seq) from agent_events))" >/dev/null
into -tAc "select setval(pg_get_serial_sequence('voice_messages', 'seq'), (select max(seq) from voice_messages))" >/dev/null
echo "done"
