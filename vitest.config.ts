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
          environmentOptions: { nuxt: { domEnvironment: 'happy-dom' } },
          // Booting Nuxt for a file takes 7-11 s here, and the default 10 s
          // hook limit failed whichever file happened to boot first.
          hookTimeout: 30_000
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
          // reports, and creates the database. The services are a precondition
          // of the suite, so there is no skip. See test/setup/require-database.ts.
          // The build is the one `test/e2e` starts its server from, shared with
          // the `electric` project — see test/helpers/app-build.ts.
          globalSetup: [
            resolve(rootDir, 'test/setup/require-database.ts'),
            resolve(rootDir, 'test/setup/build-app.ts')
          ],
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
      },

      // 6. The voice agent end to end, with nothing faked: a real Chromium with
      //    a real microphone, the real app and server, and a real GPT-Live
      //    session on a real OpenAI account. It is the only layer that can run
      //    `useVoiceChannel` at all — happy-dom has no AudioContext and no
      //    worklet — and the only one that finds out whether OpenAI accepts
      //    what Domo sends. Costs money, so it is opt in: `pnpm test:voice`.
      {
        resolve: { alias },
        test: {
          name: 'voice-live',
          environment: 'node',
          include: ['test/voice/**/*.live.spec.ts'],
          // One server and one database, and every test opens a real browser.
          fileParallelism: false,
          globalSetup: [resolve(rootDir, 'test/voice/global-setup.ts')],
          // No `test/setup/database.ts`: that one resets `domo_test`, and this
          // layer runs against `domo_e2e` so it can use the real Electric the
          // `electric-e2e` container is bound to. The reset happens once, in
          // the global setup, and the spec only ever talks HTTP.
          // A turn on a live voice model is tens of seconds; a cold app build
          // in front of it is more.
          hookTimeout: 600_000,
          testTimeout: 300_000
        }
      },

      // 7. Development environments made and retired the way a person does it:
      //    the real app in a real Chromium, against a real Docker daemon and
      //    real git. Needs Postgres, the `electric-e2e` service, Docker and a
      //    Chromium. Opt in: `pnpm test:environments`.
      {
        resolve: { alias },
        test: {
          name: 'environments-live',
          environment: 'node',
          include: ['test/environments/**/*.live.spec.ts'],
          // One server, one browser, and tests that build on each other.
          fileParallelism: false,
          globalSetup: [resolve(rootDir, 'test/environments/global-setup.ts')],
          hookTimeout: 900_000,
          testTimeout: 600_000
        }
      },

      // 6. Real coding agents, in a real environment, on real accounts: the one
      //    boundary every other layer stops at. Needs Postgres *and* Docker *and*
      //    a Claude and a Codex login, so it can never be part of the default
      //    run. Opt in: `pnpm test:agents`.
      {
        resolve: { alias },
        test: {
          name: 'agents-live',
          environment: 'node',
          include: ['test/agents/**/*.live.spec.ts'],
          // One environment and one database, shared by the files in turn.
          fileParallelism: false,
          globalSetup: [resolve(rootDir, 'test/agents/global-setup.ts')],
          setupFiles: [resolve(rootDir, 'test/setup/database.ts')],
          // A cold environment build is minutes; a turn on a real model is tens
          // of seconds.
          hookTimeout: 900_000,
          testTimeout: 300_000
        }
      }
    ]
  }
}))
