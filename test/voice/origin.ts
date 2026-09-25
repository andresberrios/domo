/**
 * The origin the `voice-live` layer runs on.
 *
 * Its own port rather than the `electric` layer's, even though the two share a
 * database and never run at the same time: both are opt-in commands a
 * developer may well run back to back, and a server that has not finished
 * letting go of a port turns into a confusing bind failure in whichever one
 * goes second. A different number costs nothing.
 *
 * Its own module with no dependencies, so `global-setup.ts` and the spec can
 * both read it without dragging the harness in.
 */
export const VOICE_SERVER_PORT = Number(process.env.DOMO_VOICE_SERVER_PORT || 43118)

export const VOICE_SERVER_ORIGIN = `http://127.0.0.1:${VOICE_SERVER_PORT}`
