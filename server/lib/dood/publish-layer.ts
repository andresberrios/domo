import type { DoodRequest } from './http'
import { answer, withResponse, type DoodLayer, type Next, type Outcome } from './layers'
import { agentName, type Namespace } from './names'
import type { EnvironmentNetwork } from './network'
import {
  bindFailureMessage,
  conflictingNetworkMode,
  extraHostsFor,
  primaryNetwork,
  publishingError,
  REQUESTED_HOSTS_LABEL
} from './publish'
import { REQUESTED_PUBLISHING_LABEL, type RequestedPublishing } from './rewrite'
import { classifyRequest, domoError } from './scope'

/**
 * The layer that makes an environment's `localhost` the host its containers
 * publish on, and makes the environment the host `host.docker.internal`
 * means inside them. Placed *inside* the scope layer, so every reference it
 * sees is already a real id and every create already carries the
 * `domo.publishing` label the scope layer wrote the dropped publishing onto.
 *
 * - create: publishing that cannot be relayed (SCTP, a `container:` network
 *   mode) is refused here, since the daemon no longer sees it to refuse; and
 *   `host.docker.internal` is pointed at the environment's address on the
 *   network the container lands on.
 * - `start` / `restart`: the ports are held *before* the start is forwarded,
 *   so a taken one refuses the start with Docker's own error and the
 *   container never runs; once the daemon has answered, the relay learns the
 *   container's address.
 * - `stop` / `kill` / `rm` / prune: reconciled once answered. The events
 *   stream would get there too; this gets there before the client's next
 *   request.
 */

export interface PublishLayerOptions {
  ns: Namespace
  network: EnvironmentNetwork
}

const RECONCILED_AFTER = new Set(['stop', 'kill', 'DELETE', 'pause', 'unpause'])

const json = (body: Buffer | null): Record<string, any> | undefined => {
  if (!body?.length) return undefined
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function requestedPublishing(labels: unknown): RequestedPublishing | null {
  const value = (labels as Record<string, unknown> | undefined)?.[REQUESTED_PUBLISHING_LABEL]
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function publishLayer(options: PublishLayerOptions): DoodLayer {
  const { ns, network } = options

  const create = async (request: DoodRequest, next: Next): Promise<Outcome> => {
    const spec = json(request.body)
    if (!spec) return next(request)
    const hostConfig: Record<string, unknown> = { ...(spec.HostConfig ?? {}) }
    const requested = requestedPublishing(spec.Labels)
    const refusal = conflictingNetworkMode(hostConfig, requested) ?? publishingError(requested)
    if (refusal) return answer(400, { message: refusal })

    const target = primaryNetwork(hostConfig, spec.NetworkingConfig?.EndpointsConfig)
    // The redirect has to be in place before anything in the container can
    // call back; a create is the first moment it could.
    await network.ensureRedirect()
    const address = target ? await network.addressOn(target) : null
    if (!address) return next(request)
    const rewritten = {
      ...spec,
      HostConfig: { ...hostConfig, ExtraHosts: extraHostsFor(hostConfig.ExtraHosts, address) },
      Labels: { ...spec.Labels, [REQUESTED_HOSTS_LABEL]: JSON.stringify(hostConfig.ExtraHosts ?? null) }
    }
    return next({ ...request, body: Buffer.from(JSON.stringify(rewritten), 'utf8') })
  }

  const start = async (request: DoodRequest, next: Next, ref: string): Promise<Outcome> => {
    let check
    try {
      check = await network.prepareStart(ref)
    } catch (error) {
      return answer(500, domoError(
        `could not publish the ports of ${agentName(ns, ref)} in this environment: `
        + `${error instanceof Error ? error.message : String(error)}`
      ))
    }
    if (!check) return next(request)
    if (check.failure) return answer(500, { message: bindFailureMessage(agentName(ns, check.name), check.id, check.failure) })
    const { id } = check
    return withResponse(await next(request), { after: () => network.finishStart(id) })
  }

  return {
    wantsBody(request) {
      return classifyRequest(request.method, request.path, request.query).kind === 'container-create'
    },

    async handle(request, next) {
      const route = classifyRequest(request.method, request.path, request.query)
      if (route.kind === 'container-create') return create(request, next)
      if (route.kind === 'container' && (route.action === 'start' || route.action === 'restart')) {
        return start(request, next, route.ref)
      }
      if ((route.kind === 'container' && RECONCILED_AFTER.has(route.action)) || route.kind === 'container-prune') {
        return withResponse(await next(request), { after: () => network.schedule(0) })
      }
      return next(request)
    }
  }
}
