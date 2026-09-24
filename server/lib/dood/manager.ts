import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { run } from '../dev-env/docker'
import { dataDir } from '../paths'
import { startDoodProxy, type DoodProxy } from './proxy'
import type { PublishedPort } from './rewrite'

/**
 * The running proxies, one per dev environment, and the Docker work they need.
 *
 * `proxy.ts` is deliberately pure of Docker: it is handed `ensureSubpaths` and
 * `joinNetworks` and knows nothing about how they happen. This is where those
 * are, along with the socket's path and the registry that survives a Nitro
 * reload.
 *
 * The socket path is derived from the environment id rather than stored,
 * because it has to be the *same* path after a restart: mounts are fixed when a
 * container is created, so an environment created today must find its proxy at
 * that path for as long as it exists. Measured on Docker Desktop: a running
 * container reaches a socket re-created at the same host path, so re-listening
 * after a restart is all a restart needs.
 */

/** Stamped on every container an environment creates, so retirement can sweep it. */
export const ENVIRONMENT_LABEL = 'domo.env'

export const doodLabels = (environmentId: string): Record<string, string> =>
  ({ [ENVIRONMENT_LABEL]: environmentId })

/**
 * A unix socket path has to fit in `sun_path`: 104 bytes on macOS, 108 on
 * Linux, and `listen` fails outright past it. Under the data directory it did
 * not — a worktree's `.data/dood/env_<id>.sock` measured 117 — so the sockets
 * live under the home directory, in a folder named for the data directory so
 * two installs (two worktrees) never share one. Not under `/tmp`: macOS
 * periodically deletes what nobody has touched there, and an idle
 * environment's socket is exactly that.
 */
const SUN_PATH_MAX = 103

export function doodSocketDir(): string {
  const configured = process.env.NUXT_DOOD_SOCKET_DIR
  if (configured) return configured
  const install = createHash('sha256').update(dataDir()).digest('hex').slice(0, 8)
  return join(homedir(), '.domo', 'dood', install)
}

export function doodSocketPath(environmentId: string): string {
  const path = join(doodSocketDir(), `${environmentId}.sock`)
  if (Buffer.byteLength(path) > SUN_PATH_MAX) {
    throw new Error(
      `The Docker socket path for ${environmentId} is too long for a unix socket (${path}). `
      + 'Set NUXT_DOOD_SOCKET_DIR to a shorter directory.'
    )
  }
  return path
}

const live = new Map<string, DoodProxy>()

export interface DoodProxyInput {
  environmentId: string
  /** The environment's own container, which is what joins a new network. */
  containerReference: string
  /** Where the checkout appears inside the environment. */
  workspacePath: string
  workspaceVolume: string
  /** A small image guaranteed to be present; the caller owns the pin. */
  helperImage: string
  onDroppedPorts?(ports: PublishedPort[]): void
}

/**
 * A subpath is derived from a prefix match on a path the caller controls, so
 * `..` can appear in one. Refuse it here rather than handing it to `mkdir -p`:
 * this is the boundary where it stops being a string and starts being a path.
 */
function safeSubpath(subpath: string): boolean {
  return subpath.length > 0
    && !subpath.startsWith('/')
    && !subpath.split('/').includes('..')
}

