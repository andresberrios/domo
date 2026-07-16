import { createPullWakeRunner } from '@electric-ax/agents-runtime'
import { createBuiltinAgentHandler } from '@electric-ax/agents'

const ELECTRIC_AGENTS_URL = 'http://localhost:4437'
const MODEL = 'claude-sonnet-4-6'

// A single pull-wake runner hosts every agent type this app exposes:
//  - `assistant` — our own agent, defined below as a sibling
//  - `horton` + `worker` — the built-in demo agents (@electric-ax/agents)
//
// Why one runner (and not a webhook for assistant)? The dev UI
// (https://localhost:4438) injects `dispatch_policy: { runner }` into EVERY
// session it spawns once any runner is enabled — including `assistant`. So a
// separate webhook-dispatched `assistant` never gets woken; its wakes land on
// the runner instead, which would reject them as "unknown entity type". Every
// UI-spawnable type must therefore live on the one runner.
const RUNNER_ID = 'domo-builtin-agents'

// Matches the principal the dev UI uses, so the runner (and its advertised
// sandbox profiles) is owned by — and visible to — the same principal. The dev
// UI's composer only enables once it sees an enabled runner (AGENTS.md gotcha 2).
const PRINCIPAL = 'system:dev-local'
const PRINCIPAL_HEADERS = { 'electric-principal': PRINCIPAL }

// Register the pull-wake runner row on the agents server, advertising the Docker
// sandbox profiles the worker needs. Returns the wake-stream offset to resume
// from. Mirrors BuiltinAgentsServer.registerPullWakeRunner (not public API).
async function registerRunnerRow(
  sandboxProfiles: unknown
): Promise<{ wake_stream_offset?: string }> {
  const response = await fetch(`${ELECTRIC_AGENTS_URL}/_electric/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...PRINCIPAL_HEADERS },
    body: JSON.stringify({
      id: RUNNER_ID,
      label: 'Domo built-in agents',
      kind: 'local',
      admin_status: 'enabled',
      sandbox_profiles: sandboxProfiles
    })
  })
  if (!response.ok) {
    throw new Error(
      `runner registration failed: ${response.status} ${await response.text()}`
    )
  }
  return (await response.json()) as { wake_stream_offset?: string }
}

export default defineNitroPlugin((nitroApp) => {
  // Bootstrap + pull-wake wiring is async; kick it off without blocking plugin
  // registration. Requires a model-provider API key (ANTHROPIC_API_KEY / …) in
  // this process's env and a running Docker daemon (the worker spawns real
  // sandbox containers).
  const started = (async () => {
    const bootstrap = await createBuiltinAgentHandler({
      agentServerUrl: ELECTRIC_AGENTS_URL,
      workingDirectory: process.cwd(),
      serverHeaders: PRINCIPAL_HEADERS,
      // All types dispatch to this runner (the UI would force it anyway).
      defaultDispatchPolicyForType: () => ({
        targets: [{ type: 'runner', runnerId: RUNNER_ID }]
      })
    })
    if (!bootstrap) {
      throw new Error(
        'no model-provider API key found (set ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY)'
      )
    }

    // Define our own `assistant` as a sibling of horton/worker on the runner's
    // registry. ctx.electricTools is populated because createBuiltinAgentHandler
    // wires createBuiltinElectricTools.
    bootstrap.registry.define('assistant', {
      description: 'A general-purpose AI assistant',
      async handler(ctx) {
        ctx.useAgent({
          systemPrompt: 'You are a helpful assistant.',
          model: MODEL,
          tools: [...ctx.electricTools]
        })
        await ctx.agent.run()
      }
    })

    await bootstrap.runtime.registerTypes()

    const registration = await registerRunnerRow(
      bootstrap.runtime.sandboxProfileDescriptors
    )

    const puller = createPullWakeRunner({
      baseUrl: ELECTRIC_AGENTS_URL,
      runnerId: RUNNER_ID,
      runtime: bootstrap.runtime,
      headers: PRINCIPAL_HEADERS,
      offset: registration.wake_stream_offset,
      onError: (error) => {
        console.error('[agents] pull-wake runner error:', error)
      }
    })
    puller.start()
    console.log(
      `[agents] pull-wake runner ${RUNNER_ID} ready: assistant, horton, worker`
    )

    return { bootstrap, puller }
  })().catch((error) => {
    console.error('[agents] failed to start agents runner:', error)
    return null
  })

  nitroApp.hooks.hook('close', async () => {
    const running = await started
    if (!running) return
    await running.puller.stop().catch(() => {})
    running.bootstrap.runtime.abortWakes()
    await running.bootstrap.runtime.drainWakes().catch(() => {})
    await running.bootstrap.shutdownSandboxes?.().catch(() => {})
  })
})
