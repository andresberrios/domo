/**
 * Verifies the runner supervisor (server/lib/electric/runner-supervisor.ts
 * — the SHIPPED helper, imported directly here, not a copy).
 *
 * The prod incident: when the agents-server the pull-wake runner is
 * consuming goes away long enough (crash / redeploy / a sustained
 * durable-streams blip from a runaway entity), the runner's single-pass
 * `run()` loop ends — `runner.running` flips to false — and
 * agents-runtime does NOT restart it. Wake delivery is then permanently
 * dead until a manual `domo restart`. `superviseRunnerLoop` must detect
 * the dead loop and auto-reconnect (reusing the runner → offset-replay)
 * so delivery resumes with NO manual intervention.
 *
 * NB a *graceful/brief* `docker compose restart` does NOT reproduce
 * this — the DurableStream live consumer transparently reconnects
 * across a quick blip (that path was already covered by offset-replay).
 * The real failure needs a *sustained* outage, so this test fully
 * STOPS agents-server and waits for the loop to actually end before
 * bringing it back. If the loop never ends even then, that is itself a
 * red flag printed loudly (the supervisor only acts on running===false;
 * a different hang would need a different fix).
 *
 * Prod-safe: isolated dev stack only (compose project `domo-electric`,
 * alt host ports 4467/4468, own named volumes). Never touches the prod
 * `domo` project / :4437.
 *
 *   DOMO_AGENTS_PORT=4467 DOMO_AGENTS_STREAMS_PORT=4468 \
 *     docker compose -f docker-compose.yml up -d
 *   node --experimental-strip-types smoke/runner-supervisor-resume.mjs
 *
 * Signals are the runner's own exposed API (no entity-handler wiring):
 *   - runner.running  : false === the loop ended (prod failure)
 *   - runner.offset   : advances as the runner consumes wake events
 *   - supervisor log  : "reconnected" line
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  createEntityRegistry,
  createPullWakeRunner,
  createRuntimeHandler,
  createRuntimeServerClient,
} from '@electric-ax/agents-runtime'
import { superviseRunnerLoop } from '../server/lib/electric/runner-supervisor.ts'

const pexec = promisify(execFile)
const BASE = 'http://127.0.0.1:4467'
const RUNNER = 'supchk-runtime'
const TYPE = 'superchk'
const ID = `sc-${Date.now()}`
const ENTITY = `/${TYPE}/${ID}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dc = (...args) =>
  pexec('docker', ['compose', '-p', 'domo-electric', '-f', 'docker-compose.yml', ...args])

const supLog = []

async function registerRunner() {
  const r = await fetch(`${BASE}/_electric/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: RUNNER,
      label: 'supervisor-check',
      kind: 'local',
      admin_status: 'enabled',
    }),
  })
  if (!r.ok && r.status !== 409) {
    throw new Error(`runner reg ${r.status} ${await r.text()}`)
  }
  return r.ok ? await r.json() : {}
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/`, { method: 'GET' })
      if (r.status) return true
    } catch {
      /* not yet */
    }
    await sleep(1000)
  }
  return false
}

async function waitFor(label, pred, ms, step = 1000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await pred()) return true
    await sleep(step)
  }
  console.log(`   (timed out waiting for: ${label})`)
  return false
}

