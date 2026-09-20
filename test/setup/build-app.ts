import { ensureAppBuild } from '../helpers/app-build'

/**
 * Build the app once for the `integration` project, in the main process, before
 * any worker forks — `test/e2e/api.spec.ts` then starts a server from it with
 * `build: false`.
 *
 * Here rather than in the spec file because the `electric` project builds from
 * its own `globalSetup` too, and only two `globalSetup`s can agree to share one
 * build: they run in the same process, one after the other, so whichever goes
 * first pays for it. See `test/helpers/app-build.ts`.
 */
export async function setup(): Promise<void> {
  await ensureAppBuild()
}
