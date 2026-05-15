import { z } from 'zod'
import { getSetting } from '../../lib/settings'

export default defineProcedure({
  input: z.object({ key: z.string() }),
  output: z.object({ value: z.string().nullable() }),
  handler: ({ input }) => ({ value: getSetting(input.key) }),
})
