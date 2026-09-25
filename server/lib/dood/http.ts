/**
 * HTTP/1.1 framing for the DooD proxy, both directions, with no sockets in it.
 *
 * The proxy is a byte splice rather than an HTTP server (see `proxy.ts` for
 * why that is load-bearing), so it has to find message boundaries itself:
 * where a request's head and body end, and — since responses are rewritten
 * too — where each response ends. Written against `Buffer`s and a `write`
 * callback so every framing case is testable byte by byte, split at any
 * point, without a daemon.
 *
 * What makes answering and rewriting safe on a splice at all: Docker clients
 * do not pipeline. A new request on a connection is sent only once the
 * previous response has been read, so responses can be matched to requests
 * with a plain FIFO, and a request the proxy answers itself cannot overtake a
 * response still arriving from the daemon.
 */

import type { Duplex } from 'node:stream'

export const HEAD_END = '\r\n\r\n'

/** A body rewritten as it streams: bytes in, bytes out, and whatever was held back at the end. */
export interface StreamTransform {
  push(chunk: Buffer): Buffer
  end(): Buffer
}

export type Headers = [string, string][]

export function headerValue(headers: Headers, name: string): string | undefined {
  const lower = name.toLowerCase()
  return headers.find(([key]) => key.toLowerCase() === lower)?.[1]
}

function parseHeaders(lines: string[]): Headers {
  const headers: Headers = []
  for (const entry of lines) {
    const index = entry.indexOf(':')
    if (index > 0) headers.push([entry.slice(0, index), entry.slice(index + 1).trim()])
  }
  return headers
}

/** A request, as handlers see and rewrite it. */
export interface DoodRequest {
  method: string
  /** Path with the API version prefix and the query removed, still percent-encoded. */
  path: string
  /** `/v1.47`, or `''` when the client sent none. Kept so a rewrite round-trips it. */
  version: string
  query: URLSearchParams
  httpVersion: string
  headers: Headers
  /** The whole decoded body, when the handler asked for it to be buffered. */
  body: Buffer | null
}

export function parseRequestHead(raw: string): DoodRequest | null {
  const [line = '', ...rest] = raw.split('\r\n')
  const match = line.match(/^(\w+)\s+(\S+)\s+(HTTP\/1\.[01])$/i)
  if (!match) return null
  const target = match[2]!
  const queryAt = target.indexOf('?')
  const fullPath = queryAt === -1 ? target : target.slice(0, queryAt)
  const version = fullPath.match(/^\/v[\d.]+(?=\/)/)?.[0] ?? ''
  return {
    method: match[1]!.toUpperCase(),
    path: fullPath.slice(version.length),
    version,
    query: new URLSearchParams(queryAt === -1 ? '' : target.slice(queryAt + 1)),
    httpVersion: match[3]!,
    headers: parseHeaders(rest),
    body: null
  }
}

/**
 * The head a (possibly rewritten) request goes upstream with. A body that was
 * buffered is re-sent with its length restated; one that was not keeps its own
 * framing headers, since its bytes follow verbatim.
 */
export function renderRequestHead(request: DoodRequest, bodyLength: number | null): string {
  const query = request.query.toString()
  const target = `${request.version}${request.path}${query ? `?${query}` : ''}`
  let headers = request.headers
  if (bodyLength !== null) {
    headers = headers.filter(([key]) => !['content-length', 'transfer-encoding'].includes(key.toLowerCase()))
    headers.push(['Content-Length', String(bodyLength)])
  }
  return [`${request.method} ${target} ${request.httpVersion}`, ...headers.map(([k, v]) => `${k}: ${v}`), '', '']
    .join('\r\n')
}

const REASONS: Record<number, string> = {
  400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 500: 'Internal Server Error', 502: 'Bad Gateway'
}

/** A response the proxy gives itself, shaped like the daemon's so every client prints it the same way. */
export function renderLocalResponse(status: number, body: unknown): Buffer {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  const head = [
    `HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}`,
    'Content-Type: application/json',
    `Content-Length: ${payload.length}`,
    '', ''
  ].join('\r\n')
  return Buffer.concat([Buffer.from(head, 'latin1'), payload])
}

/**
 * An incremental chunked-body decoder. `push` consumes what it can and says
 * how many raw bytes that was — a pass-through forwards exactly those — and
 * what data they carried — a rewrite uses that.
 */
export class ChunkedDecoder {
  private state: 'size' | 'data' | 'data-crlf' | 'trailers' = 'size'
  private remaining = 0
  done = false

