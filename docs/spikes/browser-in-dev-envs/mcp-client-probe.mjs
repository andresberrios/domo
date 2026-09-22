import { spawn } from 'node:child_process'
const cfg = JSON.parse(process.env.MCP_CONFIG)
const child = spawn(cfg.command, cfg.args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, HOME: '/tmp', ...Object.fromEntries(cfg.env.map(e => [e.name, e.value])) }
})
let buf = ''; const waiters = new Map(); let id = 0
child.stdout.on('data', d => { buf += d; let i
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!l.trim()) continue; const m = JSON.parse(l)
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } } })
const rpc = (method, params) => new Promise(r => { const n = ++id; waiters.set(n, r)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') })
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const tools = (await rpc('tools/list', {})).result.tools
const nav = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: process.argv[2] } })
await new Promise(r => setTimeout(r, 4000))
const snap = await rpc('tools/call', { name: 'browser_snapshot', arguments: {} })
const text = (snap.result?.content ?? []).map(c => c.text ?? '').join('\n')
const shot = await rpc('tools/call', { name: 'browser_take_screenshot', arguments: {} })
const kinds = (shot.result?.content ?? []).map(c => c.type)
const img = (shot.result?.content ?? []).find(c => c.type === 'image')
console.log(JSON.stringify({
  tools: tools.length,
  navOk: !nav.result?.isError,
  snapshotChars: text.length,
  headings: text.split('\n').filter(l => /heading|button/.test(l)).length,
  shotOk: !shot.result?.isError,
  contentKinds: kinds,
  inlineImage: img ? `${img.mimeType} ${String(img.data || '').length} b64 chars` : null
}))
if (img) { const { writeFileSync } = await import('node:fs'); writeFileSync('/out/inline.png', Buffer.from(img.data, 'base64')) }
child.kill()
