import { z } from 'zod'
import { countUsers, createUser, toPublic, touchLastLogin } from '../../lib/users'
import { PublicUser } from '../../lib/schemas'

/**
 * Create the first account = the admin (public, but only while no users
 * exist — any later call 409s; subsequent signups go through `register`
 * and need admin approval). The admin is `role=admin, status=active` and
 * is logged straight in.
 */
export default defineProcedure({
  input: z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    name: z.string().trim().min(1),
    password: z.string().min(8),
  }),
  output: z.object({ user: PublicUser }),
  handler: async ({ input, event }) => {
    if (countUsers() > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Setup already completed',
      })
    }
    const passwordHash = await hashPassword(input.password)
    const user = createUser({
      email: input.email,
      name: input.name,
      passwordHash,
      role: 'admin',
      status: 'active',
    })
    touchLastLogin(user.id)
    await setUserSession(event, {
      user: { id: user.id, email: user.email, name: user.name },
    })
    return { user: toPublic({ ...user, lastLoginAt: Date.now() }) }
  },
})
