// `pnpm dev`: the Nuxt dev server plus a Caddy HTTPS proxy in front of it
// (see ../Caddyfile). If either process exits, the other is stopped too.
import { spawn, spawnSync } from 'node:child_process'

const port = process.env.DOMO_DEV_PORT ??= '3000'
const address = process.env.DOMO_HTTPS_ADDRESS ??= 'localhost:3443'

if (spawnSync('caddy', ['version']).error) {
  console.error('caddy not found on PATH — install it (e.g. `brew install caddy`) or run `pnpm dev:http`.')
  process.exit(1)
}

const children = [
  spawn('caddy', ['run', '--config', 'Caddyfile', '--adapter', 'caddyfile'], { stdio: 'inherit' }),
  spawn('nuxt', ['dev', '--port', port], { stdio: 'inherit' })
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
