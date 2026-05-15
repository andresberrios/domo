import {
  createEntityRegistry,
  createPullWakeRunner,
  createRuntimeHandler,
  type EntityRegistry,
  type PullWakeRunner,
  type RuntimeHandler,
} from '@electric-ax/agents-runtime'
import { electricConfig } from './config'
import { registerClaudeCodeCli } from './entity'

export interface ElectricRuntime {
  registry: EntityRegistry
  runtime: RuntimeHandler
  runner: PullWakeRunner
  serverUrl: string
}

let started: ElectricRuntime | null = null
let starting: Promise<ElectricRuntime | null> | null = null

async function registerRunner(
  serverUrl: string,
  runnerId: string,
): Promise<{ wake_stream_offset?: string }> {
  const res = await fetch(`${serverUrl}/_electric/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: runnerId,
      label: 'Domo runtime',
      kind: 'local',
      admin_status: 'enabled',
    }),
  })
  // Re-registering an existing runner is fine — agents-server upserts.
  if (!res.ok && res.status !== 409) {
    throw new Error(
      `agents-server runner registration failed: ${res.status} ${await res.text()}`,
    )
  }
  return res.ok
    ? ((await res.json()) as { wake_stream_offset?: string })
    : {}
}

/**
 * Bring up the in-process `claude-code-cli` runtime and connect it to
 * agents-server via a pull-wake runner. Idempotent. Non-fatal: if
 * agents-server is unreachable Domo still serves projects/envs/workspace
 * /git (only the session surface is degraded) — returns null and logs.
 */
export async function startElectricRuntime(): Promise<ElectricRuntime | null> {
  if (started) return started
  if (starting) return starting

  starting = (async () => {
    const { serverUrl, runnerId, runtimeName } = electricConfig()
    const registry = createEntityRegistry()
    registerClaudeCodeCli(registry)

    const runtime = createRuntimeHandler({
      baseUrl: serverUrl,
      registry,
      name: runtimeName,
    })

    try {
      // Push the entity-type definition to agents-server's control plane.
      // `registry.define` only registers it in-process; without this
      // POST /_electric/entity-types, `spawnEntity('claude-code-cli', …)`
      // from `sessions.create` 404s ("entity type not found"). The
      // reference builtin-agents server does the same on boot
      // (electric-source agents/src/server.ts → registerBuiltinAgentTypes).
      // Idempotent (upsert), so safe on every (re)start.
      await runtime.registerTypes()
      const { wake_stream_offset } = await registerRunner(serverUrl, runnerId)
      const runner = createPullWakeRunner({
        baseUrl: serverUrl,
        runnerId,
        runtime,
        offset: wake_stream_offset,
        onError: (err) => {
          console.error('[electric] pull-wake runner error:', err)
          return true
        },
      })
      runner.start()
      started = { registry, runtime, runner, serverUrl }
      console.log(
        `[electric] runtime "${runtimeName}" connected to ${serverUrl} (runner: ${runnerId})`,
      )
      return started
    } catch (err) {
      console.error(
        `[electric] runtime NOT started — agents-server unreachable at ${serverUrl}. ` +
          `Run \`docker compose up -d\`. Session surface degraded; rest of Domo OK.`,
        err,
      )
      return null
    } finally {
      starting = null
    }
  })()
  return starting
}

export function getElectricRuntime(): ElectricRuntime | null {
  return started
}

export async function stopElectricRuntime(): Promise<void> {
  if (!started) return
  const { runner, runtime } = started
  started = null
  await runner.stop().catch(() => {})
  runtime.abortWakes()
  await runtime.drainWakes().catch(() => {})
}
