import { z } from 'zod'
import { Session } from '../../lib/schemas'
import { getSession } from '../../lib/sessions'

export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: Session.nullable(),
  handler: ({ input }) => getSession(input.id),
})
