import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { run } from '../../server/lib/dev-env/docker'
import { portHelperImage, portHelperName } from '../../server/lib/dev-env/port-helper'
import { createEngineClient } from '../../server/lib/dood/engine'
import { ensureDoodProxy, stopDoodProxy, sweepEnvironmentResources } from '../../server/lib/dood/manager'

/**
 * Two environments on one daemon, each seeing only itself — with the real
 * `docker` CLI and real `docker compose`, through the real proxy.
 *
 * The case the namespacing exists for: one project, two environments, one
 * compose file with a `container_name:` and a named volume, brought up in both
 * at once. Without names in a namespace the second `up` collides on every name;
 * without scoping, `docker ps` in one shows the other, and a `docker rm -f
 * $(docker ps -aq)` in one takes down the other — and Domo's own Postgres,
 * which runs on the same daemon. A container, a volume and a network made
 * directly on the host stand in for the latter.
 *
 * Opt in with `pnpm test:docker`.
 */

const IMAGE = 'alpine:3'
const WORKSPACE = '/workspaces/probe'
const PROJECT = 'shared'
const BYSTANDER = 'domo-dood-ns-bystander'

interface Env {
  id: string
  container: string
  volume: string
  socket: string
  shortId: string
}

const envs: Env[] = [
  { id: 'env_d00d00000000000000a1', container: 'domo-dood-ns-env-a', volume: 'domo-dood-ns-a-workspace', socket: '', shortId: '' },
  { id: 'env_d00d00000000000000b1', container: 'domo-dood-ns-env-b', volume: 'domo-dood-ns-b-workspace', socket: '', shortId: '' }
]
const [A, B] = envs as [Env, Env]

const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true })
  .then(output => output.stdout.length > 0).catch(() => false)

let workDir: string
let socketDir: string

const envOf = (env: Env) => ({ ...process.env, DOCKER_HOST: `unix://${env.socket}` })

/** The `docker` CLI as an agent in `env` runs it. */
const cli = (env: Env, args: string[], allowFailure = false) =>
  run('docker', args, { env: envOf(env), allowFailure })

/** A shell line, for the `$(docker ps -aq)` an agent types. */
const shell = (env: Env, script: string) => run('sh', ['-c', script], { env: envOf(env), allowFailure: true })

const compose = (env: Env, args: string[], allowFailure = false) =>
  run('docker', ['compose', '-p', PROJECT, ...args], { cwd: workDir, env: envOf(env), allowFailure })

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean).sort()

/** `network inspect` of a missing name still prints `[]`, so the answer is its length. */
const hostExists = async (kind: 'container' | 'volume' | 'network', name: string) => {
  const found = await run('docker', [kind, 'inspect', name], { allowFailure: true })
  try {
    return (JSON.parse(found.stdout || '[]') as unknown[]).length > 0
  } catch {
    return false
  }
}

