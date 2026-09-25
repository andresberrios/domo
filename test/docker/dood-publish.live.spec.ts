import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * An environment's `localhost` as the host its containers publish on, and the
 * environment as the host `host.docker.internal` means inside them — with the
 * real `docker` CLI and real `docker compose`, through the real proxy, against
 * two stand-in environments on the shared daemon.
 *
 * Each stand-in is a plain `node` container: a shell and a Node to run the
 * agent's side of each check with, which is all an environment is to this.
 * "From the environment" means *in its network namespace*, so a check either
 * runs with `docker exec` in the stand-in or in a throwaway container started
 * with `--network container:<stand-in>` (psql, which the stand-in lacks).
 *
 * The Ports panel's repo is an in-memory table, as in `dood-ports.live.spec.ts`.
 * Opt in with `pnpm test:docker`.
 */

const state = vi.hoisted(() => ({ rows: [] as any[], environment: null as any }))

vi.mock('../../server/lib/repo', () => {
  const find = (id: string, port: number, protocol: string, service: string | null) =>
    state.rows.find(row => row.devEnvironmentId === id && row.innerPort === port
      && row.protocol === protocol && row.service === service)
  const withUrl = (row: any) => ({ ...row, url: row.hostPort ? `http://127.0.0.1:${row.hostPort}` : null })
  return {
    getDevEnvironment: async () => state.environment,
    listDevEnvironments: async () => [state.environment],
    listDevEnvironmentPorts: async () => state.rows.map(withUrl),
    upsertDevEnvironmentPort: async (input: any) => {
      const service = input.service ?? null
      let row = find(input.environmentId, input.innerPort, input.protocol, service)
      if (!row) {
        row = {
          id: `port_${state.rows.length}`, devEnvironmentId: input.environmentId, service,
          innerPort: input.innerPort, protocol: input.protocol, appProtocol: input.appProtocol ?? null,
          label: input.label ?? null, source: input.source, hostPort: null, listening: false, forwarded: false
        }
        state.rows.push(row)
      }
      row.listening = input.listening ?? false
      return withUrl(row)
    },
    updateDevEnvironmentPort: async (id: string, port: number, patch: any, protocol = 'tcp', service = null) => {
      const row = find(id, port, protocol, service)
      if (!row) return null
      Object.assign(row, patch)
      return withUrl(row)
    }
  }
})

// Its own port helper and helper image, not the developer's: both are one per install.
process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-dood-pub-test-'

const { run } = await import('../../server/lib/dev-env/docker')
const { portHelperImage, portHelperName } = await import('../../server/lib/dev-env/port-helper')
const { ensureDoodProxy, stopDoodProxy, sweepEnvironmentResources, ensureEnvironmentNetwork }
  = await import('../../server/lib/dood/manager')
const { refreshEnvironmentPorts, stopAllEnvironmentForwarders } = await import('../../server/lib/dev-environment-ports')

const NODE = 'node:22-bookworm-slim'
const POSTGRES = 'postgres:17-alpine'
const WORKSPACE = '/workspaces/probe'

interface Env {
  id: string
  container: string
  volume: string
  socket: string
}

const envs: Env[] = [
  { id: 'env_d00d0000000000000pa1', container: 'domo-dood-pub-env-a', volume: 'domo-dood-pub-a-workspace', socket: '' },
  { id: 'env_d00d0000000000000pb1', container: 'domo-dood-pub-env-b', volume: 'domo-dood-pub-b-workspace', socket: '' }
]
const [A, B] = envs as [Env, Env]

const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true })
  .then(output => output.stdout.length > 0).catch(() => false)

let workDir: string
let socketDir: string

/** `WHO` is what `same.yaml`'s service answers with, so each environment can tell its own apart. */
const envOf = (env: Env) => ({ ...process.env, DOCKER_HOST: `unix://${env.socket}`, WHO: env === A ? 'in-a' : 'in-b' })

/** The `docker` CLI as an agent in `env` runs it. */
const cli = (env: Env, args: string[], allowFailure = false) =>
  run('docker', args, { env: envOf(env), allowFailure })

