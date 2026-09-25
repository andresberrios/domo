import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { run } from '../../server/lib/dev-env/docker'
import { portHelperImage, portHelperName } from '../../server/lib/dev-env/port-helper'
import { ensureDoodProxy, stopDoodProxy } from '../../server/lib/dood/manager'
import { removeEnvironmentResources } from '../../server/lib/dev-env/leftovers'

/**
 * Images on the shared daemon, with the real `docker` CLI, real buildx and
 * real `docker compose`, through the real proxy, for two stand-in
 * environments: every tag an environment produces is its own, every name it
 * uses means its own tag first, and neither ever sees the other's — or a
 * private name at all.
 *
 * Opt in with `pnpm test:docker`.
 */

const BASE = 'alpine:3'
const WORKSPACE = '/workspaces/probe'
const REGISTRY = 'domo-dood-img-registry'

interface Env {
  id: string
  container: string
  volume: string
  socket: string
}

const envs: Env[] = [
  { id: 'env_d00d00000000000000a4', container: 'domo-dood-img-env-a', volume: 'domo-dood-img-a-workspace', socket: '' },
  { id: 'env_d00d00000000000000b4', container: 'domo-dood-img-env-b', volume: 'domo-dood-img-b-workspace', socket: '' }
]
const [A, B] = envs as [Env, Env]
const privateRepoOf = (env: Env, name: string) => `domo-${env.id}/docker.io/library/${name}`

const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true })
  .then(output => output.stdout.length > 0).catch(() => false)

let workDir: string
let socketDir: string
let registryPort = 0
/** Pulled by this file, and so removed by it: nothing may be left on the daemon that was not there before. */
let pulledRegistry = false
const warnings: string[] = []

interface Result { code: number, stdout: string, stderr: string }

