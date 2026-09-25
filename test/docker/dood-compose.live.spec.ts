import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { run } from '../../server/lib/dev-env/docker'
import { portHelperImage, portHelperName } from '../../server/lib/dev-env/port-helper'
import { ensureDoodProxy, stopDoodProxy, sweepEnvironmentResources } from '../../server/lib/dood/manager'
import type { DoodProxy } from '../../server/lib/dood/proxy'
import type { PublishedPort } from '../../server/lib/dood/rewrite'

/**
 * The case the whole design exists for: an agent running `docker compose up`
 * inside an environment, against the host daemon, with the workspace reaching
 * the services as bind mounts and no host port published for anything.
 *
 * Compose is worth its own file because it is not the Docker CLI — it speaks
 * the Engine API directly, so nothing a `docker run` test proves carries over
 * to it for free. It runs through `manager.ts` rather than a bare proxy so
 * that the Docker work is the real one: a stand-in for the environment's own
 * container really joins the stack's network, which is exactly what makes a
 * plain `compose down` fail on "active endpoints" unless the proxy detaches it
 * first; and the sweep really removes only what carries the label.
 *
 * Opt in with `pnpm test:docker`.
 */

const ENV_ID = 'env_composeprobe'
const VOLUME = 'domo-dood-compose-workspace'
const WORKSPACE = '/workspaces/probe'
const PROJECT = 'domodoodprobe'
const ENV_CONTAINER = 'domo-dood-compose-env'

const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true })
  .then(output => output.stdout.length > 0).catch(() => false)

let proxy: DoodProxy
let workDir: string
let socketDir: string
const dropped: PublishedPort[] = []

const inVolume = (script: string) =>
  run('docker', ['run', '--rm', '-v', `${VOLUME}:/w`, 'alpine:3', 'sh', '-c', script])

const compose = (args: string[], allowFailure = false) =>
  run('docker', ['compose', '-p', PROJECT, ...args], {
    cwd: workDir,
    env: { ...process.env, DOCKER_HOST: `unix://${proxy.socketPath}` },
    allowFailure
  })

const envNetworks = async () => Object.keys(JSON.parse((await run('docker', [
  'inspect', '--format', '{{json .NetworkSettings.Networks}}', ENV_CONTAINER
])).stdout))

const labelled = async (kind: 'network' | 'volume') => (await run('docker', [
  kind, 'ls', '-q', '--filter', `label=domo.env=${ENV_ID}`
])).stdout.split('\n').filter(Boolean)

describe.skipIf(!daemon)('DooD proxy under docker compose', () => {
  beforeAll(async () => {
    // Its own port helper (the relay publishing `ports:` runs in it), not the developer's.
    process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-dood-compose-test-'
    socketDir = await mkdtemp('/tmp/ddc-')
    process.env.NUXT_DOOD_SOCKET_DIR = socketDir
    await run('docker', ['rm', '-f', ENV_CONTAINER], { allowFailure: true })
    await run('docker', ['volume', 'rm', '-f', VOLUME], { allowFailure: true })
    await run('docker', ['volume', 'create', VOLUME])
    // The file the service will read comes from the workspace volume, which on
    // the host daemon does not exist as a path at all.
    await inVolume("mkdir -p /w/site && echo 'from-the-workspace' > /w/site/index.html")
    await run('docker', ['run', '-d', '--name', ENV_CONTAINER, 'alpine:3', 'sleep', '600'])

    workDir = await mkdtemp(join(tmpdir(), 'domo-dood-compose-'))
    await writeFile(join(workDir, 'compose.yaml'), [
      'services:',
      '  web:',
      '    image: alpine:3',
      '    command: ["sleep", "300"]',
      '    volumes:',
      `      - ${WORKSPACE}/site:/usr/share/site:ro`,
      '      - data:/data',
      '    ports:',
      '      - "8080:8080"',
      'volumes:',
      '  data: {}',
      ''
    ].join('\n'))

    proxy = await ensureDoodProxy({
      environmentId: ENV_ID,
      containerReference: ENV_CONTAINER,
      workspacePath: WORKSPACE,
      workspaceVolume: VOLUME,
      helperImage: 'alpine:3',
      onDroppedPorts: ports => { dropped.push(...ports) }
    })
  }, 180_000)

  afterAll(async () => {
    if (proxy) await compose(['down', '-v', '--remove-orphans'], true).catch(() => {})
    await stopDoodProxy(ENV_ID)
    await run('docker', ['rm', '-f', ENV_CONTAINER], { allowFailure: true })
    await sweepEnvironmentResources(ENV_ID)
    await run('docker', ['volume', 'rm', '-f', VOLUME], { allowFailure: true })
    await run('docker', ['rm', '-f', portHelperName()], { allowFailure: true })
    await run('docker', ['rmi', portHelperImage()], { allowFailure: true })
    delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
    delete process.env.NUXT_DOOD_SOCKET_DIR
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
    expect(dropped).toContainEqual({ containerPort: 8080, protocol: 'tcp', hostPort: 8080 })

    // Everything compose created carries the environment's label: the
    // container, and the network and volume it made for it.
    const label = await run('docker', ['inspect', '--format', '{{index .Config.Labels "domo.env"}}', ids[0]!])
    expect(label.stdout).toBe(ENV_ID)
    expect(await labelled('network')).toHaveLength(1)
    expect(await labelled('volume')).toHaveLength(1)

    // And the environment's own container really joined the stack's network,
    // so the agent can reach `web` by name.
    expect(await envNetworks()).toContain(`${ENV_ID}-${PROJECT}_default`)
  }, 180_000)

  it('can take the stack down although the environment joined its network', async () => {
    const down = await compose(['down'], true)
    expect(down.stderr).not.toMatch(/active endpoints/)
    expect(await envNetworks()).not.toContain(`${ENV_ID}-${PROJECT}_default`)
    expect(await labelled('network')).toHaveLength(0)
  }, 180_000)

  it('sweeps exactly what the environment made, and nothing else', async () => {
    await compose(['up', '-d'])
    const bystander = 'domo-dood-compose-bystander'
    await run('docker', ['network', 'create', bystander], { allowFailure: true })
    try {
      await run('docker', ['rm', '-f', ENV_CONTAINER])
      await sweepEnvironmentResources(ENV_ID)

      const left = await run('docker', ['ps', '-aq', '--filter', `label=domo.env=${ENV_ID}`])
      expect(left.stdout).toBe('')
      expect(await labelled('network')).toHaveLength(0)
      expect(await labelled('volume')).toHaveLength(0)
      // An unlabelled, unused network is someone else's and must survive.
      const still = await run('docker', ['network', 'ls', '-q', '--filter', `name=^${bystander}$`])
      expect(still.stdout).not.toBe('')
    } finally {
      await run('docker', ['network', 'rm', bystander], { allowFailure: true })
    }
  }, 180_000)
})
