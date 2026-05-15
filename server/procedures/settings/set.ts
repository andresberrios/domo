import { z } from 'zod'
import { setSetting } from '../../lib/settings'

export default defineProcedure({
  input: z.object({ key: z.string(), value: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  handler: ({ input }) => {
    setSetting(input.key, input.value)
    return { ok: true as const }
  },
})
