import { z } from 'zod'
import * as dc from '../../lib/devcontainer'
import { getEnv, resolveContainerId } from '../../lib/envs'
import { listExternalForwards } from '../../lib/portForwarder'
import { getProject } from '../../lib/projects'
import { Env } from '../../lib/schemas'

const Port = z.object({
  /** Label from `portsAttributes`, or a `port-<inner>` fallback. */
  name: z.string(),
  innerPort: z.number().int(),
  /** Random host loopback port assigned at create time; null when not running. */
  hostPort: z.number().int().nullable(),
  protocol: z.enum(['tcp', 'udp']),
  /** Hint from `portsAttributes.protocol` — for UI labelling only
   * (we still TCP-forward everything; no HTTP awareness in v1). */
  appProtocol: z.enum(['http', 'https', 'tcp', 'udp']).nullable(),
  /** When the operator has exposed this port externally, the public
   * port the Domo-side TCP forwarder listens on (`0.0.0.0:<external>`). */
  externalPort: z.number().int().nullable(),
})

/**
 * One-shot data for the env overview screen — env row (with live
 * status), project metadata, and the published-port list discovered
 * from the running container. v1 has no services breakdown (Coast's
 * `ps` was free; with arbitrary `docker compose` inside the env we'd
 * need to shell into the container to enumerate services — deferred).
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
    ports: z.array(Port),
    /** True if the docker daemon was unreachable. */
    daemonUnreachable: z.boolean(),
  }),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
    const project = getProject(env.projectId)
    if (!project) throw createError({ statusCode: 500, statusMessage: 'project missing' })

    const projectMeta = { id: project.id, name: project.name, rootPath: project.rootPath }

    let liveStatus: 'running' | 'stopped' | 'starting' | 'missing' | 'error' | 'unknown' | null = null
    const ports: z.infer<typeof Port>[] = []
    let daemonUnreachable = false

    const externals = new Map(listExternalForwards(env.id).map((r) => [r.innerPort, r.externalPort]))

    const cid = await resolveContainerId(env)
    if (!cid) {
      liveStatus = 'missing'
    } else {
      const info = await dc.inspect(cid)
      if (!info) {
        // Inspect failed — could be daemon down or container vanished.
        daemonUnreachable = true
      } else {
        liveStatus = dc.toEnvLiveStatus(info.status)
        // Cross-reference with the parsed devcontainer.json so we get
        // labels from `portsAttributes`. If the file is unreadable we
        // still show the published ports, just with generic names.
        let labelled: ReturnType<typeof dc.resolveForwardPorts> = []
        if (env.worktreePath) {
          try {
            const { config } = await dc.loadDevcontainer(env.worktreePath)
            labelled = dc.resolveForwardPorts(config)
          } catch {
            // devcontainer.json gone / malformed — fall through with empty labels.
          }
        }
        for (const p of info.publishedPorts) {
          const hit = labelled.find((l) => l.innerPort === p.innerPort && l.protocol === p.protocol)
          ports.push({
            name: hit?.name ?? `port-${p.innerPort}`,
            innerPort: p.innerPort,
            hostPort: p.hostPort,
            protocol: p.protocol,
            appProtocol: hit?.appProtocol ?? null,
            externalPort: externals.get(p.innerPort) ?? null,
          })
        }
      }
    }

    return {
      env: { ...env, liveStatus },
      project: projectMeta,
      ports,
      daemonUnreachable,
    }
  },
})
