/**
 * In-process TCP port forwarder for the "expose externally" toggle on
 * env ports (step 4, Decided #9 amendment).
 *
 * Declared ports in `devcontainer.json`'s `forwardPorts` are already
 * published at container-create time to `127.0.0.1:<random>` (handled
 * by `devcontainer/client.ts`'s `up()` runArgs). The forwarder here
 * layers a `net.Server` listening on `0.0.0.0:<externalPort>` and
 * piping each connection to `127.0.0.1:<hostPort>` — no container
 * recreate needed to toggle, and the mapping is stateless to rebuild
 * on boot.
 *
 * Userland forwarders for ad-hoc / runtime-opened ports (not declared
 * in `forwardPorts`) are out of scope for v1.
 *
 * The SQLite `env_external_ports` table is the single source of truth
 * (`{env_id, inner_port, external_port, created_at}`). `rebuildAll()`
 * runs at boot from `server/plugins/portForwarder.ts` and (re)opens a
 * listener per row against the current host port for that inner port
 * (re-discovered via `docker inspect`, since host ports change on
 * container recreate).
 */
import { createServer, type Server as NetServer, type Socket } from 'node:net'

import { changeBus } from './changeBus'
import { db } from './db'
import { inspect } from './devcontainer/client'
import { resolveContainerId, getEnv, listEnvs } from './envs'

interface ForwardRow {
  envId: string
  innerPort: number
  externalPort: number
  createdAt: number
}

interface LiveForwarder {
  envId: string
  innerPort: number
  externalPort: number
  server: NetServer
  /** Latest target host loopback port. May change across container recreate
   * — we re-resolve from `docker inspect` and dial against the new port. */
  targetHostPort: number
}

// envId|innerPort → live forwarder (single source per (env, inner)).
const live = new Map<string, LiveForwarder>()

function forwarderKey(envId: string, innerPort: number): string {
  return `${envId}|${innerPort}`
}

// ─── Persistence ─────────────────────────────────────────────────────────

function rowFromDb(r: { env_id: string; inner_port: number; external_port: number; created_at: number }): ForwardRow {
  return { envId: r.env_id, innerPort: r.inner_port, externalPort: r.external_port, createdAt: r.created_at }
}

export function listExternalForwards(envId?: string): ForwardRow[] {
  const stmt = envId
    ? db().prepare(`SELECT * FROM env_external_ports WHERE env_id = ? ORDER BY inner_port`).all(envId)
    : db().prepare(`SELECT * FROM env_external_ports ORDER BY env_id, inner_port`).all()
  return (stmt as Parameters<typeof rowFromDb>[0][]).map(rowFromDb)
}

export function getExternalForward(envId: string, innerPort: number): ForwardRow | null {
  const r = db().prepare(`SELECT * FROM env_external_ports WHERE env_id = ? AND inner_port = ?`).get(envId, innerPort) as Parameters<typeof rowFromDb>[0] | undefined
  return r ? rowFromDb(r) : null
}

function upsertRow(envId: string, innerPort: number, externalPort: number): void {
  db().prepare(`
    INSERT INTO env_external_ports (env_id, inner_port, external_port, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(env_id, inner_port) DO UPDATE SET external_port = excluded.external_port
  `).run(envId, innerPort, externalPort, Date.now())
  changeBus().emitTableChange({ table: 'envs', id: envId, op: 'update' })
}

function deleteRow(envId: string, innerPort: number): void {
  db().prepare(`DELETE FROM env_external_ports WHERE env_id = ? AND inner_port = ?`).run(envId, innerPort)
  changeBus().emitTableChange({ table: 'envs', id: envId, op: 'update' })
}

// ─── Live forwarders ─────────────────────────────────────────────────────

/** Resolve the current published host port for an env's inner port via
 * a fresh `docker inspect`. Returns null when the container or that
 * inner port isn't published right now. */
async function findHostPort(envId: string, innerPort: number): Promise<number | null> {
  const env = getEnv(envId)
  if (!env) return null
  const cid = await resolveContainerId(env)
  if (!cid) return null
  const info = await inspect(cid)
  if (!info) return null
  const hit = info.publishedPorts.find((p) => p.innerPort === innerPort && p.protocol === 'tcp')
  return hit ? hit.hostPort : null
}

