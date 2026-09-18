import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'

const rootDir = dirname(fileURLToPath(import.meta.url))

/**
 * The app's own aliases, so a test imports a module exactly the way the app
 * does. The `nuxt` project gets them from the real Nuxt config instead.
 */
const alias = {
  '~~': rootDir,
  '@@': rootDir,
  '~': resolve(rootDir, 'app'),
  '@': resolve(rootDir, 'app')
}

/** Anything that talks to Postgres gets its own ephemeral database. */
const database = {
  setupFiles: [resolve(rootDir, 'test/setup/database.ts')],
  // Creating and dropping a database, and bootstrapping the schema into it,
  // happens in beforeAll/afterAll and is slower than a normal hook.
  hookTimeout: 60_000
}

export default defineConfig(async () => ({
  test: {
    projects: [
      // 1. Pure logic. No Nuxt, no I/O, no services — these must stay instant.
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.spec.ts']
        }
      },

      // 2. Components and composables in a real Nuxt runtime (happy-dom).
      await defineVitestProject({
        test: {
          name: 'nuxt',
          environment: 'nuxt',
          include: ['test/nuxt/**/*.spec.ts'],
          environmentOptions: { nuxt: { domEnvironment: 'happy-dom' } }
        }
      }),

      // 3. The repo/db layer against a real Postgres.
      {
        resolve: { alias },
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/server/**/*.spec.ts'],
          ...database
        }
      },

      // 4. The whole stack over HTTP: real Nitro build, real Postgres, no browser.
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['test/e2e/**/*.spec.ts'],
          ...database,
          // Building the app and booting the server happens once, in a hook.
          hookTimeout: 300_000,
          testTimeout: 60_000
        }
      },

      // 5. Docker at the process boundary: what argv do we hand `docker`?
      {
        resolve: { alias },
        test: {
          name: 'docker',
          environment: 'node',
          include: ['test/docker/**/*.spec.ts'],
          exclude: ['test/docker/**/*.live.spec.ts']
        }
      },

      // 5b. The same code against a real Docker daemon. Opt in: `pnpm test:docker`.
      {
        resolve: { alias },
        test: {
          name: 'docker-live',
          environment: 'node',
          include: ['test/docker/**/*.live.spec.ts'],
          testTimeout: 60_000
        }
      }
    ]
  }
}))