  push(input: Buffer): { consumed: number, data: Buffer[] } {
    const data: Buffer[] = []
    let offset = 0
    while (!this.done && offset < input.length) {
      if (this.state === 'data') {
        const take = Math.min(this.remaining, input.length - offset)
        data.push(input.subarray(offset, offset + take))
        offset += take
        this.remaining -= take
        if (this.remaining === 0) this.state = 'data-crlf'
        continue
      }
      if (this.state === 'data-crlf') {
        if (input.length - offset < 2) break
        offset += 2
        this.state = 'size'
        continue
      }
      const lineEnd = input.indexOf('\r\n', offset)
      if (lineEnd === -1) break
      const line = input.subarray(offset, lineEnd).toString('latin1')
      offset = lineEnd + 2
      if (this.state === 'trailers') {
        // Trailers run to an empty line; stopping at `0\r\n` would leave the
        // final CRLF to be read as the start of the next message.
        if (line === '') this.done = true
        continue
      }
      const size = Number.parseInt(line.split(';')[0] ?? '', 16)
      if (!Number.isInteger(size) || size < 0) throw new Error('malformed chunked body')
      if (size === 0) this.state = 'trailers'
      else {
        this.state = 'data'
        this.remaining = size
      }
    }
    return { consumed: offset, data }
  }
}

