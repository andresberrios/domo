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

/**
 * There is a project per *runtime*, not per folder: a project only earns its
 * own entry when it needs a different environment, a different setup file, or
 * a dependency that has to stay out of the default run. Everything else is a
 * directory inside a project.
 */
export default defineConfig(async () => ({
  test: {
    projects: [
      // 1. Plain node, no services, no Nuxt — these must stay instant.
      //    `test/unit` is pure logic; `test/docker` is Docker at the process
      //    boundary (the argv handed to `docker`), which needs no daemon.
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.spec.ts', 'test/docker/**/*.spec.ts'],
          exclude: ['test/docker/**/*.live.spec.ts']
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

      // 3. Everything that needs a real Postgres: `test/server` drives
      //    `repo.ts` and the schema directly, `test/e2e` drives a production
      //    build of the Nitro server over HTTP. Same environment, same
      //    per-file database — one project, two directories.
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/server/**/*.spec.ts', 'test/e2e/**/*.spec.ts'],
          setupFiles: [resolve(rootDir, 'test/setup/database.ts')],
          // Creating a database and bootstrapping the schema is slower than a
          // normal hook; building the Nuxt app for the e2e files is slower still.
          hookTimeout: 300_000,
          testTimeout: 60_000
        }
      },

      // 4. The same Docker code against a real daemon. Opt in: `pnpm test:docker`.
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
