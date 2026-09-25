import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RELAY_SCRIPT } from '../../server/lib/dood/relay-script'

/**
 * The relay program itself, run with this machine's `node` exactly as the port
 * helper runs it inside an environment's namespace — only the namespace is
 * missing, and nothing in the program knows about one. Loopback only, so it
 * needs no services and cannot collide with anything but itself.
 */

interface Answer {
  seq: number
  bound: Array<{ key: string, port: number, addresses: string[] }>
  failed: Array<{ key: string, reason: string, port: number, host: string }>
}

let relay: ChildProcessWithoutNullStreams
let answers: Answer[]
let seq = 0
const servers: Server[] = []

async function state(listeners: unknown[]): Promise<Answer> {
  const mine = ++seq
  relay.stdin.write(`${JSON.stringify({ seq: mine, listeners })}\n`)
  for (let i = 0; i < 200; i++) {
    const found = answers.find(answer => answer.seq === mine)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('no answer')
}

/** A TCP server answering every connection with `reply`, on a free loopback port. */
async function echo(reply: string): Promise<number> {
  const server = createServer(socket => socket.end(reply))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function fetchText(port: number, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host)
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { text += chunk })
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

const tcp = (key: string, range: [number, number], target: { host: string, port: number } | null, host = '127.0.0.1') =>
  ({ key, proto: 'tcp', host, range, target })

beforeEach(async () => {
  answers = []
  relay = spawn(process.execPath, ['-e', RELAY_SCRIPT, 'domo-relay=test'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: relay.stdout })
  const ready = new Promise<void>((resolve) => {
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      if (message.ready) resolve()
      else answers.push(message)
    })
  })
  await ready
})

afterEach(async () => {
  relay.stdin.end()
  await new Promise(resolve => relay.once('exit', resolve))
  for (const server of servers.splice(0)) server.close()
})

describe('the publishing relay', () => {
  it('listens where it is told and relays to the target', async () => {
    const target = await echo('from the service')
    const port = await freePort()
    const answer = await state([tcp('c1/80/tcp/0', [port, port], { host: '127.0.0.1', port: target })])

    expect(answer.bound).toEqual([{ key: 'c1/80/tcp/0', port, addresses: ['127.0.0.1'] }])
    expect(await fetchText(port)).toBe('from the service')
  })

  it('allocates a free port when none was named, and keeps it across reconciles', async () => {
    const target = await echo('allocated')
    const first = await state([tcp('c1/80/tcp/0', [0, 0], { host: '127.0.0.1', port: target })])
    const port = first.bound[0]!.port
    expect(port).toBeGreaterThan(0)

    const again = await state([tcp('c1/80/tcp/0', [0, 0], { host: '127.0.0.1', port: target })])
    expect(again.bound[0]!.port).toBe(port)
    expect(await fetchText(port)).toBe('allocated')
  })

  it('takes the first free port of a range', async () => {
    const target = await echo('ranged')
    const lo = await freePort()
    const blocker = createServer()
    servers.push(blocker)
    await new Promise<void>(resolve => blocker.listen(lo, '127.0.0.1', resolve))
    const answer = await state([tcp('c1/80/tcp/0', [lo, lo + 5], { host: '127.0.0.1', port: target })])

    expect(answer.bound[0]!.port).toBeGreaterThan(lo)
    expect(await fetchText(answer.bound[0]!.port)).toBe('ranged')
  })

  it('refuses a port another listener holds as allocated, and one something else holds as in use', async () => {
    const port = await freePort()
    const allocated = await state([
      tcp('c1/80/tcp/0', [port, port], null),
      tcp('c2/80/tcp/0', [port, port], null)
    ])
    expect(allocated.bound.map(entry => entry.key)).toEqual(['c1/80/tcp/0'])
    expect(allocated.failed).toEqual([expect.objectContaining({ key: 'c2/80/tcp/0', reason: 'allocated', port })])

    const taken = await freePort()
    const blocker = createServer()
    servers.push(blocker)
    await new Promise<void>(resolve => blocker.listen(taken, '127.0.0.1', resolve))
    const inUse = await state([tcp('c3/80/tcp/0', [taken, taken], null)])
    expect(inUse.failed).toEqual([expect.objectContaining({ key: 'c3/80/tcp/0', reason: 'in-use', port: taken })])
  })

  it('holds a connection that arrives before the target is known, and relays it once it is', async () => {
    const target = await echo('late target')
    const port = await freePort()
    await state([tcp('c1/80/tcp/0', [port, port], null)])

    const text = fetchText(port)
    await new Promise(resolve => setTimeout(resolve, 100))
    await state([tcp('c1/80/tcp/0', [port, port], { host: '127.0.0.1', port: target })])
    expect(await text).toBe('late target')
  })

  it('follows a target that moved without giving up the port', async () => {
    const before = await echo('before')
    const after = await echo('after')
    const port = await freePort()
    await state([tcp('c1/80/tcp/0', [port, port], { host: '127.0.0.1', port: before })])
    expect(await fetchText(port)).toBe('before')

    const moved = await state([tcp('c1/80/tcp/0', [port, port], { host: '127.0.0.1', port: after })])
    expect(moved.bound[0]!.port).toBe(port)
    expect(await fetchText(port)).toBe('after')
  })

  it('closes what is no longer wanted', async () => {
    const target = await echo('gone soon')
    const port = await freePort()
    await state([tcp('c1/80/tcp/0', [port, port], { host: '127.0.0.1', port: target })])
    await state([])

    await expect(fetchText(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('relays UDP datagrams both ways', async () => {
    const service = createSocket('udp4')
    service.on('message', (message, from) => service.send(`echo:${message}`, from.port, from.address))
    await new Promise<void>(resolve => service.bind(0, '127.0.0.1', resolve))
    const answer = await state([{
      key: 'c1/53/udp/0', proto: 'udp', host: '127.0.0.1', range: [0, 0],
      target: { host: '127.0.0.1', port: service.address().port }
    }])
    const port = answer.bound[0]!.port

    const client = createSocket('udp4')
    const reply = new Promise<string>(resolve => client.once('message', message => resolve(String(message))))
    client.send('ping', port, '127.0.0.1')
    expect(await reply).toBe('echo:ping')
    client.close()
    service.close()
  })

  it('exits when its stdin ends', async () => {
    const exited = new Promise(resolve => relay.once('exit', resolve))
    relay.stdin.end()
    await expect(exited).resolves.toBe(0)
    // afterEach ends it again; make that a no-op.
    relay = spawn(process.execPath, ['-e', 'process.stdin.on("end", () => process.exit(0))'], { stdio: 'pipe' }) as ChildProcessWithoutNullStreams
  })
})
