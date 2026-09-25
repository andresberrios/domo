import { agentName, hostName, namespaceFor } from '../dood/names'
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
 * what Vite and Next do by default.
 *
 * So one *port helper* serves every service of every environment: a small
 * long-lived container in the host's PID namespace, which `nsenter -n`s into a
 * service's network namespace by the PID `docker inspect` reports. The scanner
 * reads `/proc/net/tcp` that way, whatever the service's own image has in it
 * (often nothing — distroless), and the userland forwarder runs its relay that
 * way, with the helper's own Node. The PID is read fresh every time, so a
 * restarted service needs nothing replaced. The alternative — a helper per
 * service joined with `--network container:<id>` — needs no capabilities, but
 * cannot follow its service through a restart (measured: it stays in the old,
 * empty namespace), so it needed a container per service and a reconciler to
 * keep them matched. An environment that can reach the host daemon can start
 * this helper itself, so its capabilities give nobody anything new.
 */

export const PORT_HELPER_ROLE_LABEL = 'domo.role'
export const PORT_HELPER_ROLE = 'port-helper'

/**
 * `docker run` for the helper. `--pid=host` to see every container's PID, and
 * `SYS_ADMIN` + `SYS_PTRACE` for `setns` into it — measured to be enough on
 * Docker Desktop, so it is not `--privileged`. `NET_ADMIN` and an unmasked
 * `/proc/sys` are for the `host.docker.internal` redirect it sets up in an
 * environment's namespace (an iptables rule, and `route_localnet`): measured,
 * `/proc/sys` is read-only without `systempaths=unconfined`, and that is
 * still not `--privileged`.
 */
export function portHelperRunArgs(name: string, image: string): string[] {
  return [
    'run', '--detach', '--init', '--name', name,
    '--pid', 'host',
    '--cap-add', 'SYS_ADMIN', '--cap-add', 'SYS_PTRACE', '--cap-add', 'NET_ADMIN',
    '--security-opt', 'systempaths=unconfined',
    '--label', `${PORT_HELPER_ROLE_LABEL}=${PORT_HELPER_ROLE}`,
    image, 'sleep', 'infinity'
  ]
}

/** A command run inside a service's network namespace, through the helper. */
export function inServiceNetwork(helper: string, pid: number, command: string[], interactive = false): string[] {
  return ['exec', ...(interactive ? ['--interactive'] : []), helper, 'nsenter', '-t', String(pid), '-n', ...command]
}

/** The part of `docker inspect` the scanner reads. */
export interface SiblingContainer {
  id: string
  /**
   * As the agent knows it: without Docker's leading slash, and without the
   * environment's namespace prefix (`server/lib/dood/names.ts`). This is what
   * a port row is keyed by and what the Ports panel shows — the name the agent
   * gave it, not the one it has on the shared daemon.
   */
  name: string
  running: boolean
  /** 0 when it is not running. */
  pid: number
  labels: Record<string, string>
  networkMode: string
}

export function siblingFromInspect(raw: any, environmentId?: string): SiblingContainer {
  const name = String(raw?.Name ?? '').replace(/^\//, '')
  return {
    id: String(raw?.Id ?? ''),
    name: environmentId ? agentName(namespaceFor(environmentId), name) : name,
    running: !!raw?.State?.Running,
    pid: Number(raw?.State?.Pid) || 0,
    labels: raw?.Config?.Labels ?? {},
    networkMode: String(raw?.HostConfig?.NetworkMode ?? '')
  }
}

/**
 * The containers worth scanning. One sharing another's namespace
 * (`container:…`) has no ports of its own to find, and one on the host network
 * or on none has nothing to reach.
 */
export function scannableServices(containers: SiblingContainer[]): SiblingContainer[] {
  return containers.filter(container => container.running
    && container.pid > 0
    && container.labels[PORT_HELPER_ROLE_LABEL] !== PORT_HELPER_ROLE
    && !container.networkMode.startsWith('container:')
    && container.networkMode !== 'host'
    && container.networkMode !== 'none')
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

/**
 * What to hand `docker inspect` for a service row: its namespaced name first,
 * then the name as it is, for a container the daemon named at random (which
 * carries no prefix). The caller still checks the label on whatever it finds.
 */
export function serviceReferences(environmentId: string, service: string): string[] {
  return [hostName(namespaceFor(environmentId), service), service]
}
