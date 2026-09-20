import { spawn } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'

import type { DevEnvironment, DevEnvironmentPort } from '../../shared/types'
import { devcontainerMetadata, inspectContainer, run } from './devcontainer/client'
import type { PortAttributes } from './devcontainer/types'
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

function key(environmentId: string, innerPort: number): string {
  return `${environmentId}:${innerPort}`
}

function reference(environment: DevEnvironment): string {
  return environment.containerId || environment.containerName
}

function detectedPortAttributes(
  innerPort: number,
  configured: Record<string, PortAttributes>,
  fallback?: PortAttributes
): PortAttributes | undefined {
  if (configured[String(innerPort)]) return configured[String(innerPort)]
  for (const [range, attributes] of Object.entries(configured)) {
    const match = range.match(/^(\d+)-(\d+)$/)
    if (match && innerPort >= Number(match[1]) && innerPort <= Number(match[2])) return attributes
  }
  return fallback
}

async function startUserlandForward(
  environment: DevEnvironment,
  port: DevEnvironmentPort,
  preferredHostPort = 0
): Promise<DevEnvironmentPort> {
  const current = live.get(key(environment.id, port.innerPort))
  if (current) {
    current.close()
    live.delete(key(environment.id, port.innerPort))
  }
  const inspection = await inspectContainer(reference(environment))
  if (!inspection?.running) {
    throw new Error('The development environment is not running.')
  }
  const server = createServer((client: Socket) => {
    const proxy = spawn('docker', [
      'exec', '--interactive', inspection.id,
      'node', '--eval', CONTAINER_PROXY_SCRIPT, String(port.innerPort)
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    proxy.stderr.resume()
    client.pipe(proxy.stdin)
    proxy.stdout.pipe(client)
    client.on('error', () => proxy.kill())
    client.on('close', () => proxy.kill())
    proxy.on('error', () => client.destroy())
    proxy.on('close', () => client.destroy())
  })
  server.on('error', error => console.error(`[ports] ${environment.id}:${port.innerPort}`, error))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(preferredHostPort, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  live.set(key(environment.id, port.innerPort), server)
  const address = server.address()
  const hostPort = address && typeof address === 'object' ? address.port : null
  return (await updateDevEnvironmentPort(environment.id, port.innerPort, {
    hostPort,
    forwarded: true
  }))!
}

async function listeningTcpPorts(environment: DevEnvironment): Promise<Set<number>> {
  const script = [
    'if command -v ss >/dev/null 2>&1; then ss -ltnH;',
    'elif command -v netstat >/dev/null 2>&1; then netstat -ltn;',
    'else cat /proc/net/tcp /proc/net/tcp6; fi'
  ].join(' ')
  const output = await run('docker', ['exec', reference(environment), 'sh', '-c', script], { allowFailure: true })
  const ports = new Set<number>()
  for (const line of output.stdout.split('\n')) {
    const procMatch = line.match(/^\s*\d+:\s+[0-9A-Fa-f]+:([0-9A-Fa-f]{4})\s+[0-9A-Fa-f]+:[0-9A-Fa-f]{4}\s+0A\s/)
    if (procMatch?.[1]) {
      ports.add(Number.parseInt(procMatch[1], 16))
      continue
    }
    const addressMatch = line.match(/(?:\*|\[[^\]]+\]|[0-9A-Fa-f:.]+):(\d+)\s/)
    const port = Number(addressMatch?.[1])
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port)
  }
  return ports
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
      })
      console.warn(
        `[ports] could not forward ${environment.id}:${port.innerPort}:`,
        error instanceof Error ? error.message : error
      )
    }
  }
}

export async function refreshEnvironmentPorts(environmentId: string): Promise<DevEnvironmentPort[]> {
  const environment = await getDevEnvironment(environmentId)
  if (!environment) throw new Error('Development environment not found')
  const inspection = await inspectContainer(reference(environment))
  if (!inspection?.running) return listDevEnvironmentPorts(environmentId)

  const listening = await listeningTcpPorts(environment)
  const existing = await listDevEnvironmentPorts(environmentId)
  // Port attributes come from the container's own devcontainer.metadata label, so they no longer
  // depend on a host copy of the repository being around.
  const resolved = devcontainerMetadata(inspection.labels)
  for (const port of existing) {
    const published = inspection.publishedPorts.find(item =>
      item.innerPort === port.innerPort && item.protocol === port.protocol
    )
    await updateDevEnvironmentPort(environmentId, port.innerPort, {
      listening: listening.has(port.innerPort),
      ...(published ? { hostPort: published.hostPort, forwarded: true } : {})
    }, port.protocol)
  }
  for (const innerPort of listening) {
    if (innerPort === 22 || existing.some(port => port.innerPort === innerPort && port.protocol === 'tcp')) continue
    const attributes = detectedPortAttributes(
      innerPort,
      resolved.portsAttributes,
      resolved.otherPortsAttributes
    )
    if (attributes?.onAutoForward === 'ignore') continue
    await upsertDevEnvironmentPort({
      environmentId,
      innerPort,
      protocol: 'tcp',
      appProtocol: attributes?.protocol === 'http' || attributes?.protocol === 'https'
        ? attributes.protocol
        : HTTP_PORTS.has(innerPort) ? 'http' : null,
      label: attributes?.label ?? null,
      source: 'detected',
      listening: true
    })
  }

  const refreshed = await listDevEnvironmentPorts(environmentId)
  for (const port of refreshed) {
    const published = inspection.publishedPorts.some(item =>
      item.innerPort === port.innerPort && item.protocol === port.protocol
    )
    if (port.source === 'declared' && port.protocol === 'tcp' && !published
      && !live.has(key(environmentId, port.innerPort))) {
      await restoreUserlandForward(environment, port)
    } else if (port.source === 'detected' && port.forwarded && port.protocol === 'tcp'
      && !live.has(key(environmentId, port.innerPort))) {
      await restoreUserlandForward(environment, port)
    }
  }
  return listDevEnvironmentPorts(environmentId)
}

export async function forwardEnvironmentPort(environmentId: string, innerPort: number): Promise<DevEnvironmentPort> {
  const environment = await getDevEnvironment(environmentId)
  if (!environment) throw new Error('Development environment not found')
  await refreshEnvironmentPorts(environmentId)
  const port = (await listDevEnvironmentPorts(environmentId)).find(item =>
    item.innerPort === innerPort && item.protocol === 'tcp'
  )
  if (!port) throw new Error(`Port ${innerPort} is not listening in this environment.`)
  if (!port.listening) throw new Error(`Port ${innerPort} is no longer listening in this environment.`)
  if (port.hostPort && (port.source === 'declared' || live.has(key(environmentId, innerPort)))) return port
  return startUserlandForward(environment, port)
}

export async function unforwardEnvironmentPort(environmentId: string, innerPort: number): Promise<void> {
  const port = (await listDevEnvironmentPorts(environmentId)).find(item => item.innerPort === innerPort)
  if (!port || port.source === 'declared') return
  live.get(key(environmentId, innerPort))?.close()
  live.delete(key(environmentId, innerPort))
  await updateDevEnvironmentPort(environmentId, innerPort, { hostPort: null, forwarded: false })
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