/** A command, its exit code and both outputs. */
function exec(program: string, args: string[], options: { env?: NodeJS.ProcessEnv, cwd?: string } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: options.env ?? process.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.once('error', reject)
    child.once('close', code => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

const envOf = (env: Env) => ({ ...process.env, DOCKER_HOST: `unix://${env.socket}` })

/** The `docker` CLI as an agent in `env` runs it; fails the test on a non-zero exit unless `allowFailure`. */
async function cli(env: Env | null, args: string[], allowFailure = false, cwd?: string): Promise<Result> {
  const result = await exec('docker', args, { env: env ? envOf(env) : process.env, cwd: cwd ?? workDir })
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(' ')} (${env?.id ?? 'host'}) exited ${result.code}: ${result.stderr}`)
  }
  return result
}

const host = (args: string[], allowFailure = false) => cli(null, args, allowFailure)

const compose = (env: Env, project: string, args: string[], allowFailure = false) =>
  cli(env, ['compose', '-p', project, ...args], allowFailure, join(workDir, 'compose'))

/** Every tag on the daemon, as the host sees them. */
async function hostTags(): Promise<string[]> {
  const out = await host(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])
  return out.stdout.split('\n').filter(Boolean)
}

/** The Engine API through an environment's socket, for what the CLI does not print. */
function api(env: Env, method: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: env.socket, method, path, headers: { Host: 'docker' } }, (res) => {
      let body = ''
      res.on('data', chunk => (body += chunk))
      res.on('end', () => resolve(body ? JSON.parse(body) : null))
    })
    req.on('error', reject)
    req.end()
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

const imageId = async (env: Env | null, name: string) =>
  (await cli(env, ['image', 'inspect', '--format', '{{.Id}}', name], true)).stdout

async function dockerfile(dir: string, lines: string[]) {
  await mkdir(join(workDir, dir), { recursive: true })
  await writeFile(join(workDir, dir, 'Dockerfile'), `${lines.join('\n')}\n`)
  return join(workDir, dir)
}

/** Timings, digests and build refs: what differs between two runs of the same build. */
function normalise(progress: string): string[] {
  return progress.split('\n')
    .filter(line => !line.startsWith('View build details'))
    .map(line => line
      .replace(/sha256:[0-9a-f]{64}/g, 'sha256:<digest>')
      .replace(/^(#\d+) \d+\.\d+ /, '$1 ')
      // A duration is printed only once it rounds above zero, so it goes altogether.
      .replace(/ \d+\.\d+s( done)?$/, '$1')
      .replace(/DONE \d+\.\d+s/, 'DONE')
      .replace(/transferring (dockerfile|context): \d+B/, 'transferring $1: <n>B'))
    .filter(Boolean)
}

async function cleanup() {
  for (const env of envs) {
    await stopDoodProxy(env.id).catch(() => {})
    await run('docker', ['rm', '-f', env.container], { allowFailure: true })
    await removeEnvironmentResources(env.id).catch(() => {})
    await run('docker', ['volume', 'rm', '-f', env.volume], { allowFailure: true })
  }
  await run('docker', ['rm', '-f', REGISTRY, portHelperName()], { allowFailure: true })
  // Anything public a test made on the host for comparison, and what a failure left behind.
  const tags = (await run('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], { allowFailure: true })).stdout
    .split('\n').filter(tag => /(^|\/)ddimg-/.test(tag) || tag.includes('domo-env_d00d'))
  if (tags.length) await run('docker', ['image', 'rm', '-f', ...tags], { allowFailure: true })
}

describe.skipIf(!daemon)('an environment\'s own image tags on the shared daemon', () => {
  beforeAll(async () => {
    // Its own port helper, not the developer's.
    process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-dood-img-test-'
    socketDir = await mkdtemp('/tmp/ddi-')
    process.env.NUXT_DOOD_SOCKET_DIR = socketDir
    const warn = console.warn.bind(console)
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
      warn(...args)
    })
    await cleanup()
    const present = await run('docker', ['image', 'inspect', BASE], { allowFailure: true })
    if (!present.stdout.startsWith('[{')) await run('docker', ['pull', BASE])

    for (const env of envs) {
      await run('docker', ['volume', 'create', env.volume])
      await run('docker', ['run', '-d', '--name', env.container, '--label', 'domo.dood=true', BASE, 'sleep', '1800'])
      env.socket = (await ensureDoodProxy({
        environmentId: env.id,
        containerReference: env.container,
        workspacePath: WORKSPACE,
        workspaceVolume: env.volume,
        helperImage: BASE
      })).socketPath
    }
    workDir = await mkdtemp(join(tmpdir(), 'domo-dood-img-'))
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await run('docker', ['rmi', portHelperImage()], { allowFailure: true })
    if (pulledRegistry) await run('docker', ['rmi', 'registry:2'], { allowFailure: true })
    delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
    delete process.env.NUXT_DOOD_SOCKET_DIR
    vi.restoreAllMocks()
    for (const dir of [workDir, socketDir]) if (dir) await rm(dir, { recursive: true, force: true })
  }, 300_000)

  it('builds the same tag in two environments at once, and each runs its own', async () => {
    const dirs = await Promise.all(envs.map(env => dockerfile(`same-${env.id}`, [`FROM ${BASE}`, `RUN echo built-by-${env.id} > /who`])))
    await Promise.all(envs.map((env, index) => cli(env, ['build', '-q', '-t', 'ddimg-app:dev', dirs[index]!])))
    for (const env of envs) {
      expect((await cli(env, ['run', '--rm', 'ddimg-app:dev', 'cat', '/who'])).stdout).toBe(`built-by-${env.id}`)
    }
    const tags = await hostTags()
    expect(tags).not.toContain('ddimg-app:dev')
    expect(tags).toEqual(expect.arrayContaining([`${privateRepoOf(A, 'ddimg-app')}:dev`, `${privateRepoOf(B, 'ddimg-app')}:dev`]))
  }, 180_000)

  it('lists only its own builds (unprefixed) and the shared images, and inspects them by the names it used', async () => {
    const listA = (await cli(A, ['images', '--format', '{{.Repository}}:{{.Tag}}'])).stdout.split('\n')
    expect(listA).toContain('ddimg-app:dev')
    expect(listA).toContain(BASE)
    expect(listA.filter(tag => tag === 'ddimg-app:dev')).toHaveLength(1)
    expect(listA.join('\n')).not.toContain('domo-env_')
    // `docker images <pattern>`: the daemon only knows the private name, so the proxy filters.
    expect((await cli(A, ['images', 'ddimg-app', '--format', '{{.Repository}}:{{.Tag}}'])).stdout).toBe('ddimg-app:dev')
    expect((await cli(A, ['images', 'ddimg-a*', '--format', '{{.Repository}}:{{.Tag}}'])).stdout).toBe('ddimg-app:dev')
    expect((await cli(A, ['images', 'nothing-like-it', '-q'])).stdout).toBe('')
    const inspect = JSON.parse((await cli(A, ['image', 'inspect', 'ddimg-app:dev'])).stdout)[0]
    expect(inspect.RepoTags).toEqual(['ddimg-app:dev'])
    expect(inspect.Id).toBe(await imageId(null, `${privateRepoOf(A, 'ddimg-app')}:dev`))
    const history = await api(A, 'GET', '/images/ddimg-app:dev/history')
    expect(history.flatMap((layer: any) => layer.Tags ?? [])).toEqual(['ddimg-app:dev'])
    // What a container was created from reads as it was asked for.
    await cli(A, ['run', '-d', '--name', 'ddimg-runner', 'ddimg-app:dev', 'sleep', '60'])
    expect((await cli(A, ['inspect', '--format', '{{.Config.Image}}', 'ddimg-runner'])).stdout).toBe('ddimg-app:dev')
    expect((await cli(A, ['ps', '--filter', 'name=ddimg-runner', '--format', '{{.Image}}'])).stdout).toBe('ddimg-app:dev')
    await cli(A, ['rm', '-f', 'ddimg-runner'])
    // The other environment's `docker images` shows its own build under the same name, never A's.
    const aId = await imageId(A, 'ddimg-app:dev')
    const bId = await imageId(B, 'ddimg-app:dev')
    expect(aId).not.toBe(bId)
    const listB = (await cli(B, ['images', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}'])).stdout
    expect(listB).toContain(`${bId} ddimg-app:dev`)
    expect(listB).not.toContain(aId)
    // `system df` agrees with `docker images`.
    const df = JSON.parse((await cli(A, ['system', 'df', '-v', '--format', '{{json .Images}}'])).stdout)
    expect(JSON.stringify(df)).not.toContain('domo-env_')
  }, 120_000)

  it('builds FROM its own image through the source policy, never another environment\'s, and a stage keeps its name', async () => {
    await cli(A, ['build', '-q', '-t', 'ddimg-base:dev', await dockerfile('base', [`FROM ${BASE}`, 'RUN echo base-of-a > /base'])])
    const child = await dockerfile('child', ['FROM ddimg-base:dev', 'RUN cp /base /child'])
    await cli(A, ['build', '-q', '-t', 'ddimg-child:dev', child])
    expect((await cli(A, ['run', '--rm', 'ddimg-child:dev', 'cat', '/child'])).stdout).toBe('base-of-a')
    // B has no `ddimg-base:dev`: exactly what a daemon of its own would say.
    const refused = await cli(B, ['build', '-q', '-t', 'ddimg-child:dev', child], true)
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toMatch(/ddimg-base/)
    expect(refused.stderr).not.toContain('domo-env_')
    // `COPY --from` an image is a source too.
    const copy = await dockerfile('copy-from', [`FROM ${BASE}`, 'COPY --from=ddimg-base:dev /base /copied'])
    await cli(A, ['build', '-q', '-t', 'ddimg-copy:dev', copy])
    expect((await cli(A, ['run', '--rm', 'ddimg-copy:dev', 'cat', '/copied'])).stdout).toBe('base-of-a')
    // A stage named like a private `:latest` image is still the stage: a
    // named build context would have replaced it with the image.
    await cli(A, ['build', '-q', '-t', 'ddimg-stage', await dockerfile('stage-image', [`FROM ${BASE}`, 'RUN echo the-image > /s'])])
    const staged = await dockerfile('staged', [`FROM ${BASE} AS ddimg-stage`, 'RUN echo the-stage > /s', 'FROM ddimg-stage', 'RUN cp /s /out'])
    await cli(A, ['build', '-q', '-t', 'ddimg-staged:dev', staged])
    expect((await cli(A, ['run', '--rm', 'ddimg-staged:dev', 'cat', '/out'])).stdout).toBe('the-stage')
  }, 180_000)

  it('prints a build through the proxy exactly as a direct build prints it', async () => {
    const base = await dockerfile('plain-base', [`FROM ${BASE}`, 'RUN echo plain-base > /base'])
    // The same base, public on the host and private in A.
    await host(['build', '-q', '-t', 'ddimg-pbase:1', base])
    await cli(A, ['build', '-q', '-t', 'ddimg-pbase:1', base])
    const child = await dockerfile('plain-child', ['FROM ddimg-pbase:1', 'RUN cat /base', 'RUN echo second-step'])
    // Straight to the daemon's socket, as the proxy is: the CLI's own context
    // name (`desktop-linux`) would otherwise head the direct output.
    const direct = () => exec('docker', ['build', '--no-cache', '--progress=plain', '-t', 'ddimg-pchild:1', child],
      { env: { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock' } })
    const proxied = () => cli(A, ['build', '--no-cache', '--progress=plain', '-t', 'ddimg-pchild:1', child])
    // Once each first: whether BuildKit prints a `FROM` of a local image as
    // `CACHED` or `DONE` depends on what it solved before, proxy or not.
    await direct()
    await proxied()
    const directRun = await direct()
    const proxiedRun = await proxied()
    expect(normalise(proxiedRun.stderr)).toEqual(normalise(directRun.stderr))
    const proxiedText = proxiedRun.stderr
    expect(proxiedText).toContain('[1/3] FROM docker.io/library/ddimg-pbase:1')
    expect(proxiedText).toContain('naming to docker.io/library/ddimg-pchild:1')
    expect(proxiedText).not.toContain('domo-env_')
  }, 180_000)

  it('writes the name the client asked for into --metadata-file', async () => {
    const file = join(workDir, 'metadata.json')
    // FROM its own base, so the provenance's materials name a private image too.
    await cli(A, ['build', '-q', '--metadata-file', file, '-t', 'ddimg-meta:dev', await dockerfile('meta', ['FROM ddimg-base:dev', 'RUN true'])])
    const metadata = JSON.parse(await readFile(file, 'utf8'))
    expect(metadata['image.name']).toBe('docker.io/library/ddimg-meta:dev')
    expect(metadata['containerimage.config.digest']).toBe(await imageId(A, 'ddimg-meta:dev'))
    // The one place a private name still shows: provenance, which buildx reads
    // out of a content-addressed blob (`Content/Read`) that is not the
    // bridge's to rewrite. What the build really used is what it records.
    const { 'buildx.build.provenance': provenance, ...rest } = metadata
    expect(JSON.stringify(rest)).not.toContain('domo-env_')
    expect(provenance.materials[0].uri).toMatch(new RegExp(`^pkg:docker/domo-${A.id}/docker.io/library/ddimg-base@dev`))
  }, 120_000)

  it('gives docker tag and commit the environment\'s own names', async () => {
    await cli(A, ['tag', BASE, 'ddimg-tagged:1'])
    expect((await cli(A, ['images', 'ddimg-tagged', '--format', '{{.Repository}}:{{.Tag}}'])).stdout).toBe('ddimg-tagged:1')
    expect((await cli(B, ['images', 'ddimg-tagged', '-q'])).stdout).toBe('')
    expect(await hostTags()).not.toContain('ddimg-tagged:1')
    // Tagging its own image again, by the name it knows.
    await cli(A, ['tag', 'ddimg-tagged:1', 'ddimg-tagged:2'])
    expect(await imageId(A, 'ddimg-tagged:2')).toBe(await imageId(null, BASE))

    await cli(A, ['run', '--name', 'ddimg-committed', BASE, 'sh', '-c', 'echo committed > /f'])
    await cli(A, ['commit', 'ddimg-committed', 'ddimg-commit:1'])
    await cli(A, ['rm', 'ddimg-committed'])
    expect((await cli(A, ['run', '--rm', 'ddimg-commit:1', 'cat', '/f'])).stdout).toBe('committed')
    expect(await hostTags()).toContain(`${privateRepoOf(A, 'ddimg-commit')}:1`)
    expect(await hostTags()).not.toContain('ddimg-commit:1')
  }, 120_000)

  it('saves an archive under the names it used, and loads one as its own without moving a shared tag', async () => {
    await cli(A, ['build', '-q', '-t', 'ddimg-saved:1', await dockerfile('saved', [`FROM ${BASE}`, 'RUN echo saved-by-a > /saved'])])
    const archive = join(workDir, 'saved.tar')
    await cli(A, ['save', '-o', archive, 'ddimg-saved:1'])
    const extracted = join(workDir, 'saved-archive')
    await mkdir(extracted)
    await run('tar', ['-xf', archive, '-C', extracted])
    const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'))
    expect(manifest[0].RepoTags).toEqual(['ddimg-saved:1'])
    const index = JSON.parse(await readFile(join(extracted, 'index.json'), 'utf8'))
    expect(index.manifests[0].annotations['io.containerd.image.name']).toBe('docker.io/library/ddimg-saved:1')
    // The layers are untouched: the host loads the same archive under its public name.
    expect(JSON.stringify(manifest)).not.toContain('domo-env_')

    // A shared tag of the same name, the host's: the load in B must not move it.
    await host(['tag', BASE, 'ddimg-saved:1'])
    const loaded = await cli(B, ['load', '-i', archive])
    expect(loaded.stdout).toContain('Loaded image: ddimg-saved:1')
    expect(`${loaded.stdout}${loaded.stderr}`).not.toContain('domo-env_')
    expect((await cli(B, ['run', '--rm', 'ddimg-saved:1', 'cat', '/saved'])).stdout).toBe('saved-by-a')
    expect(await imageId(null, 'ddimg-saved:1')).toBe(await imageId(null, BASE))
    expect(await hostTags()).toContain(`${privateRepoOf(B, 'ddimg-saved')}:1`)
    await host(['rmi', 'ddimg-saved:1'])
  }, 180_000)

  it('pushes its own image under the real name, and leaves the shared tag of that name as it was', async () => {
    // A host port chosen here, not by Docker: measured on Docker Desktop, the
    // daemon cannot push to `localhost:<port>` when Docker allocated the port
    // (a timeout), and can when the port was asked for.
    registryPort = await freePort()
    if (!(await imageId(null, 'registry:2'))) {
      pulledRegistry = true
      await host(['pull', '-q', 'registry:2'])
    }
    await host(['run', '-d', '--name', REGISTRY, '-p', `127.0.0.1:${registryPort}:5000`, 'registry:2'])
    await expect.poll(async () => (await fetch(`http://127.0.0.1:${registryPort}/v2/`).catch(() => null))?.status, { timeout: 30_000 }).toBe(200)
    const name = `localhost:${registryPort}/ddimg-push:1`
    await cli(A, ['build', '-q', '-t', name, await dockerfile('push', [`FROM ${BASE}`, 'RUN echo pushed-by-a > /pushed'])])
    // Somebody else's copy under the same name on the host.
    await host(['tag', BASE, name])
    const pushed = await cli(A, ['push', name])
    expect(pushed.stdout).toContain('1: digest: sha256:')
    await expect.poll(() => imageId(null, name)).toBe(await imageId(null, BASE))
    expect(await imageId(A, name)).not.toBe(await imageId(null, BASE))
    // What the registry holds is A's.
    await host(['rmi', name])
    await host(['pull', '-q', name])
    expect((await host(['run', '--rm', name, 'cat', '/pushed'])).stdout).toBe('pushed-by-a')
    await host(['rmi', name])

    // `--push` in the build itself: the exporter keeps the registry's name, and the private tag is added after.
    const built = `localhost:${registryPort}/ddimg-bpush:1`
    await cli(A, ['build', '-q', '--push', '-t', built, await dockerfile('bpush', [`FROM ${BASE}`, 'RUN echo built-and-pushed > /p'])])
    expect(await hostTags()).not.toContain(built)
    expect((await cli(A, ['run', '--rm', built, 'cat', '/p'])).stdout).toBe('built-and-pushed')
    expect(await hostTags()).toContain(`domo-${A.id}/localhost__${registryPort}/ddimg-bpush:1`)
    // No pushed tag was ever there: `--all-tags` of a repo A holds is refused rather than pushing the shared ones.
    const all = await cli(A, ['push', '--all-tags', `localhost:${registryPort}/ddimg-push`], true)
    expect(all.stderr).toContain('Domo: `docker push --all-tags')
  }, 240_000)

  it('pulls into the shared cache, and a pull of a name it built moves its own tag to what was pulled', async () => {
    const name = `localhost:${registryPort}/ddimg-pulled:1`
    await host(['build', '-q', '-t', name, await dockerfile('pulled', [`FROM ${BASE}`, 'RUN echo from-the-registry > /r'])])
    await host(['push', '-q', name])
    await host(['rmi', name])
    await cli(A, ['build', '-q', '-t', name, await dockerfile('pulled-local', [`FROM ${BASE}`, 'RUN echo built-locally > /r'])])
    expect((await cli(A, ['run', '--rm', name, 'cat', '/r'])).stdout).toBe('built-locally')
    await cli(A, ['pull', '-q', name])
    expect(await hostTags()).toContain(name)
    expect((await cli(A, ['run', '--rm', name, 'cat', '/r'])).stdout).toBe('from-the-registry')
    // B, which built nothing under that name, simply uses the shared one.
    expect((await cli(B, ['run', '--rm', name, 'cat', '/r'])).stdout).toBe('from-the-registry')
    await host(['rmi', name])
  }, 180_000)

  it('removes only its own tags, a shared name unforced, and never an image a container uses', async () => {
    await cli(B, ['tag', BASE, 'ddimg-tagged:1'])
    const removed = await cli(A, ['rmi', 'ddimg-tagged:2'])
    expect(removed.stdout).toBe('Untagged: ddimg-tagged:2')
    expect((await cli(A, ['images', 'ddimg-tagged', '--format', '{{.Tag}}'])).stdout).toBe('1')
    await cli(A, ['rmi', 'ddimg-tagged:1'])
    expect((await cli(A, ['images', 'ddimg-tagged', '-q'])).stdout).toBe('')
    expect((await cli(B, ['images', 'ddimg-tagged', '--format', '{{.Tag}}'])).stdout).toBe('1')
    expect(await imageId(null, BASE)).not.toBe('')

    // A shared image the stand-in environments run on — the developer's own
    // containers, for this purpose — even while B holds a private name on the
    // same image, which is what lets the daemon untag it without complaint.
    for (const args of [['rmi', BASE], ['rmi', '-f', BASE], ['rmi', '-f', await imageId(null, BASE)]]) {
      const refused = await cli(A, args, true)
      expect(refused.code).not.toBe(0)
      expect(refused.stderr).toMatch(/is shared with the host and the other environments on this daemon, and \d+ containers? outside/)
    }
    expect(await imageId(null, BASE)).not.toBe('')
    expect(await imageId(null, `${privateRepoOf(B, 'ddimg-tagged')}:1`)).not.toBe('')
    // A shared name nothing uses goes, as on a real machine.
    await host(['build', '-q', '-t', 'ddimg-shared:1', await dockerfile('shared', [`FROM ${BASE}`, 'RUN echo nobody-runs-this > /s'])])
    expect((await cli(A, ['rmi', 'ddimg-shared:1'])).stdout).toMatch(/^Untagged: ddimg-shared:1\nDeleted: sha256:/)
    expect(await hostTags()).not.toContain('ddimg-shared:1')

    // By id, an image only this environment names goes altogether.
    const id = await imageId(A, 'ddimg-copy:dev')
    await cli(A, ['rmi', id])
    expect(await imageId(null, id)).toBe('')
    // A name it never had: the daemon's own answer, with no private name in it.
    const missing = await cli(A, ['rmi', 'ddimg-never:1'], true)
    expect(missing.stderr).toMatch(/No such image: ddimg-never:1/)
  }, 120_000)

  it('refuses docker builder prune, loudly', async () => {
    const pruned = await cli(A, ['builder', 'prune', '-f'], true)
    expect(pruned.code).not.toBe(0)
    expect(pruned.stderr).toContain('Domo: the build cache is shared by every environment on this daemon')
  }, 60_000)

  it('runs compose build then up, image + build, pull_policy, and a service FROM another service\'s image', async () => {
    const dir = join(workDir, 'compose')
    await mkdir(join(dir, 'base'), { recursive: true })
    await mkdir(join(dir, 'app'), { recursive: true })
    await writeFile(join(dir, 'base', 'Dockerfile'), `FROM ${BASE}\nARG WHO\nRUN echo "base-of-$WHO" > /base\n`)
    await writeFile(join(dir, 'app', 'Dockerfile'), 'FROM ddimg-cbase:dev\nRUN cp /base /app\n')
    await writeFile(join(dir, 'compose.yaml'), [
      'services:',
      '  base:',
      '    image: ddimg-cbase:dev',
      '    build: { context: ./base, args: { WHO: "${WHO}" } }',
      '    command: ["cat", "/base"]',
      '  app:',
      '    image: ddimg-capp:dev',
      '    build: ./app',
      '    pull_policy: missing',
      '    command: ["sh", "-c", "cat /app; sleep 600"]',
      '  unnamed:',
      '    build: ./base',
      '    command: ["sleep", "600"]',
      '  shared:',
      `    image: ${BASE}`,
      '    pull_policy: always',
      '    command: ["sleep", "600"]',
      ''
    ].join('\n'))
    for (const env of envs) {
      const project = { ...process.env }
      process.env.WHO = env.id
      try {
        await compose(env, 'ddimg', ['build', 'base'])
        await compose(env, 'ddimg', ['build'])
      } finally {
        process.env.WHO = project.WHO
      }
    }
    for (const env of envs) {
      await compose(env, 'ddimg', ['up', '-d'])
      await expect.poll(async () => (await compose(env, 'ddimg', ['logs', 'app'])).stdout, { timeout: 30_000 })
        .toContain(`base-of-${env.id}`)
      const images = (await compose(env, 'ddimg', ['images', '--format', 'json'])).stdout
      expect(images).not.toContain('domo-env_')
      // A second `up` recreates nothing: what inspect says about the image agrees with what compose asked for.
      const again = await compose(env, 'ddimg', ['up', '-d'])
      // `pull_policy: always` pulls the shared image, and nothing else is pulled.
      const output = `${again.stdout}\n${again.stderr}`
      expect(output).not.toMatch(/Recreat|pull access denied|ddimg-c(app|base):dev Pulling/)
      expect(output).toContain(`Image ${BASE} Pulled`)
    }
    expect((await cli(A, ['images', 'ddimg-unnamed', '--format', '{{.Repository}}:{{.Tag}}'])).stdout).toBe('ddimg-unnamed:latest')
    expect(await hostTags()).not.toContain('ddimg-capp:dev')
    // `--rmi local`: every image compose built (compose 5 counts `image:` + `build:` as local), and only this environment's.
    const down = await compose(A, 'ddimg', ['down', '--rmi', 'local'])
    expect(down.stderr).toContain('Image ddimg-capp:dev Removed')
    const built = ['ddimg-capp', 'ddimg-cbase', 'ddimg-unnamed']
    const listed = async (env: Env) => (await cli(env, ['images', '--format', '{{.Repository}}', ...built.flatMap(name => ['--filter', `reference=${name}`])])).stdout
    expect(await listed(A)).toBe('')
    expect((await listed(B)).split('\n').sort()).toEqual(built)
    await compose(B, 'ddimg', ['down', '--rmi', 'local'])
    expect(await listed(B)).toBe('')
    expect(await imageId(null, BASE)).not.toBe('')
  }, 300_000)

  it('names the legacy builder\'s tags privately too', async () => {
    const dir = await dockerfile('legacy', [`FROM ${BASE}`, 'RUN echo legacy > /l'])
    const built = await exec('docker', ['build', '-t', 'ddimg-legacy:1', dir], { env: { ...envOf(A), DOCKER_BUILDKIT: '0' } })
    if (built.code !== 0 && /legacy builder is (deprecated|removed)|not supported/i.test(built.stderr)) return
    expect(built.code).toBe(0)
    expect(`${built.stdout}\n${built.stderr}`).toContain('Successfully tagged ddimg-legacy:1')
    expect(`${built.stdout}\n${built.stderr}`).not.toContain('domo-env_')
    expect((await cli(A, ['run', '--rm', 'ddimg-legacy:1', 'cat', '/l'])).stdout).toBe('legacy')
    expect(await hostTags()).not.toContain('ddimg-legacy:1')
  }, 120_000)

  it('shows another environment none of its image events', async () => {
    const since = Math.floor(Date.now() / 1000) - 1
    await cli(B, ['tag', BASE, 'ddimg-evented:1'])
    await cli(A, ['tag', BASE, 'ddimg-evented-a:1'])
    const until = Math.floor(Date.now() / 1000) + 1
    const events = (await cli(A, ['events', '--since', String(since), '--until', String(until), '--filter', 'type=image', '--format', '{{json .}}'])).stdout
    expect(events).toContain('ddimg-evented-a:1')
    expect(events).not.toContain('ddimg-evented:1"')
    expect(events).not.toContain('domo-env_')
  }, 60_000)

  it('logged nothing about a build client hanging up', () => {
    expect(warnings.filter(line => /hung up|build channel|build could not/.test(line))).toEqual([])
  })

  it('sweeps an environment\'s private tags when it is retired, and only its own', async () => {
    await removeEnvironmentResources(A.id)
    const tags = await hostTags()
    expect(tags.filter(tag => tag.startsWith(`domo-${A.id}/`))).toEqual([])
    expect(tags.filter(tag => tag.startsWith(`domo-${B.id}/`)).length).toBeGreaterThan(0)
    expect(await imageId(null, BASE)).not.toBe('')
  }, 120_000)
})
