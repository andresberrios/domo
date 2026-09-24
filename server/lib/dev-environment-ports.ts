import { spawn } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'

import type { DevEnvironment, DevEnvironmentPort } from '../../shared/types'
import { DOOD_CONTAINER_LABEL } from './dev-env/container'
import { inspectContainer, run, type ContainerInspection } from './dev-env/docker'
import { RUNTIME_IMAGE, RUNTIME_ROOT } from './dev-env/runtime-volume'
import {
  parseListeningPorts,
  planPortHelpers,
  PORT_HELPER_FOR_LABEL,
  PORT_HELPER_ROLE,
  PORT_HELPER_ROLE_LABEL,
  PORT_HELPER_STARTED_LABEL,
  requestedPorts,
  siblingFromInspect,
  type SiblingContainer
} from './dev-env/service-ports'
import type { PortAttributes } from './dev-env/types'
import { ENVIRONMENT_LABEL } from './dood/manager'
import {
  getDevEnvironment,
  listDevEnvironmentPorts,
  listDevEnvironments,
  updateDevEnvironmentPort,
  upsertDevEnvironmentPort
} from './repo'

const live = new Map<string, Server>()
/**
 * The helper currently serving each service, by environment and service name.
 * Read when a connection arrives rather than captured when the forward starts,
 * because a service restarted since has a new helper — see `service-ports.ts`.
 */
const helpers = new Map<string, Map<string, string>>()
const HTTP_PORTS = new Set([3000, 3001, 4000, 4173, 4200, 5000, 5173, 8000, 8080, 8888])
const CONTAINER_PROXY_SCRIPT = [
  "const net = require('node:net')",
  "const socket = net.connect(Number(process.argv[1]), '127.0.0.1')",
  "socket.on('connect', () => { process.stdin.pipe(socket); socket.pipe(process.stdout) })",
  "socket.on('error', () => process.exit(1))"
].join(';')
const LISTENING_SCRIPT = [
  'if command -v ss >/dev/null 2>&1; then ss -ltnH;',
  'elif command -v netstat >/dev/null 2>&1; then netstat -ltn;',
  'else cat /proc/net/tcp /proc/net/tcp6; fi'
].join(' ')

function key(environmentId: string, service: string | null, innerPort: number): string {
  return `${environmentId}:${service ?? ''}:${innerPort}`
}

function reference(environment: DevEnvironment): string {
  return environment.containerId || environment.containerName
}

