import { mkdir, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

import { rewriteContainerCreate, type DoodScope, type PublishedPort } from './rewrite'

/**
 * The Docker socket an environment is given in place of a daemon of its own.
 *
 * Everything is forwarded to the host daemon untouched except
 * `POST /containers/create`, which is translated by `rewrite.ts`. One socket is
 * created per environment and bind-mounted at the container's
 * `/var/run/docker.sock`, so *which* environment a request came from is the
 * socket it arrived on — there is nothing in a request body to trust.
 *
 * **This is a byte splice, not an HTTP server, and that is load-bearing.** An
 * earlier version used `http.createServer` and deadlocked every `docker run`:
 * a Docker client reuses one connection, `POST /containers/{id}/wait` is a long
 * poll that cannot answer until the container exits, and an HTTP server may not
 * answer requests on a connection out of order — so the `start` that would
 * cause that exit queued behind the wait forever, leaving the container stuck
 * in `Created`. Forcing `Connection: close` per response did not save it.
 * Measured against the same daemon, a pure byte splice runs it fine.
 *
 * So only the **client -> daemon** direction is parsed, and only far enough to
 * find request boundaries. The daemon -> client direction is never inspected:
 * responses are returned in order and nothing here alters them, so splicing
 * them blind is both correct and immune to whatever a response happens to be
 * (chunked logs, an event stream, a hijacked attach).
 *
 * A dev environment is a namespace, not a security boundary. A container that
 * can reach the host daemon can take the host; that is already true here, and
 * nothing in this file changes it.
 */

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock'
const CREATE_LINE = /^POST\s+\S*\/containers\/create(\?\S*)?\s+HTTP\/1\.[01]$/i
const HEAD_END = '\r\n\r\n'

export interface DoodProxyOptions {
  /** Where this environment's socket is created. Bind-mount this *file*, not its directory. */
  socketPath: string
  scope: DoodScope
  dockerSocket?: string
  /**
   * Create the workspace subpaths a rewritten mount needs. Docker refuses a
   * `volume-subpath` that does not exist yet, and a compose file mounting a
   * directory it expects to be created is ordinary.
   */
  ensureSubpaths(subpaths: string[]): Promise<void>
  /**
   * Attach the environment's own container to the networks a new container
   * joins, so an agent can reach the services it just started by name.
   */
  joinNetworks(networks: string[]): Promise<void>
  onDroppedPorts?(ports: PublishedPort[]): void
  onError?(error: unknown): void
  /** Diagnostics. `kind` is how the request was handled, not what it was. */
  onRequest?(entry: { line: string, kind: 'rewritten' | 'forwarded' | 'hijacked' }): void
}

export interface DoodProxy {
  socketPath: string
  close(): Promise<void>
}

interface Head {
  line: string
  headers: [string, string][]
  raw: string
}

function parseHead(raw: string): Head {
  const [line = '', ...rest] = raw.split('\r\n')
  const headers: [string, string][] = []
  for (const entry of rest) {
    const index = entry.indexOf(':')
    if (index > 0) headers.push([entry.slice(0, index), entry.slice(index + 1).trim()])
  }
  return { line, headers, raw }
}

const headerValue = (head: Head, name: string): string | undefined =>
  head.headers.find(([key]) => key.toLowerCase() === name)?.[1]

/** Re-emit a head with its content-length restated for a body we rewrote. */
function renderHead(head: Head, contentLength: number): string {
  const kept = head.headers.filter(([key]) => {
    const lower = key.toLowerCase()
    return lower !== 'content-length' && lower !== 'transfer-encoding'
  })
  kept.push(['Content-Length', String(contentLength)])
  return [head.line, ...kept.map(([key, value]) => `${key}: ${value}`), '', ''].join('\r\n')
}

export async function startDoodProxy(options: DoodProxyOptions): Promise<DoodProxy> {
  const dockerSocket = options.dockerSocket ?? DEFAULT_DOCKER_SOCKET
  const report = (error: unknown) => options.onError?.(error)

  // `server.close()` only answers once every connection has gone, and a Docker
  // client holds idle ones open. Tracking them is what lets close() finish.
  const open = new Set<Socket>()

  const handle = (client: Socket) => {
    open.add(client)
    client.on('close', () => open.delete(client))
    // `allowHalfOpen` on both ends, and it is not optional. A Docker client
    // with no stdin to send half-closes the connection right after the attach
    // request; with Node's default the socket's *write* side is torn down with
    // its read side, so the container's output never reaches the caller and
    // `docker run` prints nothing at all. Measured: identical command, empty
    // stdout through the proxy and correct output straight to the daemon.
    const upstream = connect({ path: dockerSocket, allowHalfOpen: true })
    upstream.on('error', error => { report(error); client.destroy() })
    client.on('error', () => upstream.destroy())
    // Half-close is forwarded rather than escalated to a full close.
    client.on('end', () => upstream.end())
    upstream.on('end', () => client.end())

    // Responses are never inspected.
    upstream.pipe(client)

    let buffer = Buffer.alloc(0)
    let raw = false
    let busy = false

    /** The body of a request we are forwarding verbatim, and how much is left. */
    let pending: { kind: 'length', remaining: number } | { kind: 'chunked', remaining: number } | null = null

    const pump = async () => {
      if (busy) return
      busy = true
      try {
        while (!raw && buffer.length) {
          if (pending) {
            if (pending.kind === 'length') {
              const take = Math.min(pending.remaining, buffer.length)
              upstream.write(buffer.subarray(0, take))
              buffer = buffer.subarray(take)
              pending.remaining -= take
              if (pending.remaining === 0) pending = null
              if (buffer.length === 0) break
              continue
            }
            // Chunked: forward verbatim, tracking framing to find the end.
            const consumed = forwardChunked(pending)
            if (!consumed) break
            continue
          }

          const end = buffer.indexOf(HEAD_END)
          if (end === -1) break
          const head = parseHead(buffer.subarray(0, end).toString('latin1'))
          const afterHead = end + HEAD_END.length

          if (headerValue(head, 'upgrade')) {
            // Hijack: the rest of this connection is not HTTP.
            options.onRequest?.({ line: head.line, kind: 'hijacked' })
            upstream.write(buffer.subarray(0, afterHead))
            buffer = buffer.subarray(afterHead)
            raw = true
            if (buffer.length) upstream.write(buffer)
            buffer = Buffer.alloc(0)
            break
          }

          const length = Number.parseInt(headerValue(head, 'content-length') ?? '', 10)
          const chunked = (headerValue(head, 'transfer-encoding') ?? '').toLowerCase().includes('chunked')

          if (CREATE_LINE.test(head.line)) {
            if (Number.isInteger(length)) {
              if (buffer.length < afterHead + length) break
              const body = buffer.subarray(afterHead, afterHead + length)
              buffer = buffer.subarray(afterHead + length)
              await rewriteAndForward(head, body)
              continue
            }
            // Every Docker client sends this body from a buffer, so it always
            // carries a content-length. If one ever does not, say so: the
            // create would otherwise be forwarded untranslated, and a bind
            // mount reaching the host daemon is exactly what must not happen
            // quietly.
            report(new Error(`container create with no content-length: ${head.line}`))
          }

          options.onRequest?.({ line: head.line, kind: 'forwarded' })
          upstream.write(buffer.subarray(0, afterHead))
          buffer = buffer.subarray(afterHead)
          if (chunked) pending = { kind: 'chunked', remaining: 0 }
          else if (Number.isInteger(length) && length > 0) pending = { kind: 'length', remaining: length }
        }
      } catch (error) {
        report(error)
        client.destroy()
      } finally {
        busy = false
      }
    }

    /** Forward one chunked-body step; false means "need more bytes". */
    const forwardChunked = (state: { kind: 'chunked', remaining: number }): boolean => {
      if (state.remaining > 0) {
        const take = Math.min(state.remaining, buffer.length)
        upstream.write(buffer.subarray(0, take))
        buffer = buffer.subarray(take)
        state.remaining -= take
        return take > 0
      }
      const lineEnd = buffer.indexOf('\r\n')
      if (lineEnd === -1) return false
      const size = Number.parseInt(buffer.subarray(0, lineEnd).toString('latin1').split(';')[0] ?? '', 16)
      if (!Number.isInteger(size)) throw new Error('malformed chunked body')
      if (size === 0) {
        // Final chunk, then any trailers, then a blank line. Waiting for that
        // terminator matters: stopping at the `0\r\n` would leave the trailing
        // CRLF to be read as the start of the next request line.
        const trailerEnd = buffer.indexOf(HEAD_END)
        if (trailerEnd === -1) return false
        const stop = trailerEnd + HEAD_END.length
        upstream.write(buffer.subarray(0, stop))
        buffer = buffer.subarray(stop)
        pending = null
        return true
      }
      // chunk size line + data + trailing CRLF
      state.remaining = size + 2
      upstream.write(buffer.subarray(0, lineEnd + 2))
      buffer = buffer.subarray(lineEnd + 2)
      return true
    }

    const rewriteAndForward = async (head: Head, body: Buffer) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        // Not ours to translate; let the daemon's own error be the answer.
        options.onRequest?.({ line: head.line, kind: 'forwarded' })
        upstream.write(head.raw + HEAD_END)
        upstream.write(body)
        return
      }
      const result = rewriteContainerCreate(parsed, options.scope)
      await options.ensureSubpaths(result.requiredSubpaths)
      if (result.networksToJoin.length) {
        // Best effort: a service that cannot be reached by name is worse than
        // one that was never created, but not by enough to refuse the create.
        await options.joinNetworks(result.networksToJoin).catch(report)
      }
      if (result.droppedPorts.length) options.onDroppedPorts?.(result.droppedPorts)
      const rewritten = Buffer.from(JSON.stringify(result.spec), 'utf8')
      options.onRequest?.({ line: head.line, kind: 'rewritten' })
      upstream.write(renderHead(head, rewritten.length))
      upstream.write(rewritten)
    }

    client.on('data', (chunk) => {
      if (raw) { upstream.write(chunk); return }
      buffer = Buffer.concat([buffer, chunk])
      void pump()
    })
  }

  const server: Server = createServer({ allowHalfOpen: true }, handle)
  server.on('error', report)

  await mkdir(dirname(options.socketPath), { recursive: true })
  await rm(options.socketPath, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    socketPath: options.socketPath,
    async close() {
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      for (const socket of open) socket.destroy()
      open.clear()
      await closed
      await rm(options.socketPath, { force: true })
    }
  }
}
