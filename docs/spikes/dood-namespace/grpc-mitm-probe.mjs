// Spike probe: can the DooD proxy terminate BuildKit's `/grpc` HTTP/2 channel
// (instead of splicing its frames) and read — then rewrite — a build's gRPC
// messages? Listens on a unix socket, splices everything to the daemon except
// `POST /grpc`, which it upgrades itself and bridges with two `node:http2`
// sessions, one per side, so each side keeps its own flow control.
//
//   node grpc-mitm-probe.mjs /tmp/probe.sock [--rewrite <prefix>] [--context name=ref ...]
//   DOCKER_HOST=unix:///tmp/probe.sock docker build -t app .
//
// Logs every gRPC call, and decodes Control/Solve requests and responses.
import http2 from 'node:http2'
import net from 'node:net'
import fs from 'node:fs'

const [socketPath, ...flags] = process.argv.slice(2)
const rewritePrefix = flags.includes('--rewrite') ? flags[flags.indexOf('--rewrite') + 1] : null
const contexts = flags.flatMap((flag, i) => flag === '--context' ? [flags[i + 1]] : [])
const DAEMON = '/var/run/docker.sock'
const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args)

// ---- minimal protobuf wire format ------------------------------------------
function readVarint(buf, pos) {
  let result = 0n; let shift = 0n
  for (;;) {
    const byte = buf[pos++]
    result |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [Number(result), pos]
    shift += 7n
  }
}
function writeVarint(value) {
  const out = []
  let v = BigInt(value)
  do { let byte = Number(v & 0x7fn); v >>= 7n; if (v) byte |= 0x80; out.push(byte) } while (v)
  return Buffer.from(out)
}
/** Top-level fields as [{ field, wire, value(Buffer|number), raw(Buffer) }], order kept. */
function decode(buf) {
  const fields = []; let pos = 0
  while (pos < buf.length) {
    const start = pos
    let key; [key, pos] = readVarint(buf, pos)
    const field = key >>> 3; const wire = key & 7
    let value
    if (wire === 0) [value, pos] = readVarint(buf, pos)
    else if (wire === 2) { let len; [len, pos] = readVarint(buf, pos); value = buf.subarray(pos, pos + len); pos += len }
    else if (wire === 1) { value = buf.subarray(pos, pos + 8); pos += 8 }
    else if (wire === 5) { value = buf.subarray(pos, pos + 4); pos += 4 }
    else throw new Error(`wire type ${wire}`)
    fields.push({ field, wire, value, raw: buf.subarray(start, pos) })
  }
  return fields
}
const lenField = (field, bytes) => Buffer.concat([writeVarint((field << 3) | 2), writeVarint(bytes.length), bytes])
const mapEntry = (entry) => {
  const f = decode(entry)
  return [f.find(x => x.field === 1)?.value.toString() ?? '', f.find(x => x.field === 2)?.value.toString() ?? '']
}
const encodeMapEntry = (field, key, value) =>
  lenField(field, Buffer.concat([lenField(1, Buffer.from(key)), lenField(2, Buffer.from(value))]))

