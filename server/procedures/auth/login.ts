import { z } from 'zod'
import { getUserByEmail, toPublic, touchLastLogin } from '../../lib/users'
import { PublicUser } from '../../lib/schemas'

/**
 * Email + password sign-in (public). Returns the public user incl.
 * `role`/`status` so the SPA can route a still-`pending` account to the
 * waiting screen. A generic 401 on both unknown-email and bad-password
 * (don't leak which emails are registered).
 */
export default defineProcedure({
  input: z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password: z.string().min(1),
  }),
  output: z.object({ user: PublicUser }),
  handler: async ({ input, event }) => {
    const user = getUserByEmail(input.email)
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Invalid email or password',
      })
    }
    touchLastLogin(user.id)
    await setUserSession(event, {
      user: { id: user.id, email: user.email, name: user.name },
    })
    return { user: toPublic({ ...user, lastLoginAt: Date.now() }) }
  },
})