export function encodeChunk(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`, 'latin1'), body, Buffer.from('\r\n', 'latin1')])
}

export const LAST_CHUNK = Buffer.from('0\r\n\r\n', 'latin1')

/**
 * What to do with the response to one request. Every field is optional: a
 * request with no transform has its response spliced through untouched (and
 * unbuffered — logs, attach, build output and stats are streams).
 */
export interface ResponseTransform {
  /**
   * Rewrite a complete 2xx JSON body. The response is buffered for this, so it
   * must only be registered on endpoints whose answer is finite.
   */
  json?(body: unknown): unknown
  /**
   * Rewrite a newline-delimited JSON stream (`GET /events`) one line at a time
   * while it streams. `null` drops the line.
   */
  line?(line: unknown): unknown | null
  /** Called once the response has been delivered, with its status. For reconciling after the fact. */
  after?(status: number): void | Promise<void>
  /**
   * Rewrite a 2xx body of any type as it streams (an image archive): bytes in,
   * bytes out, re-sent chunked since its length changes.
   */
  stream?(): StreamTransform
  /**
   * Take over an upgraded connection once the daemon answers `101`: the two
   * sockets are handed over with any bytes already read put back, and the
   * proxy stops interpreting either. For the `/grpc` build channel.
   */
  hijack?(client: Duplex, daemon: Duplex): void
}

interface Pending {
  method: string
  /** The request asked to upgrade the connection (attach, exec start, BuildKit session). */
  upgrade: boolean
  transform?: ResponseTransform
  /** Written as-is when it reaches the front: a response the proxy answered itself. */
  local?: Buffer
}

export interface ResponseSplicerOptions {
  write(data: Buffer): void
  /** A `101` to a request with a `hijack` transform: `rest` is what the daemon sent after the head. */
  onHijack?(hijack: NonNullable<ResponseTransform['hijack']>, rest: Buffer): void
  /** A request with a `hijack` transform was answered with something other than `101`. */
  onHijackDeclined?(): void
  /** Applied to the `message` of every JSON error response, whatever the request. */
  rewriteError?(message: string): string
  onError?(error: unknown): void
}

type BodyMode = 'pass' | 'buffer' | 'lines' | 'stream'

/**
 * The daemon -> client direction. Fed raw bytes; writes what the client
 * should receive. Every response is framed — status line and headers, then a
 * body delimited by content-length, chunked encoding, or the connection
 * closing; none at all for HEAD, 1xx, 204 and 304 — so the next response's
 * head is always found, whether or not this one was rewritten. A `101`, or a
 * body delimited by close, turns the connection into a raw pipe for good.
 */
export class ResponseSplicer {
  private queue: Pending[] = []
  private buffer: Buffer = Buffer.alloc(0)
  private raw = false
  private current: {
    pending: Pending
    status: number
    head: string
    headers: Headers
    mode: BodyMode
    framing: 'length' | 'chunked' | 'close'
    remaining: number
    decoder: ChunkedDecoder | null
    collected: Buffer[]
    partialLine: string
    stream: StreamTransform | null
  } | null = null
  /** Handed to a hijack: nothing more is read here. */
  private detached = false

  constructor(private readonly options: ResponseSplicerOptions) {}

  /** A request went upstream; its response will be the next unclaimed one. */
  expect(pending: Omit<Pending, 'local'>): void {
    this.queue.push(pending)
  }

  /** A request answered locally: delivered in order, once everything before it has been. */
  answer(response: Buffer): void {
    this.queue.push({ method: '', upgrade: false, local: response })
    if (!this.current && !this.buffer.length) this.flushLocal()
  }

  get isRaw(): boolean {
    return this.raw
  }

  feed(chunk: Buffer): void {
    if (this.detached) return
    if (this.raw) {
      this.options.write(chunk)
      return
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    try {
      this.drain()
    } catch (error) {
      // A framing error means we no longer know where a response ends; the
      // honest thing is to stop interpreting and pass the rest through.
      this.options.onError?.(error)
      this.goRaw()
    }
  }

  /** The daemon closed its side. A close-delimited body ends here. */
  end(): void {
    const current = this.current
    if (current && current.framing === 'close') this.finishBody()
    else if (this.buffer.length) {
      this.options.write(this.buffer)
      this.buffer = Buffer.alloc(0)
    }
  }

  private goRaw() {
    this.raw = true
    if (this.buffer.length) this.options.write(this.buffer)
    this.buffer = Buffer.alloc(0)
  }

  private flushLocal() {
    while (this.queue[0]?.local) this.options.write(this.queue.shift()!.local!)
  }

  private drain() {
    while (!this.raw) {
      if (!this.current) {
        this.flushLocal()
        if (!this.buffer.length) return
        if (!this.startResponse()) return
        continue
      }
      if (!this.readBody()) return
    }
  }

  /** Parse one response head. False means "need more bytes". */
  private startResponse(): boolean {
    const end = this.buffer.indexOf(HEAD_END)
    if (end === -1) return false
    const head = this.buffer.subarray(0, end + HEAD_END.length)
    this.buffer = this.buffer.subarray(end + HEAD_END.length)
    const [line = '', ...rest] = head.toString('latin1').slice(0, -HEAD_END.length).split('\r\n')
    const status = Number.parseInt(line.split(' ')[1] ?? '', 10)
    const headers = parseHeaders(rest)
    const pending = this.queue.shift()
    if (!pending || !Number.isInteger(status)) {
      // Nothing asked for this; do not guess what it is.
      this.options.write(head)
      this.goRaw()
      return false
    }
    if (status >= 100 && status < 200 && status !== 101) {
      // Interim: the real response to the same request follows.
      this.options.write(head)
      this.queue.unshift(pending)
      return true
    }
    if (status === 101) {
      this.options.write(head)
      const hijack = pending.transform?.hijack
      if (hijack && this.options.onHijack) {
        const rest = this.buffer
        this.buffer = Buffer.alloc(0)
        this.raw = true
        this.detached = true
        this.options.onHijack(hijack, rest)
        return false
      }
      this.goRaw()
      return false
    }
    if (pending.transform?.hijack) this.options.onHijackDeclined?.()
    const noBody = pending.method === 'HEAD' || status === 204 || status === 304
    if (noBody) {
      this.options.write(head)
      this.done(pending, status)
      return true
    }
    const chunked = (headerValue(headers, 'transfer-encoding') ?? '').toLowerCase().includes('chunked')
    const length = Number.parseInt(headerValue(headers, 'content-length') ?? '', 10)
    const framing = chunked ? 'chunked' : Number.isInteger(length) ? 'length' : 'close'
    const json = (headerValue(headers, 'content-type') ?? '').includes('json')
    let mode: BodyMode = 'pass'
    if (json && status >= 400 && this.options.rewriteError) mode = 'buffer'
    else if (status >= 200 && status < 300 && pending.transform?.json && framing !== 'close') mode = 'buffer'
    else if (status >= 200 && status < 300 && pending.transform?.line) mode = 'lines'
    else if (status >= 200 && status < 300 && pending.transform?.stream) mode = 'stream'
    // A hijack answered 200 with no framing is a raw stream from here on.
    if (framing === 'close' && pending.upgrade) mode = 'pass'

    this.current = {
      pending, status, head: head.toString('latin1'), headers, mode, framing,
      remaining: framing === 'length' ? length : 0,
      decoder: framing === 'chunked' ? new ChunkedDecoder() : null,
      collected: [],
      partialLine: '',
      stream: mode === 'stream' ? pending.transform!.stream!() : null
    }
    // Whatever is not buffered is sent as it arrives, head first — `wait`
    // sends its head long before its body, and the client is waiting on it.
    if (mode === 'pass' || (mode === 'lines' && framing !== 'length')) this.options.write(head)
    // A rewritten stream changes length: chunked, unless the daemon delimits it by closing.
    if (mode === 'stream') this.options.write(Buffer.from(renderResponseHead(head.toString('latin1'), framing === 'close' ? null : 'chunked'), 'latin1'))
    if (framing === 'length' && length === 0) this.finishBody()
    else if (framing === 'close' && mode === 'pass') {
      this.current = null
      this.goRaw()
    }
    return true
  }

  /** Consume body bytes of the current response. False means "need more bytes". */
  private readBody(): boolean {
    const current = this.current!
    if (!this.buffer.length) return false
    let raw: Buffer
    let data: Buffer[]
    let finished = false
    if (current.framing === 'length') {
      const take = Math.min(current.remaining, this.buffer.length)
      raw = this.buffer.subarray(0, take)
      data = [raw]
      current.remaining -= take
      finished = current.remaining === 0
    } else if (current.framing === 'chunked') {
      const result = current.decoder!.push(this.buffer)
      raw = this.buffer.subarray(0, result.consumed)
      data = result.data
      finished = current.decoder!.done
      if (!result.consumed) return false
    } else {
      raw = this.buffer
      data = [raw]
    }
    this.buffer = this.buffer.subarray(raw.length)

    if (current.mode === 'pass') this.options.write(raw)
    else if (current.mode === 'buffer') current.collected.push(...data)
    else if (current.mode === 'stream') this.streamBytes(current.stream!.push(Buffer.concat(data)))
    else this.streamLines(data)

    if (finished) this.finishBody()
    return true
  }

  private streamBytes(out: Buffer) {
    if (!out.length) return
    this.options.write(this.current!.framing === 'close' ? out : encodeChunk(out))
  }

  private streamLines(data: Buffer[]) {
    const current = this.current!
    if (current.framing === 'length') {
      current.collected.push(...data)
      return
    }
    const text = current.partialLine + Buffer.concat(data).toString('utf8')
    const lines = text.split('\n')
    current.partialLine = lines.pop() ?? ''
    const out = lines.map(line => this.transformLine(line)).filter((line): line is string => line !== null).join('')
    if (!out) return
    this.options.write(current.framing === 'chunked' ? encodeChunk(out) : Buffer.from(out, 'utf8'))
  }

  private transformLine(line: string): string | null {
    if (!line.trim()) return `${line}\n`
    const transform = this.current!.pending.transform!.line!
    try {
      const result = transform(JSON.parse(line))
      return result === null ? null : `${JSON.stringify(result)}\n`
    } catch (error) {
      this.options.onError?.(error)
      return `${line}\n`
    }
  }

  private finishBody() {
    const current = this.current!
    this.current = null
    if (current.mode === 'buffer') {
      const body = Buffer.concat(current.collected)
      const rewritten = this.rewriteBody(current.status, current.pending, body)
      this.options.write(Buffer.from(renderResponseHead(current.head, rewritten.length), 'latin1'))
      this.options.write(rewritten)
    } else if (current.mode === 'stream') {
      const rest = current.stream!.end()
      if (rest.length) this.options.write(current.framing === 'close' ? rest : encodeChunk(rest))
      if (current.framing !== 'close') this.options.write(LAST_CHUNK)
    } else if (current.mode === 'lines') {
      if (current.framing === 'length') {
        const text = Buffer.concat(current.collected).toString('utf8')
        const out = text.split('\n').filter(Boolean).map(line => this.transformLine(line))
          .filter((line): line is string => line !== null).join('')
        const body = Buffer.from(out, 'utf8')
        this.options.write(Buffer.from(renderResponseHead(current.head, body.length), 'latin1'))
        this.options.write(body)
      } else {
        if (current.partialLine) {
          const last = this.transformLine(current.partialLine)?.replace(/\n$/, '')
          if (last) this.options.write(current.framing === 'chunked' ? encodeChunk(last) : Buffer.from(last))
        }
        if (current.framing === 'chunked') this.options.write(LAST_CHUNK)
      }
    }
    this.done(current.pending, current.status)
  }

  private rewriteBody(status: number, pending: Pending, body: Buffer): Buffer {
    try {
      const parsed = JSON.parse(body.toString('utf8'))
      let result: unknown = parsed
      if (status >= 400) {
        if (parsed && typeof parsed.message === 'string' && this.options.rewriteError) {
          result = { ...parsed, message: this.options.rewriteError(parsed.message) }
        }
      } else if (pending.transform?.json) {
        result = pending.transform.json(parsed)
      }
      return Buffer.from(`${JSON.stringify(result)}\n`, 'utf8')
    } catch (error) {
      this.options.onError?.(error)
      return body
    }
  }

  private done(pending: Pending, status: number) {
    const after = pending.transform?.after
    if (after) {
      try {
        void Promise.resolve(after(status)).catch(error => this.options.onError?.(error))
      } catch (error) {
        this.options.onError?.(error)
      }
    }
    this.flushLocal()
  }
}

/** A response head re-emitted with a restated length (or chunked, or neither), for a body that was rewritten. */
function renderResponseHead(head: string, length: number | 'chunked' | null): string {
  const [line = '', ...rest] = head.slice(0, -HEAD_END.length).split('\r\n')
  const kept = parseHeaders(rest).filter(([key]) => !['content-length', 'transfer-encoding'].includes(key.toLowerCase()))
  if (length === 'chunked') kept.push(['Transfer-Encoding', 'chunked'])
  else if (length !== null) kept.push(['Content-Length', String(length)])
  return [line, ...kept.map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n')
}
