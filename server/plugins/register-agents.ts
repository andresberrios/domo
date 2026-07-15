import {
  createEntityRegistry,
  createRuntimeHandler
} from '@electric-ax/agents-runtime'

declare module 'h3' {
  interface H3EventContext {
    $electricAgentsRuntime: ReturnType<typeof createRuntimeHandler>
  }
}

export default defineNitroPlugin((nitroApp) => {
  // const config = useRuntimeConfig()

  const PORT = 4001
  const SERVE_URL = `http://localhost:${PORT}`
  const ELECTRIC_AGENTS_URL = 'http://localhost:4437'
  const MODEL = 'claude-sonnet-4-6'

  const registry = createEntityRegistry()

  registry.define('assistant', {
    description: 'A general-purpose AI assistant',
    async handler(ctx) {
      ctx.useAgent({
        systemPrompt: 'You are a helpful assistant.',
        model: MODEL,
        tools: []
      })
      await ctx.agent.run()
    }
  })

  const runtime = createRuntimeHandler({
    baseUrl: ELECTRIC_AGENTS_URL,
    serveEndpoint: `${SERVE_URL}/webhooks/electric-agents`,
    registry
  })

  runtime.registerTypes().catch(console.error)

  nitroApp.hooks.hook('request', (event) => {
    event.context.$electricAgentsRuntime = runtime
  })
})
