/**
 * The origin the `environments-live` layer serves the app on: its own port,
 * for the reason `test/voice/origin.ts` gives. Its own module so the setup and
 * the spec share it without importing each other.
 */
export const ENVIRONMENTS_SERVER_PORT = Number(process.env.DOMO_ENVIRONMENTS_SERVER_PORT || 43119)

export const ENVIRONMENTS_SERVER_ORIGIN = `http://127.0.0.1:${ENVIRONMENTS_SERVER_PORT}`

/** Every Docker resource the server makes is named with this, so none is the developer's. */
export const ENVIRONMENTS_PREFIX = 'domo-envlive-'
