import { z } from 'zod'
import { requireUser } from '../../lib/auth'
import { toPublic } from '../../lib/users'
import { PublicUser } from '../../lib/schemas'

/**
 * DB-fresh identity for the signed-in user (incl. live `role`/`status`).
 * The SPA polls this — a still-`pending` account flips to `active` here
 * the instant the admin approves it, with no re-login (the sealed cookie
 * carries identity only). Allow-listed in the auth middleware because a
 * `pending` user must be able to read their own status; `requireUser`
 * (not `requireActiveUser`) lets them through.
 */
export default defineProcedure({
  output: z.object({ user: PublicUser }),
  handler: async ({ event }) => {
    const user = await requireUser(event)
    return { user: toPublic(user) }
  },
})
