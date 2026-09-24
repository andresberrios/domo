import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { run } from '../../server/lib/dev-env/docker'
import { startDoodProxy, type DoodProxy } from '../../server/lib/dood/proxy'
import type { PublishedPort } from '../../server/lib/dood/rewrite'

/**
 * The proxy against a real daemon. The pure translation is covered in
 * `test/unit/dood-rewrite.spec.ts`; what needs a daemon is everything the
 * translation cannot tell you — that a rewritten mount really carries the
 * workspace, that `volume-subpath` accepts what we built for it, and above all
 * that the transport survives the two shapes an earlier version deadlocked on:
 * an attached (hijacked) run, and a long-polled wait.
 *
 * Opt in with `pnpm test:docker`.
 */

const VOLUME = 'domo-dood-test-workspace'
const WORKSPACE = '/workspaces/probe'
const HELPER = 'alpine:3'

const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true })
  .then(output => output.stdout.length > 0).catch(() => false)

let proxy: DoodProxy
let socketDir: string
let dropped: PublishedPort[] = []
let joined: string[] = []

/** Run the host `docker` CLI against the proxy instead of the daemon. */
const viaProxy = (args: string[], allowFailure = false) =>
  run('docker', args, { env: { ...process.env, DOCKER_HOST: `unix://${proxy.socketPath}` }, allowFailure })

const inVolume = (script: string) =>
  run('docker', ['run', '--rm', '-v', `${VOLUME}:/w`, HELPER, 'sh', '-c', script])

describe.skipIf(!daemon)('DooD socket proxy', () => {
  beforeAll(async () => {
    await run('docker', ['volume', 'rm', '-f', VOLUME], { allowFailure: true })
    await run('docker', ['volume', 'create', VOLUME])
    await inVolume('mkdir -p /w/app && echo hello > /w/app/file.txt && echo root > /w/root.txt')

    socketDir = await mkdtemp(join(tmpdir(), 'domo-dood-'))
    proxy = await startDoodProxy({
      socketPath: join(socketDir, 'docker.sock'),
      scope: { workspacePath: WORKSPACE, workspaceVolume: VOLUME, labels: { 'domo.env': 'env_probe' } },
      ensureSubpaths: async subpaths => {
        for (const subpath of subpaths) await inVolume(`mkdir -p ${JSON.stringify(`/w/${subpath}`)}`)
      },
      joinNetworks: async networks => { joined.push(...networks) },
      onDroppedPorts: ports => { dropped.push(...ports) }
    })
  }, 120_000)

  afterAll(async () => {
    await proxy?.close()
    // By volume as well as by label: a `--rm` container from the last test may
    // still be unwinding, and the volume cannot go while anything references it.
    for (const filter of ['label=domo.env=env_probe', `volume=${VOLUME}`]) {
      const found = await run('docker', ['ps', '-aq', '--filter', filter], { allowFailure: true })
      if (found.stdout) await run('docker', ['rm', '-f', ...found.stdout.split('\n')], { allowFailure: true })
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const removed = await run('docker', ['volume', 'rm', VOLUME], { allowFailure: true })
      if (!removed.stderr) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (socketDir) await rm(socketDir, { recursive: true, force: true })
  }, 120_000)

  it('passes an attached run through without deadlocking', async () => {
    // The shape that hung when every request was buffered and re-framed.
    const output = await viaProxy(['run', '--rm', HELPER, 'echo', 'attached-ok'])
    expect(output.stdout).toContain('attached-ok')
  }, 120_000)

  it('answers ordinary queries', async () => {
    const output = await viaProxy(['version', '--format', '{{.Server.Version}}'])
    expect(output.stdout).toMatch(/^\d+\./)
  }, 60_000)

  it('carries the workspace into a rewritten bind mount', async () => {
    const output = await viaProxy(['run', '--rm', '-v', `${WORKSPACE}/app:/app`, HELPER, 'cat', '/app/file.txt'])
    expect(output.stdout).toBe('hello')
  }, 120_000)

  it('mounts the whole volume for the workspace root', async () => {
    const output = await viaProxy(['run', '--rm', '-v', `${WORKSPACE}:/src`, HELPER, 'cat', '/src/root.txt'])
    expect(output.stdout).toBe('root')
  }, 120_000)

  it('creates a subpath the compose file expects to exist', async () => {
    // Docker refuses a `volume-subpath` that is not there; the proxy builds it first.
    const output = await viaProxy([
      'run', '--rm', '-v', `${WORKSPACE}/made/up/dir:/x`, HELPER, 'sh', '-c', 'touch /x/ok && ls /x'
    ])
    expect(output.stdout).toContain('ok')
    const check = await inVolume('ls /w/made/up/dir')
    expect(check.stdout).toContain('ok')
  }, 120_000)

  it('writes through to the volume', async () => {
    await viaProxy(['run', '--rm', '-v', `${WORKSPACE}/app:/app`, HELPER, 'sh', '-c', 'echo written > /app/probe.txt'])
    const check = await inVolume('cat /w/app/probe.txt')
    expect(check.stdout).toBe('written')
  }, 120_000)

  it('leaves a bind outside the workspace alone', async () => {
    // Not ours to translate: it must reach the daemon as written and fail there.
    const output = await viaProxy(
      ['run', '--rm', '-v', '/definitely/not/shared/anywhere:/x', HELPER, 'ls', '/x'],
      true
    )
    expect(`${output.stdout}${output.stderr}`).not.toBe('')
  }, 120_000)

  it('drops host port publishing and reports it', async () => {
    dropped = []
    const created = await viaProxy(['create', '-p', '3000:3000', HELPER, 'true'])
    const id = created.stdout.trim()
    const bindings = await run('docker', ['inspect', '--format', '{{json .HostConfig.PortBindings}}', id])
    expect(bindings.stdout).toBe('{}')
    expect(dropped).toContainEqual({ containerPort: 3000, protocol: 'tcp', hostPort: 3000 })
    await run('docker', ['rm', '-f', id], { allowFailure: true })
  }, 120_000)

  it('stamps the environment label so cleanup can sweep by it', async () => {
    const created = await viaProxy(['create', HELPER, 'true'])
    const id = created.stdout.trim()
    const labels = await run('docker', ['inspect', '--format', '{{index .Config.Labels "domo.env"}}', id])
    expect(labels.stdout).toBe('env_probe')
    await run('docker', ['rm', '-f', id], { allowFailure: true })
  }, 120_000)

  it('reports the networks the environment container must join', async () => {
    joined = []
    await run('docker', ['network', 'create', 'domo-dood-test-net'], { allowFailure: true })
    const created = await viaProxy(['create', '--network', 'domo-dood-test-net', HELPER, 'true'])
    expect(joined).toContain('domo-dood-test-net')
    await run('docker', ['rm', '-f', created.stdout.trim()], { allowFailure: true })
    await run('docker', ['network', 'rm', 'domo-dood-test-net'], { allowFailure: true })
  }, 120_000)
})