const compose = (env: Env, project: string, file: string, args: string[], allowFailure = false) =>
  run('docker', ['compose', '-p', project, '-f', file, ...args], { cwd: workDir, env: envOf(env), allowFailure })

/** Node, inside the environment. */
const nodeIn = (env: Env, script: string, allowFailure = true) =>
  run('docker', ['exec', env.container, 'node', '-e', script], { allowFailure })

/** A server the agent runs in the environment, in the background. */
const serveIn = (env: Env, script: string) => run('docker', ['exec', '-d', env.container, 'node', '-e', script])

const FETCH = (url: string) => `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(4000) })`
  + '.then(r => r.text()).then(t => process.stdout.write(t))'
  + '.catch(e => { process.stderr.write(String(e.cause?.code || e.cause || e.message)); process.exit(1) })'

/** `url` fetched from inside the environment. */
const fetchIn = async (env: Env, url: string) => (await nodeIn(env, FETCH(url))).stdout

/** Whether a TCP connection to `host:port` from inside the environment is accepted. */
const connectsIn = async (env: Env, port: number, host = '127.0.0.1') => (await nodeIn(env,
  `const s = require('net').connect(${port}, ${JSON.stringify(host)}); s.on('connect', () => { process.stdout.write('open'); s.destroy() });`
  + 's.on(\'error\', e => process.stdout.write(e.code))')).stdout

/** One UDP round trip from inside the environment. */
const udpIn = async (env: Env, port: number, message: string) => (await nodeIn(env, [
  'const s = require(\'dgram\').createSocket(\'udp4\')',
  's.on(\'message\', m => { process.stdout.write(String(m)); process.exit(0) })',
  `const send = () => s.send(${JSON.stringify(message)}, ${port}, '127.0.0.1')`,
  'send(); setInterval(send, 300); setTimeout(() => process.exit(1), 5000)'
].join(';'))).stdout

/** An HTTP server answering with $NAME on each port in $PORTS; `/die` makes it exit 1. */
const HTTP_SERVER = [
  'const http = require(\'http\')',
  'for (const port of (process.env.PORTS || \'80\').split(\',\')) {',
  '  http.createServer((q, r) => { if (q.url === \'/die\') { r.end(\'dying\'); setTimeout(() => process.exit(1), 50); return }',
  '    r.end((process.env.NAME || \'ok\') + \':\' + port) }).listen(Number(port))',
  '}'
].join('\n')

const UDP_ECHO = 'const s = require(\'dgram\').createSocket(\'udp4\'); '
  + 's.on(\'message\', (m, r) => s.send(\'echo:\' + m, r.port, r.address)); s.bind(Number(process.env.PORT || 53))'

/** Poll until `check` stops throwing: a server takes a moment to listen, a reconcile a moment to land. */
async function eventually<T>(check: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}

const answers = (env: Env, url: string, expected: string) => eventually(async () => {
  expect(await fetchIn(env, url)).toBe(expected)
})

const refused = (env: Env, port: number) => eventually(async () => {
  expect(await connectsIn(env, port)).toBe('ECONNREFUSED')
})

const envAddress = async (env: Env) =>
  (await run('docker', ['inspect', '--format', '{{.NetworkSettings.Networks.bridge.IPAddress}}', env.container])).stdout

async function cleanup() {
  stopAllEnvironmentForwarders()
  for (const env of envs) {
    await stopDoodProxy(env.id).catch(() => {})
    await run('docker', ['rm', '-f', env.container], { allowFailure: true })
    await sweepEnvironmentResources(env.id).catch(() => {})
    await run('docker', ['volume', 'rm', '-f', env.volume], { allowFailure: true })
  }
  await run('docker', ['rm', '-f', portHelperName()], { allowFailure: true })
}

async function startEnvironment(env: Env) {
  await run('docker', ['volume', 'create', env.volume])
  // A stand-in for the environment's own container: the labels that mark it
  // as one, a shell, and a Node for the agent's side of each check.
  await run('docker', [
    'run', '-d', '--name', env.container, '--label', 'domo.dood=true', '--label', `domo.envId=${env.id}`,
    NODE, 'sleep', 'infinity'
  ])
  env.socket = (await ensureDoodProxy({
    environmentId: env.id,
    containerReference: env.container,
    workspacePath: WORKSPACE,
    workspaceVolume: env.volume,
    helperImage: NODE
  })).socketPath
  await ensureEnvironmentNetwork(env.id)
}

