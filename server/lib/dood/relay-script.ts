/**
 * The program that publishes an environment's containers on the environment's
 * own `localhost`: one Node process per environment, run by the port helper
 * under `nsenter -n` into the environment's network namespace, so what it
 * listens on is what the agent's `localhost` has.
 *
 * It is told the *whole* desired state on stdin, one JSON line at a time, and
 * answers each with what it bound and what it could not:
 *
 *   in:  {"seq":1,"listeners":[{"key","proto","host","range":[lo,hi],"target":{"host","port"}|null}]}
 *   out: {"seq":1,"bound":[{"key","port","addresses"}],"failed":[{"key","host","port","proto","reason","message"}]}
 *
 * A listener whose key and spec are unchanged keeps its socket (and the port
 * it was given, when it was allocated) and only has its target replaced, so a
 * service restarting on a new address is followed without the port moving.
 * A connection that arrives while the target is unknown — between a
 * container's `start` being answered and Domo learning its address — waits for
 * one instead of being refused, for up to `PENDING_MS`.
 *
 * `host` is `''` for every address (dual-stack `::`, or `0.0.0.0` where the
 * namespace has no IPv6), or a literal address. `range` `[0, 0]` asks the
 * kernel for a free port; `[lo, hi]` takes the first free port in it.
 *
 * It exits when stdin ends: it lives exactly as long as the Domo that drives
 * it, and a Domo that dies takes its listeners with it.
 *
 * Plain JavaScript in a string rather than a module, because it runs with the
 * helper's own `node -e`, where nothing of Domo's is installed. The unit spec
 * runs this exact text.
 */
