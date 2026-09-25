import {
  connect as http2Connect,
  constants,
  createServer as createHttp2Server,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream
} from 'node:http2'
import type { Duplex } from 'node:stream'
import { gunzipSync } from 'node:zlib'

import { GrpcMessageReader, grpcFrame } from './protobuf'

/**
 * BuildKit's gRPC channel, terminated and re-originated so its messages can
 * be read and changed.
 *
 * `docker build` and `docker compose build` do not use `POST /build`: a build
 * is `POST /grpc` upgraded to cleartext HTTP/2 (h2c), carrying BuildKit's
 * `Control` service, and the image name travels inside a protobuf message on
 * it. Editing HTTP/2 frames in flight would mean reconciling every changed
 * length with flow control in both directions, so the bridge does not: it is
 * an HTTP/2 *server* to the client and an HTTP/2 *client* to the daemon, each
 * session with its own flow control, and a call is re-issued stream for
 * stream. Only the calls `rewrites` names are decoded; every other call — and
 * `POST /session`, which stays a byte splice in `proxy.ts` — passes as bytes.
 *
 * Measured by the spike (`docs/spikes/dood-namespace`): ~15 ms per build.
 *
 * Teardown is the part that has to be right:
 * - the client resetting its socket once every call is answered is how the
 *   Docker CLI hangs up (no GOAWAY, no FIN) — the daemon side is closed
 *   quietly, and only a hang-up with a call still open is reported;
 * - a call the client cancels (`^C` during a build is an RST_STREAM on the
 *   `Solve`) is cancelled upstream with the same code, so the build stops;
 * - the daemon going away takes the client side with it.
 */

export class GrpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

/** gRPC status codes used here. */
export const GRPC = { INVALID_ARGUMENT: 3, PERMISSION_DENIED: 7, INTERNAL: 13 } as const

export interface CallRewrite {
  /** Answer the call with this error and never forward it. */
  refuse?: GrpcError
  /** Each request message, in order. Throw a `GrpcError` to fail the call. */
  request?(message: Buffer): Buffer | Promise<Buffer>
  /** Each response message, in order. Throw a `GrpcError` to fail the call. */
  response?(message: Buffer): Buffer | Promise<Buffer>
  /** The status message of a call that failed (`grpc-message`), which prints as the build's error. */
  statusMessage?(message: string): string
}

export interface GrpcBridgeOptions {
  /** What to do with one call, by its path (`/moby.buildkit.v1.Control/Solve`); null passes it as bytes. */
  rewrites(path: string): CallRewrite | null
  onError?(error: unknown): void
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings'])

/**
 * Headers to send on, from the *raw* list when there is one. Node joins a
 * repeated header into one `a, b` string in the parsed object, and gRPC
 * metadata is not a comma list: BuildKit's session announces every method it
 * serves as a repeated `x-docker-expose-session-grpc-method`, and joined they
 * name no method at all — measured, a bake of two targets sharing a context
 * then failed with `no local sources enabled`.
 */
function forwardHeaders(headers: IncomingHttpHeaders, keepPseudo: string[], raw?: string[]): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  const keep = (key: string) => !HOP_HEADERS.has(key) && (!key.startsWith(':') || keepPseudo.includes(key))
  if (raw?.length) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const key = raw[index]!.toLowerCase()
      const value = raw[index + 1]!
      if (!keep(key)) continue
      const existing = out[key]
      if (existing === undefined) out[key] = value
      else out[key] = Array.isArray(existing) ? [...existing, value] : [String(existing), value]
    }
    return out
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || !keep(key)) continue
    out[key] = value
  }
  return out
}

const grpcStatusHeaders = (error: GrpcError): OutgoingHttpHeaders => ({
  'grpc-status': String(error.code),
  'grpc-message': encodeURIComponent(error.message)
})

const asGrpcError = (error: unknown) => error instanceof GrpcError
  ? error
  : new GrpcError(GRPC.INTERNAL, `Domo: the build could not be translated: ${error instanceof Error ? error.message : String(error)}`)

function decodeGrpcMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * One message's bytes, readable. A compressed message is inflated when it is
 * gzip, the one encoding gRPC clients use; it is then sent on uncompressed,
 * which the per-message flag allows whatever the call's `grpc-encoding`.
 */