/** What `createEnvironment` stamped on the container as `domo.portsAttributes`. */
function labelPortAttributes(labels: Record<string, string>): Record<string, PortAttributes> {
  try {
    const parsed = JSON.parse(labels['domo.portsAttributes'] ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function detectedPortAttributes(
  innerPort: number,
  configured: Record<string, PortAttributes>
): PortAttributes | undefined {
  if (configured[String(innerPort)]) return configured[String(innerPort)]
  for (const [range, attributes] of Object.entries(configured)) {
    const match = range.match(/^(\d+)-(\d+)$/)
    if (match && innerPort >= Number(match[1]) && innerPort <= Number(match[2])) return attributes
  }
  return undefined
}

/**
 * Where a connection to this port is relayed from: the environment container
 * itself, or the helper sharing a service's network namespace. Both run the
 * same Node relay — the environment's from the runtime volume, because the
 * project picks that image and it need not have a Node of its own; a helper's
 * from its own image, which is the image the runtime volume's Node came from.
 */
function relayTarget(environment: DevEnvironment, service: string | null): { container: string, node: string } | null {
  if (!service) return { container: reference(environment), node: `${RUNTIME_ROOT}/node/bin/node` }
  const helper = helpers.get(environment.id)?.get(service)
  return helper ? { container: helper, node: 'node' } : null
}

async function startUserlandForward(
  environment: DevEnvironment,
  port: DevEnvironmentPort,
  preferredHostPort = 0
): Promise<DevEnvironmentPort> {
  const forwardKey = key(environment.id, port.service, port.innerPort)
  const current = live.get(forwardKey)
  if (current) {
    current.close()
    live.delete(forwardKey)
  }
  if (!relayTarget(environment, port.service)) {
    throw new Error(port.service
      ? `${port.service} is not running.`
      : 'The development environment is not running.')
  }
  if (!port.service) {
    const inspection = await inspectContainer(reference(environment))
    if (!inspection?.running) throw new Error('The development environment is not running.')
  }
  const server = createServer((client: Socket) => {
    const target = relayTarget(environment, port.service)
    if (!target) {
      client.destroy()
      return
    }
    const proxy = spawn('docker', [
      'exec', '--interactive', target.container,
      target.node, '--eval', CONTAINER_PROXY_SCRIPT, String(port.innerPort)
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    proxy.stderr.resume()
    client.pipe(proxy.stdin)
    proxy.stdout.pipe(client)
    client.on('error', () => proxy.kill())
    client.on('close', () => proxy.kill())
    proxy.on('error', () => client.destroy())
    proxy.on('close', () => client.destroy())
  })
  server.on('error', error => console.error(`[ports] ${forwardKey}`, error))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(preferredHostPort, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  live.set(forwardKey, server)
  const address = server.address()
  const hostPort = address && typeof address === 'object' ? address.port : null
  return (await updateDevEnvironmentPort(environment.id, port.innerPort, {
    hostPort,
    forwarded: true
  }, port.protocol, port.service))!
}

async function restoreUserlandForward(environment: DevEnvironment, port: DevEnvironmentPort): Promise<void> {
  try {
    await startUserlandForward(environment, port, port.hostPort ?? 0)
  } catch {
    try {
      await startUserlandForward(environment, port, 0)
    } catch (error) {
      await updateDevEnvironmentPort(environment.id, port.innerPort, {
        hostPort: null,
        forwarded: false
      }, port.protocol, port.service)
      console.warn(
        `[ports] could not forward ${key(environment.id, port.service, port.innerPort)}:`,
        error instanceof Error ? error.message : error
      )
    }
  }
}

/** One scan at a time per environment: a scan may start helpers, and two would start two. */
const scanning = new Map<string, Promise<unknown>>()

function serially<T>(environmentId: string, task: () => Promise<T>): Promise<T> {
  const previous = scanning.get(environmentId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  scanning.set(environmentId, next)
  void next.finally(() => { if (scanning.get(environmentId) === next) scanning.delete(environmentId) })
  return next
}

async function startPortHelper(environmentId: string, service: SiblingContainer): Promise<string> {
  const { stdout } = await run('docker', [
    'run', '--detach', '--rm', '--init',
    '--network', `container:${service.id}`,
    // Labelled with the environment, so stopping and retiring it take the
    // helpers along with the services they serve.
    '--label', `${ENVIRONMENT_LABEL}=${environmentId}`,
    '--label', `${PORT_HELPER_ROLE_LABEL}=${PORT_HELPER_ROLE}`,
    '--label', `${PORT_HELPER_FOR_LABEL}=${service.id}`,
    '--label', `${PORT_HELPER_STARTED_LABEL}=${service.startedAt}`,
    RUNTIME_IMAGE, 'sleep', 'infinity'
  ])
  return stdout.trim()
}

/**
 * The services an environment started on the host daemon and what each is
 * listening on, reconciling one port helper per running service on the way.
 */
async function scanServices(environmentId: string): Promise<Array<{ service: SiblingContainer, ports: Set<number> }>> {
  return serially(environmentId, async () => {
    const ids = await run('docker', ['ps', '-aq', '--filter', `label=${ENVIRONMENT_LABEL}=${environmentId}`], {
      allowFailure: true
    })
    const list = ids.stdout.split('\n').map(line => line.trim()).filter(Boolean)
    let containers: SiblingContainer[] = []
    if (list.length) {
      const inspected = await run('docker', ['inspect', ...list], { allowFailure: true })
      try {
        containers = (JSON.parse(inspected.stdout || '[]') as unknown[]).map(siblingFromInspect)
      } catch { /* a container removed between the two calls; the next scan sees it */ }
    }
    const plan = planPortHelpers(containers)
    if (plan.remove.length) await run('docker', ['rm', '--force', ...plan.remove], { allowFailure: true })

    const serving = new Map<string, string>()
    const found = await Promise.all(plan.services.map(async ({ service, helper }) => {
      const current = helper ?? await startPortHelper(environmentId, service).catch((error) => {
        console.warn(`[ports] no helper for ${service.name}:`, error instanceof Error ? error.message : error)
        return null
      })
      if (!current) return { service, ports: new Set<number>() }
      serving.set(service.name, current)
      const output = await run('docker', ['exec', current, 'cat', '/proc/net/tcp', '/proc/net/tcp6'], {
        allowFailure: true
      })
      return { service, ports: parseListeningPorts(output.stdout) }
    }))
    helpers.set(environmentId, serving)
    return found
  })
}

async function listeningTcpPorts(environment: DevEnvironment): Promise<Set<number>> {
  const output = await run('docker', ['exec', reference(environment), 'sh', '-c', LISTENING_SCRIPT], { allowFailure: true })
  return parseListeningPorts(output.stdout)
}

function appProtocolFor(innerPort: number, attributes: PortAttributes | undefined): DevEnvironmentPort['appProtocol'] {
  return attributes?.protocol === 'http' || attributes?.protocol === 'https'
    ? attributes.protocol
    : HTTP_PORTS.has(innerPort) ? 'http' : null
}

const hasDockerProxy = (inspection: ContainerInspection) => inspection.labels[DOOD_CONTAINER_LABEL] === 'true'

export async function refreshEnvironmentPorts(environmentId: string): Promise<DevEnvironmentPort[]> {
  const environment = await getDevEnvironment(environmentId)
  if (!environment) throw new Error('Development environment not found')
  const inspection = await inspectContainer(reference(environment))
  if (!inspection?.running) return listDevEnvironmentPorts(environmentId)

  const listening = await listeningTcpPorts(environment)
  // Only an environment on the host daemon has siblings to look for; one with
  // a daemon of its own has its services in its own namespace, where `ss`
  // above already found them.
  const services = hasDockerProxy(inspection) ? await scanServices(environmentId) : []
  const existing = await listDevEnvironmentPorts(environmentId)
  // Port attributes travel on the container's own label, so they do not depend on the
  // project's config still saying what it said when the environment was created.
  const configured = labelPortAttributes(inspection.labels)
  const listeningIn = (service: string | null) => service
    ? services.find(entry => entry.service.name === service)?.ports ?? new Set<number>()
    : listening
  for (const port of existing) {
    const published = !port.service && inspection.publishedPorts.find(item =>
      item.innerPort === port.innerPort && item.protocol === port.protocol
    )
    await updateDevEnvironmentPort(environmentId, port.innerPort, {
      listening: listeningIn(port.service).has(port.innerPort),
      ...(published ? { hostPort: published.hostPort, forwarded: true } : {})
    }, port.protocol, port.service)
  }
  const known = (service: string | null, innerPort: number) =>
    existing.some(port => port.service === service && port.innerPort === innerPort && port.protocol === 'tcp')
  for (const innerPort of listening) {
    if (innerPort === 22 || known(null, innerPort)) continue
    const attributes = detectedPortAttributes(innerPort, configured)
    if (attributes?.onAutoForward === 'ignore') continue
    await upsertDevEnvironmentPort({
      environmentId,
      innerPort,
      protocol: 'tcp',
      appProtocol: appProtocolFor(innerPort, attributes),
      label: attributes?.label ?? null,
      source: 'detected',
      listening: true
    })
  }
  for (const { service, ports } of services) {
    const requested = requestedPorts(service.labels)
    for (const innerPort of ports) {
      if (known(service.name, innerPort)) continue
      const attributes = detectedPortAttributes(innerPort, configured)
      if (attributes?.onAutoForward === 'ignore') continue
      const asked = requested.find(entry => entry.containerPort === innerPort && entry.protocol === 'tcp')
      const port = await upsertDevEnvironmentPort({
        environmentId,
        service: service.name,
        innerPort,
        protocol: 'tcp',
        appProtocol: appProtocolFor(innerPort, attributes),
        label: attributes?.label ?? service.labels['com.docker.compose.service'] ?? null,
        source: 'detected',
        listening: true
      })
      // The stack asked for this one to be published, which is a request to
      // reach it from the host. Honour it the first time the port is seen, on
      // the host port it named if that is free — never again after that, or
      // an un-forward would be undone by the next scan.
      if (asked) {
        await startUserlandForward(environment, port, asked.hostPort ?? 0)
          .catch(() => restoreUserlandForward(environment, { ...port, hostPort: null }))
      }
    }
  }

  const refreshed = await listDevEnvironmentPorts(environmentId)
  for (const port of refreshed) {
    if (port.protocol !== 'tcp' || live.has(key(environmentId, port.service, port.innerPort))) continue
    const published = !port.service && inspection.publishedPorts.some(item =>
      item.innerPort === port.innerPort && item.protocol === port.protocol
    )
    if (port.source === 'declared' && !published) {
      await restoreUserlandForward(environment, port)
    } else if (port.source === 'detected' && port.forwarded && (!port.service || port.listening)) {
      await restoreUserlandForward(environment, port)
    }
  }
  return listDevEnvironmentPorts(environmentId)
}

export async function forwardEnvironmentPort(
  environmentId: string,
  innerPort: number,
  service: string | null = null
): Promise<DevEnvironmentPort> {
  const environment = await getDevEnvironment(environmentId)
  if (!environment) throw new Error('Development environment not found')
  await refreshEnvironmentPorts(environmentId)
  const port = (await listDevEnvironmentPorts(environmentId)).find(item =>
    item.innerPort === innerPort && item.protocol === 'tcp' && item.service === service
  )
  const where = service ? ` in ${service}` : ' in this environment'
  if (!port) throw new Error(`Port ${innerPort} is not listening${where}.`)
  if (!port.listening) throw new Error(`Port ${innerPort} is no longer listening${where}.`)
  if (port.hostPort && (port.source === 'declared' || live.has(key(environmentId, service, innerPort)))) return port
  return startUserlandForward(environment, port)
}

export async function unforwardEnvironmentPort(
  environmentId: string,
  innerPort: number,
  service: string | null = null
): Promise<void> {
  const port = (await listDevEnvironmentPorts(environmentId)).find(item =>
    item.innerPort === innerPort && item.service === service
  )
  if (!port || port.source === 'declared') return
  live.get(key(environmentId, service, innerPort))?.close()
  live.delete(key(environmentId, service, innerPort))
  await updateDevEnvironmentPort(environmentId, innerPort, { hostPort: null, forwarded: false }, port.protocol, service)
}

export function stopEnvironmentForwarders(environmentId: string): void {
  for (const [forwardKey, server] of live) {
    if (!forwardKey.startsWith(`${environmentId}:`)) continue
    server.close()
    live.delete(forwardKey)
  }
  helpers.delete(environmentId)
}

export async function rebuildEnvironmentForwarders(): Promise<void> {
  for (const environment of await listDevEnvironments()) {
    if (environment.status !== 'running') continue
    await refreshEnvironmentPorts(environment.id).catch(error =>
      console.warn(`[ports] could not restore ${environment.id}:`, error instanceof Error ? error.message : error)
    )
  }
}

export function stopAllEnvironmentForwarders(): void {
  for (const server of live.values()) server.close()
  live.clear()
  helpers.clear()
}
