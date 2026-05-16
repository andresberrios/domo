import { z } from 'zod'
import { Session } from '../../lib/schemas'
import { markSessionViewed } from '../../lib/sessions'

/**
 * Stamp the calling device's "last viewed" time for a session. The chat
 * surface calls this on open and as new output arrives while it's the
 * focused session; the left rail then renders a new-output dot for any
 * session whose `lastEventAt` is newer than this device's stamp.
 *
 * Idempotent and per-device — the deviceId is a stable client-generated id
 * (localStorage; see `useDeviceId`). Returns the updated row, or null if
 * the session was deleted in the meantime.
 */
export default defineProcedure({
  input: z.object({ id: z.string(), deviceId: z.string().min(1) }),
  output: Session.nullable(),
  handler: ({ input }) =>
    markSessionViewed(input.id, input.deviceId, Date.now()),
})
