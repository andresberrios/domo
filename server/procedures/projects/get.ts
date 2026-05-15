import { z } from 'zod'
import { Project } from '../../lib/schemas'
import { getProject } from '../../lib/projects'

export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: Project.nullable(),
  handler: ({ input }) => getProject(input.id),
})
