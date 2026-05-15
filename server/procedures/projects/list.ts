import { z } from 'zod'
import { Project } from '../../lib/schemas'
import { listProjects } from '../../lib/projects'

export default defineProcedure({
  output: z.array(Project),
  handler: () => listProjects(),
})
