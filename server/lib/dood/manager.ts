import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { run } from '../dev-env/docker'
import { dataDir } from '../paths'
import { createEngineClient } from './engine'
import { namespaceFor } from './names'
import { EnvironmentNetwork, watchContainerEvents, type EventWatcher } from './network'
import { startDoodProxy, type DoodProxy } from './proxy'
import type { Binding, Proto } from './publish'
import { publishLayer } from './publish-layer'
import type { PublishedPort } from './rewrite'
import { errorRewriter, scopeLayer } from './scope-layer'

/**
 * The running proxies, one per dev environment, and the Docker work they need.
 *
 * `proxy.ts` is only transport and the layers above it take their Docker
 * access as parameters. This is where those are made — the Engine API client
 * on the daemon's socket, the helper run that creates workspace subpaths —
 * along with the socket's path and the registry that survives a Nitro reload.
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
 *
 * The limit that bites first is tighter than that, and silent: Docker Desktop
 * forwards a bind-mounted host socket into its VM only when the host path is
 * at most **88** bytes. Measured on 29.8: 88 connects, 89 is `ECONNREFUSED`
 * inside the container, and nothing anywhere says why. Both the environment
 * and every service given `/var/run/docker.sock` (`binds.ts`) mount this path,
 * so it is held to that. `~/.domo/dood/<8 hex>/env_<20 hex>.sock` is 50 bytes
 * plus the home directory's own length.
 */
const SUN_PATH_MAX = 88

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
      `The Docker socket path for ${environmentId} is too long for a unix socket a container can mount (${path}). `
      + 'Set NUXT_DOOD_SOCKET_DIR to a shorter directory.'
    )
  }
  return path
}

const live = new Map<string, DoodProxy>()
const networks = new Map<string, EnvironmentNetwork>()
let watcher: EventWatcher | null = null

/** The host daemon. The proxy and its Engine API client both talk to it directly. */
const DAEMON_SOCKET = '/var/run/docker.sock'

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

  const ns = namespaceFor(input.environmentId)
  const report = (error: unknown) =>
    console.warn(`[dood] ${input.environmentId}:`, error instanceof Error ? error.message : error)
  const engine = createEngineClient(DAEMON_SOCKET)
  const network = new EnvironmentNetwork({
    environmentId: input.environmentId,
    ownContainer: input.containerReference,
    engine,
    labelFilter: labelFilter(input.environmentId),
    onError: report
  })
  const proxy = await startDoodProxy({
    socketPath: doodSocketPath(input.environmentId),
    layers: [
      scopeLayer({
        ns,
        scope: {
          workspacePath: input.workspacePath,
          workspaceVolume: input.workspaceVolume,
          labels: doodLabels(input.environmentId),
          dockerSocket: doodSocketPath(input.environmentId)
        },
        engine,
        ownContainer: input.containerReference,
        ensureSubpaths: async (volume, subpaths) => {
          const wanted = subpaths.filter(safeSubpath)
          if (!wanted.length) return
          // One helper run per volume: a create waits on this.
          await run('docker', [
            'run', '--rm', '-v', `${volume}:/volume`, input.helperImage,
            'mkdir', '-p', ...wanted.map(subpath => `/volume/${subpath}`)
          ])
        },
        onDroppedPorts: input.onDroppedPorts,
        published: containerId => network.bindings(containerId),
        onError: report
      }),
      // Inside the scope layer: it sees real ids, and the publishing label.
      publishLayer({ ns, network })
    ],
    rewriteError: errorRewriter(ns),
    dockerSocket: DAEMON_SOCKET,
    onError: report,
    // Every request line and what became of it, for working out what a client
    // really sends — which is rarely what its documentation suggests.
    ...(process.env.NUXT_DOOD_DEBUG && {
      onRequest: ({ line, kind }) => console.info(`[dood] ${input.environmentId} ${kind}: ${line}`)
    })
  })

  networks.set(input.environmentId, network)
  watcher ??= watchContainerEvents(DAEMON_SOCKET, () => networks.entries(), ENVIRONMENT_LABEL)
  // A running environment gets its redirect and its relay back now; one that
  // is stopped gets them from the event its start raises.
  network.schedule(0)
  live.set(input.environmentId, proxy)
  return proxy
}

export async function stopDoodProxy(environmentId: string): Promise<void> {
  const proxy = live.get(environmentId)
  const network = networks.get(environmentId)
  live.delete(environmentId)
  networks.delete(environmentId)
  if (!networks.size) {
    watcher?.stop()
    watcher = null
  }
  await network?.close()
  await proxy?.close()
}

export async function stopAllDoodProxies(): Promise<void> {
  await Promise.all([...new Set([...live.keys(), ...networks.keys()])].map(stopDoodProxy))
}

/**
 * Re-establish what lives in the environment's network namespace — its
 * published ports and its `host.docker.internal` redirect — for the namespace
 * it has now. Called when Domo starts or creates an environment; the events
 * stream would get there too, a moment later.
 */
export async function ensureEnvironmentNetwork(environmentId: string): Promise<void> {
  await networks.get(environmentId)?.reconcile()
}

/** The host ports the environment's relay holds, which are its containers' and not its own. */
export function publishedHostPorts(environmentId: string, proto: Proto = 'tcp'): Set<number> {
  return networks.get(environmentId)?.hostPorts(proto) ?? new Set()
}

/** What one of the environment's containers has published on its `localhost` right now. */
export function publishedBindings(environmentId: string, containerId: string): Binding[] {
  return networks.get(environmentId)?.bindings(containerId) ?? []
}

const labelFilter = (environmentId: string) => `${ENVIRONMENT_LABEL}=${environmentId}`

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

/**
 * Stop what the environment started, for `stopEnvironment`. On a daemon of its
 * own the containers stopped with it; on the shared one they would go on
 * running — and holding memory and ports — with nobody looking at them.
 * Nothing restarts them: an agent brings its stack back up the way it did the
 * first time.
 */
export async function stopEnvironmentContainers(environmentId: string): Promise<void> {
  const found = await run('docker', ['ps', '-q', '--filter', `label=${labelFilter(environmentId)}`], { allowFailure: true })
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
  const filter = `label=${labelFilter(environmentId)}`
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
