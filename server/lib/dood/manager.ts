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
 * that path for as long as it exists.
 */

/** Stamped on every container an environment creates, so retirement can sweep it. */
export const ENVIRONMENT_LABEL = 'domo.env'

export const doodLabels = (environmentId: string): Record<string, string> =>
  ({ [ENVIRONMENT_LABEL]: environmentId })

export function doodSocketPath(environmentId: string): string {
  return join(dataDir(), 'dood', `${environmentId}.sock`)
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

/**
 * Everything the environment created on the host daemon. This is the whole
 * point of the label: with a daemon of its own, retiring an environment threw
 * the containers away with the DinD volume; on a shared daemon they would
 * outlive it, so they are swept explicitly.
 */
export async function sweepEnvironmentContainers(environmentId: string): Promise<void> {
  const found = await run('docker', [
    'ps', '-aq', '--filter', `label=${ENVIRONMENT_LABEL}=${environmentId}`
  ], { allowFailure: true })
  if (found.stdout) {
    await run('docker', ['rm', '-f', ...found.stdout.split('\n')], { allowFailure: true })
  }
  // Compose networks carry no label of ours, but they are named for the
  // project and removing a network with no endpoints left is safe.
  await run('docker', ['network', 'prune', '-f'], { allowFailure: true })
}
