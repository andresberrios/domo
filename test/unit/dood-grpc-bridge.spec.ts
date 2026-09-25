import { mkdtemp, rm } from 'node:fs/promises'
import {
  connect as http2Connect,
  constants,
  createServer as createHttp2Server,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
  type Http2Server,
  type ServerHttp2Stream
} from 'node:http2'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bridgeGrpc, GRPC, GrpcError, type CallRewrite } from '../../server/lib/dood/grpc-bridge'
import { GrpcMessageReader, grpcFrame } from '../../server/lib/dood/protobuf'

/**
 * The build bridge with real HTTP/2 on both of its sides — a stand-in daemon
 * serving gRPC-shaped calls, and a client — over local sockets: calls are
 * rewritten where asked and passed as bytes everywhere else, trailers and
 * errors arrive, a cancel reaches the daemon, and a client hanging up the way
 * the Docker CLI does is not an error.
 */

interface Received { path: string, headers: IncomingHttpHeaders, raw: string[], messages: Buffer[], cancelled: boolean }

let dir: string
let daemon: Http2Server
let bridge: Server
let calls: Received[]
let errors: unknown[]
let sockets: Socket[]
let rewrites: (path: string) => CallRewrite | null

const SOLVE = '/moby.buildkit.v1.Control/Solve'

function serveDaemon(stream: ServerHttp2Stream, headers: IncomingHttpHeaders, raw: string[]) {
  const call: Received = { path: String(headers[':path']), headers, raw, messages: [], cancelled: false }
  calls.push(call)
  const reader = new GrpcMessageReader()
  stream.on("data", (chunk: Buffer) => call.messages.push(...reader.push(chunk).map(entry => entry.message)))
  stream.on('close', () => { call.cancelled = stream.rstCode === constants.NGHTTP2_CANCEL })
  stream.on('error', () => {})
  if (call.path.endsWith('/Fail')) {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '5', 'grpc-message': encodeURIComponent('not found: secret/app') }, { endStream: true })
    return
  }
  if (call.path.endsWith('/Hang')) {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' })
    return
  }
  stream.on('end', () => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
    for (const message of call.messages) stream.write(grpcFrame(Buffer.concat([Buffer.from('echo:'), message])))
    if (call.path.endsWith('/Status')) for (let index = 0; index < 50; index++) stream.write(grpcFrame(Buffer.from(`secret/app ${index}`)))
    stream.end()
  })
}

interface CallResult { status: string | undefined, message: string | undefined, messages: string[] }

function call(client: ClientHttp2Session, path: string, messages: Buffer[], extra: Record<string, string | string[]> = {}): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = client.request({ ':method': 'POST', ':path': path, 'content-type': 'application/grpc', te: 'trailers', ...extra })
    const reader = new GrpcMessageReader()
    const out: string[] = []
    let status: string | undefined
    let message: string | undefined
    req.on('response', (headers) => {
      if (headers['grpc-status'] !== undefined) {
        status = String(headers['grpc-status'])
        message = decodeURIComponent(String(headers['grpc-message'] ?? ''))
      }
    })
    req.on('data', chunk => out.push(...reader.push(chunk).map(entry => entry.message.toString())))
    req.on('trailers', (trailers) => {
      status = String(trailers['grpc-status'])
      message = trailers['grpc-message'] === undefined ? undefined : decodeURIComponent(String(trailers['grpc-message']))
    })
    req.on('close', () => resolve({ status, message, messages: out }))
    req.on('error', reject)
    for (const each of messages) req.write(grpcFrame(each))
    req.end()
  })
}

/** Over TCP, which is what lets a test reset the connection the way the CLI does (`resetAndDestroy` is TCP-only). */
const clientSocket = () => connect({ host: '127.0.0.1', port: (bridge.address() as AddressInfo).port })
const openClient = () => http2Connect('http://docker', { createConnection: clientSocket })

