import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'

import { TEST_SERVER_ORIGIN } from './test/electric/origin.ts'

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
      //    build of the Nitro server over HTTP, and `test/helpers` covers the
      //    harness's own database lifecycle. Same environment, same per-file
      //    database — one project.
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'test/server/**/*.spec.ts',
            'test/e2e/**/*.spec.ts',
            'test/helpers/**/*.spec.ts'
          ],
          // One test database, shared by every file, so the files must not
          // overlap. The suite is ~13 s and most of that is the Nuxt transform
          // in another project, so there is no parallelism worth keeping here.
          fileParallelism: false,
          // Turns "Postgres is not running" into an exit code before any test
          // reports, and creates the database. See test/setup/require-database.ts.
          globalSetup: [resolve(rootDir, 'test/setup/require-database.ts')],
          setupFiles: [resolve(rootDir, 'test/setup/database.ts')],
          // Resetting the schema is slower than a normal hook; building the
          // Nuxt app for the e2e files is slower still.
          hookTimeout: 300_000,
          testTimeout: 60_000
        }
      },

      // 4. The full loop, still without a browser: a page mounted in happy-dom
      //    drives the real Nitro server, which writes to the real Postgres,
      //    which a real ElectricSQL streams back into the mounted page.
      //    Its own database and its own Electric: the `integration` project
      //    resets `domo_test` with `drop schema public cascade`, which would
      //    empty a publication out from under a live instance.
      await defineVitestProject({
        test: {
          name: 'electric',
          environment: 'nuxt',
          include: ['test/electric/**/*.spec.ts'],
          environmentOptions: {
            nuxt: {
              domEnvironment: 'happy-dom',
              // The app resolves `/api/shape` against `window.location.origin`,
              // so the document has to live on the real server's origin — both
              // to reach it and to stay same-origin for happy-dom's fetch.
              url: TEST_SERVER_ORIGIN
            }
          },
          globalSetup: [resolve(rootDir, 'test/electric/global-setup.ts')],
          setupFiles: [resolve(rootDir, 'test/electric/setup.ts')],
          // One database, one Electric, one pinned port: the files take turns.
          fileParallelism: false,
          // Building the app and booting the server happens once, in globalSetup.
          hookTimeout: 300_000,
          testTimeout: 120_000
        }
      }),

      // 5. The Docker code from project 1 against a real daemon. Opt in:
      //    `pnpm test:docker`.
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