export const RELAY_SCRIPT = String.raw`
'use strict'
const net = require('node:net')
const dgram = require('node:dgram')
const readline = require('node:readline')

const PENDING_MS = 10000
const UDP_IDLE_MS = 60000
const listeners = new Map()

const say = message => process.stdout.write(JSON.stringify(message) + '\n')
const sameSpec = (a, b) => a.proto === b.proto && a.host === b.host && a.range[0] === b.range[0] && a.range[1] === b.range[1]
const isV6 = host => host.includes(':')
const overlaps = (a, b) => a === '' || b === '' || a === b || a === '::' || b === '::'

function allocatedBy(proto, host, port) {
  for (const listener of listeners.values()) {
    if (listener.spec.proto === proto && listener.port === port && overlaps(listener.spec.host, host)) return true
  }
  return false
}

function listenTcp(host, port, ipv6Only) {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true })
    server.once('error', reject)
    server.listen({ host, port, ipv6Only, exclusive: true }, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

function bindUdp(type, host, port, ipv6Only) {
  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = dgram.createSocket({ type, ipv6Only })
    } catch (error) {
      reject(error)
      return
    }
    socket.once('error', reject)
    socket.bind({ address: host, port, exclusive: true }, () => {
      socket.off('error', reject)
      resolve(socket)
    })
  })
}

/** One socket on the requested address and port, and the addresses it really covers. */
async function open(proto, host, port) {
  if (host === '') {
    try {
      const handle = proto === 'tcp' ? await listenTcp('::', port, false) : await bindUdp('udp6', '::', port, false)
      return { handle, addresses: ['0.0.0.0', '::'] }
    } catch (error) {
      if (error.code === 'EADDRINUSE') throw error
      // No IPv6 in this namespace: IPv4 alone, as Docker does on such a host.
      const handle = proto === 'tcp' ? await listenTcp('0.0.0.0', port, false) : await bindUdp('udp4', '0.0.0.0', port, false)
      return { handle, addresses: ['0.0.0.0'] }
    }
  }
  const v6 = isV6(host)
  const handle = proto === 'tcp' ? await listenTcp(host, port, v6) : await bindUdp(v6 ? 'udp6' : 'udp4', host, port, v6)
  return { handle, addresses: [host] }
}

function serveTcp(listener) {
  const server = listener.handle
  listener.connections = new Set()
  listener.pending = []
  const relay = (client) => {
    const target = listener.target
    const upstream = net.connect({ host: target.host, port: target.port, allowHalfOpen: true })
    listener.connections.add(upstream)
    upstream.on('close', () => listener.connections.delete(upstream))
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
    client.pipe(upstream)
    upstream.pipe(client)
  }
  listener.flush = () => {
    const waiting = listener.pending.splice(0)
    for (const entry of waiting) {
      clearTimeout(entry.timer)
      if (!entry.client.destroyed) relay(entry.client)
    }
  }
  server.on('connection', (client) => {
    listener.connections.add(client)
    client.on('close', () => listener.connections.delete(client))
    client.on('error', () => client.destroy())
    if (listener.target) {
      relay(client)
      return
    }
    // Whatever the client sends meanwhile waits in its socket, unread.
    client.pause()
    const entry = { client, timer: setTimeout(() => client.destroy(), PENDING_MS) }
    listener.pending.push(entry)
  })
  listener.close = () => new Promise((resolve) => {
    for (const entry of listener.pending) clearTimeout(entry.timer)
    for (const socket of listener.connections) socket.destroy()
    server.close(() => resolve())
  })
}

function serveUdp(listener) {
  const socket = listener.handle
  listener.sessions = new Map()
  const endSession = (id) => {
    const session = listener.sessions.get(id)
    if (!session) return
    listener.sessions.delete(id)
    clearTimeout(session.timer)
    try { session.socket.close() } catch {}
  }
  listener.flush = () => {
    for (const id of [...listener.sessions.keys()]) endSession(id)
  }
  socket.on('message', (message, from) => {
    const target = listener.target
    if (!target) return
    const id = from.address + '|' + from.port
    let session = listener.sessions.get(id)
    if (!session) {
      const upstream = dgram.createSocket(isV6(target.host) ? 'udp6' : 'udp4')
      session = { socket: upstream, timer: null, connected: false, waiting: [] }
      listener.sessions.set(id, session)
      upstream.on('message', (reply) => {
        socket.send(reply, from.port, from.address)
        refresh(id)
      })
      upstream.on('error', () => endSession(id))
      upstream.connect(target.port, target.host, () => {
        session.connected = true
        for (const queued of session.waiting.splice(0)) upstream.send(queued)
      })
    }
    if (session.connected) session.socket.send(message)
    else session.waiting.push(message)
    refresh(id)
  })
  const refresh = (id) => {
    const session = listener.sessions.get(id)
    if (!session) return
    clearTimeout(session.timer)
    session.timer = setTimeout(() => endSession(id), UDP_IDLE_MS)
  }
  listener.close = () => new Promise((resolve) => {
    listener.flush()
    socket.close(() => resolve())
  })
}

async function bind(spec) {
  const [lo, hi] = spec.range
  const first = lo === 0 ? 0 : lo
  const last = lo === 0 ? 0 : hi
  let lastError = null
  for (let port = first; port <= last; port++) {
    if (port !== 0 && allocatedBy(spec.proto, spec.host, port)) {
      lastError = { reason: 'allocated', port }
      continue
    }
    try {
      const { handle, addresses } = await open(spec.proto, spec.host, port)
      const listener = { spec, handle, addresses, target: spec.target || null }
      listener.port = handle.address().port
      if (spec.proto === 'tcp') serveTcp(listener)
      else serveUdp(listener)
      return { listener }
    } catch (error) {
      lastError = { reason: error.code === 'EADDRINUSE' ? 'in-use' : 'other', port, message: error.message }
    }
  }
  return { error: lastError || { reason: 'other', port: first, message: 'no port to bind' } }
}

async function apply(state) {
  const wanted = new Map(state.listeners.map(spec => [spec.key, spec]))
  for (const [key, listener] of [...listeners]) {
    const spec = wanted.get(key)
    if (spec && sameSpec(spec, listener.spec)) continue
    listeners.delete(key)
    await listener.close()
  }
  const bound = []
  const failed = []
  for (const spec of state.listeners) {
    let listener = listeners.get(spec.key)
    if (listener) {
      const before = JSON.stringify(listener.target)
      listener.spec = spec
      listener.target = spec.target || null
      if (JSON.stringify(listener.target) !== before) {
        if (spec.proto === 'udp') listener.flush()
        else if (listener.target) listener.flush()
      }
    } else {
      const result = await bind(spec)
      if (result.error) {
        failed.push({ key: spec.key, host: spec.host, proto: spec.proto, ...result.error })
        continue
      }
      listener = result.listener
      listeners.set(spec.key, listener)
    }
    bound.push({ key: spec.key, port: listener.port, addresses: listener.addresses })
  }
  say({ seq: state.seq, bound, failed })
}

let queue = Promise.resolve()
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let state
  try {
    state = JSON.parse(line)
  } catch {
    return
  }
  queue = queue.then(() => apply(state)).catch((error) => {
    say({ seq: state.seq, bound: [], failed: [], error: String(error && error.message || error) })
  })
})
process.stdin.on('end', () => process.exit(0))
say({ ready: true })
`