// SolveRequest: 7 FrontendAttrs map<string,string>, 13 Exporters repeated { 1 Type, 2 Attrs map }
function describeSolveRequest(buf) {
  const out = { frontendAttrs: {}, exporters: [] }
  for (const f of decode(buf)) {
    if (f.field === 1) out.ref = f.value.toString()
    if (f.field === 6) out.frontend = f.value.toString()
    if (f.field === 7) { const [k, v] = mapEntry(f.value); out.frontendAttrs[k] = v.length > 120 ? v.slice(0, 120) + '…' : v }
    if (f.field === 13) {
      const ex = { attrs: {} }
      for (const g of decode(f.value)) {
        if (g.field === 1) ex.type = g.value.toString()
        if (g.field === 2) { const [k, v] = mapEntry(g.value); ex.attrs[k] = v }
      }
      out.exporters.push(ex)
    }
  }
  return out
}
function rewriteSolveRequest(buf) {
  const parts = []
  for (const f of decode(buf)) {
    if (f.field === 13 && rewritePrefix) {
      const inner = []
      for (const g of decode(f.value)) {
        if (g.field === 2) {
          const [k, v] = mapEntry(g.value)
          if (k === 'name') {
            const renamed = v.split(',').map(name => `${rewritePrefix}/${name}`).join(',')
            inner.push(encodeMapEntry(2, k, renamed)); continue
          }
        }
        inner.push(g.raw)
      }
      parts.push(lenField(13, Buffer.concat(inner))); continue
    }
    parts.push(f.raw)
  }
  for (const pair of contexts) {
    const [name, ref] = pair.split('=')
    parts.push(encodeMapEntry(7, `context:${name}`, `docker-image://${ref}`))
  }
  return Buffer.concat(parts)
}
// LLBBridge SolveRequest (the gateway call the Dockerfile frontend is invoked
// through): 2 Frontend, 3 FrontendOpt map<string,string>.
function describeBridgeSolve(buf) {
  const out = { frontendOpt: {} }
  for (const f of decode(buf)) {
    if (f.field === 2) out.frontend = f.value.toString()
    if (f.field === 3) { const [k, v] = mapEntry(f.value); out.frontendOpt[k] = v.length > 120 ? v.slice(0, 120) + '…' : v }
  }
  return out
}
function rewriteBridgeSolve(buf) {
  const fields = decode(buf)
  // Only a call that runs a frontend resolves FROM lines.
  if (!fields.some(f => f.field === 2 && f.value.length)) return buf
  const parts = fields.map(f => f.raw)
  for (const pair of contexts) {
    const [name, ref] = pair.split('=')
    parts.push(encodeMapEntry(3, `context:${name}`, `docker-image://${ref}`))
  }
  return Buffer.concat(parts)
}
// Hiding the private name again on the way back. BuildKit spells a name the
// way `docker` normalised it, so both the short and the docker.io forms go.
function unprivate(text) {
  if (!rewritePrefix) return text
  return text
    .replaceAll(`docker.io/${rewritePrefix}/`, 'docker.io/library/')
    .replaceAll(`${rewritePrefix}/`, '')
    .replaceAll('docker.io/library/docker.io/', 'docker.io/')
}
function rewriteStrings(buf, paths) {
  // paths: { field: true } for a string to rewrite, { field: {...} } to recurse.
  const out = []
  for (const f of decode(buf)) {
    const rule = paths[f.field]
    if (f.wire === 2 && rule === true) out.push(lenField(f.field, Buffer.from(unprivate(f.value.toString()))))
    else if (f.wire === 2 && rule && typeof rule === 'object') out.push(lenField(f.field, rewriteStrings(f.value, rule)))
    else out.push(f.raw)
  }
  return Buffer.concat(out)
}
// StatusResponse: 1 Vertex{3 name}, 2 VertexStatus{1 ID, 3 name}, 3 VertexLog{3 msg},
// 4 VertexWarning{3 short, 4 detail}.
const STATUS_STRINGS = { 1: { 3: true }, 2: { 1: true, 3: true }, 3: { 3: true }, 4: { 3: true, 4: true } }
// SolveResponse: 1 ExporterResponse map entries {1 key, 2 value}.
const SOLVE_RESPONSE_STRINGS = { 1: { 2: true } }
const grpcFrame = (msg) => { const h = Buffer.alloc(5); h.writeUInt32BE(msg.length, 1); return Buffer.concat([h, msg]) }
/** Complete gRPC messages in a buffer; returns [messages, rest]. */
function grpcMessages(buf) {
  const msgs = []
  while (buf.length >= 5) {
    const len = buf.readUInt32BE(1)
    if (buf.length < 5 + len) break
    msgs.push(buf.subarray(5, 5 + len)); buf = buf.subarray(5 + len)
  }
  return [msgs, buf]
}

