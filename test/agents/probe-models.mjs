// Ad-hoc probe: what does each adapter offer as `configOptions` on session/new?
// Run with the credentials in the environment. Prints ids only, never secrets.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const require = createRequire(join(process.cwd(), 'package.json'))

function entry(pkg) {
  const p = require.resolve(`${pkg}/package.json`)
  const meta = require(p)
  const bin = typeof meta.bin === 'string' ? meta.bin : Object.values(meta.bin)[0]
  return join(dirname(p), bin)
}

async function probe(label, pkg, env) {
  const cwd = await mkdtemp(join(tmpdir(), 'domo-probe-'))
  const child = spawn(process.execPath, [entry(pkg)], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buf = ''
  const want = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && want.has(msg.id)) { want.get(msg.id)(msg); want.delete(msg.id) }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', d => process.stderr.write(`[${label}:stderr] ${d}`))

  let id = 0
  const send = (method, params) => new Promise((res, rej) => {
    const myId = ++id
    want.set(myId, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`)
    setTimeout(() => rej(new Error(`${label} ${method} timed out`)), 120000)
  })

  try {
    const init = await send('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'domo-probe', version: '1.0.0' }
    })
    console.log(`\n=== ${label} ===`)
    console.log('mcpCapabilities:', JSON.stringify(init?.agentCapabilities?.mcpCapabilities))
    const created = await send('session/new', { cwd, mcpServers: [] })
    for (const opt of created.configOptions ?? []) {
      const opts = (opt.options ?? []).flatMap(o => (o.options ? o.options : [o]))
      console.log(`  option id=${opt.id} category=${opt.category} current=${JSON.stringify(opt.currentValue)}`)
      for (const o of opts) console.log(`     - ${o.value}   (${o.name})  :: ${o.description ?? ''}`)
    }
    if (created.modes) {
      console.log('  modes current:', created.modes.currentModeId,
        'available:', (created.modes.availableModes ?? []).map(m => m.id).join(', '))
    }
  } catch (e) {
    console.log(`\n=== ${label} FAILED: ${e.message}`)
  } finally {
    child.kill('SIGTERM')
  }
}

await probe('claude-code', '@agentclientprotocol/claude-agent-acp', {
  CLAUDE_CODE_OAUTH_TOKEN: process.env.NUXT_CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN
})
await probe('codex', '@agentclientprotocol/codex-acp', {
  ...(process.env.NUXT_CODEX_API_KEY ? { CODEX_API_KEY: process.env.NUXT_CODEX_API_KEY } : {})
})
process.exit(0)
