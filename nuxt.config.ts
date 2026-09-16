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
        '@agentclientprotocol/claude-agent-acp',
        '@agentclientprotocol/sdk'
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
