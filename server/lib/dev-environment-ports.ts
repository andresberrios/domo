import { spawn } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'

import type { DevEnvironment, DevEnvironmentPort } from '../../shared/types'
import { DOOD_CONTAINER_LABEL } from './dev-env/container'
import { inspectContainer, run, type ContainerInspection } from './dev-env/docker'
import { ensurePortHelper, knownPortHelper } from './dev-env/port-helper'
import { RUNTIME_ROOT } from './dev-env/runtime-volume'
import {
  inServiceNetwork,
  parseListeningPorts,
  requestedPorts,
  scannableServices,
  serviceReferences,
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
 * The PID of a service's first process, or null when it is not running — read
 * per connection, so a restarted service is simply found again. The label is
 * checked too: the name comes from a row, and a container that merely took the
 * same name is not this environment's to reach into.
 */
async function servicePid(environmentId: string, service: string): Promise<number | null> {
  for (const reference of serviceReferences(environmentId, service)) {
    const found = await run('docker', [
      'inspect', '--type', 'container',
      '--format', `{{.State.Pid}} {{index .Config.Labels "${ENVIRONMENT_LABEL}"}}`, reference
    ], { allowFailure: true })
    const [pid, owner] = found.stdout.split(' ')
    if (owner === environmentId) return Number(pid) > 0 ? Number(pid) : null
  }
  return null
}

/**
 * The `docker` argv relaying a connection to this port: in the environment
 * container itself with the runtime volume's Node (the project picks that
 * image and it need not have one), or in a service's namespace through the
 * port helper, with the helper's Node — the image the runtime volume's came from.
 */
async function relayArgs(environment: DevEnvironment, port: DevEnvironmentPort): Promise<string[] | null> {
  const relay = ['--eval', CONTAINER_PROXY_SCRIPT, String(port.innerPort)]
  if (!port.service) {
    return ['exec', '--interactive', reference(environment), `${RUNTIME_ROOT}/node/bin/node`, ...relay]
  }
  const pid = await servicePid(environment.id, port.service)
  if (!pid) return null
  return inServiceNetwork(await knownPortHelper(), pid, ['node', ...relay], true)
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
  if (port.service) {
    if (!await servicePid(environment.id, port.service)) throw new Error(`${port.service} is not running.`)
  } else {
    const inspection = await inspectContainer(reference(environment))
    if (!inspection?.running) throw new Error('The development environment is not running.')
  }
  const server = createServer((client: Socket) => {
    // Whatever the client sends while the relay is being found waits in the
    // socket's buffer: nothing reads it until it is piped.
    client.on('error', () => client.destroy())
    void relayArgs(environment, port).then((args) => {
      if (!args || client.destroyed) {
        client.destroy()
        return
      }
      const proxy = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      proxy.stderr.resume()
      client.pipe(proxy.stdin)
      proxy.stdout.pipe(client)
      client.on('error', () => proxy.kill())
      client.on('close', () => proxy.kill())
      proxy.on('error', () => client.destroy())
      proxy.on('close', () => client.destroy())
    }, () => client.destroy())
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

/**
 * The services an environment started on the host daemon and what each is
 * listening on, read inside each one's network namespace through the helper.
 */
async function scanServices(environmentId: string): Promise<Array<{ service: SiblingContainer, ports: Set<number> }>> {
  const ids = await run('docker', ['ps', '-q', '--filter', `label=${ENVIRONMENT_LABEL}=${environmentId}`], {
    allowFailure: true
  })
  const list = ids.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  if (!list.length) return []
  let containers: SiblingContainer[] = []
  const inspected = await run('docker', ['inspect', ...list], { allowFailure: true })
  try {
    containers = (JSON.parse(inspected.stdout || '[]') as unknown[]).map(raw => siblingFromInspect(raw, environmentId))
  } catch { /* a container removed between the two calls; the next scan sees it */ }
  const services = scannableServices(containers)
  if (!services.length) return []
  const helper = await ensurePortHelper()
  return Promise.all(services.map(async (service) => {
    const output = await run('docker', inServiceNetwork(helper, service.pid, ['cat', '/proc/net/tcp', '/proc/net/tcp6']), {
      allowFailure: true
    })
    return { service, ports: parseListeningPorts(output.stdout) }
  }))
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
}
