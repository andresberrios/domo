import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * One volume holds Node and both ACP adapters for every environment on the machine.
 * Its name is a hash of what is in it, so bumping a pin builds a new one and leaves
 * the volume a running environment already mounted exactly where it was.
 */

const run = vi.fn(async (_program: string, _args: string[], _options?: unknown) => ({ stdout: '', stderr: '' }))
const dockerServerArch = vi.fn(async () => 'arm64')

vi.mock('../../server/lib/dev-env/docker', () => ({
  run,
  dockerServerArch,
  resourcePrefix: () => 'domo-dev-'
}))

/** The module memoises its build for the process, so every test needs its own copy. */
async function load() {
  vi.resetModules()
  return import('../../server/lib/dev-env/runtime-volume')
}

function dockerCalls(): string[][] {
  return run.mock.calls.filter(([program]) => program === 'docker').map(([, args]) => args)
}

beforeEach(() => {
  vi.clearAllMocks()
  run.mockResolvedValue({ stdout: '', stderr: '' })
  dockerServerArch.mockResolvedValue('arm64')
})

describe('runtimeVolumeName', () => {
  it('is stable for the same pins', async () => {
    const { runtimeVolumeName } = await load()

    expect(runtimeVolumeName('arm64')).toBe(runtimeVolumeName('arm64'))
    expect(runtimeVolumeName('arm64')).toMatch(/^domo-dev-runtime-[0-9a-f]{12}$/)
  })

  it('changes with the architecture, because the binaries in it do', async () => {
    const { runtimeVolumeName } = await load()

    expect(runtimeVolumeName('arm64')).not.toBe(runtimeVolumeName('amd64'))
  })

  it('changes when a pinned version does', async () => {
    const before = (await load()).runtimeVolumeName('arm64')
    process.env.NUXT_DEV_ENV_RUNTIME_IMAGE = 'node:24-bookworm-slim'
    const bumped = (await load()).runtimeVolumeName('arm64')
    delete process.env.NUXT_DEV_ENV_RUNTIME_IMAGE

    expect(bumped).not.toBe(before)
  })
})

describe('adapterCommandPath', () => {
  it('points at the wrapper in the volume, not at anything on the image\'s PATH', async () => {
    const { adapterCommandPath } = await load()

    expect(adapterCommandPath('claude-code')).toBe('/opt/domo/bin/claude-agent-acp')
    expect(adapterCommandPath('codex')).toBe('/opt/domo/bin/codex-acp')
    expect(adapterCommandPath('opencode')).toBe('/opt/domo/bin/opencode-acp')
  })
})

describe('ensureRuntimeVolume', () => {
  it('populates a volume that has no .ready marker, and writes the marker last', async () => {
    // The readiness probe fails: nothing is in the volume yet.
    run.mockImplementation(async (_program, args) => {
      if (args.includes('test')) throw new Error('exit 1')
      return { stdout: '', stderr: '' }
    })
    const { ensureRuntimeVolume } = await load()

    const volume = await ensureRuntimeVolume()

    expect(dockerCalls()[0]).toEqual(['volume', 'create', '--label', 'domo.runtime=true', volume])
    const script = dockerCalls().at(-1)!.at(-1)!
    expect(script).toContain('npm install --prefix /opt/domo/adapters')
    expect(script).toContain('@agentclientprotocol/claude-agent-acp@0.81.1')
    expect(script).toContain('@agentclientprotocol/codex-acp@1.13.1')
    expect(script).toContain('@opencode/cli@2.0.15')
    // The absolute node: npm's own shims say `#!/usr/bin/env node`, and the environment's
    // image is not required to have a node at all.
    expect(script).toContain('exec /opt/domo/node/bin/node /opt/domo/adapters/node_modules/')
    expect(script).toContain('exec /opt/domo/adapters/node_modules/@opencode/cli/bin/opencode.exe acp')
    expect(script.trim().endsWith('touch /opt/domo/.ready')).toBe(true)
  })

  it('does nothing to a volume that is already populated', async () => {
    const { ensureRuntimeVolume } = await load()

    await ensureRuntimeVolume()

    expect(dockerCalls().join('\n')).not.toContain('npm install')
    expect(dockerCalls()).toHaveLength(2)
  })

  it('is built once, however many environments ask for it at the same time', async () => {
    const { ensureRuntimeVolume } = await load()

    const [first, second, third] = await Promise.all([
      ensureRuntimeVolume(), ensureRuntimeVolume(), ensureRuntimeVolume()
    ])

    expect([second, third]).toEqual([first, first])
    expect(dockerCalls().filter(args => args[0] === 'volume' && args[1] === 'create')).toHaveLength(1)
  })

  it('is retried after a failure instead of handing out the failure for ever', async () => {
    run.mockRejectedValueOnce(new Error('no such image'))
    const { ensureRuntimeVolume } = await load()

    await expect(ensureRuntimeVolume()).rejects.toThrow('no such image')
    await expect(ensureRuntimeVolume()).resolves.toMatch(/^domo-dev-runtime-/)
  })
})

describe('collectRuntimeVolumes', () => {
  it('removes every runtime volume but the current one', async () => {
    const { collectRuntimeVolumes, runtimeVolumeName } = await load()
    const current = runtimeVolumeName('arm64')
    run.mockImplementation(async (_program, args) => ({
      stdout: args[1] === 'ls' ? [current, 'domo-dev-runtime-deadbeef0000'].join('\n') : '',
      stderr: ''
    }))

    await collectRuntimeVolumes()

    expect(dockerCalls()).toContainEqual(['volume', 'rm', 'domo-dev-runtime-deadbeef0000'])
    expect(dockerCalls()).not.toContainEqual(['volume', 'rm', current])
  })
})
