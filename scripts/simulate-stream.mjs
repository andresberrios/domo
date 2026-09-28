// Simulate a live agent turn against `domo_e2e`, the second dev server's
// database, so the browser can be measured while text is streaming without
// spending an agent's tokens to produce it.
//
//   node scripts/simulate-stream.mjs <agentSessionId> [ticks] [msBetween]
//
// One `agent_message` row is appended and then rewritten, which is what
// server/lib/acp does while a turn streams. Electric sends the whole row on
// each rewrite (the synced tables are REPLICA IDENTITY FULL), so this is the
// hot path the transcript has to survive. Pair it with `seed-perf-db.sh`, which
// puts a transcript the size of a real one in front of it.
import pg from 'pg'

const sessionId = process.argv[2]
const ticks = Number(process.argv[3] ?? 100)
const everyMs = Number(process.argv[4] ?? 150)

if (!sessionId) {
  console.error('usage: node scripts/simulate-stream.mjs <agentSessionId> [ticks] [msBetween]')
  process.exit(1)
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? 'postgresql://postgres:password@localhost:54321/domo_e2e'
})
const id = `ev_sim_${Date.now()}`
const words = 'the quick brown fox jumps over the lazy dog while the agent narrates its plan in detail'.split(' ')

await pool.query(
  `insert into agent_events (id, agent_session_id, type, payload, created_at)
   values ($1, $2, 'agent_message', $3, $4)`,
  [id, sessionId, JSON.stringify({ text: '', streaming: true }), new Date().toISOString()]
)
await pool.query(`update agent_sessions set status = 'thinking' where id = $1`, [sessionId])

let text = ''
for (let tick = 0; tick < ticks; tick += 1) {
  text += `${words[tick % words.length]} `
  await pool.query(`update agent_events set payload = $2 where id = $1`, [
    id,
    JSON.stringify({ text, streaming: true })
  ])
  await new Promise(resolve => setTimeout(resolve, everyMs))
}

await pool.query(`update agent_events set payload = $2 where id = $1`, [
  id,
  JSON.stringify({ text, streaming: false })
])
await pool.query(`update agent_sessions set status = 'idle' where id = $1`, [sessionId])
await pool.end()
console.log(`streamed ${ticks} rewrites into ${sessionId} as ${id}`)