async function main() {
  const registry = createEntityRegistry()
  registry.define(TYPE, {
    description: 'supervisor-check entity (no-op handler)',
    creationSchema: z.object({ sessionId: z.string() }),
    inboxSchemas: { ping: z.object({ n: z.number() }) },
    state: {},
    handler: () => {},
  })

  const runtime = createRuntimeHandler({ baseUrl: BASE, registry, name: 'sup' })
  await runtime.registerTypes()
  const { wake_stream_offset } = await registerRunner()

  const runner = createPullWakeRunner({
    baseUrl: BASE,
    runnerId: RUNNER,
    runtime,
    offset: wake_stream_offset,
    onError: () => true, // same as the app: suppress; supervisor reconnects
  })
  runner.start()

  // Drive the REAL shipped supervisor. `stop` flips isDone to end it.
  let stop = false
  const sink = (kind) => (m, e) => {
    const line = e === undefined ? `${m}` : `${m} ${e?.message || e}`
    supLog.push(line)
    console.log(`   [sup:${kind}]`, line)
  }
  const supervisor = superviseRunnerLoop(runner, {
    reassert: async () => {
      await registerRunner()
    },
    isDone: () => stop,
    // Tight knobs so the test isn't slow; prod defaults (1s/30s/60s)
    // are covered by code review.
    minMs: 500,
    maxMs: 3000,
    healthyMs: 4000,
    log: sink('log'),
    warn: sink('warn'),
    error: sink('err'),
  })

  const client = createRuntimeServerClient({ baseUrl: BASE })

  console.log('1) spawn entity + send #1 (baseline, runner healthy)')
  await client.spawnEntity({
    type: TYPE,
    id: ID,
    args: { sessionId: ID },
    dispatch_policy: { targets: [{ type: 'runner', runnerId: RUNNER }] },
  })
  await client.sendEntityMessage({ targetUrl: ENTITY, type: 'ping', payload: { n: 1 } })
  const off0 = runner.offset
  const consumed1 = await waitFor(
    'runner to consume wake #1 (offset advances)',
    () => runner.offset !== off0,
    20000,
  )
  console.log(
    `   runner.running=${runner.running} offset ${off0} -> ${runner.offset} (consumed1=${consumed1})`,
  )

  console.log('2) STOP agents-server (sustained outage — the real failure)')
  await dc('stop', 'agents-server')
  // The prod failure: the runner's single-pass loop ends.
  const loopEnded = await waitFor(
    'runner loop to end (running===false)',
    () => runner.running === false,
    120000,
  )
  console.log(`   runner.running===false (loop ended): ${loopEnded}`)
  if (!loopEnded) {
    console.log(
      '   !! RED FLAG: the loop never ended despite a 120s full outage. ' +
        'The supervisor only acts on running===false, so the prod hang ' +
        'must be a different mechanism — do NOT ship without rethinking.',
    )
  }

  console.log('3) START agents-server back (supervisor must auto-recover)')
  await dc('start', 'agents-server')
  if (!(await waitUp())) throw new Error('isolated agents-server did not return')

  const reconnected = await waitFor(
    'supervisor to reconnect the runner',
    () => runner.running === true && supLog.some((l) => l.includes('reconnected')),
    60000,
  )
  console.log(
    `   runner.running=${runner.running}, supervisor logged reconnect: ` +
      `${supLog.some((l) => l.includes('reconnected'))}`,
  )

  console.log('4) send #2 — does the reconnected runner consume it?')
  await client
    .spawnEntity({
      type: TYPE,
      id: ID,
      args: { sessionId: ID },
      dispatch_policy: { targets: [{ type: 'runner', runnerId: RUNNER }] },
    })
    .catch(() => {})
  const offBefore2 = runner.offset
  await client.sendEntityMessage({ targetUrl: ENTITY, type: 'ping', payload: { n: 2 } })
  const consumed2 = await waitFor(
    'reconnected runner to consume wake #2 (offset advances)',
    () => runner.offset !== offBefore2,
    40000,
  )
  console.log(
    `   offset ${offBefore2} -> ${runner.offset} (consumed2=${consumed2})`,
  )

  // teardown
  stop = true
  await runner.stop().catch(() => {})
  await supervisor.catch(() => {})
  await client.deleteEntity(ENTITY).catch(() => {})

  const ok = consumed1 && loopEnded && reconnected && consumed2
  console.log(
    ok
      ? '\nPASS — a sustained agents-server outage ended the runner loop; ' +
          'the supervisor auto-reconnected it and wake consumption resumed ' +
          'with NO manual intervention'
      : '\nFAIL — auto-recovery did not hold ' +
          `(consumed1=${consumed1} loopEnded=${loopEnded} ` +
          `reconnected=${reconnected} consumed2=${consumed2})`,
  )
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('check error:', e)
  process.exit(1)
})
