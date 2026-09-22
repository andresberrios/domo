import { spawn } from 'node:child_process'
const child = spawn('/opt/domo/node/bin/node', [
  '/opt/browser/node_modules/@playwright/mcp/cli.js',
  '--headless', '--isolated', '--no-sandbox', '--ignore-https-errors',
  '--executable-path', '/opt/browser/browser/chrome-headless-shell',
  '--output-dir', '/out'
], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env,
  LD_LIBRARY_PATH: '/opt/browser/lib', FONTCONFIG_PATH: '/opt/browser/fontconfig', HOME: '/tmp' } })
let buf = ''
const waiters = new Map()
child.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id) }
  }
})
let id = 0
const rpc = (method, params) => new Promise(res => {
  const n = ++id
  waiters.set(n, res)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
})
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const tools = await rpc('tools/list', {})
console.log('TOOLS', tools.result.tools.length, tools.result.tools.map(t => t.name).slice(0, 12).join(','))
const nav = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: process.argv[2] } })
console.log('NAV_OK', !nav.result?.isError)
await new Promise(r => setTimeout(r, 4000))
const snap = await rpc('tools/call', { name: 'browser_snapshot', arguments: {} })
const text = (snap.result?.content ?? []).map(c => c.text ?? '').join('\n')
console.log('snapshot_chars', text.length)
console.log('SNAPSHOT_HEAD:\n' + text.split('\n').filter(l => /heading|button|link/.test(l)).slice(0, 8).join('\n'))
const shot = await rpc('tools/call', { name: 'browser_take_screenshot', arguments: { filename: '/out/mcp-domo.png', fullPage: false } })
console.log('SHOT', (shot.result?.content ?? []).map(c => c.text ?? `[${c.type}]`).join(' ').slice(0, 160))
child.kill()
