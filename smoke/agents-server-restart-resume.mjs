/**
 * Verifies the vendored agents-server patch (release/agents-server-0.4.2
 * -boot-relink.patch): after the agents-server process is recreated
 * (crash / reboot / upgrade), it re-links every persisted entity's
 * pull-wake subscription on boot, so wake delivery resumes — the exact
 * scenario that was silently broken.
 *
 * Prod-safe: isolated dev stack only (compose project `domo-electric`,
 * alt host ports 4467/4468, own named volumes). The dev compose
 * bind-mounts the repo, so the container runs the HOST node_modules —
 * which `scripts/apply-patches.sh` (postinstall) has patched. Never
 * touches the prod `domo` project / :4437.
 *
 *   DOMO_AGENTS_PORT=4467 DOMO_AGENTS_STREAMS_PORT=4468 \
 *     docker compose -f docker-compose.yml up -d
 *   node smoke/agents-server-restart-resume.mjs
 *
 * It does NOT need a working entity handler — it asserts the agents-server
 * mechanics directly: subscription exists → recreate agents-server →
 * subscription is re-linked by the patch → a fresh send produces a wake.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  createEntityRegistry,
  createRuntimeHandler,
  createRuntimeServerClient,
} from '@electric-ax/agents-runtime'

const pexec = promisify(execFile)
const BASE = 'http://127.0.0.1:4467'
const RUNNER = 'restartchk-runtime'
const TYPE = 'restartchk'
const ID = `rc-${Date.now()}`
const ENTITY = `/${TYPE}/${ID}`
const SUB = `runner:${RUNNER}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const recreateEnv = {
  ...process.env,
  DOMO_AGENTS_PORT: '4467',
  DOMO_AGENTS_STREAMS_PORT: '4468',
}

async function getSubscription() {
  // agents-server proxies the durable-streams subscription API at
  // /v1/stream-meta/subscriptions/<id>?service=default.
  const r = await fetch(
    `${BASE}/v1/stream-meta/subscriptions/${encodeURIComponent(
      SUB,
    )}?service=default`,
    { headers: { accept: 'application/json' } },
  )
  if (r.status === 404) return null
  if (!r.ok) return { _status: r.status, _body: (await r.text()).slice(0, 200) }
  return await r.json()
}

async function wakeStreamLen() {
  const r = await fetch(
    `${BASE}/runners/${RUNNER}/wake?offset=-1`,
    { headers: { accept: 'application/json' } },
  )
  if (!r.ok) return -1
  const a = await r.json()
  return Array.isArray(a) ? a.length : -1
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

async function main() {
  const registry = createEntityRegistry()
  registry.define(TYPE, {
    description: 'restart-check entity (no-op handler)',
    creationSchema: z.object({ sessionId: z.string() }),
    inboxSchemas: { ping: z.object({ n: z.number() }) },
    state: {},
    handler: () => {},
  })
  const runtime = createRuntimeHandler({ baseUrl: BASE, registry, name: 'rc' })
  await runtime.registerTypes()
  const reg = await fetch(`${BASE}/_electric/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: RUNNER,
      label: 'restartchk',
      kind: 'local',
      admin_status: 'enabled',
    }),
  })
  if (!reg.ok && reg.status !== 409) throw new Error(`runner reg ${reg.status}`)

  const client = createRuntimeServerClient({ baseUrl: BASE })
  console.log('1) spawn entity with runner dispatch policy')
  await client.spawnEntity({
    type: TYPE,
    id: ID,
    args: { sessionId: ID },
    dispatch_policy: { targets: [{ type: 'runner', runnerId: RUNNER }] },
  })
  await sleep(500)
  const subBefore = await getSubscription()
  console.log('   subscription before recreate:', subBefore ? 'EXISTS' : 'MISSING')

  console.log('2) --force-recreate agents-server (crash/upgrade/reboot sim)')
  await pexec(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      'up',
      '-d',
      '--force-recreate',
      'agents-server',
    ],
    { env: recreateEnv },
  )
  if (!(await waitUp())) throw new Error('agents-server did not come back')
  await sleep(3000)

  console.log('3) did the boot re-link patch run?')
  const { stdout: logs } = await pexec('docker', [
    'logs',
    '--tail',
    '60',
    'domo-electric-agents-server-1',
  ]).catch((e) => ({ stdout: String(e) }))
  const relinkLine = logs
    .split('\n')
    .find((l) => l.includes('re-linked dispatch subscriptions'))
  console.log('   boot log:', relinkLine ? relinkLine.trim() : '(NOT FOUND)')

  const subAfter = await getSubscription()
  console.log(
    '   subscription after recreate:',
    subAfter && !subAfter._status ? 'EXISTS (re-linked)' : JSON.stringify(subAfter),
  )

  console.log('4) send after recreate → does a wake get emitted?')
  const wbefore = await wakeStreamLen()
  await client.sendEntityMessage({
    targetUrl: ENTITY,
    type: 'ping',
    payload: { n: 1 },
  })
  let wafter = wbefore
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    wafter = await wakeStreamLen()
    if (wafter > wbefore) break
  }
  console.log(`   wake-stream events: ${wbefore} -> ${wafter}`)

  await client.deleteEntity(ENTITY).catch(() => {})

  const ok =
    !!subBefore &&
    !!relinkLine &&
    !!subAfter &&
    !subAfter._status &&
    wafter > wbefore
  console.log(
    ok
      ? '\nPASS — patch re-links subscriptions on agents-server restart; wake delivery resumes'
      : '\nFAIL — wake delivery did NOT resume after agents-server recreate',
  )
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('check error:', e)
  process.exit(1)
})
