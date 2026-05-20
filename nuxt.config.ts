// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/eslint', 'nuxt-procedures', '@comark/nuxt', '@vueuse/nuxt', 'nuxt-auth-utils'],

  // `main.css` is the Nuxt UI v4 entry (@import tailwindcss + @nuxt/ui) —
  // mandatory; without it Tailwind never runs and the whole app renders
  // unstyled. Keep it first so xterm's CSS layers on top.
  css: ['~/assets/css/main.css', '@xterm/xterm/css/xterm.css'],

  // Window/tab title + favicon. The Robo logo lives at
  // `public/image/logo.png` (served at `/image/logo.png`) and is the only
  // favicon — the legacy `public/favicon.ico` was removed.
  app: {
    head: {
      title: 'Domo',
      link: [
        { rel: 'icon', type: 'image/png', href: '/image/logo.png' },
        { rel: 'apple-touch-icon', href: '/image/logo.png' },
      ],
    },
  },

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

  // Domo's canonical port. Dev uses this directly; the built node-server
  // is launched by the `domo` CLI / systemd unit with `PORT=7575` (Nitro
  // has no config-baked listen port — it's runtime env). See
  // initial-design.md "Distribution & release".
  devServer: {
    port: Number(process.env.PORT) || 7575,
  },

  nitro: {
    experimental: {
      websocket: true,
    },
    // `@devcontainers/cli` is resolved at runtime via
    // `createRequire(import.meta.url)` in `server/lib/devcontainer/
    // client.ts` (the package has no `exports`/`main`, only a `bin`).
    // Nitro/Rollup's static analysis can't see the import, so the
    // bundle doesn't trace it and release builds fail with "Cannot
    // find module '@devcontainers/cli/package.json'" (the dev tree
    // had a hoisted node_modules to fall back on; `.output/server/`
    // has only the traced deps). `traceInclude` is a list of file
    // paths nitro hands to `@vercel/nft` as additional roots — we
    // resolve the cli's devcontainer.js + package.json off the build-
    // time node_modules tree so they (and their transitive deps) get
    // copied into `.output/server/node_modules/`.
    externals: {
      external: ['@devcontainers/cli'],
      traceInclude: [
        new URL(
          './node_modules/@devcontainers/cli/devcontainer.js',
          import.meta.url,
        ).pathname,
        new URL(
          './node_modules/@devcontainers/cli/package.json',
          import.meta.url,
        ).pathname,
      ],
    },
  },

  runtimeConfig: {
    // Server-side only. Override via DOMO_HOME (data dir for SQLite + state).
    domoHome: process.env.DOMO_HOME || '',
    // nuxt-auth-utils sealed-cookie session. `password` is left empty here
    // and filled at runtime by `server/plugins/00.session-secret.ts` from
    // an auto-generated, persisted `$DOMO_HOME/session-secret` (so the
    // operator never has to set an env var and sessions survive restarts).
    // `NUXT_SESSION_PASSWORD` still overrides via Nuxt's env convention.
    session: {
      password: process.env.NUXT_SESSION_PASSWORD || '',
      maxAge: 60 * 60 * 24 * 30, // 30 days — self-hosted, infrequent logins
    },
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
