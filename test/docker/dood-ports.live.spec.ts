import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Ports in a stack an environment started on the host daemon, for real.
 *
 * This is the part of the move off Docker-in-Docker that fails *quietly*: a
 * service on the shared daemon is not in the environment's network namespace,
 * so the old in-container `ss` stops seeing it and `127.0.0.1` stops reaching
 * it, and nothing errors. The service here listens on loopback only — what
 * Vite and Next do by default, and the case that rules out reaching a service
 * by name — so the only way this passes is through the port helper entering
 * its namespace.
 *
 * Postgres is replaced by an in-memory table; everything Docker is real.
 * Opt in with `pnpm test:docker`.
 */

const state = vi.hoisted(() => ({ rows: [] as any[], environment: null as any }))

vi.mock('../../server/lib/repo', () => {
  const find = (id: string, port: number, protocol: string, service: string | null) =>
    state.rows.find(row => row.devEnvironmentId === id && row.innerPort === port
      && row.protocol === protocol && row.service === service)
  const withUrl = (row: any) => ({
    ...row,
    url: row.hostPort ? `http://127.0.0.1:${row.hostPort}` : null
  })
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

// Its own port helper, not the developer's: the helper is one per install.
process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-dood-ports-test-'
const PORT_HELPER = 'domo-dood-ports-test-port-helper'

const { run } = await import('../../server/lib/dev-env/docker')
const { RUNTIME_IMAGE } = await import('../../server/lib/dev-env/runtime-volume')
const { portHelperImage } = await import('../../server/lib/dev-env/port-helper')
const { ensureDoodProxy, stopDoodProxy, sweepEnvironmentResources } = await import('../../server/lib/dood/manager')
const { refreshEnvironmentPorts, stopAllEnvironmentForwarders } = await import('../../server/lib/dev-environment-ports')

const ENV_ID = 'env_portsprobe'
const ENV_CONTAINER = 'domo-dood-ports-env'
const VOLUME = 'domo-dood-ports-workspace'
const PROJECT = 'domodoodports'

const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true })
  .then(output => output.stdout.length > 0).catch(() => false)

let workDir: string
let socketDir: string
let socketPath: string

const compose = (args: string[]) => run('docker', ['compose', '-p', PROJECT, ...args], {
  cwd: workDir,
  env: { ...process.env, DOCKER_HOST: `unix://${socketPath}` }
})

const helperId = async () => (await run('docker', ['inspect', '--format', '{{.Id}}', PORT_HELPER])).stdout

/** Poll a scan until the service's port shows up forwarded: a server takes a moment to listen. */
async function forwardedWeb() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const ports = await refreshEnvironmentPorts(ENV_ID)
    const web = ports.find(port => port.service?.includes('web') && port.innerPort === 3000)
    if (web?.listening && web.url) return web
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`web never came up forwarded: ${JSON.stringify(state.rows)}`)
}

describe.skipIf(!daemon)('ports in a stack on the host daemon', () => {
  beforeAll(async () => {
    socketDir = await mkdtemp('/tmp/ddo-')
    process.env.NUXT_DOOD_SOCKET_DIR = socketDir
    await run('docker', ['rm', '-f', ENV_CONTAINER], { allowFailure: true })
    await run('docker', ['volume', 'create', VOLUME])
    // A stand-in for the environment's own container: all the scanner needs of
    // it is the label saying it was created with the proxy, and a shell.
    const { stdout: id } = await run('docker', [
      'run', '-d', '--name', ENV_CONTAINER, '--label', 'domo.dood=true', 'alpine:3', 'sleep', '600'
    ])
    state.environment = {
      id: ENV_ID, containerId: id.trim(), containerName: ENV_CONTAINER, status: 'running',
      remoteUser: 'root', workspacePath: '/workspaces/probe'
    }
    socketPath = (await ensureDoodProxy({
      environmentId: ENV_ID,
      containerReference: ENV_CONTAINER,
      workspacePath: '/workspaces/probe',
      workspaceVolume: VOLUME,
      helperImage: 'alpine:3'
    })).socketPath

    workDir = await mkdtemp(join(tmpdir(), 'domo-dood-ports-stack-'))
    await writeFile(join(workDir, 'compose.yaml'), [
      'services:',
      '  web:',
      `    image: ${RUNTIME_IMAGE}`,
      // Loopback only, like a dev server left on its defaults.
      `    command: ["node", "-e", "require('http').createServer((q, r) => r.end('loopback-ok')).listen(3000, '127.0.0.1')"]`,
      '    ports:',
      // No host port named: the forward goes wherever is free.
      '      - "3000"',
      ''
    ].join('\n'))
    await compose(['up', '-d'])
  }, 300_000)

  afterAll(async () => {
    stopAllEnvironmentForwarders()
    await stopDoodProxy(ENV_ID)
    await run('docker', ['rm', '-f', ENV_CONTAINER], { allowFailure: true })
    await sweepEnvironmentResources(ENV_ID)
    await run('docker', ['volume', 'rm', '-f', VOLUME], { allowFailure: true })
    await run('docker', ['rm', '-f', PORT_HELPER], { allowFailure: true })
    await run('docker', ['rmi', portHelperImage()], { allowFailure: true })
    delete process.env.NUXT_DOOD_SOCKET_DIR
    delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
    for (const dir of [workDir, socketDir]) if (dir) await rm(dir, { recursive: true, force: true })
  }, 180_000)

  it('finds a loopback-only service and forwards what the stack asked to publish', async () => {
    const web = await forwardedWeb()

    expect(web).toMatchObject({ source: 'detected', label: 'web', forwarded: true })
    expect(await (await fetch(web.url!)).text()).toBe('loopback-ok')
    // The helper carries no environment label: it serves every one of them.
    const labels = await run('docker', ['inspect', '--format', '{{json .Config.Labels}}', PORT_HELPER])
    expect(JSON.parse(labels.stdout)).not.toHaveProperty('domo.env')
  }, 120_000)

  it('follows the service through a restart with nothing replaced', async () => {
    const before = await helperId()
    const url = (await forwardedWeb()).url!
    await compose(['restart', 'web'])

    const web = await forwardedWeb()
    // The same host port and the same helper: only the PID it enters moved.
    expect(web.url).toBe(url)
    expect(await (await fetch(web.url!)).text()).toBe('loopback-ok')
    expect(await helperId()).toBe(before)
  }, 120_000)

  it('leaves nothing of the environment behind once it is swept, and the helper for the next one', async () => {
    stopAllEnvironmentForwarders()
    await run('docker', ['rm', '-f', ENV_CONTAINER])
    await sweepEnvironmentResources(ENV_ID)

    const left = await run('docker', ['ps', '-aq', '--filter', `label=domo.env=${ENV_ID}`])
    expect(left.stdout).toBe('')
    expect(await helperId()).not.toBe('')
  }, 120_000)
})
