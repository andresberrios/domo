import { z } from 'zod'
import { requireAdmin } from '../../../lib/auth'
import { deleteUser, getUserById } from '../../../lib/users'

/**
 * Remove an account (admin only) — this is both "reject a pending
 * signup" and "revoke a member". Guards: an admin can't delete
 * themselves, and admins aren't deletable through this path (avoids
 * locking the instance out of its last admin / admin-on-admin removal —
 * that's an out-of-band concern).
 */
export default defineProcedure({
  input: z.object({ userId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  handler: async ({ input, event }) => {
    const admin = await requireAdmin(event)
    const target = getUserById(input.userId)
    if (!target) {
      throw createError({ statusCode: 404, statusMessage: 'User not found' })
    }
    if (target.id === admin.id) {
      throw createError({
        statusCode: 400,
        statusMessage: 'You cannot delete your own account',
      })
    }
    if (target.role === 'admin') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Admin accounts cannot be deleted here',
      })
    }
    deleteUser(target.id)
    return { ok: true as const }
  },
})