describe.skipIf(!daemon)('publishing on the environment\'s own localhost', () => {
  beforeAll(async () => {
    socketDir = await mkdtemp('/tmp/ddp-')
    process.env.NUXT_DOOD_SOCKET_DIR = socketDir
    await cleanup()
    for (const image of [NODE, POSTGRES]) {
      const present = await run('docker', ['image', 'inspect', image], { allowFailure: true })
      if (!present.stdout.startsWith('[{')) await run('docker', ['pull', image])
    }
    for (const env of envs) await startEnvironment(env)

    workDir = await mkdtemp(join(tmpdir(), 'domo-dood-pub-stack-'))
    await writeFile(join(workDir, 'postgres.yaml'), [
      'services:',
      '  db:',
      `    image: ${POSTGRES}`,
      '    environment: { POSTGRES_PASSWORD: pw }',
      '    ports: ["5432:5432"]',
      ''
    ].join('\n'))
    await writeFile(join(workDir, 'web.yaml'), [
      'services:',
      '  web:',
      `    image: ${NODE}`,
      `    command: ["node", "-e", ${JSON.stringify(HTTP_SERVER)}]`,
      '    environment: { NAME: web }',
      // No host port: the daemon — here, the relay — picks one.
      '    ports: ["80"]',
      ''
    ].join('\n'))
    await writeFile(join(workDir, 'callback.yaml'), [
      'services:',
      '  plain:',
      `    image: ${NODE}`,
      '    command: ["sleep", "600"]',
      '  gateway:',
      `    image: ${NODE}`,
      '    command: ["sleep", "600"]',
      '    extra_hosts: ["host.docker.internal:host-gateway"]',
      ''
    ].join('\n'))
    await writeFile(join(workDir, 'same.yaml'), [
      'services:',
      '  app:',
      `    image: ${NODE}`,
      `    command: ["node", "-e", ${JSON.stringify(HTTP_SERVER)}]`,
      '    environment: { NAME: "${WHO}" }',
      '    ports: ["8080:80"]',
      ''
    ].join('\n'))
  }, 600_000)

  afterAll(async () => {
    await cleanup()
    await run('docker', ['rmi', portHelperImage()], { allowFailure: true })
    delete process.env.NUXT_DOOD_SOCKET_DIR
    delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
    for (const dir of [workDir, socketDir]) if (dir) await rm(dir, { recursive: true, force: true })
  }, 300_000)

  it('reaches a compose postgres with ports ["5432:5432"] at localhost:5432 from the environment', async () => {
    await compose(A, 'pg', 'postgres.yaml', ['up', '-d'])
    const psql = () => run('docker', [
      'run', '--rm', '--network', `container:${A.container}`, '--env', 'PGPASSWORD=pw',
      POSTGRES, 'psql', '-h', 'localhost', '-p', '5432', '-U', 'postgres', '-tAc', 'select 40 + 2'
    ])
    await eventually(async () => expect((await psql()).stdout).toBe('42'), 60_000)
    expect((await compose(A, 'pg', 'postgres.yaml', ['port', 'db', '5432'])).stdout).toBe('0.0.0.0:5432')
    await compose(A, 'pg', 'postgres.yaml', ['down'])
    await refused(A, 5432)
  }, 180_000)

  it('reaches a plain `docker run -d -p 8080:80` at localhost:8080, and reports it as Docker does', async () => {
    await cli(A, ['run', '-d', '--name', 'plain', '-e', 'NAME=plain', '-p', '8080:80', NODE, 'node', '-e', HTTP_SERVER])
    await answers(A, 'http://localhost:8080', 'plain:80')

    expect((await cli(A, ['port', 'plain'])).stdout.split('\n')).toEqual(['80/tcp -> 0.0.0.0:8080', '80/tcp -> [::]:8080'])
    expect((await cli(A, ['ps', '--filter', 'name=^plain$', '--format', '{{.Ports}}'])).stdout)
      .toBe('0.0.0.0:8080->80/tcp, [::]:8080->80/tcp')
    const inspected = JSON.parse((await cli(A, ['inspect', 'plain'])).stdout)[0]
    expect(inspected.NetworkSettings.Ports['80/tcp']).toEqual([
      { HostIp: '0.0.0.0', HostPort: '8080' }, { HostIp: '::', HostPort: '8080' }
    ])
    // Nothing is published on the daemon's own host: that is what lets two environments both have 8080.
    const host = JSON.parse((await run('docker', ['inspect', `${A.id}-plain`])).stdout)[0]
    expect(host.HostConfig.PortBindings).toEqual({})

    await cli(A, ['rm', '-f', 'plain'])
    await refused(A, 8080)
  }, 120_000)

  it('relays UDP both ways', async () => {
    await cli(A, ['run', '-d', '--name', 'udp', '-e', 'PORT=5353', '-p', '5353:5353/udp', NODE, 'node', '-e', UDP_ECHO])
    await eventually(async () => expect(await udpIn(A, 5353, 'ping')).toBe('echo:ping'))
    expect((await cli(A, ['port', 'udp'])).stdout).toContain('5353/udp -> 0.0.0.0:5353')
    await cli(A, ['rm', '-f', 'udp'])
  }, 120_000)

  it('binds 127.0.0.1: on loopback only, and the default on every address', async () => {
    await cli(A, ['run', '-d', '--name', 'bindings', '-e', 'PORTS=80,81',
      '-p', '127.0.0.1:8181:80', '-p', '8282:81', NODE, 'node', '-e', HTTP_SERVER])
    await answers(A, 'http://127.0.0.1:8181', 'ok:80')
    await answers(A, 'http://127.0.0.1:8282', 'ok:81')
    const address = await envAddress(A)
    // From inside the environment, its own bridge address is not loopback.
    expect(await connectsIn(A, 8181, address)).toBe('ECONNREFUSED')
    expect(await connectsIn(A, 8282, address)).toBe('open')
    expect((await cli(A, ['port', 'bindings', '80'])).stdout).toBe('127.0.0.1:8181')
    await cli(A, ['rm', '-f', 'bindings'])
  }, 120_000)

  it('publishes a range pairwise, and takes the first free port of a host range', async () => {
    // The agent is already using the first port of the host range.
    await serveIn(A, 'require(\'net\').createServer().listen(18200)')
    await eventually(async () => expect(await connectsIn(A, 18200)).toBe('open'))
    await cli(A, ['run', '-d', '--name', 'ranges', '-e', 'PORTS=80,81,82,90',
      '-p', '18100-18102:80-82', '-p', '18200-18205:90', NODE, 'node', '-e', HTTP_SERVER])
    for (const [host, inner] of [[18100, 80], [18101, 81], [18102, 82]]) {
      await answers(A, `http://127.0.0.1:${host}`, `ok:${inner}`)
    }
    expect((await cli(A, ['port', 'ranges', '90'])).stdout.split('\n')[0]).toBe('0.0.0.0:18201')
    await answers(A, 'http://127.0.0.1:18201', 'ok:90')
    await cli(A, ['rm', '-f', 'ranges'])
  }, 120_000)

  it('publishes every exposed port on a free one for -P, and reports where', async () => {
    await cli(A, ['run', '-d', '--name', 'all', '-e', 'PORTS=80,81', '--expose', '80', '--expose', '81', '-P',
      NODE, 'node', '-e', HTTP_SERVER])
    const lines = (await eventually(async () => {
      const out = (await cli(A, ['port', 'all'])).stdout
      expect(out.split('\n')).toHaveLength(4)
      return out
    })).split('\n')
    for (const inner of [80, 81]) {
      const line = lines.find(entry => entry.startsWith(`${inner}/tcp -> 0.0.0.0:`))!
      const port = Number(line.split(':').at(-1))
      expect(port).toBeGreaterThan(1024)
      await answers(A, `http://127.0.0.1:${port}`, `ok:${inner}`)
    }
    await cli(A, ['rm', '-f', 'all'])
  }, 120_000)

  it('allocates a port when none was named, and every way of asking reports the same one', async () => {
    await compose(A, 'alloc', 'web.yaml', ['up', '-d'])
    const reported = (await compose(A, 'alloc', 'web.yaml', ['port', 'web', '80'])).stdout
    expect(reported).toMatch(/^0\.0\.0\.0:\d+$/)
    const port = reported.split(':')[1]!
    expect((await cli(A, ['port', 'alloc-web-1', '80'])).stdout.split('\n')).toEqual([`0.0.0.0:${port}`, `[::]:${port}`])
    expect((await cli(A, ['ps', '--filter', 'name=alloc-web-1', '--format', '{{.Ports}}'])).stdout)
      .toBe(`0.0.0.0:${port}->80/tcp, [::]:${port}->80/tcp`)
    const inspected = JSON.parse((await cli(A, ['inspect', 'alloc-web-1'])).stdout)[0]
    expect(inspected.NetworkSettings.Ports['80/tcp'][0]).toEqual({ HostIp: '0.0.0.0', HostPort: port })
    // …while the requested publishing is shown as it was asked.
    expect(inspected.HostConfig.PortBindings['80/tcp'][0].HostPort).toBe('')
    await answers(A, `http://localhost:${port}`, 'web:80')
  }, 120_000)

  it('lets two environments publish the same host port at once, each reaching its own service', async () => {
    await compose(A, 'same', 'same.yaml', ['up', '-d'])
    await compose(B, 'same', 'same.yaml', ['up', '-d'])
    await answers(A, 'http://localhost:8080', 'in-a:80')
    await answers(B, 'http://localhost:8080', 'in-b:80')
  }, 180_000)

  it('refuses a start whose port is taken, in Docker\'s words, and leaves nothing half-started', async () => {
    // 8080 is `same-app-1`'s in A, from the test above.
    const clash = await cli(A, ['run', '-d', '--name', 'clash', '-e', 'PORTS=80,81', '-p', '8383:81', '-p', '8080:80',
      NODE, 'node', '-e', HTTP_SERVER], true)
    expect(clash.stderr).toMatch(
      /driver failed programming external connectivity on endpoint clash \([0-9a-f]{64}\): Bind for 0\.0\.0\.0:8080 failed: port is already allocated/
    )
    expect((await cli(A, ['inspect', '--format', '{{.State.Status}}', 'clash'])).stdout).toBe('created')
    // The port it did get before the clash was given back.
    expect(await connectsIn(A, 8383)).toBe('ECONNREFUSED')
    expect((await cli(A, ['port', 'clash'])).stdout).toBe('')
    await answers(A, 'http://localhost:8080', 'in-a:80')

    // Something of the agent's own holding the port is the userland proxy's error.
    await serveIn(A, 'require(\'net\').createServer().listen(8484)')
    await eventually(async () => expect(await connectsIn(A, 8484)).toBe('open'))
    const busy = await cli(A, ['run', '-d', '--name', 'busy', '-p', '8484:80', NODE, 'node', '-e', HTTP_SERVER], true)
    expect(busy.stderr).toMatch(/listen tcp4 0\.0\.0\.0:8484: bind: address already in use/)
    expect((await cli(A, ['inspect', '--format', '{{.State.Status}}', 'busy'])).stdout).toBe('created')
    await cli(A, ['rm', '-f', 'clash', 'busy'])
  }, 120_000)

  it('follows a service through `compose restart`, `docker restart` and a restart policy', async () => {
    await compose(A, 'same', 'same.yaml', ['restart'])
    await answers(A, 'http://localhost:8080', 'in-a:80')
    await cli(A, ['restart', 'same-app-1'])
    await answers(A, 'http://localhost:8080', 'in-a:80')

    await cli(A, ['run', '-d', '--name', 'phoenix', '--restart', 'always', '-e', 'NAME=phoenix', '-p', '8585:80',
      NODE, 'node', '-e', HTTP_SERVER])
    await answers(A, 'http://localhost:8585', 'phoenix:80')
    const restarts = async () => Number((await cli(A, ['inspect', '--format', '{{.RestartCount}}', 'phoenix'])).stdout)
    expect(await fetchIn(A, 'http://localhost:8585/die')).toBe('dying')
    await eventually(async () => expect(await restarts()).toBeGreaterThan(0))
    await answers(A, 'http://localhost:8585', 'phoenix:80')
    await cli(A, ['rm', '-f', 'phoenix'])
  }, 180_000)

  it('points host.docker.internal at the environment — loopback-only servers included — for compose and docker run', async () => {
    await serveIn(A, 'require(\'http\').createServer((q, r) => r.end(\'loopback\')).listen(5173, \'127.0.0.1\')')
    await serveIn(A, 'require(\'http\').createServer((q, r) => r.end(\'everywhere\')).listen(5174)')
    await compose(A, 'cb', 'callback.yaml', ['up', '-d'])
    const fromService = (service: string, url: string) =>
      compose(A, 'cb', 'callback.yaml', ['exec', '-T', service, 'node', '-e', FETCH(url)], true)
    for (const service of ['plain', 'gateway']) {
      await eventually(async () => {
        expect((await fromService(service, 'http://host.docker.internal:5173')).stdout).toBe('loopback')
      })
      expect((await fromService(service, 'http://host.docker.internal:5174')).stdout).toBe('everywhere')
    }
    // What compose asked for is what inspect shows.
    const gateway = JSON.parse((await cli(A, ['inspect', 'cb-gateway-1'])).stdout)[0]
    expect(gateway.HostConfig.ExtraHosts).toEqual(['host.docker.internal:host-gateway'])

    const fromRun = await cli(A, ['run', '--rm', NODE, 'node', '-e', FETCH('http://host.docker.internal:5173')], true)
    expect(fromRun.stdout, fromRun.stderr).toBe('loopback')
  }, 180_000)

  it('keeps the relays out of the Ports panel\'s own list, and still forwards published ports to the Mac', async () => {
    state.environment = {
      id: A.id, containerId: A.container, containerName: A.container, status: 'running',
      remoteUser: 'root', workspacePath: WORKSPACE
    }
    const forwarded = await eventually(async () => {
      const ports = await refreshEnvironmentPorts(A.id)
      const app = ports.find(port => port.service === 'same-app-1' && port.innerPort === 80)
      expect(app?.forwarded && app.url).toBeTruthy()
      return { ports, app: app! }
    })
    const own = forwarded.ports.filter(port => !port.service).map(port => port.innerPort)
    // The agent's own servers are its; 8080 is the relay's, i.e. same-app-1's.
    expect(own).toEqual(expect.arrayContaining([5173, 5174]))
    expect(own).not.toContain(8080)
    expect(await (await fetch(forwarded.app.url!)).text()).toBe('in-a:80')
    stopAllEnvironmentForwarders()
  }, 120_000)

  it('re-establishes the relays and the redirect when the environment restarts', async () => {
    await run('docker', ['restart', '-t', '0', A.container])
    // The agent's servers died with the environment; it starts its dev server again.
    await serveIn(A, 'require(\'http\').createServer((q, r) => r.end(\'loopback again\')).listen(5173, \'127.0.0.1\')')
    await answers(A, 'http://localhost:8080', 'in-a:80')
    await eventually(async () => {
      const out = await compose(A, 'cb', 'callback.yaml', ['exec', '-T', 'plain', 'node', '-e', FETCH('http://host.docker.internal:5173')], true)
      expect(out.stdout).toBe('loopback again')
    })
    // B was never touched.
    await answers(B, 'http://localhost:8080', 'in-b:80')
  }, 180_000)

  it('takes the relays down with `compose down`', async () => {
    const port = Number((await compose(A, 'alloc', 'web.yaml', ['port', 'web', '80'])).stdout.split(':')[1])
    await compose(A, 'alloc', 'web.yaml', ['down'])
    await compose(A, 'same', 'same.yaml', ['down'])
    await compose(A, 'cb', 'callback.yaml', ['down'])
    await refused(A, 8080)
    await refused(A, port)
    await answers(B, 'http://localhost:8080', 'in-b:80')
    await compose(B, 'same', 'same.yaml', ['down'])
    await refused(B, 8080)
  }, 180_000)
})
