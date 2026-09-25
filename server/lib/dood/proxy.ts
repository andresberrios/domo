import { mkdir, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

import {
  ChunkedDecoder,
  HEAD_END,
  headerValue,
  parseRequestHead,
  renderLocalResponse,
  renderRequestHead,
  ResponseSplicer,
  type DoodRequest
} from './http'
import { layersWantBody, runLayers, type DoodLayer } from './layers'
import { domoError } from './scope'

/**
 * The Docker socket an environment is given in place of a daemon of its own.
 *
 * One socket is created per environment and bind-mounted at the container's
 * `/var/run/docker.sock`, so *which* environment a request came from is the
 * socket it arrived on — there is nothing in a request body to trust. What is
 * done to a request is decided by a stack of layers (`layers.ts`); this file
 * is only the transport under them.
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
 * Both directions are *framed* (`http.ts`) — every request's and every
 * response's boundaries are found — but bytes are only held back where a layer
 * asked for it: a JSON request body a layer rewrites, a JSON response a layer
 * transforms, an error whose message names something. Everything else — logs,
 * attach, build output, stats, an event stream (rewritten line by line as it
 * flows) — passes as it arrives. A request that upgrades the connection, and
 * a response that switches protocols, turn it into a raw pipe for good.
 *
 * A dev environment is a namespace, not a security boundary. A container that
 * can reach the host daemon can take the host; that is already true here, and
 * nothing in this file changes it.
 */

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock'

export interface DoodProxyOptions {
  /** Where this environment's socket is created. Bind-mount this *file*, not its directory. */
  socketPath: string
  /** Outermost first. See `layers.ts`. */
  layers: DoodLayer[]
  /** Applied to the `message` of every JSON error the daemon answers with. */
  rewriteError?(message: string): string
  dockerSocket?: string
  onError?(error: unknown): void
  /** Diagnostics. `kind` is how the request was handled, not what it was. */
  onRequest?(entry: { line: string, kind: 'forwarded' | 'answered' | 'hijacked' }): void
}

export interface DoodProxy {
  socketPath: string
  close(): Promise<void>
}

type BodyState =
  | { kind: 'length', remaining: number, discard: boolean }
  | { kind: 'chunked', decoder: ChunkedDecoder, discard: boolean }

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
    upstream.on('error', (error) => { report(error); client.destroy() })
    client.on('error', () => upstream.destroy())
    // Half-close is forwarded rather than escalated to a full close.
    client.on('end', () => upstream.end())

    // Backpressure both ways, which `pipe` used to give for free: an export or
    // a followed log to a slow reader must not pile up in memory here.
    client.on('drain', () => upstream.resume())
    upstream.on('drain', () => client.resume())
    const responses = new ResponseSplicer({
      write: (data) => {
        if (!client.destroyed && !client.write(data)) upstream.pause()
      },
      rewriteError: options.rewriteError,
      onError: report
    })
    upstream.on('data', (chunk: Buffer) => responses.feed(chunk))
    upstream.on('end', () => {
      responses.end()
      client.end()
    })

    let buffer: Buffer = Buffer.alloc(0)
    let raw = false
    let busy = false
    let body: BodyState | null = null

    const sendUpstream = (data: Buffer | string) => {
      if (!upstream.destroyed && !upstream.write(data)) client.pause()
    }

    /** Move the current request body along, forwarding or dropping it. False means "need more bytes". */
    const moveBody = (state: BodyState): boolean => {
      if (state.kind === 'length') {
        const take = Math.min(state.remaining, buffer.length)
        if (!state.discard) sendUpstream(buffer.subarray(0, take))
        buffer = buffer.subarray(take)
        state.remaining -= take
        if (state.remaining === 0) body = null
        return take > 0
      }
      const { consumed } = state.decoder.push(buffer)
      if (!state.discard) sendUpstream(buffer.subarray(0, consumed))
      buffer = buffer.subarray(consumed)
      if (state.decoder.done) body = null
      return consumed > 0
    }

    /** The whole body of a request that is to be buffered, or null while it has not all arrived. */
    const takeBody = (start: number, length: number, chunked: boolean): { body: Buffer, end: number } | null => {
      if (!chunked) {
        if (buffer.length < start + length) return null
        return { body: buffer.subarray(start, start + length), end: start + length }
      }
      const decoder = new ChunkedDecoder()
      const { consumed, data } = decoder.push(buffer.subarray(start))
      if (!decoder.done) return null
      return { body: Buffer.concat(data), end: start + consumed }
    }

    const pump = async () => {
      if (busy) return
      busy = true
      try {
        while (!raw && buffer.length && !client.destroyed) {
          if (body) {
            if (!moveBody(body)) break
            continue
          }

          const end = buffer.indexOf(HEAD_END)
          if (end === -1) break
          const afterHead = end + HEAD_END.length
          const rawHead = buffer.subarray(0, end).toString('latin1')
          const request = parseRequestHead(rawHead)
          if (!request) {
            // Not a request line we understand: stop interpreting, stay a pipe.
            raw = true
            sendUpstream(buffer)
            buffer = Buffer.alloc(0)
            break
          }
          const line = rawHead.split('\r\n')[0]!
          const length = Number.parseInt(headerValue(request.headers, 'content-length') ?? '', 10)
          const chunked = (headerValue(request.headers, 'transfer-encoding') ?? '').toLowerCase().includes('chunked')
          const hasBody = chunked || (Number.isInteger(length) && length > 0)
          const upgrade = !!headerValue(request.headers, 'upgrade')

          let buffered = false
          if (hasBody && layersWantBody(options.layers, request)) {
            const taken = takeBody(afterHead, Number.isInteger(length) ? length : 0, chunked)
            if (!taken) break
            request.body = taken.body
            buffer = buffer.subarray(taken.end)
            buffered = true
          } else {
            buffer = buffer.subarray(afterHead)
          }

          let outcome
          try {
            outcome = await runLayers(options.layers, request)
          } catch (error) {
            report(error)
            outcome = {
              kind: 'answer' as const,
              status: 500,
              body: domoError(`could not translate ${request.method} ${request.path}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          if (client.destroyed) break

          const unbufferedBody = (discard: boolean): BodyState | null => {
            if (buffered || !hasBody) return null
            return chunked
              ? { kind: 'chunked', decoder: new ChunkedDecoder(), discard }
              : { kind: 'length', remaining: length, discard }
          }

          if (outcome.kind === 'answer') {
            options.onRequest?.({ line, kind: 'answered' })
            responses.answer(renderLocalResponse(outcome.status, outcome.body))
            body = unbufferedBody(true)
            continue
          }

          const forwarded: DoodRequest = outcome.request
          responses.expect({ method: forwarded.method, upgrade, transform: outcome.response })
          if (forwarded.body) {
            sendUpstream(renderRequestHead(forwarded, forwarded.body.length))
            sendUpstream(forwarded.body)
            // A layer replaced a body it never asked to see: the original goes nowhere.
            body = unbufferedBody(true)
          } else {
            sendUpstream(renderRequestHead(forwarded, null))
            body = unbufferedBody(false)
          }

          if (upgrade) {
            // Hijack: the rest of this connection is not HTTP (the body of an
            // exec start included — it is forwarded verbatim with the rest).
            // The Docker client dials a fresh connection for every hijack, so
            // nothing after this is a request anyone expects interpreted.
            options.onRequest?.({ line, kind: 'hijacked' })
            raw = true
            body = null
            if (buffer.length) sendUpstream(buffer)
            buffer = Buffer.alloc(0)
            break
          }
          options.onRequest?.({ line, kind: 'forwarded' })
        }
      } catch (error) {
        report(error)
        client.destroy()
      } finally {
        busy = false
      }
    }

    // Bytes arriving while a layer is awaited are picked up by the loop that
    // is already running: it re-reads `buffer` after every request.
    client.on('data', (chunk: Buffer) => {
      if (raw) { sendUpstream(chunk); return }
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      void pump()
    })
  }

  const server: Server = createServer({ allowHalfOpen: true }, handle)
  server.on('error', report)

  await mkdir(dirname(options.socketPath), { recursive: true })
  // Recursive, because a container started while nothing was listening here
  // leaves a *directory* behind: `-v` creates a missing source as one.
  await rm(options.socketPath, { force: true, recursive: true })
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
