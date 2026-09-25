import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { createInterface } from 'node:readline'

import { run } from '../dev-env/docker'
import { ensurePortHelper } from '../dev-env/port-helper'
import { engineOk, type EngineClient } from './engine'
import {
  bindingsFor,
  environmentAddress,
  extraHostAddress,
  listenerSpecs,
  managedHostNames,
  primaryNetwork,
  REQUESTED_HOSTS_LABEL,
  rewriteHostsFile,
  targetAddress,
  type Binding,
  type BoundListener,
  type FailedListener,
  type ListenerSpec,
  type Proto
} from './publish'
import { RELAY_SCRIPT } from './relay-script'
import { REQUESTED_PUBLISHING_LABEL, type RequestedPublishing } from './rewrite'

/**
 * An environment's own network, as far as the containers it starts on the
 * shared daemon are concerned: their published ports answering on the
 * environment's `localhost`, and `host.docker.internal` inside them reaching
 * the environment. The decisions are in `publish.ts`; this is the Docker work.
 *
 * Both live in the environment's network namespace, entered through the port
 * helper by the environment container's PID — so both die with that namespace
 * when the environment restarts, and both are re-established whenever the PID
 * is seen to have changed:
 *
 * - **The relay**, one process per environment (`relay-script.ts`), holding
 *   every published port of every running container. It is driven with the
 *   whole desired state, recomputed from the daemon on every reconcile, so
 *   there is no incremental bookkeeping to drift. A reconcile runs before a
 *   `start` is forwarded (a taken port refuses the start, as a real host
 *   does, and the container is never started), after `start`, `stop`,
 *   `kill` and `rm` are answered, and on every container `start` / `die` /
 *   `destroy` the daemon reports (`watchContainerEvents`) — which is what
 *   covers a restart policy bringing a crashed service back, `docker compose
 *   restart`, and anything started from outside Domo. The target of each
 *   listener is re-read on every reconcile rather than kept, because a
 *   restarted container may come back on a different address.
 * - **The redirect**: `route_localnet` and one iptables rule sending traffic
 *   that arrives for any of the environment's own addresses to `127.0.0.1`,
 *   so a service calling `host.docker.internal:5173` reaches a dev server the
 *   agent bound to loopback — which is what Docker Desktop does for the Mac.
 *
 * And two things that follow the environment when *it* restarts:
 *
 * - **Services in its namespace** (`network_mode: host`, which the proxy makes
 *   `container:<environment>`, or the agent's own `--network
 *   container:$(hostname)`) keep running in the old one, which has only a
 *   loopback left — measured. Each one still running that started before the
 *   environment did is stopped and started again, which joins the new one. Compared by start
 *   time rather than by noticing the restart, so a restart that happened
 *   while Domo was down is caught on boot as well.
 * - **`host.docker.internal`** in a service is an address in its `/etc/hosts`,
 *   fixed at create. Docker gives a restarted container its old address back
 *   when it is free, but not when something took it meanwhile (measured: the
 *   environment came back on `.4`, and `.2` was another container's). Docker
 *   rewrites the file from `ExtraHosts` on every start and the API cannot
 *   change `ExtraHosts`, so a service whose entry no longer names the
 *   environment has its `/etc/hosts` rewritten in place, through the helper
 *   (`/proc/<pid>/root/etc/hosts`, measured to work on a running container).
 */

const RELAY_ANSWER_MS = 15_000
const RELAY_RETRY_MS = 1_000
const SCHEDULE_MS = 50

/**
 * Applied in the environment's namespace. Idempotent: the chain is flushed and
 * refilled, and the jump into it added only once. `! -d 127.0.0.0/8` keeps
 * loopback traffic out of it; `--dst-type LOCAL` is every address the
 * environment has on every network it joins, including ones it joins later.
 */
const REDIRECT_SCRIPT = [
  'set -e',
  'echo 1 > /proc/sys/net/ipv4/conf/all/route_localnet',
  'iptables -w -t nat -N DOMO_HOST 2>/dev/null || iptables -w -t nat -F DOMO_HOST',
  'for proto in tcp udp; do',
  '  iptables -w -t nat -A DOMO_HOST -p "$proto" -m addrtype --dst-type LOCAL ! -d 127.0.0.0/8 -j DNAT --to-destination 127.0.0.1',
  'done',
  'iptables -w -t nat -C PREROUTING -j DOMO_HOST 2>/dev/null || iptables -w -t nat -I PREROUTING -j DOMO_HOST'
].join('\n')