// ---- the h2 bridge -----------------------------------------------------------
function bridge(client, upstream, id) {
  const server = http2.createServer()
  const session = http2.connect('http://docker', { createConnection: () => upstream })
  session.on('error', e => log(id, 'upstream h2 error', e.message))
  // The CLI resets its socket once every call it made has been answered — no
  // GOAWAY, no FIN. That is its way of hanging up, not a failure: close the
  // daemon side cleanly, and say nothing unless a call was still open.
  let open = 0
  const hangUp = () => { if (!session.closed) session.close() }
  client.on('close', hangUp)
  server.on('sessionError', e => { if (open > 0) log(id, 'client h2 error with', open, 'calls open:', e.message); hangUp() }); server.on('session', s => { s.on('goaway', (code, last) => log(id, 'client goaway', code, last)); s.on('frameError', (t, c, sid) => log(id, 'client frameError type', t, 'code', c, 'stream', sid)) })
  server.on('stream', (stream, headers) => {
    const path = headers[':path']
    const forwarded = {}
    for (const [k, v] of Object.entries(headers)) if (!k.startsWith(':') || k === ':path' || k === ':method') forwarded[k] = v
    const req = session.request(forwarded)
    open++
    req.on('close', () => { open-- })
    const isSolve = path === '/moby.buildkit.v1.Control/Solve'
    const isBridgeSolve = path === '/moby.buildkit.v1.frontend.LLBBridge/Solve'
    log(id, '→', path)

    let pending = Buffer.alloc(0)
    stream.on('data', (chunk) => {
      if (!isSolve && !isBridgeSolve) { req.write(chunk); return }
      pending = Buffer.concat([pending, chunk])
      const [msgs, rest] = grpcMessages(pending); pending = rest
      if (isBridgeSolve) {
        for (const msg of msgs) {
          log(id, '  Bridge solve', JSON.stringify(describeBridgeSolve(msg)))
          const out = rewriteBridgeSolve(msg)
          if (!out.equals(msg)) log(id, '  rewritten   ', JSON.stringify(describeBridgeSolve(out)))
          req.write(grpcFrame(out))
        }
        return
      }
      for (const msg of msgs) {
        log(id, '  Solve request', JSON.stringify(describeSolveRequest(msg)))
        const out = rewriteSolveRequest(msg)
        if (!out.equals(msg)) log(id, '  rewritten   ', JSON.stringify(describeSolveRequest(out)))
        req.write(grpcFrame(out))
      }
    })
    stream.on('end', () => req.end())
    stream.on('close', () => { if (!req.closed) req.close() })

    req.on('response', (h) => {
      const response = {}
      for (const [k, v] of Object.entries(h)) if (!k.startsWith(':') || k === ':status') response[k] = v
      stream.respond(response, { waitForTrailers: true })
    })
    let trailers = null
    req.on('trailers', (t) => { trailers = t })
    const isStatus = path === '/moby.buildkit.v1.Control/Status'
    let responseBuf = Buffer.alloc(0)
    req.on('data', (chunk) => {
      if (!isSolve && !isStatus) { stream.write(chunk); return }
      responseBuf = Buffer.concat([responseBuf, chunk])
      const [msgs, rest] = grpcMessages(responseBuf); responseBuf = rest
      for (const msg of msgs) {
        const out = rewriteStrings(msg, isSolve ? SOLVE_RESPONSE_STRINGS : STATUS_STRINGS)
        if (isSolve) {
          const exp = {}
          for (const f of decode(out)) if (f.field === 1) { const [k, v] = mapEntry(f.value); exp[k] = v.length > 100 ? v.slice(0, 100) + '…' : v }
          log(id, '  Solve response', JSON.stringify(exp))
        }
        stream.write(grpcFrame(out))
      }
    })
    stream.on('wantTrailers', () => stream.sendTrailers(trailers ?? {}))
    req.on('end', () => stream.end())
    req.on('error', e => { log(id, 'stream error', path, e.message); stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR) })
  })
  server.emit('connection', client)
}

// ---- the splice, with /grpc taken out --------------------------------------
let seq = 0
try { fs.unlinkSync(socketPath) } catch { /* not there yet */ }
net.createServer({ allowHalfOpen: true }, (client) => {
  const id = `#${++seq}`
  let head = Buffer.alloc(0)
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end === -1) return
    const line = head.subarray(0, head.indexOf('\r\n')).toString()
    client.off('data', onData)
    client.pause()
    const upstream = net.connect({ path: DAEMON, allowHalfOpen: true })
    if (!/^POST \S*\/grpc /.test(line)) {
      // Not the build channel: splice as the real proxy does.
      upstream.write(head)
      client.pipe(upstream); upstream.pipe(client); client.resume()
      client.on('end', () => upstream.end()); upstream.on('end', () => client.end())
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy())
      return
    }
    log(id, line)
    upstream.write(head.subarray(0, end + 4))
    const leftover = head.subarray(end + 4)
    let answer = Buffer.alloc(0)
    const onAnswer = (chunk) => {
      answer = Buffer.concat([answer, chunk])
      const aEnd = answer.indexOf('\r\n\r\n')
      if (aEnd === -1) return
      upstream.off('data', onAnswer)
      upstream.pause()
      log(id, 'daemon:', answer.subarray(0, answer.indexOf('\r\n')).toString())
      client.write(answer.subarray(0, aEnd + 4))
      const upRest = answer.subarray(aEnd + 4)
      if (upRest.length) upstream.unshift(upRest)
      if (leftover.length) client.unshift(leftover)
      bridge(client, upstream, id)
    }
    upstream.on('data', onAnswer)
  }
  client.on('data', onData)
}).listen(socketPath, () => log('listening on', socketPath, rewritePrefix ? `rewrite → ${rewritePrefix}/` : '', contexts.length ? `contexts ${contexts}` : ''))
