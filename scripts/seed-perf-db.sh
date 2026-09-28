#!/bin/sh
# Copy a realistic slice of the developer's own `domo` database into `domo_e2e`,
# which is where the second dev server in docs/working-on-domo.md points.
#
# Only for measuring the browser against a transcript the size of a real one.
# `pnpm test` resets `domo_e2e` (the `electric` project does), so run this after
# a test run, not before.
set -e

PSQL="docker exec -e PGPASSWORD=password domo-postgres-1 psql -h localhost -U postgres"

copy() {
  $PSQL -d domo -c "copy ($2) to '/tmp/seed.csv' with csv" >/dev/null
  $PSQL -d domo_e2e -c "copy $1 from '/tmp/seed.csv' with csv" >/dev/null
  echo "  $1"
}

echo "seeding domo_e2e:"
copy projects 'select * from projects'
copy dev_environments 'select * from dev_environments'
copy voice_sessions 'select * from voice_sessions'
copy agent_sessions 'select * from agent_sessions'
copy voice_messages 'select * from voice_messages'
copy agent_inbox 'select * from agent_inbox'
copy agent_permissions 'select * from agent_permissions'
# The eight busiest transcripts: enough to measure against, far less than all.
copy agent_events "select * from agent_events where agent_session_id in (
  select agent_session_id from agent_events group by 1 order by count(*) desc limit 8
)"

$PSQL -d domo_e2e -c "select count(*) as agent_events from agent_events"