describe.skipIf(!daemon)('an environment\'s own view of the shared daemon', () => {
  beforeAll(async () => {
    // Its own port helper, not the developer's.
    process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-dood-ns-test-'
    socketDir = await mkdtemp('/tmp/ddn-')
    process.env.NUXT_DOOD_SOCKET_DIR = socketDir
    await cleanup()

    for (const env of envs) {
      await run('docker', ['volume', 'create', env.volume])
      await run('docker', ['run', '--rm', '-v', `${env.volume}:/w`, IMAGE, 'sh', '-c',
        `mkdir -p /w/site && echo 'site of ${env.id}' > /w/site/index.html`])
      // A stand-in for the environment's own container: the label that marks it
      // as one, and nothing that would put it in its own environment's lists.
      await run('docker', ['run', '-d', '--name', env.container, '--label', 'domo.dood=true', IMAGE, 'sleep', '900'])
      env.shortId = (await run('docker', ['inspect', '--format', '{{.Config.Hostname}}', env.container])).stdout
      env.socket = (await ensureDoodProxy({
        environmentId: env.id,
        containerReference: env.container,
        workspacePath: WORKSPACE,
        workspaceVolume: env.volume,
        helperImage: IMAGE
      })).socketPath
    }

    // Made directly on the host, as Domo's own Postgres and whatever else the
    // developer runs are: nothing an environment does may touch these.
    await run('docker', ['run', '-d', '--name', BYSTANDER, IMAGE, 'sleep', '900'])
    await run('docker', ['volume', 'create', BYSTANDER])
    await run('docker', ['network', 'create', BYSTANDER])

    workDir = await mkdtemp(join(tmpdir(), 'domo-dood-ns-stack-'))
    await writeFile(join(workDir, 'compose.yaml'), [
      'services:',
      '  db:',
      `    image: ${IMAGE}`,
      '    container_name: db',
      '    command: ["sh", "-c", "echo db-started; exec sleep 600"]',
      '    volumes: ["data:/data"]',
      '    ports: ["5432:5432"]',
      '  web:',
      `    image: ${IMAGE}`,
      '    command: ["sleep", "600"]',
      `    volumes: ["${WORKSPACE}/site:/site:ro"]`,
      '    ports: ["8080:80"]',
      'volumes:',
      '  data: {}',
      ''
    ].join('\n'))
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await run('docker', ['rmi', portHelperImage()], { allowFailure: true })
    delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
    delete process.env.NUXT_DOOD_SOCKET_DIR
    for (const dir of [workDir, socketDir]) if (dir) await rm(dir, { recursive: true, force: true })
  }, 300_000)

  it('runs one compose file with a container_name and a named volume in both environments at once', async () => {
    await compose(A, ['up', '-d'])
    await compose(B, ['up', '-d'])

    for (const env of envs) {
      expect(lines((await cli(env, ['ps', '-a', '--format', '{{.Names}}'])).stdout)).toEqual(['db', 'shared-web-1'])
      expect(lines((await compose(env, ['ps', '--format', '{{.Name}}'])).stdout)).toEqual(['db', 'shared-web-1'])
      // Each service reads its own environment's checkout.
      const site = await compose(env, ['exec', '-T', 'web', 'cat', '/site/index.html'])
      expect(site.stdout).toBe(`site of ${env.id}`)
    }
    // On the host they are two sets of objects, each in its environment's namespace.
    for (const env of envs) {
      expect(await hostExists('container', `${env.id}-db`)).toBe(true)
      expect(await hostExists('volume', `${env.id}-shared_data`)).toBe(true)
      expect(await hostExists('network', `${env.id}-shared_default`)).toBe(true)
    }
  }, 300_000)

  it('lists only the environment\'s own objects, and the builtin networks', async () => {
    for (const env of envs) {
      const ids = lines((await cli(env, ['ps', '-aq', '--no-trunc'])).stdout)
      const other = env === A ? B : A
      const theirs = (await run('docker', ['ps', '-aq', '--no-trunc', '--filter', `label=domo.env=${other.id}`])).stdout
      expect(ids).toHaveLength(2)
      for (const id of ids) expect(theirs).not.toContain(id)
      expect(lines((await cli(env, ['network', 'ls', '--format', '{{.Name}}'])).stdout))
        .toEqual(['bridge', 'host', 'none', 'shared_default'])
      expect(lines((await cli(env, ['volume', 'ls', '--format', '{{.Name}}'])).stdout)).toEqual(['shared_data'])
    }
  }, 120_000)

  it('shows inspect the name, the mounts and the publishing the client asked for', async () => {
    const db = JSON.parse((await cli(A, ['inspect', 'db'])).stdout)[0]
    expect(db.Name).toBe('/db')
    expect(db.HostConfig.PortBindings).toEqual({ '5432/tcp': [{ HostIp: '', HostPort: '5432' }] })
    expect(db.Mounts.map((mount: any) => mount.Name)).toContain('shared_data')
    expect(Object.keys(db.NetworkSettings.Networks)).toEqual(['shared_default'])
    expect(Object.keys(db.Config.Labels).filter(key => key.startsWith('domo.'))).toEqual([])
    expect(JSON.stringify(db)).not.toContain(A.id)

    const web = JSON.parse((await cli(A, ['inspect', 'shared-web-1'])).stdout)[0]
    expect(web.Mounts).toContainEqual(expect.objectContaining({ Type: 'bind', Source: `${WORKSPACE}/site`, Destination: '/site', RW: false }))
    // Really published, on the environment's own localhost: both families, as Docker reports them.
    expect((await cli(A, ['port', 'shared-web-1'])).stdout.split('\n')).toEqual(['80/tcp -> 0.0.0.0:8080', '80/tcp -> [::]:8080'])
    expect((await cli(A, ['ps', '--filter', 'name=^db$', '--format', '{{.Ports}}'])).stdout).toContain('0.0.0.0:5432->5432/tcp')

    // …while on the host, nothing is published and the mount is the workspace volume.
    const host = JSON.parse((await run('docker', ['inspect', `${A.id}-shared-web-1`])).stdout)[0]
    expect(host.HostConfig.PortBindings).toEqual({})
    expect(host.Mounts).toContainEqual(expect.objectContaining({ Type: 'volume', Name: A.volume }))
  }, 120_000)

  it('resolves names on the stack\'s network, from a service and from the environment', async () => {
    const fromService = await compose(A, ['exec', '-T', 'web', 'nslookup', 'db'], true)
    expect(fromService.stdout).toMatch(/Address:\s*\d+\.\d+\.\d+\.\d+/)
    const dbIp = JSON.parse((await run('docker', ['inspect', `${A.id}-db`])).stdout)[0]
      .NetworkSettings.Networks[`${A.id}-shared_default`].IPAddress
    expect(fromService.stdout).toContain(dbIp)
    // The environment joined the stack's network, so the agent reaches `db` by name too.
    const fromEnv = await run('docker', ['exec', A.container, 'nslookup', 'db'], { allowFailure: true })
    expect(fromEnv.stdout).toContain(dbIp)
    // A plain `docker run` on the stack's network, by the network's own name.
    const fromRun = await cli(A, ['run', '--rm', '--network', 'shared_default', IMAGE, 'nslookup', 'shared-web-1'], true)
    expect(fromRun.stdout).toMatch(/Address:\s*\d+\.\d+\.\d+\.\d+/)
  }, 120_000)

  it('round-trips compose: logs, a second up that recreates nothing, and a down', async () => {
    expect((await compose(A, ['logs', 'db'])).stdout).toContain('db-started')
    const before = lines((await compose(A, ['ps', '-q'])).stdout)
    const again = await compose(A, ['up', '-d'])
    expect(again.stderr).not.toMatch(/Recreat/)
    expect(lines((await compose(A, ['ps', '-q'])).stdout)).toEqual(before)
  }, 180_000)

  it('passes an attached run\'s output through, and the daemon\'s own errors without the prefix', async () => {
    expect((await cli(A, ['run', '--rm', IMAGE, 'echo', 'attached-ok'])).stdout).toBe('attached-ok')
    const conflict = await cli(A, ['run', '-d', '--name', 'db', IMAGE, 'true'], true)
    expect(conflict.stderr).toMatch(/The container name "\/db" is already in use/)
    expect(conflict.stderr).not.toContain(A.id)
    expect((await cli(A, ['rm', 'nothere'], true)).stderr).toContain('No such container: nothere')
    expect((await cli(A, ['volume', 'inspect', 'nothere'], true)).stderr).toContain('get nothere: no such volume')
    expect((await cli(A, ['network', 'inspect', 'nothere'], true)).stderr).toContain('network nothere not found')
    // Another environment's container is not found either, by name or by id.
    const theirs = (await run('docker', ['inspect', '--format', '{{.Id}}', `${B.id}-db`])).stdout
    expect((await cli(A, ['inspect', theirs.slice(0, 12)], true)).stderr).toMatch(new RegExp(`no such object: ${theirs.slice(0, 12)}`, 'i'))
    expect((await cli(A, ['inspect', BYSTANDER], true)).stderr).toMatch(new RegExp(`no such object: ${BYSTANDER}`, 'i'))
  }, 120_000)

  it('still passes every stream through: cp both ways, exec with stdin, a followed event stream, a build', async () => {
    // Archive upload and download, by the agent's name for the container.
    await writeFile(join(workDir, 'upload.txt'), 'uploaded')
    await cli(A, ['cp', join(workDir, 'upload.txt'), 'db:/tmp/upload.txt'])
    await cli(A, ['cp', 'db:/tmp/upload.txt', join(workDir, 'download.txt')])
    expect((await run('cat', [join(workDir, 'download.txt')])).stdout).toBe('uploaded')

    // An exec that reads stdin: a hijacked connection with a request body behind it.
    const piped = await run('docker', ['exec', '-i', 'db', 'cat'], { env: envOf(A), input: 'through-stdin' })
    expect(piped.stdout).toBe('through-stdin')

    // A followed event stream sees its own new container as it happens, and
    // nothing of the host's made at the same moment.
    const stream = spawn('docker', ['events', '--filter', 'type=container', '--format', '{{.Action}} {{.Actor.Attributes.name}}'],
      { env: envOf(A) })
    let seen = ''
    stream.stdout.on('data', (chunk) => { seen += chunk })
    try {
      await new Promise(resolve => setTimeout(resolve, 500))
      await run('docker', ['run', '--rm', '--name', `${BYSTANDER}-2`, IMAGE, 'true'])
      await cli(A, ['run', '--rm', '--name', 'evprobe', IMAGE, 'true'])
      for (let attempt = 0; attempt < 40 && !seen.includes('destroy evprobe'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    } finally {
      stream.kill()
    }
    expect(seen).toContain('create evprobe')
    expect(seen).toContain('destroy evprobe')
    expect(seen).not.toContain(BYSTANDER)

    // A BuildKit build: two hijacked connections (`/session`, `/grpc`) and a streamed context.
    await writeFile(join(workDir, 'Dockerfile'), `FROM ${IMAGE}\nRUN echo built > /built\n`)
    const tag = `domo-dood-ns-build-${Date.now()}`
    try {
      await run('docker', ['build', '-q', '-t', tag, workDir], { env: envOf(A) })
      expect((await cli(A, ['run', '--rm', tag, 'cat', '/built'])).stdout).toBe('built')
    } finally {
      await run('docker', ['rmi', '-f', tag], { allowFailure: true })
    }
  }, 180_000)

  it('lets a container share the environment\'s own network namespace by its hostname', async () => {
    const mac = async (args: string[]) => (await run('docker', args)).stdout
    const envMac = await mac(['exec', A.container, 'cat', '/sys/class/net/eth0/address'])
    const shared = await cli(A, ['run', '--rm', '--network', `container:${A.shortId}`, IMAGE, 'cat', '/sys/class/net/eth0/address'])
    expect(shared.stdout).toBe(envMac)
    // Visible by reference, but never in the environment's own lists.
    expect((await cli(A, ['inspect', '--format', '{{.Id}}', A.shortId])).stdout).toMatch(/^[0-9a-f]{64}$/)
    expect((await cli(A, ['ps', '-aq'])).stdout).not.toContain(A.shortId)
  }, 120_000)

  it('refuses loudly what would reach past the environment', async () => {
    const refusals: Array<[string[], RegExp]> = [
      [['stop', A.shortId], /this environment's own container/],
      [['rm', '-f', A.shortId], /this environment's own container/],
      [['image', 'prune', '-af'], /images are shared/],
      [['swarm', 'init'], /swarm mode/]
    ]
    for (const [args, message] of refusals) {
      const result = await cli(A, args, true)
      expect(result.stderr, args.join(' ')).toMatch(/Error response from daemon: Domo: /)
      expect(result.stderr, args.join(' ')).toMatch(message)
    }
    expect((await run('docker', ['inspect', '--format', '{{.State.Running}}', A.container])).stdout).toBe('true')

    // The HTTP build-cache prune. `docker builder prune` itself goes through
    // buildx and BuildKit's gRPC, which only the /grpc bridge can see into.
    const prune = await createEngineClient(A.socket).request('POST', '/v1.47/build/prune')
    expect(prune.status).toBe(403)
    expect(prune.body.message).toMatch(/^Domo: the build cache is shared/)
  }, 120_000)

  it('shows only the environment\'s own events', async () => {
    // Events of its own, the other environment's and a bystander's, in a
    // window of their own: the daemon keeps only the last 256 events, and the
    // other live files running beside this one fill that in seconds.
    const since = Math.floor(Date.now() / 1000) - 1
    await cli(B, ['restart', '-t', '0', 'db'])
    await cli(A, ['restart', '-t', '0', 'db'])
    await run('docker', ['restart', '-t', '0', BYSTANDER])
    const until = Math.floor(Date.now() / 1000) + 1
    const events = await cli(B, ['events', '--since', String(since), '--until', String(until), '--format', '{{json .}}'])
    const parsed = lines(events.stdout).map(line => JSON.parse(line))
    const names = parsed.filter(event => event.Type === 'container').map(event => event.Actor.Attributes.name)
    expect(names).toContain('db')
    expect(names.every(name => !String(name).startsWith('env_') && name !== BYSTANDER)).toBe(true)
    expect(events.stdout).not.toContain(A.id)
    expect(events.stdout).not.toContain(B.id)
  }, 120_000)

  it('removes everything with `rm -f $(docker ps -aq)` and the prunes — its own, and nothing else', async () => {
    await shell(A, 'docker rm -f $(docker ps -aq)')
    await cli(A, ['volume', 'prune', '-af'])
    await cli(A, ['network', 'prune', '-f'])

    expect((await cli(A, ['ps', '-aq'])).stdout).toBe('')
    expect(lines((await cli(A, ['volume', 'ls', '-q'])).stdout)).toEqual([])
    expect(lines((await cli(A, ['network', 'ls', '--format', '{{.Name}}'])).stdout)).toEqual(['bridge', 'host', 'none'])
    // The environment left the network before it was pruned.
    const envNetworks = JSON.parse((await run('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', A.container])).stdout)
    expect(Object.keys(envNetworks)).toEqual(['bridge'])

    // The other environment, the bystanders and the environments themselves are untouched.
    expect(lines((await cli(B, ['ps', '--format', '{{.Names}}'])).stdout)).toEqual(['db', 'shared-web-1'])
    expect(lines((await cli(B, ['volume', 'ls', '-q'])).stdout)).toEqual(['shared_data'])
    for (const kind of ['container', 'volume', 'network'] as const) expect(await hostExists(kind, BYSTANDER), kind).toBe(true)
    for (const env of envs) expect(await hostExists('container', env.container)).toBe(true)
  }, 180_000)

  it('takes the other environment\'s stack down cleanly, network and volume included', async () => {
    const down = await compose(B, ['down', '-v'])
    expect(down.stderr).not.toMatch(/still in use|active endpoints/)
    expect((await cli(B, ['ps', '-aq'])).stdout).toBe('')
    expect(await hostExists('network', `${B.id}-shared_default`)).toBe(false)
    expect(await hostExists('volume', `${B.id}-shared_data`)).toBe(false)
    expect(await hostExists('container', BYSTANDER)).toBe(true)
  }, 180_000)
})

async function cleanup() {
  for (const env of envs) {
    await stopDoodProxy(env.id)
    await run('docker', ['rm', '-f', env.container], { allowFailure: true })
    await sweepEnvironmentResources(env.id)
    await run('docker', ['volume', 'rm', '-f', env.volume], { allowFailure: true })
  }
  await run('docker', ['rm', '-f', BYSTANDER, `${BYSTANDER}-2`], { allowFailure: true })
  await run('docker', ['volume', 'rm', '-f', BYSTANDER], { allowFailure: true })
  await run('docker', ['network', 'rm', BYSTANDER], { allowFailure: true })
  // The relays publishing `ports:` on each environment's localhost run in it.
  await run('docker', ['rm', '-f', portHelperName()], { allowFailure: true })
}
