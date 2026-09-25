import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Binds outside the checkout, the Docker socket, and `network_mode: host` —
 * with the real `docker` CLI and real `docker compose`, through the real
 * proxy, against a stand-in environment mounted the way a real one is: its
 * checkout and a second volume, a host directory bound at `~/.aws`, and the
 * proxy's socket at `/var/run/docker.sock`.
 *
 * The clients run on the host but are told the environment's home
 * (`HOME=/home/vscode`) and working directory (`--project-directory`), which
 * is all `~` and `../` need: both are resolved by the client, and what
 * reaches the proxy is the absolute path an agent's client would send.
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
process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-dood-binds-test-'

const { run } = await import('../../server/lib/dev-env/docker')
const { portHelperImage, portHelperName } = await import('../../server/lib/dev-env/port-helper')
const { ensureDoodProxy, stopDoodProxy, ensureEnvironmentNetwork } = await import('../../server/lib/dood/manager')
const { removeEnvironmentResources } = await import('../../server/lib/dev-env/leftovers')
const { refreshEnvironmentPorts, stopAllEnvironmentForwarders } = await import('../../server/lib/dev-environment-ports')

const NODE = 'node:22-bookworm-slim'
const WORKSPACE = '/workspaces/probe'
const HOME = '/home/vscode'
const ENV_ID = 'env_d00d0000000000000bd1'
const ENV = 'domo-dood-binds-env'
const WORKSPACE_VOLUME = 'domo-dood-binds-workspace'
const CACHE_VOLUME = 'domo-dood-binds-cache'
const BYSTANDER = 'domo-dood-binds-bystander'
const THIEF = 'domo-dood-binds-thief'
const PREFIX = `${ENV_ID}-`

const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true })
  .then(output => output.stdout.length > 0).catch(() => false)

let socketPath = ''
let socketDir: string
let workDir: string
let awsDir: string

const clientEnv = () => ({
  ...process.env,
  DOCKER_HOST: `unix://${socketPath}`,
  // The environment's home, for `~`; the CLI plugins stay where they are.
  HOME,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(homedir(), '.docker')
})

/** The `docker` CLI as an agent in the environment runs it. */
const cli = (args: string[], allowFailure = false) => run('docker', args, { env: clientEnv(), allowFailure })

/** `docker compose` as an agent in the environment's checkout runs it. */
const compose = (project: string, file: string, args: string[], allowFailure = false) =>
  run('docker', ['compose', '-p', project, '-f', join(workDir, file), '--project-directory', WORKSPACE, ...args], {
    env: clientEnv(),
    allowFailure
  })

/** Run something in the environment itself. */
const inEnv = (args: string[], allowFailure = true) => run('docker', ['exec', ENV, ...args], { allowFailure })
const serveIn = (script: string) => run('docker', ['exec', '-d', ENV, 'node', '-e', script])

const FETCH = (url: string) => `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(4000) })`
  + '.then(r => r.text()).then(t => process.stdout.write(t))'
  + '.catch(e => { process.stderr.write(String(e.cause?.code || e.cause || e.message)); process.exit(1) })'

const SERVER = (port: number, answer: string, host = '0.0.0.0') =>
  `require('http').createServer((q, r) => r.end(${JSON.stringify(answer)})).listen(${port}, ${JSON.stringify(host)})`

/**
 * What a service with the Docker socket mounted does with it: lists every
 * container it can see, then creates and starts one called `child`. Engine
 * API over the socket, with Node — no CLI needed in the image.
 */
const SOCKET_USER = `
const http = require('http')
const call = (method, path, body) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath: '/var/run/docker.sock', method, path, headers: { 'Content-Type': 'application/json' } }, res => {
    let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
  })
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined)
})
;(async () => {
  const list = await call('GET', '/containers/json?all=1')
  const created = await call('POST', '/containers/create?name=child', { Image: '${NODE}', Cmd: ['sleep', '600'] })
  const started = await call('POST', '/containers/' + created.body.Id + '/start')
  process.stdout.write(JSON.stringify({ names: list.body.map(c => c.Names[0]), created: created.status, started: started.status }))
})().catch(e => { process.stderr.write(String(e)); process.exit(1) })
`

async function eventually<T>(check: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
}

const fetchIn = async (url: string) => (await inEnv(['node', '-e', FETCH(url)])).stdout

