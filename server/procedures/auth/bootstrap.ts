import { z } from 'zod'
import { countUsers } from '../../lib/users'

/**
 * First-run probe (public). `needsSetup` is true only while the `users`
 * table is empty — the SPA uses it to route the very first visitor to
 * `/setup` (create the admin) instead of `/login`.
 */
export default defineProcedure({
  output: z.object({ needsSetup: z.boolean() }),
  handler: () => ({ needsSetup: countUsers() === 0 }),
})
