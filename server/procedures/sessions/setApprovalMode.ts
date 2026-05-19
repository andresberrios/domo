import { z } from 'zod'
import { ApprovalMode, Session } from '../../lib/schemas'
import { getSession, updateSession } from '../../lib/sessions'

/**
 * Set this session's edit-approval policy (Decided #22). Plain Domo-side
 * DB write — deliberately NOT a durable inbox round-trip: the entity
 * reads the effective mode fresh at the start of each turn
 * (`getSession(...).approvalMode ?? config default ?? 'manual'`), so the
 * change applies to the next turn with no wake and no restart-resume
 * fragility. `null` clears the override → inherit `config.claude
 * .approvalMode` (default `manual`).
 */
export default defineProcedure({
  input: z.object({
    id: z.string(),
    approvalMode: ApprovalMode.nullable(),
  }),
  output: Session,
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    updateSession(session.id, { approvalMode: input.approvalMode })
    return { ...session, approvalMode: input.approvalMode }
  },
})
