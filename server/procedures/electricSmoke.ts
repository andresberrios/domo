import { z } from 'zod'
import { electricConfig } from '../lib/electric/config'
import { getElectricRuntime, startElectricRuntime } from '../lib/electric/runtime'

/**
 * Smoke procedure — agents-server reachability + local runtime/runner
 * state. Attempts a (cheap, idempotent) runtime start so calling this
 * after `docker compose up -d` recovers from a boot-time miss.
 */
export default defineProcedure({
  output: z.object({
    ok: z.boolean(),
    serverUrl: z.string(),
    serverReachable: z.boolean(),
    runtimeStarted: z.boolean(),
    runnerRunning: z.boolean(),
    detail: z.string().optional(),
  }),
  handler: async () => {
    const { serverUrl } = electricConfig()

    let serverReachable = false
    let detail: string | undefined
    try {
      const res = await fetch(`${serverUrl}/_electric/runners`, {
        signal: AbortSignal.timeout(3000),
      })
      serverReachable = res.ok
      if (!res.ok) detail = `GET /_electric/runners → ${res.status}`
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e)
    }

    if (serverReachable && !getElectricRuntime()) {
      await startElectricRuntime()
    }
    const rt = getElectricRuntime()

    return {
      ok: serverReachable && !!rt && rt.runner.running,
      serverUrl,
      serverReachable,
      runtimeStarted: !!rt,
      runnerRunning: !!rt && rt.runner.running,
      detail,
    }
  },
})