async function cleanup() {
  stopAllEnvironmentForwarders()
  await stopDoodProxy(ENV_ID).catch(() => {})
  await run('docker', ['rm', '-f', ENV, BYSTANDER, THIEF], { allowFailure: true })
  await removeEnvironmentResources(ENV_ID).catch(() => {})
  await run('docker', ['volume', 'rm', '-f', WORKSPACE_VOLUME, CACHE_VOLUME], { allowFailure: true })
  await run('docker', ['rm', '-f', portHelperName()], { allowFailure: true })
}

describe.skipIf(!daemon)('binds outside the checkout, the socket, and host networking', () => {
  beforeAll(async () => {
    // Short, unlike the other live files': a container mounts this socket,
    // and Docker Desktop forwards one only from a path of at most 88 bytes.
    socketDir = await mkdtemp('/tmp/ddb-')
    process.env.NUXT_DOOD_SOCKET_DIR = socketDir
    await cleanup()
    const present = await run('docker', ['image', 'inspect', NODE], { allowFailure: true })
    if (!present.stdout.startsWith('[{')) await run('docker', ['pull', NODE])

    // `~/.aws` on the host, as the home overlay would mount it.
    awsDir = await mkdtemp(join(tmpdir(), 'domo-dood-binds-aws-'))
    await writeFile(join(awsDir, 'credentials'), 'aws-from-the-host\n')
    await run('docker', ['volume', 'create', WORKSPACE_VOLUME])
    await run('docker', ['volume', 'create', CACHE_VOLUME])
    await run('docker', ['run', '--rm', '-v', `${CACHE_VOLUME}:/v`, 'busybox:1.37', 'sh', '-c',
      'mkdir -p /v/data && echo from-the-cache-volume > /v/data/hello.txt'])

    // The socket has to exist before the container that binds it is created.
    socketPath = (await ensureDoodProxy({
      environmentId: ENV_ID,
      containerReference: ENV,
      workspacePath: WORKSPACE,
      workspaceVolume: WORKSPACE_VOLUME,
      helperImage: 'busybox:1.37'
    })).socketPath
    const { stdout: id } = await run('docker', [
      'run', '-d', '--name', ENV, '--label', 'domo.dood=true', '--label', `domo.envId=${ENV_ID}`,
      '--ipc', 'shareable',
      '--mount', `type=volume,source=${WORKSPACE_VOLUME},target=${WORKSPACE}`,
      '--mount', `type=volume,source=${CACHE_VOLUME},target=${HOME}/cachevol`,
      '--mount', `type=bind,source=${awsDir},target=${HOME}/.aws`,
      '--volume', `${socketPath}:/var/run/docker.sock`,
      NODE, 'sleep', 'infinity'
    ])
    // Exists only in the environment's own filesystem.
    await inEnv(['mkdir', '-p', `${HOME}/cache`, `${WORKSPACE}/db`], false)
    state.environment = {
      id: ENV_ID, containerId: id.trim(), containerName: ENV, status: 'running', remoteUser: 'root', workspacePath: WORKSPACE
    }
    await ensureEnvironmentNetwork(ENV_ID)
    // Someone else's container on the same daemon.
    await run('docker', ['run', '-d', '--name', BYSTANDER, 'busybox:1.37', 'sleep', '600'])

    workDir = await mkdtemp(join(tmpdir(), 'domo-dood-binds-stack-'))
    await mkdir(workDir, { recursive: true })
    await writeFile(join(workDir, 'binds.yaml'), [
      'services:',
      '  reader:',
      `    image: ${NODE}`,
      '    command: ["sh", "-c", "cat /root/.aws/credentials /d/hello.txt && ls /db && test -s /etc/localtime && echo tz-ok"]',
      '    volumes:',
      '      - ~/.aws:/root/.aws:ro',
      // Out of the checkout by `..`, and into another of the environment's mounts.
      '      - ../../home/vscode/cachevol/data:/d',
      '      - ./db:/db',
      '      - /etc/localtime:/etc/localtime:ro',
      '  keeper:',
      `    image: ${NODE}`,
      '    command: ["sleep", "600"]',
      '    volumes:',
      '      - ~/.aws:/root/.aws:ro',
      '      - ~/cachevol/data:/d',
      '      - /var/run/docker.sock:/var/run/docker.sock',
      ''
    ].join('\n'))
    await writeFile(join(workDir, 'refused.yaml'), [
      'services:',
      '  bad:',
      `    image: ${NODE}`,
      '    command: ["true"]',
      '    volumes:',
      '      - ~/cache:/cache',
      ''
    ].join('\n'))
    await writeFile(join(workDir, 'shared.yaml'), [
      'services:',
      '  bad:',
      `    image: ${NODE}`,
      '    command: ["true"]',
      '    volumes: ["../shared:/shared"]',
      ''
    ].join('\n'))
    await writeFile(join(workDir, 'host.yaml'), [
      'services:',
      '  hostnet:',
      `    image: ${NODE}`,
      `    command: ["node", "-e", ${JSON.stringify(SERVER(7070, 'host-mode', '127.0.0.1'))}]`,
      '    network_mode: host',
      // Discarded on a real host with host networking, and here.
      '    ports: ["7070:7070"]',
      ''
    ].join('\n'))
  }, 600_000)

  afterAll(async () => {
    await cleanup()
    await run('docker', ['rmi', portHelperImage()], { allowFailure: true })
    delete process.env.NUXT_DOOD_SOCKET_DIR
    delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
    for (const dir of [workDir, socketDir, awsDir]) if (dir) await rm(dir, { recursive: true, force: true })
  }, 300_000)

  it('mounts ~/.aws from the host, a path in another volume by `..`, the checkout and the zone file, through compose', async () => {
    const out = await compose('binds', 'binds.yaml', ['run', '--rm', '-T', 'reader'])
    expect(out.stdout.split('\n')).toEqual(['aws-from-the-host', 'from-the-cache-volume', 'tz-ok'])
    // A second `up` recreates nothing: what inspect reports agrees with what compose asked for.
    await compose('binds', 'binds.yaml', ['up', '-d', 'keeper'])
    const again = await compose('binds', 'binds.yaml', ['up', '-d', 'keeper'])
    expect(`${again.stdout}\n${again.stderr}`).not.toMatch(/Recreat/)
    await compose('binds', 'binds.yaml', ['down'])
  }, 120_000)

  it('mounts a path inside a non-workspace volume, both syntaxes, and creates a missing subpath the environment then sees', async () => {
    const read = await cli(['run', '--rm', '-v', `${HOME}/cachevol/data:/d:ro`, NODE, 'cat', '/d/hello.txt'])
    expect(read.stdout).toBe('from-the-cache-volume')
    const long = await cli(['run', '--rm', '--mount', `type=bind,source=${HOME}/cachevol/data,target=/d`, NODE, 'cat', '/d/hello.txt'])
    expect(long.stdout).toBe('from-the-cache-volume')
    await cli(['run', '--rm', '-v', `${HOME}/cachevol/made/here:/n`, NODE, 'sh', '-c', 'echo written-by-a-service > /n/f'])
    expect((await inEnv(['cat', `${HOME}/cachevol/made/here/f`])).stdout).toBe('written-by-a-service')
    // Through a bind, a service writes to the host's own directory.
    await cli(['run', '--rm', '-v', `${HOME}/.aws:/aws`, NODE, 'sh', '-c', 'echo back > /aws/from-a-service'])
    expect((await run('cat', [join(awsDir, 'from-a-service')])).stdout).toBe('back')
  }, 120_000)

  it('passes /etc/localtime through to the daemon\'s host', async () => {
    const out = await cli(['run', '--rm', '-v', '/etc/localtime:/etc/localtime:ro', NODE, 'sh', '-c', 'test -s /etc/localtime && echo ok'])
    expect(out.stdout).toBe('ok')
  }, 60_000)

  it('refuses a path that exists only in the environment, loudly, through the CLI and through compose', async () => {
    for (const source of ['/tmp/foo', `${HOME}/cache`]) {
      const out = await cli(['run', '--rm', '-v', `${source}:/x`, NODE, 'true'], true)
      expect(out.stderr).toContain(`Domo: ${source} exists only inside this dev environment`)
      const long = await cli(['run', '--rm', '--mount', `type=bind,source=${source},target=/x`, NODE, 'true'], true)
      expect(long.stderr).toContain(`Domo: ${source} exists only inside this dev environment`)
    }
    const refused = await compose('refused', 'refused.yaml', ['up', '-d'], true)
    expect(refused.stderr).toContain(`Domo: ${HOME}/cache exists only inside this dev environment`)
    const shared = await compose('shared', 'shared.yaml', ['up', '-d'], true)
    expect(shared.stderr).toContain('Domo: /workspaces/shared exists only inside this dev environment')
    // Nothing was created for either.
    expect((await cli(['ps', '-aq', '--filter', 'name=bad'])).stdout).toBe('')
    await compose('refused', 'refused.yaml', ['down'], true)
    await compose('shared', 'shared.yaml', ['down'], true)
  }, 120_000)

  it('shows the sources the agent named in docker inspect, not where they really are', async () => {
    await cli(['create', '--name', 'inspected',
      '-v', `${HOME}/.aws:/root/.aws:ro`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '--mount', `type=bind,source=${HOME}/cachevol/data,target=/d`,
      NODE, 'true'])
    const out = JSON.parse((await cli(['inspect', 'inspected'])).stdout)[0]
    expect(out.HostConfig.Binds).toEqual([`${HOME}/.aws:/root/.aws:ro`, '/var/run/docker.sock:/var/run/docker.sock'])
    expect(out.HostConfig.Mounts).toEqual([{ Type: 'bind', Source: `${HOME}/cachevol/data`, Target: '/d' }])
    const sources = Object.fromEntries(out.Mounts.map((mount: any) => [mount.Destination, [mount.Type, mount.Source]]))
    expect(sources).toEqual({
      '/root/.aws': ['bind', `${HOME}/.aws`],
      '/var/run/docker.sock': ['bind', '/var/run/docker.sock'],
      '/d': ['bind', `${HOME}/cachevol/data`]
    })
    // What it really got, seen from the host.
    const real = JSON.parse((await run('docker', ['inspect', `${PREFIX}inspected`])).stdout)[0]
    // Docker Desktop reports the source it resolved (`/var/folders` is `/private/var/folders`).
    expect(real.HostConfig.Binds).toEqual([`${await realpath(awsDir)}:/root/.aws:ro`, `${socketPath}:/var/run/docker.sock`])
    await cli(['rm', 'inspected'])
  }, 60_000)

  it('gives a service the environment\'s own socket: it sees and makes only the environment\'s containers', async () => {
    const out = await cli(['run', '--name', 'sockuser', '-v', '/var/run/docker.sock:/var/run/docker.sock', NODE, 'node', '-e', SOCKET_USER])
    const seen = JSON.parse(out.stdout)
    expect(seen).toMatchObject({ created: 201, started: 204 })
    // Itself, by the name the agent gave it, and nobody else's.
    expect(seen.names).toContain('/sockuser')
    expect(seen.names.join(' ')).not.toContain(BYSTANDER)
    expect(seen.names.join(' ')).not.toContain(ENV)
    expect(seen.names.every((name: string) => !name.includes(PREFIX))).toBe(true)
    // What it made is the environment's: namespaced, labelled, and visible to the agent by its own name.
    const child = JSON.parse((await run('docker', ['inspect', `${PREFIX}child`])).stdout)[0]
    expect(child.Config.Labels['domo.env']).toBe(ENV_ID)
    expect(child.State.Running).toBe(true)
    expect((await cli(['ps', '--format', '{{.Names}}'])).stdout.split('\n')).toContain('child')
    // A plain `docker restart` of a container that mounts the socket fails on
    // Docker Desktop; through the proxy it is a stop and a start, and works.
    await cli(['run', '-d', '--name', 'sockd', '-v', '/var/run/docker.sock:/var/run/docker.sock', NODE, 'sleep', '600'])
    await cli(['restart', '-t', '0', 'sockd'])
    expect((await cli(['inspect', '--format', '{{.State.Running}}', 'sockd'])).stdout).toBe('true')
    await cli(['rm', '-f', 'sockuser', 'child', 'sockd'])
  }, 120_000)

  it('runs a network_mode: host service in the environment\'s own network, both ways', async () => {
    await compose('host', 'host.yaml', ['up', '-d'])
    // The service answers on the environment's loopback …
    await eventually(async () => expect(await fetchIn('http://localhost:7070')).toBe('host-mode'))
    // … and reaches the environment's loopback-only servers at localhost.
    await serveIn(SERVER(7171, 'env-server', '127.0.0.1'))
    await eventually(async () => {
      const out = await compose('host', 'host.yaml', ['exec', '-T', 'hostnet', 'node', '-e', FETCH('http://localhost:7171')], true)
      expect(out.stdout).toBe('env-server')
    })
    const again = await compose('host', 'host.yaml', ['up', '-d'])
    expect(`${again.stdout}\n${again.stderr}`).not.toMatch(/Recreat/)
    const inspected = JSON.parse((await cli(['inspect', 'host-hostnet-1'])).stdout)[0]
    expect(inspected.HostConfig.NetworkMode).toBe('host')
    // No relay was set up for the discarded `ports:`.
    expect(inspected.NetworkSettings.Ports).toEqual({})
    // The CLI's `--network host` too.
    await cli(['run', '-d', '--name', 'clihost', '--network', 'host', NODE, 'node', '-e', SERVER(7272, 'cli-host')])
    await eventually(async () => expect(await fetchIn('http://127.0.0.1:7272')).toBe('cli-host'))
  }, 120_000)

  it('shares the environment\'s processes with --pid host', async () => {
    const out = await cli(['run', '--rm', '--pid', 'host', NODE, 'sh', '-c', 'tr "\\000" " " < /proc/1/cmdline'])
    // The environment's own PID 1, not the daemon host's init.
    expect(out.stdout.trim()).toBe('sleep infinity')
  }, 60_000)

  it('moves host-networked services into the environment\'s new namespace when it restarts', async () => {
    const before = JSON.parse((await run('docker', ['inspect', `${PREFIX}host-hostnet-1`])).stdout)[0].State.StartedAt
    // Stopped and started, as Domo does: Docker Desktop cannot `docker restart`
    // a container that mounts a host socket, and the environment mounts one.
    await run('docker', ['stop', '-t', '0', ENV])
    await run('docker', ['start', ENV])
    await eventually(async () => expect(await fetchIn('http://localhost:7070')).toBe('host-mode'), 60_000)
    await eventually(async () => expect(await fetchIn('http://127.0.0.1:7272')).toBe('cli-host'), 60_000)
    const after = JSON.parse((await run('docker', ['inspect', `${PREFIX}host-hostnet-1`])).stdout)[0].State.StartedAt
    expect(after).not.toBe(before)
    await compose('host', 'host.yaml', ['down'])
    await cli(['rm', '-f', 'clihost'])
  }, 180_000)

  it('forwards what -P published to the host, like an explicit -p', async () => {
    await cli(['run', '-d', '--name', 'allports', '-P', '--expose', '8088', NODE, 'node', '-e', SERVER(8088, 'published-by-P')])
    const row = await eventually(async () => {
      const ports = await refreshEnvironmentPorts(ENV_ID)
      const port = ports.find(entry => entry.service === 'allports' && entry.innerPort === 8088)
      expect(port?.forwarded && port.url).toBeTruthy()
      return port!
    })
    expect(await (await fetch(row.url!)).text()).toBe('published-by-P')
    stopAllEnvironmentForwarders()
    await cli(['rm', '-f', 'allports'])
  }, 120_000)

  it('points host.docker.internal back at the environment when it comes back on another address', async () => {
    await cli(['network', 'create', '--subnet', '10.231.77.0/24', 'hnet'])
    await cli(['run', '-d', '--name', 'caller', '--network', 'hnet', NODE, 'sleep', '600'])
    const address = async () => (await run('docker', ['inspect', '--format', `{{(index .NetworkSettings.Networks "${PREFIX}hnet").IPAddress}}`, ENV])).stdout
    const resolved = async () => (await cli(['exec', 'caller', 'getent', 'hosts', 'host.docker.internal'])).stdout.split(/\s+/)[0]
    const first = await address()
    expect(await resolved()).toBe(first)

    // The environment goes away, and something else takes its address meanwhile.
    await run('docker', ['stop', '-t', '0', ENV])
    await run('docker', ['run', '-d', '--name', THIEF, '--network', `${PREFIX}hnet`, '--ip', first, 'busybox:1.37', 'sleep', '600'])
    await run('docker', ['start', ENV])
    const second = await address()
    expect(second).not.toBe(first)

    await eventually(async () => expect(await resolved()).toBe(second), 60_000)
    await serveIn(SERVER(7373, 'back-home', '127.0.0.1'))
    await eventually(async () => {
      const out = await cli(['exec', 'caller', 'node', '-e', FETCH('http://host.docker.internal:7373')], true)
      expect(out.stdout).toBe('back-home')
    })
    // A restart of the service rewrites the stale file again from ExtraHosts; that is fixed again too.
    await cli(['restart', '-t', '0', 'caller'])
    await eventually(async () => expect(await resolved()).toBe(second), 60_000)

    await run('docker', ['rm', '-f', THIEF])
    await cli(['rm', '-f', 'caller'])
    await cli(['network', 'rm', 'hnet'])
  }, 180_000)

  it('leaves nothing of the environment behind once it is swept', async () => {
    stopAllEnvironmentForwarders()
    await run('docker', ['rm', '-f', ENV])
    await removeEnvironmentResources(ENV_ID)
    expect((await run('docker', ['ps', '-aq', '--filter', `label=domo.env=${ENV_ID}`])).stdout).toBe('')
    expect((await run('docker', ['network', 'ls', '-q', '--filter', `label=domo.env=${ENV_ID}`])).stdout).toBe('')
  }, 120_000)
})
