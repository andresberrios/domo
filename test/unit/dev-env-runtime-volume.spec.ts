import { readFileSync } from 'node:fs'

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

describe('the pins', () => {
  // Host sessions run what package.json installs and container sessions what
  // the volume does; drifting apart gives the two different models.
  it('match what package.json and pnpm-workspace.yaml install on the host', async () => {
    const { ADAPTER_PACKAGES, ADAPTER_OVERRIDES } = await load()
    const root = new URL('../../', import.meta.url)
    const dependencies = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).dependencies
    const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8')

    for (const { spec } of Object.values(ADAPTER_PACKAGES)) {
      const at = spec.lastIndexOf('@')
      expect(dependencies[spec.slice(0, at)]?.replace(/^\^/, ''), spec).toBe(spec.slice(at + 1))
    }
    for (const [name, version] of Object.entries(ADAPTER_OVERRIDES)) {
      expect(workspace).toContain(`'${name}': ${version}`)
      expect(dependencies[name]?.replace(/^\^/, ''), name).toBe(version)
    }
  })

  // An installed Domo runs what agents/ pins: its lockfile is what a release
  // ships and the launcher installs (docs/install-and-updates.md).
  it('match what an installed Domo runs, lockfile included', async () => {
    const { ADAPTER_PACKAGES, ADAPTER_OVERRIDES } = await load()
    const root = new URL('../../', import.meta.url)
    const agents = JSON.parse(readFileSync(new URL('agents/package.json', root), 'utf8'))
    const lock = JSON.parse(readFileSync(new URL('agents/package-lock.json', root), 'utf8'))
    const pinned = Object.fromEntries([
      ...Object.values(ADAPTER_PACKAGES).map(({ spec }) => [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)]),
      ...Object.entries(ADAPTER_OVERRIDES)
    ])

    expect(agents.dependencies).toEqual(pinned)
    expect(agents.overrides).toEqual(ADAPTER_OVERRIDES)
    expect(lock.packages[''].dependencies).toEqual(agents.dependencies)
    for (const [name, version] of Object.entries(pinned)) expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version)
  })
})

describe('adapterCommandPath', () => {
  it('points at the wrapper in the volume, not at anything on the image\'s PATH', async () => {
    const { adapterCommandPath } = await load()

    expect(adapterCommandPath('claude-code')).toBe('/opt/domo/bin/claude-agent-acp')
    expect(adapterCommandPath('codex')).toBe('/opt/domo/bin/codex-acp')
    expect(adapterCommandPath('opencode')).toBe('/opt/domo/bin/opencode-acp')
    expect(adapterCommandPath('grok')).toBe('/opt/domo/bin/grok-acp')
  })
})

describe('ensureRuntimeVolume', () => {
  it('populates a volume that has no .ready marker, and writes the marker last', async () => {
    // The readiness probe fails: nothing is in the volume yet.
    run.mockImplementation(async (_program, args) => {
      if (args.at(-1)?.startsWith('test -f')) throw new Error('exit 1')
      return { stdout: '', stderr: '' }
    })
    const { ensureRuntimeVolume } = await load()

    const volume = await ensureRuntimeVolume()

    expect(dockerCalls()[0]).toEqual(['volume', 'create', '--label', 'domo.runtime=true', volume])
    const script = dockerCalls().at(-1)!.at(-1)!
    expect(script).toContain('npm install --prefix /opt/domo/adapters')
    expect(script).toContain('@agentclientprotocol/claude-agent-acp@0.90.0')
    expect(script).toContain('@agentclientprotocol/codex-acp@2.2.2')
    expect(script).toContain('@opencode/cli@2.0.29')
    // codex-acp's own range would bring a second, older Codex; the override is
    // in place before the install that reads it.
    expect(script.indexOf('{"private":true,"overrides":{"@openai/codex":"0.162.1"}}'))
      .toBeLessThan(script.indexOf('npm install'))
    expect(script.indexOf('{"private":true')).toBeGreaterThan(-1)
    // The absolute node: npm's own shims say `#!/usr/bin/env node`, and the environment's
    // image is not required to have a node at all.
    expect(script).toContain('exec /opt/domo/node/bin/node /opt/domo/adapters/node_modules/')
    expect(script).toContain('exec /opt/domo/adapters/node_modules/@opencode/cli/bin/opencode.exe acp')
    // Grok ships its executable compressed: unpacked before the wrapper that runs it is written.
    expect(script).toContain('@xai-official/grok@1.0.62')
    expect(script.indexOf('brotliDecompressSync')).toBeGreaterThan(script.indexOf('npm install'))
    expect(script.indexOf('brotliDecompressSync')).toBeLessThan(script.indexOf('/opt/domo/bin/grok-acp'))
    // Its wrapper's own arguments go first: Grok takes `--trust` only ahead of `agent`.
    expect(script).toContain(`'exec /opt/domo/adapters/node_modules/@xai-official/grok/../grok-linux-*/bin/grok "$@" agent --no-leader stdio'`)
    expect(script).toContain(`'exec /opt/domo/adapters/node_modules/@opencode/cli/bin/opencode.exe acp "$@"'`)
    // The marker last, and flushed on both sides of it: a crash must not leave
    // a marker in front of files still in the page cache.
    expect(script.trim().split('\n').slice(-3)).toEqual(['sync', 'touch /opt/domo/.ready', 'sync'])
  })

  it('trusts an existing volume only when its contents check out, not on the marker alone', async () => {
    const { readyCheckScript } = await load()

    const check = readyCheckScript()

    expect(check.startsWith('test -f /opt/domo/.ready && /opt/domo/node/bin/node --version')).toBe(true)
    // Every adapter's entry has content and every wrapper can run: a volume cut
    // short by a crash carried the marker and neither.
    for (const path of [
      'test -s /opt/domo/adapters/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
      'test -s /opt/domo/adapters/node_modules/@agentclientprotocol/codex-acp/dist/index.js',
      'test -s /opt/domo/adapters/node_modules/@opencode/cli/bin/opencode.exe',
      'test -x /opt/domo/bin/claude-agent-acp',
      'test -x /opt/domo/bin/codex-acp',
      'test -x /opt/domo/bin/opencode-acp',
      'test -s /opt/domo/adapters/node_modules/@xai-official/grok/../grok-linux-*/bin/grok',
      'test -x /opt/domo/bin/grok-acp'
    ]) expect(check).toContain(path)
  })

  it('rebuilds a volume whose marker is there but whose contents are not', async () => {
    run.mockImplementation(async (_program, args) => {
      if (args.at(-1)?.includes('test -s')) throw new Error('exit 1')
      return { stdout: '', stderr: '' }
    })
    const { ensureRuntimeVolume } = await load()

    await ensureRuntimeVolume()

    expect(dockerCalls().at(-1)!.at(-1)).toContain('npm install')
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
