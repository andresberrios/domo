import { readdirSync } from 'node:fs'
// https://nuxt.com/docs/api/configuration/nuxt-config
function kokoroVoices(): string[] {
  const dir = new URL('./node_modules/kokoro-js/voices/', import.meta.url).pathname
  try {
    return readdirSync(dir).filter(name => name.endsWith('.bin')).map(name => `${dir}${name}`)
  } catch {
    return []
  }
}

// `scripts/release.mjs build`: what is shipped carries no source. Source maps
// embed it, and the server bundle is otherwise readable as written. The build
// id is the commit's, not a random one, so a rebuild comes out the same.
const release = process.env.DOMO_RELEASE_BUILD === '1'

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

  sourcemap: { server: !release, client: false },
  ...(release && process.env.DOMO_BUILD_ID ? { buildId: process.env.DOMO_BUILD_ID } : {}),

  nitro: {
    minify: release,
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
        '@agentclientprotocol/sdk',
        // Native ONNX runtime and the open speech models that run on it.
        'onnxruntime-node',
        '@huggingface/transformers',
        'kokoro-js'
      ],
      traceInclude: [
        new URL('./node_modules/@devcontainers/cli/devcontainer.js', import.meta.url).pathname,
        new URL('./node_modules/@devcontainers/cli/package.json', import.meta.url).pathname,
        new URL('./node_modules/@agentclientprotocol/claude-agent-acp/package.json', import.meta.url).pathname,
        new URL('./node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', import.meta.url).pathname,
        new URL('./node_modules/@agentclientprotocol/codex-acp/package.json', import.meta.url).pathname,
        new URL('./node_modules/@agentclientprotocol/codex-acp/dist/index.js', import.meta.url).pathname,
        new URL('./node_modules/@openai/codex/package.json', import.meta.url).pathname,
        new URL('./node_modules/@openai/codex/bin/codex.js', import.meta.url).pathname,
        // kokoro-js reads its voices by a path built at run time, which the
        // tracer cannot follow; without them the local speaker fails in a build.
        ...kokoroVoices()
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