async function startListener(envId: string, innerPort: number, externalPort: number): Promise<NetServer> {
  const targetHostPort = await findHostPort(envId, innerPort)
  if (targetHostPort == null) {
    throw new Error(`port ${innerPort}/tcp is not currently published by the env's container`)
  }
  const server = createServer((client: Socket) => {
    // `import('node:net').connect` lazy-required to keep the file ESM-only.
    void import('node:net').then(({ connect }) => {
      const upstream = connect(targetHostPort, '127.0.0.1')
      client.on('error', () => { try { upstream.destroy() } catch { /* gone */ } })
      upstream.on('error', () => { try { client.destroy() } catch { /* gone */ } })
      client.pipe(upstream).pipe(client)
    })
  })
  server.on('error', (err) => {
    console.error(`[portForwarder] listener ${envId}:${innerPort} → :${externalPort}`, err)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(externalPort, '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  live.set(forwarderKey(envId, innerPort), {
    envId,
    innerPort,
    externalPort,
    server,
    targetHostPort,
  })
  return server
}

function stopListener(envId: string, innerPort: number): void {
  const key = forwarderKey(envId, innerPort)
  const f = live.get(key)
  if (!f) return
  try { f.server.close() } catch { /* already closed */ }
  live.delete(key)
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function expose(envId: string, innerPort: number, externalPort: number): Promise<void> {
  // Same external port for the same (env, inner) is a no-op refresh. A
  // different external port means rebind: stop the old listener first.
  const existing = live.get(forwarderKey(envId, innerPort))
  if (existing && existing.externalPort === externalPort) {
    return
  }
  if (existing) stopListener(envId, innerPort)
  await startListener(envId, innerPort, externalPort)
  upsertRow(envId, innerPort, externalPort)
}

export function unexpose(envId: string, innerPort: number): void {
  stopListener(envId, innerPort)
  deleteRow(envId, innerPort)
}

/**
 * Rebuild every persisted external forwarder from the DB. Called at
 * boot (`server/plugins/portForwarder.ts`). Misses (the container
 * isn't running or the inner port isn't published right now) are
 * logged + the row is kept — the next `up`/`start` will rebuild on
 * demand via a follow-up call from the env-run code path.
 */
export async function rebuildAll(): Promise<void> {
  const rows = listExternalForwards()
  for (const r of rows) {
    try {
      await startListener(r.envId, r.innerPort, r.externalPort)
    } catch (e) {
      console.warn(`[portForwarder] rebuild ${r.envId}:${r.innerPort} → :${r.externalPort} failed:`, e instanceof Error ? e.message : e)
    }
  }
}

/**
 * Called by the env-run code path AFTER a container's host ports have
 * been (re)assigned. Any persisted external forwarders for this env
 * whose target host port has changed get rebound in place — no
 * external-port change visible to the user.
 */
export async function rebindForEnv(envId: string): Promise<void> {
  const rows = listExternalForwards(envId)
  for (const r of rows) {
    const newTarget = await findHostPort(envId, r.innerPort)
    if (newTarget == null) continue
    const current = live.get(forwarderKey(envId, r.innerPort))
    if (current && current.targetHostPort === newTarget) continue
    if (current) stopListener(envId, r.innerPort)
    try {
      await startListener(envId, r.innerPort, r.externalPort)
    } catch (e) {
      console.warn(`[portForwarder] rebind ${envId}:${r.innerPort}`, e)
    }
  }
}

/** SIGTERM-time cleanup — close every live listener. */
export function stopAll(): void {
  for (const [, f] of live) {
    try { f.server.close() } catch { /* gone */ }
  }
  live.clear()
}

/** UI helper — read-side: list every external forward we have running
 * (or persisted), regardless of live-listener state. */
export function listAll(): Array<{ envId: string; envName: string; innerPort: number; externalPort: number }> {
  const envMap = new Map(listEnvs().map((e) => [e.id, e.name]))
  return listExternalForwards().map((r) => ({
    envId: r.envId,
    envName: envMap.get(r.envId) ?? r.envId,
    innerPort: r.innerPort,
    externalPort: r.externalPort,
  }))
}
