import { spawn, type ChildProcess } from 'node:child_process'

import type { DevEnvironment } from '../../../shared/types'
import { run } from './docker'

/**
 * What the daemon says each environment's own container is doing, and what
 * that makes the environment's row.
 *
 * `status` used to be written only by Domo's own lifecycle calls, so anything
 * that happened to a container outside them — Docker Desktop or the machine
 * restarting, an out-of-memory kill, a `docker rm` — left the row saying
 * `running` for as long as nobody pressed a button. The rows are now kept to
 * what Docker reports: an event stream says something changed, and a listing
 * says what it changed to.
 */

/** Stamped on every environment's own container (`containerRunArgs`). */
export const ENVIRONMENT_ID_LABEL = 'domo.envId'

export const MISSING_CONTAINER_ERROR
  = 'The environment container no longer exists. Delete and recreate the environment.'

export interface EnvironmentContainer {
  id: string
  name: string
  /** Docker's `State`: created, running, paused, restarting, removing, exited, dead. */
  state: string
  environmentId: string
}

/**
 * Every environment container on the daemon, whichever Domo made it.
 *
 * Deliberately not `allowFailure`: an unreachable daemon lists nothing, and
 * reading that as "every container is gone" would break every environment
 * while Docker restarts. It throws, and the caller changes nothing.
 */
export async function listEnvironmentContainers(): Promise<EnvironmentContainer[]> {
  const { stdout } = await run('docker', [
    'ps', '--all', '--no-trunc', '--filter', `label=${ENVIRONMENT_ID_LABEL}`,
    '--format', `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "${ENVIRONMENT_ID_LABEL}"}}`
  ])
  return stdout.split('\n').map(line => line.trim()).filter(Boolean).map((line) => {
    const [id = '', name = '', state = '', environmentId = ''] = line.split('\t')
    return { id, name, state, environmentId }
  })
}

/**
 * The row's own container: by the id it recorded, then by its name. The name
 * is the row's, not one derived from this Domo's prefix, so a row another
 * install created (a copied database) still finds its container.
 */
export function findEnvironmentContainer(
  environment: Pick<DevEnvironment, 'containerId' | 'containerName'>,
  containers: EnvironmentContainer[]
): EnvironmentContainer | null {
  return (environment.containerId && containers.find(container => container.id === environment.containerId))
    || containers.find(container => container.name === environment.containerName)
    || null
}

export type StatusPatch = Pick<DevEnvironment, 'status' | 'lastError'>

/**
 * What a row should say given what its container is doing, or null to leave it.
 *
 * - A row being built or already retired belongs to the code doing that.
 * - `error` is left for a person: it is written when something needs one (a
 *   failed creation, a container that would not start), and a container that
 *   happens to be up does not say that it was dealt with. Starting it clears it.
 * - Only `running` is running. A paused or restarting container cannot run an
 *   agent, so it reads as stopped, which is also what offers Start.
 * - A container that is gone is permanent until somebody recreates the
 *   environment, which is the bar for `error`.
 */
export function nextEnvironmentStatus(
  environment: Pick<DevEnvironment, 'status' | 'retiredAt'>,
  container: EnvironmentContainer | null
): StatusPatch | null {
  if (environment.retiredAt) return null
  if (environment.status !== 'running' && environment.status !== 'stopped') return null
  if (!container) return { status: 'error', lastError: MISSING_CONTAINER_ERROR }
  const status = container.state === 'running' ? 'running' : 'stopped'
  if (status === environment.status) return null
  return { status, lastError: null }
}

export interface ContainerWatcherOptions {
  /** One environment's container changed. */
  onChange: (environmentId: string) => void
  /** Look at every environment: the stream (re)opened, or it is down and this is a poll. */
  onReconcile: () => void
  /** How often to look while the stream is down. */
  pollMs?: number
  /** How soon to try the stream again after it dropped. */
  retryMs?: number
  /** `docker events …`, injectable so a test can drive the stream. */
  spawnEvents?: (args: string[]) => ChildProcess
}

export interface ContainerWatcher {
  stop(): void
  /** Whether the event stream is open right now. */
  readonly streaming: boolean
}

export const EVENTS_ARGS = [
  'events', '--format', '{{json .}}',
  '--filter', 'type=container',
  '--filter', `label=${ENVIRONMENT_ID_LABEL}`,
  ...['start', 'die', 'stop', 'pause', 'unpause', 'destroy'].flatMap(event => ['--filter', `event=${event}`])
]

/**
 * `docker events` for every environment container, for as long as Domo runs.
 *
 * The stream says *that* a container changed, never what to write: each event
 * only asks for that environment to be looked at again, so a missed or
 * reordered event costs nothing. What the stream cannot say — anything that
 * happened while it was not open — is what the full look on every (re)open is
 * for. While it cannot be opened at all (the daemon is down or restarting),
 * every environment is looked at on a timer instead, and a look that cannot
 * reach Docker changes nothing.
 *
 * The CLI rather than the Engine API, so it reaches the same daemon as every
 * other `docker` call Domo makes, whatever context or `DOCKER_HOST` says.
 */
export function watchEnvironmentContainers(options: ContainerWatcherOptions): ContainerWatcher {
  const pollMs = options.pollMs ?? 15_000
  const retryMs = options.retryMs ?? 5_000
  const spawnEvents = options.spawnEvents ?? (args => spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] }))
  let stopped = false
  let streaming = false
  let child: ChildProcess | null = null
  let retry: NodeJS.Timeout | null = null
  let poll: NodeJS.Timeout | null = null

  const startPolling = () => {
    if (poll || stopped) return
    poll = setInterval(() => options.onReconcile(), pollMs)
    poll.unref?.()
  }
  const stopPolling = () => {
    if (poll) clearInterval(poll)
    poll = null
  }

  const open = () => {
    if (stopped) return
    const events = spawnEvents(EVENTS_ARGS)
    child = events
    let buffer = ''
    let opened = false
    events.stdout?.setEncoding('utf8')
    events.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        try {
          const event = JSON.parse(line)
          const environmentId = event?.Actor?.Attributes?.[ENVIRONMENT_ID_LABEL]
          if (typeof environmentId === 'string' && environmentId) options.onChange(environmentId)
        } catch { /* not an event; the next line is */ }
      }
    })
    // `docker events` prints nothing until something happens, so "open" is
    // "did not fail at once": a daemon that is not there fails in well under
    // a second. The look that follows covers whatever came before.
    const settle = setTimeout(() => {
      if (stopped || child !== events) return
      opened = true
      streaming = true
      stopPolling()
      options.onReconcile()
    }, Math.min(1_000, retryMs))
    settle.unref?.()
    const dropped = () => {
      clearTimeout(settle)
      if (child !== events) return
      child = null
      streaming = false
      if (stopped) return
      // A drop after a working stream: look now, then keep looking until it is back.
      if (opened) options.onReconcile()
      startPolling()
      retry = setTimeout(() => {
        retry = null
        open()
      }, retryMs)
      retry.unref?.()
    }
    events.once('error', dropped)
    events.once('exit', dropped)
  }

  // Polling until the stream is up; the caller does the first look itself.
  startPolling()
  open()

  return {
    get streaming() {
      return streaming
    },
    stop() {
      stopped = true
      streaming = false
      stopPolling()
      if (retry) clearTimeout(retry)
      const current = child
      child = null
      current?.kill()
    }
  }
}
