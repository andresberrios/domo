// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },

  modules: ['@nuxt/ui', '@nuxt/eslint'],

  css: ['~/assets/css/main.css'],

  // Self-hosted and often offline: never reach out to the public Iconify API.
  // Statically-used icons are bundled into the client, dynamic names resolve
  // through our own Nitro server from the installed @iconify-json collection.
  icon: {
    provider: 'server',
    serverBundle: 'local',
    clientBundle: {
      scan: true,
      sizeLimitKb: 512
    }
  },

  // Single-user local app: render client-side only so the browser owns audio,
  // WebSocket and EventSource lifecycles without hydration dances.
  ssr: false,
  routeRules: {
    '/**': { ssr: false }
  },

  nitro: {
    experimental: {
      websocket: true
    },
    // node-only: the pg driver and the ACP adapter subprocess entry point.
    externals: {
      external: [
        'pg',
        '@devcontainers/cli',
        '@agentclientprotocol/claude-agent-acp',
        '@agentclientprotocol/codex-acp',
        '@openai/codex',
        '@agentclientprotocol/sdk'
      ],
      traceInclude: [
        new URL('./node_modules/@devcontainers/cli/devcontainer.js', import.meta.url).pathname,
        new URL('./node_modules/@devcontainers/cli/package.json', import.meta.url).pathname,
        new URL('./node_modules/@agentclientprotocol/claude-agent-acp/package.json', import.meta.url).pathname,
        new URL('./node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', import.meta.url).pathname,
        new URL('./node_modules/@agentclientprotocol/codex-acp/package.json', import.meta.url).pathname,
        new URL('./node_modules/@agentclientprotocol/codex-acp/dist/index.js', import.meta.url).pathname,
        new URL('./node_modules/@openai/codex/package.json', import.meta.url).pathname,
        new URL('./node_modules/@openai/codex/bin/codex.js', import.meta.url).pathname
      ]
    }
  },

  runtimeConfig: {
    geminiApiKey: '',
    anthropicApiKey: '',
    dataDir: '',
    public: {
      appName: 'Domo'
    }
  },

  future: { compatibilityVersion: 4 },

  typescript: {
    typeCheck: false,
    strict: true
  }
})
