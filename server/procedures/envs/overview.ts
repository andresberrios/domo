import { z } from 'zod'
import { coast, CoastError } from '../../lib/coast'
import { getEnv } from '../../lib/envs'
import { getProject } from '../../lib/projects'
import { Env } from '../../lib/schemas'

const Service = z.object({
  name: z.string(),
  status: z.string(),
  ports: z.string(),
  image: z.string(),
  kind: z.string().nullable().optional(),
})

const Port = z.object({
  logicalName: z.string(),
  canonicalPort: z.number().int(),
  dynamicPort: z.number().int(),
  isPrimary: z.boolean(),
})

/**
 * One-shot data for the env overview screen — env row (with live status),
 * services from `coast ps`, ports from `coast ports`, project metadata.
 *
 * Folded into a single procedure so the page can render with one round
 * trip instead of three.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({
    env: Env,
    project: z.object({
      id: z.string(),
      name: z.string(),
      rootPath: z.string(),
    }),
    services: z.array(Service),
    ports: z.array(Port),
    /** Set if coastd was reachable but the instance wasn't found there. */
    coastUnknown: z.boolean(),
    /** Set if coastd was unreachable; cached row is still returned. */
    coastUnreachable: z.boolean(),
  }),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
    const project = getProject(env.projectId)
    if (!project) throw createError({ statusCode: 500, statusMessage: 'project missing' })

    const projectMeta = { id: project.id, name: project.name, rootPath: project.rootPath }

    let liveStatus: string | null = null
    let checkedOut = false
    let services: z.infer<typeof Service>[] = []
    let ports: z.infer<typeof Port>[] = []
    let coastUnknown = false
    let coastUnreachable = false

    try {
      const ls = await coast().ls(project.name)
      const instance = ls.instances.find((i) => i.name === env.coastInstanceName)
      if (!instance) {
        coastUnknown = true
      } else {
        liveStatus = instance.status
        checkedOut = instance.checked_out
      }
    } catch (e) {
      if (e instanceof CoastError) {
        coastUnreachable = true
      } else {
        throw e
      }
    }

    if (!coastUnreachable && !coastUnknown) {
      try {
        const psRes = await coast().ps(env.coastInstanceName, project.name)
        services = psRes.services.map((s) => ({
          name: s.name,
          status: s.status,
          ports: s.ports,
          image: s.image,
          kind: s.kind ?? null,
        }))
      } catch { /* services unknown is fine */ }

      try {
        const portsRes = await coast().ports(env.coastInstanceName, project.name)
        ports = portsRes.ports.map((p) => ({
          logicalName: p.logical_name,
          canonicalPort: p.canonical_port,
          dynamicPort: p.dynamic_port,
          isPrimary: p.is_primary,
        }))
      } catch { /* ports unknown is fine */ }
    }

    return {
      env: { ...env, liveStatus, checkedOut },
      project: projectMeta,
      services,
      ports,
      coastUnknown,
      coastUnreachable,
    }
  },
})
