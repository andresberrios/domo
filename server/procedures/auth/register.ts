import { z } from 'zod'
import {
  countUsers,
  createUser,
  getUserByEmail,
  toPublic,
} from '../../lib/users'
import { PublicUser } from '../../lib/schemas'

/**
 * Self-service signup once an admin exists (public). The new account is
 * `role=member, status=pending` — it gets a session immediately so the
 * SPA can show the "waiting for approval" screen, but every app
 * procedure stays blocked (server middleware + `requireActiveUser`)
 * until the admin approves it. No email is ever sent.
 */
export default defineProcedure({
  input: z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    name: z.string().trim().min(1),
    password: z.string().min(8),
  }),
  output: z.object({ user: PublicUser }),
  handler: async ({ input, event }) => {
    if (countUsers() === 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'No admin yet — complete initial setup first',
      })
    }
    if (getUserByEmail(input.email)) {
      throw createError({
        statusCode: 409,
        statusMessage: 'An account with this email already exists',
      })
    }
    const passwordHash = await hashPassword(input.password)
    const user = createUser({
      email: input.email,
      name: input.name,
      passwordHash,
      role: 'member',
      status: 'pending',
    })
    await setUserSession(event, {
      user: { id: user.id, email: user.email, name: user.name },
    })
    return { user: toPublic(user) }
  },
})
