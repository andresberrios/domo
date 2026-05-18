import { z } from 'zod'
import { requireAdmin } from '../../../lib/auth'
import { listUsers, toPublic } from '../../../lib/users'
import { PublicUser } from '../../../lib/schemas'

/** All accounts, oldest first (admin only) — backs the management UI. */
export default defineProcedure({
  output: z.object({ users: z.array(PublicUser) }),
  handler: async ({ event }) => {
    await requireAdmin(event)
    return { users: listUsers().map(toPublic) }
  },
})
