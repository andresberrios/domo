// Ad-hoc: build a real environment, run claude-agent-acp inside it by hand, and
// print everything it says. Removes the environment afterwards.
process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-agents-test-'
process.env.NUXT_CLAUDE_CONFIG_DIR = '/nonexistent-domo-agents-test'
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:password@localhost:54321/domo_test'

const { spawn } = await import('node:child_process')
const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const { run } = await import('../../server/lib/dev-env/docker')
const { DEFAULT_IMAGE } = await import('../../server/lib/dev-env/config')
const { createProject } = await import('../../server/lib/repo')
const { createEnvironment, removeEnvironment, containerExecArgs } = await import('../../server/lib/dev-environments')
const { adapterCommandPath } = await import('../../server/lib/dev-env/runtime-volume')

const repo = await mkdtemp(join(tmpdir(), 'domo-probe-repo-'))
await run('git', ['init', '--quiet', '--initial-branch=main', repo])
await writeFile(join(repo, 'README.md'), '# fixture\n')
await mkdir(join(repo, 'src'), { recursive: true })
await writeFile(join(repo, '.domo.json'), JSON.stringify({
  devEnvironment: { image: DEFAULT_IMAGE, docker: false, remoteUser: 'vscode' }
}))
await run('git', ['-C', repo, 'add', '--all'])
await run('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '--quiet', '-m', 'f'])

const project = await createProject({ name: 'probe', repoPath: repo })
const env = await createEnvironment({ projectId: project.id, name: 'Probe' })
console.log('environment:', env.id, env.containerName, 'user:', env.remoteUser)

const inside = async (...cmd) => {
  const out = await run('docker', ['exec', '--user', env.remoteUser, env.containerId, ...cmd], { allowFailure: true })
  return out.stdout + (out.stderr ? `\nSTDERR: ${out.stderr}` : '')
}
console.log('--- HOME:', await inside('sh', '-c', 'echo $HOME'))
console.log('--- ls -la $HOME:', await inside('sh', '-c', 'ls -la $HOME'))
console.log('--- .claude.json:', await inside('sh', '-c', 'cat $HOME/.claude.json || echo MISSING'))
console.log('--- ls .claude:', await inside('sh', '-c', 'ls -la $HOME/.claude || echo MISSING'))

const adapterEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/vscode',
  USER: 'vscode',
  LOGNAME: 'vscode',
  CLAUDE_CODE_OAUTH_TOKEN: process.env.NUXT_CLAUDE_CODE_OAUTH_TOKEN || ''
}
const args = [...containerExecArgs(env, adapterEnv), 'sh', '-c', 'exec "$1"', 'sh', adapterCommandPath('claude-code')]
console.log('--- spawning adapter')
const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.setEncoding('utf8')
child.stderr.on('data', d => process.stdout.write(`[stderr] ${d}`))
child.stdout.setEncoding('utf8')
let buf = ''
const want = new Map()
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    console.log(`[stdout] ${line.slice(0, 2000)}`)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id && want.has(m.id)) { want.get(m.id)(m); want.delete(m.id) }
  }
})
let id = 0
const send = (method, params) => new Promise((res) => {
  const myId = ++id
  want.set(myId, res)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`)
  setTimeout(() => res({ error: { message: 'TIMEOUT' } }), 90000)
})

await send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  clientInfo: { name: 'domo', version: '1.0.0' }
})
const created = await send('session/new', { cwd: env.workspacePath, mcpServers: [] })
console.log('--- session/new result:', JSON.stringify(created).slice(0, 3000))

child.kill('SIGTERM')
await removeEnvironment(env.id)
await rm(repo, { recursive: true, force: true })
process.exit(0)
