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
import { superviseRunnerLoop } from './runner-supervisor'

export interface ElectricRuntime {
  registry: EntityRegistry
  runtime: RuntimeHandler
  runner: PullWakeRunner
  serverUrl: string
}

let started: ElectricRuntime | null = null
let starting: Promise<ElectricRuntime | null> | null = null
/**
 * Set true by `stopElectricRuntime` so the runner supervisor exits
 * instead of treating the intentional stop as an outage to reconnect.
 */
let stopRequested = false

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
 * Thin module wrapper over `superviseRunnerLoop` (the resilience logic
 * lives there — see runner-supervisor.ts). Supplies the two
 * environment-specific seams: re-assert the runner registration on
 * reconnect (idempotent upsert; covers an agents-server that restarted
 * and dropped runner state), and the exit predicate — stop when
 * `stopElectricRuntime` ran OR this runner is no longer the active one
 * (`started` only changes on stop/restart; a transient disconnect keeps
 * the same instance, so this stays false through reconnects).
 */
function superviseRunner(
  runner: PullWakeRunner,
  serverUrl: string,
  runnerId: string,
): Promise<void> {
  return superviseRunnerLoop(runner, {
    reassert: async () => {
      await registerRunner(serverUrl, runnerId)
    },
    isDone: () => stopRequested || started?.runner !== runner,
  })
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
    stopRequested = false
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
          // Returning true suppresses the throw (don't crash the
          // process on a transient heartbeat/stream error). It does
          // NOT reconnect — superviseRunner() owns that.
          console.error('[electric] pull-wake runner error:', err)
          return true
        },
      })
      runner.start()
      started = { registry, runtime, runner, serverUrl }
      // Fire-and-forget: keep the runner alive across agents-server
      // blips/restarts (otherwise a single dropped wake stream
      // permanently stops wake delivery — see superviseRunner).
      void superviseRunner(runner, serverUrl, runnerId)
      console.log(
        `[electric] runtime "${runtimeName}" connected to ${serverUrl} (runner: ${runnerId})`,
      )
      // Restart-resume note: there is deliberately NO host-side boot
      // sweep here. agents-server keeps pull-wake subscriptions only in
      // memory and does not rebuild them on its own boot, so after an
      // agents-server restart no host claim/sweep can recover orphans
      // (the subscription is gone → claim 404s). The real fix is twofold
      // and lives elsewhere: (1) `bin/domo` no longer recreates
      // agents-server on app update (app-only restart — the common path,
      // so offset-replay keeps working), and (2) a patch to
      // `@electric-ax/agents-server` re-links every persisted entity's
      // dispatch subscription on *its* boot (covers true agents-server
      // crash/reboot/upgrade). See CLAUDE.md "restart-resume" + the
      // `patches/` entry + Decided #23.
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
  // Set before stop() so superviseRunner sees the intentional stop
  // (its waitForStopped resolves) and exits instead of reconnecting.
  stopRequested = true
  started = null
  await runner.stop().catch(() => {})
  runtime.abortWakes()
  await runtime.drainWakes().catch(() => {})
}
