/**
 * The origin the `electric` layer runs on.
 *
 * Its own module, with no dependencies, because `vitest.config.ts` imports it
 * too: happy-dom's `window.location` is an environment option, fixed before any
 * test runs, and the app derives its `/api/shape` URL from
 * `window.location.origin`. The pinned port is what makes those two agree.
 */
export const TEST_SERVER_PORT = Number(process.env.DOMO_TEST_SERVER_PORT || 43117)

export const TEST_SERVER_ORIGIN = `http://127.0.0.1:${TEST_SERVER_PORT}`
