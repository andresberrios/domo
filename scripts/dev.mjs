// `pnpm dev`: the Nuxt dev server plus a Caddy HTTPS proxy in front of it
// (see ../Caddyfile). If either process exits, the other is stopped too.
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'

// 3666 is the address you open ("domo" on a phone keypad); Nuxt sits on the
// next port up, behind it. Both are away from 3000 and the rest of the crowded
// dev range: another project's server on the same port does not announce
// itself, it just answers some of the requests (see the preflight below).
const port = process.env.DOMO_DEV_PORT ??= '3667'
const address = process.env.DOMO_HTTPS_ADDRESS ??= 'localhost:3666'

// Nitro reads PORT, and `internalBaseUrl()` (server/lib/internal-url.ts) builds
// the agent-mesh URL handed to every coding agent from it. `nuxt dev --port`
// leaves PORT unset, so agents dialled 3000 whatever the flag said.
process.env.PORT = port

if (spawnSync('caddy', ['version']).error) {
  console.error('caddy not found on PATH — install it (e.g. `brew install caddy`).')
  process.exit(1)
}

// Refuse to start on a port something else already answers on. Binding is not
// the test: a server holding the wildcard address (`*:3667`) does not stop
// Nuxt from binding the one address left over (`[::1]:3667`), so both end up
// listening and Caddy — which dials `localhost` — reaches whichever the
// resolver hands it first. Half the requests then come back as resets and the
// app half-loads, with nothing in the log saying why. Dialling each address
// catches that; binding one would not.
function occupant(host) {
  return new Promise(resolve => {
    const socket = connect({ host, port: Number(port) })
      .setTimeout(500)
      .on('connect', () => (socket.destroy(), resolve(host)))
      .on('timeout', () => (socket.destroy(), resolve(null)))
      .on('error', () => resolve(null))
  })
}

const taken = (await Promise.all(['127.0.0.1', '::1'].map(occupant))).filter(Boolean)
if (taken.length) {
  console.error(`port ${port} is already in use (${taken.join(', ')}) — stop whatever is listening, or pick another port with \`DOMO_DEV_PORT=… pnpm dev\`.`)
  process.exit(1)
}

const children = [
  spawn('caddy', ['run', '--config', 'Caddyfile', '--adapter', 'caddyfile'], { stdio: 'inherit' }),
  // IPv4 loopback, explicitly. Left to `localhost`, Nuxt binds `[::1]` only, and
  // Docker Desktop forwards `host.docker.internal` to 127.0.0.1: every agent in a
  // dev environment then gets `connection refused` from the mesh.
  spawn('nuxt', ['dev', '--port', port, '--host', '127.0.0.1'], { stdio: 'inherit' })
]

console.log(`\n  ➜ HTTPS: https://${address}/\n`)

let exitCode = 0
let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  exitCode = code
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}

for (const child of children) {
  child.on('exit', code => {
    stop(code ?? 0)
    if (children.every(c => c.exitCode !== null || c.signalCode !== null)) process.exit(exitCode)
  })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0))