/**
 * A relay left by a Domo that died without its stdin closing (it should not
 * happen, but a port held by nobody is the worst way for it to). The marker is
 * the relay's last argument; the pattern is assembled from `$1` so this
 * script's own command line never matches it.
 */
const KILL_STALE_SCRIPT = [
  'for dir in /proc/[0-9]*; do',
  '  pid="${dir#/proc/}"',
  '  [ "$pid" = "$$" ] && continue',
  '  if tr "\\000" " " < "$dir/cmdline" 2>/dev/null | grep -q -- "domo-relay=$1\\( \\|$\\)"; then kill "$pid" 2>/dev/null || true; fi',
  'done'
].join('\n')

interface RelayAnswer {
  bound: BoundListener[]
  failed: FailedListener[]
}

interface RelayListener extends Omit<ListenerSpec, 'containerId' | 'containerPort'> {
  target: { host: string, port: number } | null
}

class Relay {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly waiting = new Map<number, { resolve(answer: RelayAnswer): void, reject(error: Error): void, timer: NodeJS.Timeout }>()
  private seq = 0
  private stderr = ''
  exited = false
  readonly ready: Promise<void>

  constructor(args: string[], onExit: (relay: Relay) => void) {
    this.child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-2000) })
    let markReady!: () => void
    let failReady!: (error: Error) => void
    this.ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject })
    const readyTimer = setTimeout(() => failReady(new Error('the relay did not start in time')), RELAY_ANSWER_MS)
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.ready) {
        clearTimeout(readyTimer)
        markReady()
        return
      }
      const waiter = this.waiting.get(message.seq)
      if (!waiter) return
      this.waiting.delete(message.seq)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve({ bound: message.bound ?? [], failed: message.failed ?? [] })
    })
    const exit = (error?: Error) => {
      if (this.exited) return
      this.exited = true
      clearTimeout(readyTimer)
      const reason = error ?? new Error(`the relay exited${this.stderr ? `: ${this.stderr.trim()}` : ''}`)
      failReady(reason)
      for (const waiter of this.waiting.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(reason)
      }
      this.waiting.clear()
      onExit(this)
    }
    this.child.on('error', exit)
    this.child.on('close', () => exit())
    this.child.stdin.on('error', () => {})
  }

  send(listeners: RelayListener[]): Promise<RelayAnswer> {
    if (this.exited) return Promise.reject(new Error('the relay is not running'))
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(seq)
        reject(new Error('the relay did not answer in time'))
      }, RELAY_ANSWER_MS)
      this.waiting.set(seq, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ seq, listeners })}\n`)
    })
  }

  /** Ending stdin is what stops it: the relay exits on EOF, wherever it runs. */
  stop(): void {
    this.child.stdin.end()
    setTimeout(() => { if (!this.exited) this.child.kill() }, 2_000).unref()
  }
}

export interface EnvironmentNetworkOptions {
  environmentId: string
  /** The environment's own container, by name or id. */
  ownContainer: string
  engine: EngineClient
  /** `domo.env=<id>`: what the environment's containers are labelled with. */
  labelFilter: string
  onError?(error: unknown): void
}

export interface StartCheck {
  /** The container's full id: what `finishStart` is to be called with. */
  id: string
  /** The container as the daemon names it, for the error. */
  name: string
  /** Null when every port was held and the start may go ahead. */
  failure: FailedListener | null
}

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)

function parsePublishing(labels: unknown): RequestedPublishing | null {
  if (!isObject(labels) || typeof labels[REQUESTED_PUBLISHING_LABEL] !== 'string') return null
  try {
    return JSON.parse(labels[REQUESTED_PUBLISHING_LABEL])
  } catch {
    return null
  }
}

const ACTIVE_STATES = new Set(['running', 'restarting', 'paused'])

interface EnvironmentState {
  id: string
  pid: number
  networkIds: Set<string>
  /** `NetworkSettings.Networks`, by network name. */
  networks: Record<string, { IPAddress?: string, NetworkID?: string }>
  startedAt: string
  /** A namespace this network has not set anything up in before: a restart, or the first look since Domo started. */
  fresh: boolean
}

export class EnvironmentNetwork {
  private relay: Relay | null = null
  /** The environment PID the relay and the redirect were set up for. */
  private pid: number | null = null
  /** Containers whose `start` is in flight: their ports are held before the daemon has them running. */
  private readonly starting = new Set<string>()
  private bound = new Map<string, Binding[]>()
  private queue: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private closed = false
  /** The environment container's full id, once seen — how its own events are recognised. */
  ownId: string | null = null
  /** Per container, the PID and address its `/etc/hosts` was last pointed at, so it is rewritten once per start. */
  private readonly hostsPointed = new Map<string, string>()

  constructor(private readonly options: EnvironmentNetworkOptions) {}

  private report(error: unknown) {
    this.options.onError?.(error)
  }

  /** What a container really has published, for inspect and `docker ps`. Undefined when it has nothing held. */
  bindings(containerId: string): Binding[] | undefined {
    return this.bound.get(containerId)
  }

  /** Every host port the relay holds, so the Ports panel does not list them as the environment's own. */
  hostPorts(proto: Proto = 'tcp'): Set<number> {
    const ports = new Set<number>()
    for (const bindings of this.bound.values()) {
      for (const binding of bindings) if (binding.proto === proto) ports.add(binding.hostPort)
    }
    return ports
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  /** Coalesce a burst (compose starts a whole stack) into one reconcile. */
  schedule(delay = SCHEDULE_MS): void {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.reconcile().catch(error => this.report(error))
    }, delay)
    this.timer.unref?.()
  }

  reconcile(): Promise<Map<string, FailedListener[]>> {
    return this.enqueue(() => this.sync())
  }

  /** The redirect only, for a create: cheap, and a service may call back before anything is published. */
  ensureRedirect(): Promise<void> {
    return this.enqueue(async () => { await this.environment() })
  }

  /**
   * Hold a container's ports before its `start` is forwarded. Null when it
   * publishes nothing. A `failure` is the listener that could not be bound,
   * with every port the container did get released again, so a refused start
   * leaves nothing behind.
   */
  prepareStart(containerRef: string): Promise<StartCheck | null> {
    return this.enqueue(async () => {
      const inspected = await this.options.engine.request('GET', `/containers/${encodeURIComponent(containerRef)}/json`)
      if (inspected.status !== 200 || !parsePublishing(inspected.body?.Config?.Labels)) return null
      const id = String(inspected.body.Id)
      const name = String(inspected.body.Name ?? '').replace(/^\//, '')
      this.starting.add(id)
      let failures: Map<string, FailedListener[]>
      try {
        failures = await this.sync()
      } catch (error) {
        this.starting.delete(id)
        await this.sync().catch(() => {})
        throw error
      }
      const failure = failures.get(id)?.[0] ?? null
      if (failure) {
        this.starting.delete(id)
        await this.sync().catch(error => this.report(error))
      }
      return { id, name, failure }
    })
  }

  /** After the daemon answered the `start`, however it went. */
  finishStart(containerId: string): Promise<void> {
    return this.enqueue(async () => {
      this.starting.delete(containerId)
      await this.sync()
    }).then(() => {}, error => this.report(error))
  }

  /** The environment's address on a network, for a new container's `host.docker.internal`. */
  async addressOn(network: string): Promise<string | null> {
    const own = await this.options.engine.request('GET', `/containers/${encodeURIComponent(this.options.ownContainer)}/json`)
    if (own.status !== 200) return null
    return environmentAddress(own.body?.NetworkSettings?.Networks, network)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.queue
    this.stopRelay()
    this.bound.clear()
  }

  private stopRelay() {
    const relay = this.relay
    this.relay = null
    relay?.stop()
  }

  /**
   * The environment container as it is now; the redirect re-applied and the
   * relay dropped when its namespace is a new one. Null when it is not running,
   * in which case there is nothing to hold anything in.
   */
  private async environment(): Promise<EnvironmentState | null> {
    const own = await this.options.engine.request('GET', `/containers/${encodeURIComponent(this.options.ownContainer)}/json`)
    const running = own.status === 200 && own.body?.State?.Running && Number(own.body.State.Pid) > 0
    if (!running) {
      this.stopRelay()
      this.pid = null
      this.bound.clear()
      return null
    }
    this.ownId = String(own.body.Id)
    const pid = Number(own.body.State.Pid)
    const fresh = pid !== this.pid
    if (fresh) {
      // The old relay listens in a namespace nothing uses any more.
      this.stopRelay()
      this.bound.clear()
      await this.redirect(pid).catch(error => this.report(new Error(
        `could not point host.docker.internal at the environment: ${error instanceof Error ? error.message : error}`
      )))
      this.pid = pid
    }
    const networks = own.body.NetworkSettings?.Networks ?? {}
    const networkIds = new Set<string>(Object.values(networks)
      .map((endpoint: any) => String(endpoint?.NetworkID ?? '')).filter(Boolean))
    return { pid, networkIds, networks, startedAt: String(own.body.State.StartedAt ?? ''), fresh, id: this.ownId }
  }

  /**
   * Restart what shares the environment's namespace but still runs in the one
   * it had before (see the top of this file). Not awaited by the reconcile: a
   * restart waits out the service's stop timeout, and its `start` event brings
   * the next reconcile anyway.
   */
  private restartStranded(list: any[], environment: EnvironmentState) {
    const mode = `container:${environment.id}`
    for (const entry of list) {
      if (entry?.HostConfig?.NetworkMode !== mode || entry?.State !== 'running') continue
      const id = String(entry.Id)
      this.options.engine.request('GET', `/containers/${id}/json`).then(async (inspected) => {
        const startedAt = String(inspected.body?.State?.StartedAt ?? '')
        if (inspected.status !== 200 || !inspected.body?.State?.Running) return
        if (!startedAt || !environment.startedAt || Date.parse(startedAt) >= Date.parse(environment.startedAt)) return
        // A stop and a start, not a restart: Docker Desktop cannot restart a
        // container that mounts a host socket (see `restartAsStop` in
        // `scope-layer.ts`), and a service given the Docker socket does.
        for (const step of ['stop', 'start']) {
          const answered = await this.options.engine.request('POST', `/containers/${id}/${step}`)
          if (answered.status >= 400) throw new Error(answered.body?.message ?? `${step}: status ${answered.status}`)
        }
      }).catch(error => this.report(new Error(
        `could not move ${id.slice(0, 12)} into the environment's new network namespace: ${error instanceof Error ? error.message : error}`
      )))
    }
  }

  /** Point `host.docker.internal` back at the environment in every running service where it no longer does. */
  private async repointHosts(list: any[], environment: EnvironmentState) {
    const running = new Set<string>()
    for (const entry of list) {
      const requested = entry?.Labels?.[REQUESTED_HOSTS_LABEL]
      if (entry?.State !== 'running' || typeof requested !== 'string') continue
      const id = String(entry.Id)
      running.add(id)
      let names: string[]
      try {
        names = managedHostNames(JSON.parse(requested))
      } catch {
        continue
      }
      if (!names.length) continue
      const inspected = await this.options.engine.request('GET', `/containers/${id}/json`)
      const body = inspected.body
      if (inspected.status !== 200 || !body?.State?.Running) continue
      const network = primaryNetwork(body.HostConfig ?? {}, body.NetworkSettings?.Networks)
      const address = network ? environmentAddress(environment.networks, network) : null
      if (!address) continue
      const pid = Number(body.State.Pid)
      // What Docker wrote at this start is right: nothing to do.
      if (extraHostAddress(body.HostConfig?.ExtraHosts, names[0]!) === address) {
        this.hostsPointed.delete(id)
        continue
      }
      const key = `${pid}:${address}`
      if (this.hostsPointed.get(id) === key) continue
      try {
        const helper = await ensurePortHelper()
        const file = `/proc/${pid}/root/etc/hosts`
        const current = await run('docker', ['exec', helper, 'cat', file], { trimOutput: false })
        // Written in place, not renamed over: the file is a bind mount.
        await run('docker', ['exec', '--interactive', helper, 'sh', '-c', 'cat > "$1"', 'sh', file], {
          input: rewriteHostsFile(current.stdout, names, address)
        })
        this.hostsPointed.set(id, key)
      } catch (error) {
        this.report(new Error(`could not point host.docker.internal in ${id.slice(0, 12)} at the environment: ${error instanceof Error ? error.message : error}`))
      }
    }
    for (const id of this.hostsPointed.keys()) if (!running.has(id)) this.hostsPointed.delete(id)
  }

  private async redirect(pid: number) {
    const helper = await ensurePortHelper()
    await run('docker', ['exec', helper, 'nsenter', '-t', String(pid), '-n', 'sh', '-c', REDIRECT_SCRIPT])
  }

  private async ensureRelay(pid: number): Promise<Relay> {
    if (this.relay && !this.relay.exited) return this.relay
    const helper = await ensurePortHelper()
    const marker = this.options.environmentId
    await run('docker', ['exec', helper, 'sh', '-c', KILL_STALE_SCRIPT, 'sh', marker], { allowFailure: true })
    const relay = new Relay([
      'exec', '--interactive', helper, 'nsenter', '-t', String(pid), '-n',
      'node', '-e', RELAY_SCRIPT, `domo-relay=${marker}`
    ], (gone) => {
      if (this.relay !== gone) return
      // Not asked to stop: the helper was replaced, or the relay crashed.
      this.relay = null
      this.bound.clear()
      if (!this.closed) this.schedule(RELAY_RETRY_MS)
    })
    this.relay = relay
    await relay.ready
    return relay
  }

  private async sync(): Promise<Map<string, FailedListener[]>> {
    const failures = new Map<string, FailedListener[]>()
    if (this.closed) return failures
    const environment = await this.environment()
    if (!environment) return failures

    const filters = encodeURIComponent(JSON.stringify({ label: [this.options.labelFilter] }))
    const list = await engineOk(this.options.engine, 'GET', `/containers/json?all=1&filters=${filters}`) as any[]
    if (environment.fresh) this.restartStranded(list, environment)
    await this.repointHosts(list, environment)
    const specs: ListenerSpec[] = []
    const targets = new Map<string, string | null>()
    const byContainer = new Map<string, ListenerSpec[]>()
    for (const entry of list) {
      const id = String(entry.Id)
      const requested = parsePublishing(entry.Labels)
      if (!requested) continue
      if (!ACTIVE_STATES.has(String(entry.State)) && !this.starting.has(id)) continue
      const inspected = await this.options.engine.request('GET', `/containers/${id}/json`)
      if (inspected.status !== 200) continue
      const body = inspected.body
      const exposed = Object.keys(body?.Config?.ExposedPorts ?? {})
      const containerSpecs = listenerSpecs(id, requested, exposed)
      byContainer.set(id, containerSpecs)
      specs.push(...containerSpecs)
      targets.set(id, body?.State?.Running && !body?.State?.Restarting
        ? targetAddress(body?.NetworkSettings?.Networks, environment.networkIds)
        : null)
    }

    if (!specs.length && !this.relay) {
      this.bound.clear()
      return failures
    }
    const relay = await this.ensureRelay(environment.pid)
    const answer = await relay.send(specs.map((spec) => {
      const host = targets.get(spec.containerId)
      return {
        key: spec.key,
        proto: spec.proto,
        host: spec.host,
        range: spec.range,
        target: host ? { host, port: spec.containerPort } : null
      }
    }))
    const bound = new Map<string, Binding[]>()
    for (const [id, containerSpecs] of byContainer) {
      const bindings = bindingsFor(containerSpecs, answer.bound)
      if (bindings.length) bound.set(id, bindings)
    }
    this.bound = bound
    const owner = new Map(specs.map(spec => [spec.key, spec.containerId]))
    for (const failure of answer.failed) {
      const id = owner.get(failure.key)
      if (!id) continue
      failures.set(id, [...(failures.get(id) ?? []), failure])
      if (!this.starting.has(id)) {
        this.report(new Error(`a published port of ${id.slice(0, 12)} could not be held: ${failure.reason} ${failure.host || '*'}:${failure.port}`))
      }
    }
    return failures
  }
}

