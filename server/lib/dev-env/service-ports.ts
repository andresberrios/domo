import { REQUESTED_PORTS_LABEL, type PublishedPort } from '../dood/rewrite'

/**
 * The pure half of finding ports in the containers an environment started on
 * the host daemon (`server/lib/dood/`).
 *
 * On a daemon of its own, a compose service's published port landed in the
 * environment container's network namespace, so `ss` in there saw it and
 * `127.0.0.1` reached it. On the shared daemon a service is a sibling with a
 * namespace of its own: invisible to `ss`, unreachable at `127.0.0.1`, and —
 * measured — unreachable by name as well when it listens on loopback, which is
 * what Vite and Next do by default. So each running service gets a small
 * long-lived *port helper* sharing its network namespace
 * (`--network container:<id>`): the scanner reads `/proc/net/tcp` through it,
 * whatever the service's own image has in it (often nothing — distroless), and
 * the userland forwarder `docker exec`s its relay in it exactly as it does in
 * the environment container. A helper does not follow its service through a
 * restart: measured, it keeps running in the old, empty namespace. So a helper
 * is keyed on the service's id *and* its start time, and replaced when either
 * moves.
 */

export const PORT_HELPER_ROLE_LABEL = 'domo.role'
export const PORT_HELPER_ROLE = 'port-helper'
export const PORT_HELPER_FOR_LABEL = 'domo.portsFor'
export const PORT_HELPER_STARTED_LABEL = 'domo.portsStartedAt'

/** The part of `docker inspect` the scanner reads. */
export interface SiblingContainer {
  id: string
  /** Without Docker's leading slash. */
  name: string
  running: boolean
  startedAt: string
  labels: Record<string, string>
  networkMode: string
}

export function siblingFromInspect(raw: any): SiblingContainer {
  return {
    id: String(raw?.Id ?? ''),
    name: String(raw?.Name ?? '').replace(/^\//, ''),
    running: !!raw?.State?.Running,
    startedAt: String(raw?.State?.StartedAt ?? ''),
    labels: raw?.Config?.Labels ?? {},
    networkMode: String(raw?.HostConfig?.NetworkMode ?? '')
  }
}

export interface PortHelperPlan {
  /** Running services, each with the helper that currently serves it, if any. */
  services: Array<{ service: SiblingContainer, helper: string | null }>
  /** Services that need a helper started. */
  create: SiblingContainer[]
  /** Helpers whose service is gone, stopped or restarted since. */
  remove: string[]
}

const isHelper = (container: SiblingContainer) =>
  container.labels[PORT_HELPER_ROLE_LABEL] === PORT_HELPER_ROLE

/**
 * Which containers are services worth scanning, and which helpers to start and
 * remove. A container sharing another's namespace (`container:…`, a helper
 * included) has no ports of its own to find, and one on the host network or on
 * none has nothing a helper could reach.
 */
export function planPortHelpers(containers: SiblingContainer[]): PortHelperPlan {
  const helpers = containers.filter(isHelper)
  const services = containers.filter(container => !isHelper(container)
    && container.running
    && !container.networkMode.startsWith('container:')
    && container.networkMode !== 'host'
    && container.networkMode !== 'none')

  const used = new Set<string>()
  const plan: PortHelperPlan = { services: [], create: [], remove: [] }
  for (const service of services) {
    const helper = helpers.find(candidate => candidate.running
      && !used.has(candidate.id)
      && candidate.labels[PORT_HELPER_FOR_LABEL] === service.id
      && candidate.labels[PORT_HELPER_STARTED_LABEL] === service.startedAt)
    if (helper) used.add(helper.id)
    else plan.create.push(service)
    plan.services.push({ service, helper: helper?.id ?? null })
  }
  plan.remove = helpers.filter(helper => !used.has(helper.id)).map(helper => helper.id)
  return plan
}

/**
 * Docker's embedded DNS resolver, and how `/proc/net/tcp` spells it. It listens
 * on a random TCP port in every container on a user-defined network — which
 * the environment itself now is, having joined its stack's — and is nobody's
 * service. Measured: without this every service, and the environment, listed
 * one bogus high port.
 */
const DOCKER_DNS = '127.0.0.11'
const DOCKER_DNS_PROC = '0B00007F'

/**
 * Listening TCP ports out of `ss -ltnH`, `netstat -ltn` or `/proc/net/tcp{,6}`,
 * whichever the container had.
 */
export function parseListeningPorts(output: string): Set<number> {
  const ports = new Set<number>()
  for (const line of output.split('\n')) {
    const procMatch = line.match(/^\s*\d+:\s+([0-9A-Fa-f]+):([0-9A-Fa-f]{4})\s+[0-9A-Fa-f]+:[0-9A-Fa-f]{4}\s+(\w{2})\s/)
    if (procMatch?.[2]) {
      // `0A` is LISTEN; every other state is a connection, not a service.
      if (procMatch[3] === '0A' && procMatch[1]!.toUpperCase() !== DOCKER_DNS_PROC) {
        ports.add(Number.parseInt(procMatch[2], 16))
      }
      continue
    }
    if (/^\s*sl\s+local_address/.test(line) || line.includes(`${DOCKER_DNS}:`)) continue
    const addressMatch = line.match(/(?:\*|\[[^\]]+\]|[0-9A-Fa-f:.]+):(\d+)\s/)
    const port = Number(addressMatch?.[1])
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port)
  }
  return ports
}

/** What a service asked to publish, as the DooD proxy wrote it down. */
export function requestedPorts(labels: Record<string, string>): PublishedPort[] {
  try {
    const parsed = JSON.parse(labels[REQUESTED_PORTS_LABEL] ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