export async function ensureDoodProxy(input: DoodProxyInput): Promise<DoodProxy> {
  const existing = live.get(input.environmentId)
  if (existing) return existing

  const proxy = await startDoodProxy({
    socketPath: doodSocketPath(input.environmentId),
    scope: {
      workspacePath: input.workspacePath,
      workspaceVolume: input.workspaceVolume,
      labels: doodLabels(input.environmentId)
    },
    ensureSubpaths: async (subpaths) => {
      const wanted = subpaths.filter(safeSubpath)
      if (!wanted.length) return
      // One helper run for the lot: a create waits on this.
      await run('docker', [
        'run', '--rm', '-v', `${input.workspaceVolume}:/workspace`, input.helperImage,
        'mkdir', '-p', ...wanted.map(subpath => `/workspace/${subpath}`)
      ])
    },
    joinNetworks: async (networks) => {
      for (const network of networks) {
        // Already-connected is the ordinary case once a stack has more than
        // one service, and it is not worth distinguishing from a real failure
        // the agent can see for itself.
        await run('docker', ['network', 'connect', network, input.containerReference], {
          allowFailure: true
        })
      }
    },
    leaveNetwork: async (network, { onlyIfAlone }) => {
      if (onlyIfAlone) {
        const inspected = await run('docker', [
          'network', 'inspect', '--format', '{{json .Containers}}', network
        ], { allowFailure: true })
        let endpoints: Array<[string, { Name?: string }]>
        try {
          endpoints = Object.entries(JSON.parse(inspected.stdout || '{}') ?? {})
        } catch { return }
        const ours = ([id, endpoint]: [string, { Name?: string }]) =>
          id.startsWith(input.containerReference) || endpoint.Name === input.containerReference
        if (!endpoints.length || !endpoints.every(ours)) return
      }
      // Not joined is the ordinary case (a network the environment never
      // needed), and the request that follows reports anything real.
      await run('docker', ['network', 'disconnect', '--force', network, input.containerReference], {
        allowFailure: true
      })
    },
    onDroppedPorts: input.onDroppedPorts,
    onError: error => console.warn(`[dood] ${input.environmentId}:`, error instanceof Error ? error.message : error)
  })

  live.set(input.environmentId, proxy)
  return proxy
}

export async function stopDoodProxy(environmentId: string): Promise<void> {
  const proxy = live.get(environmentId)
  if (!proxy) return
  live.delete(environmentId)
  await proxy.close()
}

export async function stopAllDoodProxies(): Promise<void> {
  await Promise.all([...live.keys()].map(stopDoodProxy))
}

const labelFilter = (environmentId: string) => `label=${ENVIRONMENT_LABEL}=${environmentId}`

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

/**
 * Stop what the environment started, for `stopEnvironment`. On a daemon of its
 * own the containers stopped with it; on the shared one they would go on
 * running — and holding memory and ports — with nobody looking at them.
 * Nothing restarts them: an agent brings its stack back up the way it did the
 * first time.
 */
export async function stopEnvironmentContainers(environmentId: string): Promise<void> {
  const found = await run('docker', ['ps', '-q', '--filter', labelFilter(environmentId)], { allowFailure: true })
  const ids = lines(found.stdout)
  if (ids.length) await run('docker', ['stop', ...ids], { allowFailure: true })
}

/**
 * Everything the environment created on the host daemon: containers, then the
 * networks and volumes compose made for them (labelled by the proxy on the way
 * through). This is the whole point of the label: with a daemon of its own,
 * retiring an environment threw all of it away with the DinD volume; on a
 * shared daemon it would outlive the environment, so it is removed by label —
 * exactly what this environment made and nothing of anyone else's. Images and
 * build cache are left on purpose: sharing them is why the daemon is shared.
 *
 * The environment's own container must be gone first, or a network it joined
 * still has an endpoint and refuses to go.
 */
export async function sweepEnvironmentResources(environmentId: string): Promise<void> {
  const filter = labelFilter(environmentId)
  const containers = await run('docker', ['ps', '-aq', '--filter', filter], { allowFailure: true })
  if (lines(containers.stdout).length) {
    await run('docker', ['rm', '--force', '--volumes', ...lines(containers.stdout)], { allowFailure: true })
  }
  const networks = await run('docker', ['network', 'ls', '-q', '--filter', filter], { allowFailure: true })
  for (const network of lines(networks.stdout)) {
    await run('docker', ['network', 'rm', network], { allowFailure: true })
  }
  const volumes = await run('docker', ['volume', 'ls', '-q', '--filter', filter], { allowFailure: true })
  if (lines(volumes.stdout).length) {
    await run('docker', ['volume', 'rm', '--force', ...lines(volumes.stdout)], { allowFailure: true })
  }
}