function readable(entry: { compressed: boolean, message: Buffer }, encoding: string | undefined): Buffer | null {
  if (!entry.compressed) return entry.message
  if (encoding === 'gzip') return gunzipSync(entry.message)
  return null
}

const compressedFrame = (message: Buffer) => {
  const frame = grpcFrame(message)
  frame[0] = 1
  return frame
}

export function bridgeGrpc(client: Duplex, daemon: Duplex, options: GrpcBridgeOptions): void {
  const report = (error: unknown) => options.onError?.(error)
  let open = 0
  let finished = false
  let clientSession: ServerHttp2Session | null = null

  const upstream: ClientHttp2Session = http2Connect('http://docker', {
    createConnection: () => daemon as any
  })

  /** Both sides down, once. */
  const finish = () => {
    if (finished) return
    finished = true
    if (!upstream.destroyed) upstream.close()
    // Anything still open after a moment is gone for good.
    setTimeout(() => {
      if (!upstream.destroyed) upstream.destroy()
    }, 1000).unref()
    if (clientSession && !clientSession.destroyed) clientSession.destroy()
    if (!client.destroyed) client.destroy()
  }

  upstream.on('error', (error) => {
    if (!finished) report(new Error(`the daemon's end of a build channel failed: ${error.message}`))
    finish()
  })
  upstream.on('close', () => {
    if (!finished && open > 0) report(new Error(`the daemon closed a build channel with ${open} call(s) open`))
    finish()
  })

  // The Docker CLI hangs up by resetting its socket once it has what it
  // asked for; `ERR_HTTP2_ERROR` / `ECONNRESET` then is not a failure.
  const clientGone = (error?: Error) => {
    if (!finished && open > 0) {
      report(new Error(`a build client hung up with ${open} call(s) open${error ? `: ${error.message}` : ''}`))
    }
    finish()
  }
  client.on('close', () => clientGone())

  const server = createHttp2Server()
  server.on('session', (session) => {
    clientSession = session
    session.on('error', clientGone)
    session.on('close', () => clientGone())
  })
  server.on('sessionError', clientGone)
  server.on('stream', (stream, headers, _flags, rawHeaders) => handleCall(stream, headers, rawHeaders))

  function handleCall(stream: ServerHttp2Stream, headers: IncomingHttpHeaders, rawHeaders: string[]) {
    const path = String(headers[':path'] ?? '')
    let rewrite: CallRewrite | null = null
    try {
      rewrite = options.rewrites(path)
    } catch (error) {
      report(error)
      rewrite = { refuse: asGrpcError(error) }
    }
    stream.on('error', () => { /* reported through the call's close, if at all */ })
    if (rewrite?.refuse) {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', ...grpcStatusHeaders(rewrite.refuse) }, { endStream: true })
      stream.resume()
      return
    }
    if (upstream.destroyed || upstream.closed) {
      stream.close(constants.NGHTTP2_REFUSED_STREAM)
      return
    }

    open++
    let counted = true
    const settle = () => {
      if (counted) open--
      counted = false
    }
    stream.on('close', settle)

    const call: ClientHttp2Stream = upstream.request(forwardHeaders(headers, [':method', ':path'], rawHeaders))
    call.on('error', () => { /* its close carries the outcome */ })

    let responded = false
    let trailers: OutgoingHttpHeaders | null = null
    let failed: GrpcError | null = null

    /** End the client's call with an error, whatever state it is in, and cancel the daemon's. */
    const fail = (error: unknown) => {
      if (failed) return
      failed = asGrpcError(error)
      if (!(error instanceof GrpcError)) report(error)
      if (!call.closed) call.close(constants.NGHTTP2_CANCEL)
      if (stream.closed || stream.destroyed) return
      if (!responded) {
        responded = true
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', ...grpcStatusHeaders(failed) }, { endStream: true })
      } else {
        trailers = grpcStatusHeaders(failed)
        if (!stream.writableEnded) stream.end()
      }
    }

    // Client -> daemon.
    const requestEncoding = typeof headers['grpc-encoding'] === 'string' ? headers['grpc-encoding'] : undefined
    let requestChain: Promise<void> = Promise.resolve()
    const requestReader = rewrite?.request ? new GrpcMessageReader() : null
    const sendUp = (bytes: Buffer) => {
      if (call.closed || call.destroyed) return
      if (!call.write(bytes)) {
        stream.pause()
        call.once('drain', () => stream.resume())
      }
    }
    stream.on('data', (chunk: Buffer) => {
      if (!requestReader) {
        sendUp(chunk)
        return
      }
      for (const entry of requestReader.push(chunk)) {
        requestChain = requestChain.then(async () => {
          if (failed) return
          const message = readable(entry, requestEncoding)
          if (!message) {
            throw new GrpcError(GRPC.INVALID_ARGUMENT,
              `Domo: a build request compressed with ${requestEncoding ?? 'an unknown encoding'} cannot be read, so its image names cannot be made this environment's own.`)
          }
          sendUp(grpcFrame(await rewrite!.request!(message)))
        }).catch(fail)
      }
    })
    stream.on('end', () => {
      requestChain = requestChain.then(() => {
        if (!call.closed && !call.writableEnded) call.end()
      })
    })
    // The client cancelled (or went): so does the daemon's call.
    stream.on('close', () => {
      if (!call.closed) call.close(stream.rstCode && stream.rstCode !== constants.NGHTTP2_NO_ERROR ? stream.rstCode : constants.NGHTTP2_CANCEL)
    })

    // Daemon -> client.
    let responseEncoding: string | undefined
    let responseChain: Promise<void> = Promise.resolve()
    const responseReader = rewrite?.response ? new GrpcMessageReader() : null
    const rewriteStatus = (source: IncomingHttpHeaders): OutgoingHttpHeaders => {
      const out = forwardHeaders(source, [])
      const message = decodeGrpcMessage(source['grpc-message'])
      if (message !== null && rewrite?.statusMessage) out['grpc-message'] = encodeURIComponent(rewrite.statusMessage(message))
      return out
    }
    const sendDown = (bytes: Buffer) => {
      if (stream.closed || stream.destroyed || failed) return
      if (!stream.write(bytes)) {
        call.pause()
        stream.once('drain', () => call.resume())
      }
    }
    call.on('response', (response, _flags, rawResponse?: string[]) => {
      if (failed || stream.closed) return
      responded = true
      responseEncoding = typeof response['grpc-encoding'] === 'string' ? response['grpc-encoding'] : undefined
      // Trailers-only: an immediate status, and nothing after it.
      if (response['grpc-status'] !== undefined) {
        stream.respond({ ...forwardHeaders(response, [':status'], rawResponse), ...rewriteStatus(response) }, { endStream: true })
        return
      }
      stream.respond(forwardHeaders(response, [':status'], rawResponse), { waitForTrailers: true })
    })
    call.on('data', (chunk: Buffer) => {
      if (!responseReader) {
        sendDown(chunk)
        return
      }
      for (const entry of responseReader.push(chunk)) {
        responseChain = responseChain.then(async () => {
          if (failed) return
          const message = readable(entry, responseEncoding)
          if (!message) {
            sendDown(entry.compressed ? compressedFrame(entry.message) : grpcFrame(entry.message))
            return
          }
          sendDown(grpcFrame(await rewrite!.response!(message)))
        }).catch(fail)
      }
    })
    call.on('trailers', (received) => {
      trailers = rewriteStatus(received)
    })
    call.on('end', () => {
      responseChain = responseChain.then(() => {
        if (failed || stream.closed || stream.destroyed) return
        if (!responded) return
        if (!stream.writableEnded) stream.end()
      })
    })
    stream.on('wantTrailers', () => {
      stream.sendTrailers(trailers ?? { 'grpc-status': String(GRPC.INTERNAL), 'grpc-message': 'the daemon ended the call without a status' })
    })
    call.on('close', () => {
      void responseChain.then(() => {
        if (stream.closed || stream.destroyed) return
        // Reset by the daemon, or cut short with the session: the client's call goes the same way.
        if (!responded || (!trailers && !stream.writableEnded)) {
          const code = call.rstCode && call.rstCode !== constants.NGHTTP2_NO_ERROR ? call.rstCode : constants.NGHTTP2_INTERNAL_ERROR
          stream.close(code)
        }
      })
    })
  }

  server.emit('connection', client)
}