beforeEach(async () => {
  dir = await mkdtemp('/tmp/ddg-')
  calls = []
  errors = []
  sockets = []
  rewrites = () => null
  daemon = createHttp2Server()
  daemon.on('stream', (stream, headers, _flags, raw) => serveDaemon(stream, headers, raw))
  await new Promise<void>(resolve => daemon.listen(join(dir, 'd.sock'), resolve))
  bridge = createServer((client) => {
    sockets.push(client)
    const upstream = connect(join(dir, 'd.sock'))
    sockets.push(upstream)
    upstream.once('connect', () => bridgeGrpc(client, upstream, { rewrites: path => rewrites(path), onError: error => errors.push(error) }))
  })
  await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve))
})

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => bridge.close(resolve))
  await new Promise(resolve => daemon.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe('the build bridge', () => {
  it('passes an unrewritten call as bytes, trailers and repeated metadata included', async () => {
    const client = openClient()
    const result = await call(client, '/moby.buildkit.v1.Control/ListWorkers', [Buffer.from('hello')], {
      'x-docker-expose-session-grpc-method': ['/moby.filesync.v1.FileSync/DiffCopy', '/moby.filesync.v1.Auth/Credentials']
    })
    expect(result).toEqual({ status: '0', message: undefined, messages: ['echo:hello'] })
    const methods: string[] = []
    for (let index = 0; index < calls[0]!.raw.length; index += 2) {
      if (calls[0]!.raw[index] === 'x-docker-expose-session-grpc-method') methods.push(calls[0]!.raw[index + 1]!)
    }
    // Two header fields, not one `a, b`: BuildKit reads each as a method it may call.
    expect(methods).toEqual(['/moby.filesync.v1.FileSync/DiffCopy', '/moby.filesync.v1.Auth/Credentials'])
    client.close()
  })

  it('rewrites the messages of a call it is asked to, in order, both ways', async () => {
    rewrites = path => path === SOLVE
      ? {
          request: async (message) => {
            await new Promise(resolve => setTimeout(resolve, 5))
            return Buffer.from(message.toString().replace('public', 'private'))
          },
          response: message => Buffer.from(message.toString().replace('private', 'public'))
        }
      : path.endsWith('/Status') ? { response: message => Buffer.from(message.toString().replace('secret/', '')) } : null
    const client = openClient()
    const solve = await call(client, SOLVE, [Buffer.from('name=public/app'), Buffer.from('two public'), Buffer.alloc(100_000, 0x61)])
    expect(calls[0]!.messages.map(message => message.toString().slice(0, 20))).toEqual(['name=private/app', 'two private', 'a'.repeat(20)])
    expect(solve.status).toBe('0')
    expect(solve.messages.map(message => message.slice(0, 22))).toEqual(['echo:name=public/app', 'echo:two public', `echo:${'a'.repeat(17)}`])
    const status = await call(client, '/moby.buildkit.v1.Control/Status', [])
    expect(status.messages).toHaveLength(50)
    expect(status.messages[49]).toBe('app 49')
    client.close()
  })

  it('answers a refused call itself, and never forwards it', async () => {
    rewrites = path => path.endsWith('/Prune') ? { refuse: new GrpcError(GRPC.PERMISSION_DENIED, 'Domo: no pruning') } : null
    const client = openClient()
    expect(await call(client, '/moby.buildkit.v1.Control/Prune', [Buffer.from('all')])).toEqual({ status: '7', message: 'Domo: no pruning', messages: [] })
    expect(calls).toEqual([])
    client.close()
  })

  it('fails a call whose rewrite throws, with the rewrite\'s own status, and cancels it at the daemon', async () => {
    rewrites = () => ({ request: () => { throw new GrpcError(GRPC.INVALID_ARGUMENT, 'Domo: bad name') } })
    const client = openClient()
    expect(await call(client, SOLVE, [Buffer.from('x')])).toMatchObject({ status: '3', message: 'Domo: bad name' })
    await expect.poll(() => calls[0]?.cancelled).toBe(true)
    client.close()
  })

  it('passes a daemon\'s immediate error on, with its message rewritten', async () => {
    rewrites = () => ({ statusMessage: message => message.replace('secret/', '') })
    const client = openClient()
    expect(await call(client, '/moby.buildkit.v1.Control/Fail', [])).toEqual({ status: '5', message: 'not found: app', messages: [] })
    client.close()
  })

  it('cancels a call at the daemon when the client cancels it', async () => {
    const client = openClient()
    const req = client.request({ ':method': 'POST', ':path': '/moby.buildkit.v1.Control/Hang', 'content-type': 'application/grpc' })
    req.on('error', () => {})
    req.write(grpcFrame(Buffer.from('x')))
    await expect.poll(() => calls.length).toBe(1)
    req.close(constants.NGHTTP2_CANCEL)
    await expect.poll(() => calls[0]!.cancelled).toBe(true)
    client.close()
  })

  it('takes a client resetting its socket once it has its answers as a hang-up, not an error', async () => {
    let raw: Socket | null = null
    const client = http2Connect('http://docker', { createConnection: () => (raw = clientSocket()) })
    client.on('error', () => {})
    await call(client, '/moby.buildkit.v1.Control/ListWorkers', [Buffer.from('x')])
    // No GOAWAY, no FIN: an RST on the socket, as the Docker CLI leaves.
    raw!.resetAndDestroy()
    await expect.poll(() => sockets[1]!.destroyed).toBe(true)
    expect(errors.map(String)).toEqual([])
  })

  it('reports a client that went with a call still open', async () => {
    const client = openClient()
    const req = client.request({ ':method': 'POST', ':path': '/moby.buildkit.v1.Control/Hang', 'content-type': 'application/grpc' })
    req.on('error', () => {})
    req.write(grpcFrame(Buffer.from('x')))
    await expect.poll(() => calls.length).toBe(1)
    sockets[0]!.destroy()
    await expect.poll(() => errors.length).toBe(1)
    expect(String(errors[0])).toMatch(/hung up with 1 call\(s\) open/)
    await expect.poll(() => calls[0]!.cancelled || calls[0]!.messages.length > 0).toBe(true)
    client.destroy()
  })
})
