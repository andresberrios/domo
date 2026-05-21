import { z } from 'zod'
import * as dc from '../../lib/devcontainer'
import { getEnv, resolveContainerId } from '../../lib/envs'
import { listExternalForwards } from '../../lib/portForwarder'
import { getProject } from '../../lib/projects'
import { Env } from '../../lib/schemas'

const Drift = z.object({
  /** True iff a container has been `up`'d for this env AND the resolved
   * config hash now differs from what was persisted at that `up` time. */
  drifted: z.boolean(),
  /** Hash of the resolved config as it would be `up`'d right now. Null
   * if the env's `worktreePath` isn't readable (rare — usually the env
   * has been deleted from disk). */
  currentHash: z.string().nullable(),
  /** True iff the resolution falls back to Domo's default — surfaced
   * so the env overview can label the env "(default config)" without
   * re-resolving. */
  usedDefaultConfig: z.boolean().nullable(),
})

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
    /** Drift detection (step 8 decision #6) — null when no `up` has
     * happened yet (nothing to compare against). */
    drift: Drift.nullable(),
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

    // Drift check: resolve the config right now, hash it, compare with
    // the hash persisted on the last successful `up`. Surfaces a
    // "Rebuild to apply config changes" banner in the UI when they
    // differ. Skipped when the env hasn't been `up`'d yet
    // (`devcontainerConfigHash == null`) — nothing to compare against.
    // Skipped on `worktreePath` resolution errors (e.g. the directory
    // has been removed); the banner suppression is fine because the
    // env can't be `up`'d in that state either.
    let drift: z.infer<typeof Drift> | null = null
    if (env.worktreePath && env.devcontainerConfigHash) {
      try {
        const resolved = await dc.resolveDevcontainerConfig(env.worktreePath, env.name)
        const currentHash = dc.hashResolvedConfig(resolved.config)
        drift = {
          drifted: currentHash !== env.devcontainerConfigHash,
          currentHash,
          usedDefaultConfig: resolved.isDefault,
        }
      } catch {
        // Malformed devcontainer or missing worktree — report null hash
        // and don't drift; the UI shows the malformed-config error at
        // the actual run-time path, not here.
        drift = { drifted: false, currentHash: null, usedDefaultConfig: null }
      }
    }

    return {
      env: { ...env, liveStatus },
      project: projectMeta,
      ports,
      daemonUnreachable,
      drift,
    }
  },
})
