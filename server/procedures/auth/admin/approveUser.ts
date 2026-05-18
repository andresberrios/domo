import { z } from 'zod'
import { requireAdmin } from '../../../lib/auth'
import { getUserById, setUserStatus, toPublic } from '../../../lib/users'
import { PublicUser } from '../../../lib/schemas'

/**
 * Approve a pending account (admin only) → `status=active`. Takes effect
 * on the approved user's next request (guards read the live row), no
 * re-login needed.
 */
export default defineProcedure({
  input: z.object({ userId: z.string() }),
  output: z.object({ user: PublicUser }),
  handler: async ({ input, event }) => {
    await requireAdmin(event)
    const target = getUserById(input.userId)
    if (!target) {
      throw createError({ statusCode: 404, statusMessage: 'User not found' })
    }
    setUserStatus(target.id, 'active')
    return { user: toPublic({ ...target, status: 'active' }) }
  },
})
