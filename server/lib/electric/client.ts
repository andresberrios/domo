/**
 * Control-plane client for the `sessions.*` procedures.
 *
 * `runtime.ts` is the *worker* side (registers the entity, runs the
 * pull-wake runner). This is the *driver* side: spawning a session entity
 * and pushing inbox messages (`prompt` / `diff_decision` / `abort`) into
 * it, talking to agents-server's HTTP API via the runtime's own
 * `createRuntimeServerClient`.
 *
 * Wakes only reach our in-process handler if the entity's dispatch policy
 * targets our pull-wake runner. agents-server has no implicit
 * "route to any local runner" fallback (effective policy is
 * per-entity ?? parent ?? entity-type-default, and we deliberately do not
 * register a type default — matching electric-source's builtin-agents,
 * which keeps the same type servable by other runtimes). So every session
 * is spawned with an explicit runner dispatch policy. Recipe verified
 * against electric-source `agents-server/test/horton-pull-wake-e2e.test.ts`.
 */
import {
  appendPathToUrl,
  createRuntimeServerClient,
  type DispatchPolicy,
} from '@electric-ax/agents-runtime'
import { electricConfig } from './config'
import { startElectricRuntime } from './runtime'

type RuntimeServerClient = ReturnType<typeof createRuntimeServerClient>

let _client: RuntimeServerClient | null = null

function serverClient(): RuntimeServerClient {
  if (_client) return _client
  const { serverUrl } = electricConfig()
  _client = createRuntimeServerClient({ baseUrl: serverUrl })
  return _client
}

/**
 * Ensure the pull-wake runtime is up before driving an entity — spawning
 * or sending succeeds against agents-server's HTTP API even with no
 * runner, but the wake would never be claimed, so the turn would hang
 * silently. `startElectricRuntime` is idempotent + memoized; this just
 * surfaces a clean 503 instead.
 */
export async function ensureRuntimeReady(): Promise<RuntimeServerClient> {
  const rt = await startElectricRuntime()
  if (!rt) {
    throw createError({
      statusCode: 503,
      statusMessage:
        'Electric Agents runtime unavailable — agents-server unreachable. ' +
        'Run `docker compose up -d`.',
    })
  }
  return serverClient()
}

/** Route this session's wakes to Domo's pull-wake runner. */
export function runnerDispatchPolicy(): DispatchPolicy {
  const { runnerId } = electricConfig()
  return { targets: [{ type: 'runner', runnerId }] }
}

/** Absolute URL the chat surface subscribes to (Phase 9). */
export function durableStreamUrl(streamPath: string): string {
  const { serverUrl } = electricConfig()
  return appendPathToUrl(serverUrl, streamPath)
}

/**
 * Tear down the entity, best-effort. Deleting a Domo session is a local
 * concept (the design keeps the durable stream around — sessions can be
 * "un-done"); a missing/unreachable agents-server must not strand the DB
 * row. `deleteEntity` already swallows 404, so this only widens to "any
 * failure" (e.g. agents-server down).
 */
export async function deleteEntityBestEffort(entityUrl: string): Promise<void> {
  try {
    await serverClient().deleteEntity(entityUrl)
  } catch {
    /* orphaned stream is acceptable; the DB row is removed regardless */
  }
}