/**
 * One `GET /events` stream for every environment on this Domo, telling each
 * network when one of its containers — or its own environment container —
 * started, died or went away. A dropped stream is reopened, and every network
 * reconciled then, since whatever happened meanwhile went unreported.
 */
export interface EventWatcher {
  stop(): void
}

export function watchContainerEvents(
  socketPath: string,
  networks: () => Iterable<[string, EnvironmentNetwork]>,
  environmentLabel: string
): EventWatcher {
  let stopped = false
  let current: ClientRequest | null = null
  let retry: NodeJS.Timeout | null = null
  const filters = encodeURIComponent(JSON.stringify({ type: ['container'], event: ['start', 'die', 'destroy'] }))

  const route = (event: any) => {
    const actorId = String(event?.Actor?.ID ?? event?.id ?? '')
    const owner = event?.Actor?.Attributes?.[environmentLabel]
    for (const [id, network] of networks()) {
      if (id === owner || (network.ownId && network.ownId === actorId)) network.schedule()
    }
  }

  const open = (first: boolean) => {
    if (stopped) return
    if (!first) for (const [, network] of networks()) network.schedule()
    const req = httpRequest({ socketPath, method: 'GET', path: `/events?filters=${filters}`, headers: { Host: 'docker' } }, (res) => {
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) {
            try {
              route(JSON.parse(line))
            } catch { /* not an event; the next line is */ }
          }
          index = buffer.indexOf('\n')
        }
      })
      res.on('end', () => again())
      res.on('error', () => again())
    })
    req.on('error', () => again())
    req.end()
    current = req
  }

  const again = () => {
    current = null
    if (stopped || retry) return
    retry = setTimeout(() => {
      retry = null
      open(false)
    }, RELAY_RETRY_MS)
    retry.unref?.()
  }

  open(true)
  return {
    stop() {
      stopped = true
      if (retry) clearTimeout(retry)
      current?.destroy()
    }
  }
}
