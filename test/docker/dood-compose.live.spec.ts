import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { run } from '../../server/lib/dev-env/docker'
import { startDoodProxy, type DoodProxy } from '../../server/lib/dood/proxy'
import type { PublishedPort } from '../../server/lib/dood/rewrite'

/**
 * The case the whole design exists for: an agent running `docker compose up`
 * inside an environment, against the host daemon, with the workspace reaching
 * the services as bind mounts and no host port published for anything.
 *
 * Compose is worth its own file because it is not the Docker CLI — it speaks
 * the Engine API directly, so nothing a `docker run` test proves carries over
 * to it for free.
 *
 * Opt in with `pnpm test:docker`.
 */

const VOLUME = 'domo-dood-compose-workspace'
const WORKSPACE = '/workspaces/probe'
const PROJECT = 'domodoodprobe'

const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true })
  .then(output => output.stdout.length > 0).catch(() => false)

let proxy: DoodProxy
let workDir: string
let socketDir: string
const dropped: PublishedPort[] = []
const joined: string[] = []

const inVolume = (script: string) =>
  run('docker', ['run', '--rm', '-v', `${VOLUME}:/w`, 'alpine:3', 'sh', '-c', script])

const compose = (args: string[], allowFailure = false) =>
  run('docker', ['compose', '-p', PROJECT, ...args], {
    cwd: workDir,
    env: { ...process.env, DOCKER_HOST: `unix://${proxy.socketPath}` },
    allowFailure
  })

describe.skipIf(!daemon)('DooD proxy under docker compose', () => {
  beforeAll(async () => {
    await run('docker', ['volume', 'rm', '-f', VOLUME], { allowFailure: true })
    await run('docker', ['volume', 'create', VOLUME])
    // The file the service will read comes from the workspace volume, which on
    // the host daemon does not exist as a path at all.
    await inVolume("mkdir -p /w/site && echo 'from-the-workspace' > /w/site/index.html")

    workDir = await mkdtemp(join(tmpdir(), 'domo-dood-compose-'))
    await writeFile(join(workDir, 'compose.yaml'), [
      'services:',
      '  web:',
      '    image: alpine:3',
      '    command: ["sleep", "300"]',
      '    volumes:',
      `      - ${WORKSPACE}/site:/usr/share/site:ro`,
      '    ports:',
      '      - "8080:8080"',
      ''
    ].join('\n'))

    socketDir = await mkdtemp(join(tmpdir(), 'domo-dood-sock-'))
    proxy = await startDoodProxy({
      socketPath: join(socketDir, 'docker.sock'),
      scope: { workspacePath: WORKSPACE, workspaceVolume: VOLUME, labels: { 'domo.env': 'env_compose' } },
      ensureSubpaths: async subpaths => {
        for (const subpath of subpaths) await inVolume(`mkdir -p ${JSON.stringify(`/w/${subpath}`)}`)
      },
      joinNetworks: async networks => { joined.push(...networks) },
      onDroppedPorts: ports => { dropped.push(...ports) }
    })
  }, 180_000)

  afterAll(async () => {
    if (proxy) await compose(['down', '-v', '--remove-orphans'], true).catch(() => {})
    await proxy?.close()
    await run('docker', ['volume', 'rm', '-f', VOLUME], { allowFailure: true })
    for (const dir of [workDir, socketDir]) if (dir) await rm(dir, { recursive: true, force: true })
  }, 180_000)

  it('brings a stack up with the workspace mounted and no published ports', async () => {
    await compose(['up', '-d'])

    const ids = (await compose(['ps', '-q'])).stdout.split('\n').filter(Boolean)
    expect(ids.length).toBe(1)

    // The bind became a volume+subpath mount, so the service really sees the
    // workspace even though its path does not exist on the host at all.
    const seen = await run('docker', ['exec', ids[0]!, 'cat', '/usr/share/site/index.html'])
    expect(seen.stdout).toBe('from-the-workspace')

    // …and read-only, as the compose file asked.
    const readonly = await run('docker', ['exec', ids[0]!, 'sh', '-c', 'touch /usr/share/site/nope'], { allowFailure: true })
    expect(readonly.stderr).toMatch(/[Rr]ead-only/)

    // `ports: 8080:8080` was asked for and must not have reached the host.
    const bindings = await run('docker', ['inspect', '--format', '{{json .HostConfig.PortBindings}}', ids[0]!])
    expect(bindings.stdout).toBe('{}')
    expect(dropped).toContainEqual({ containerPort: 8080, protocol: 'tcp' })

    // Everything compose created carries the environment's label.
    const label = await run('docker', ['inspect', '--format', '{{index .Config.Labels "domo.env"}}', ids[0]!])
    expect(label.stdout).toBe('env_compose')

    // And the environment container was told which network to join.
    expect(joined.some(name => name.includes(PROJECT))).toBe(true)
  }, 180_000)
})
