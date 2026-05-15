// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/eslint', 'nuxt-procedures', '@comark/nuxt'],

  css: ['@xterm/xterm/css/xterm.css'],

  // SPA-style rendering everywhere. Domo is self-hosted, single-user, and
  // the workspace is intrinsically client-side (xterm.js, CodeMirror, WS
  // subscriptions) — server-rendering the shell buys little. We use a
  // route rule rather than top-level `ssr: false` because Nuxt 4.4's
  // vite-builder still resolves a server entry under `ssr: false` and
  // errors with "No entry found in rollupOptions.input". The Nitro server
  // is still up (API procedures, SSE/WS proxies) — only HTML rendering
  // is moved to the client.
  routeRules: {
    '/**': { ssr: false },
  },

  nitro: {
    experimental: {
      websocket: true,
    },
  },

  runtimeConfig: {
    // Server-side only. Override via DOMO_HOME (data dir for SQLite + state).
    domoHome: process.env.DOMO_HOME || '',
    coastApiUrl: process.env.DOMO_COAST_API_URL || 'http://127.0.0.1:31415',
  },

  // SQLite native binding can't be bundled.
  build: {
    transpile: [],
  },

  vite: {
    ssr: {
      external: ['better-sqlite3'],
    },
  },
})
