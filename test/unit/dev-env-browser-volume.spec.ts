import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * One volume holds a headless Chromium for every environment on the machine.
 * The same shape as the runtime volume beside it — a name that hashes what is
 * in it, a `.ready` marker written last — and two rules that are the whole
 * reason this is not simply "copy the libraries it links against".
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
  return import('../../server/lib/dev-env/browser-volume')
}

function dockerCalls(): string[][] {
  return run.mock.calls.filter(([program]) => program === 'docker').map(([, args]) => args)
}

beforeEach(() => {
  vi.clearAllMocks()
  run.mockResolvedValue({ stdout: '', stderr: '' })
  dockerServerArch.mockResolvedValue('arm64')
})

describe('browserVolumeName', () => {
  it('is stable for the same pins, and separate from the runtime volume', async () => {
    const { browserVolumeName } = await load()
    const { runtimeVolumeName } = await import('../../server/lib/dev-env/runtime-volume')

    expect(browserVolumeName('arm64')).toBe(browserVolumeName('arm64'))
    expect(browserVolumeName('arm64')).toMatch(/^domo-dev-browser-[0-9a-f]{12}$/)
    expect(browserVolumeName('arm64')).not.toBe(runtimeVolumeName('arm64'))
  })

  it('changes with the architecture, because the binaries in it do', async () => {
    const { browserVolumeName } = await load()

    expect(browserVolumeName('arm64')).not.toBe(browserVolumeName('amd64'))
  })

  it('changes when the builder image does, because that is the glibc floor', async () => {
    const before = (await load()).browserVolumeName('arm64')
    process.env.NUXT_DEV_ENV_RUNTIME_IMAGE = 'node:24-trixie-slim'
    const bumped = (await load()).browserVolumeName('arm64')
    delete process.env.NUXT_DEV_ENV_RUNTIME_IMAGE

    expect(bumped).not.toBe(before)
  })
})

describe('populateScript', () => {
  it('leaves glibc and the runtimes versioned against it to the image', async () => {
    const { populateScript } = await load()
    const script = populateScript()

    // The volume's lib directory goes on LD_LIBRARY_PATH, which is searched
    // ahead of the system paths for *every* library the process loads. Ship
    // the builder's libc and an image with a newer libstdc++ cannot resolve
    // its own: measured as `libc.so.6: version 'GLIBC_2.38' not found`, which
    // kills Node before the browser is even launched.
    for (const owned of ['ld-linux*', 'libc.so*', 'libstdc++.so*', 'libgcc_s.so*']) {
      expect(script).toContain(owned)
    }
    expect(script).toContain('take()')
  })

  it('walks the library closure to a fixed point and tops it up from NSS', async () => {
    const { populateScript } = await load()
    const script = populateScript()

    // One `ldd` pass is not the closure: the binary needs libgobject, which
    // needs libffi, and an image carrying the first and not the second fails
    // at exec with a bare loader error.
    expect(script).toContain('while :; do')
    // NSS loads its PKCS#11 modules with dlopen, so `ldd` never names them and
    // the failure is fatal the first time a page is fetched over TLS.
    expect(script).toContain('dpkg -L libnss3')
  })

  it('ships fonts and a fontconfig that points at them', async () => {
    const { populateScript } = await load()
    const script = populateScript()

    expect(script).toContain('fonts-liberation')
    expect(script).toContain('<dir>/opt/domo-browser/fonts</dir>')
    // The volume is read-only, so the cache cannot live beside the fonts.
    expect(script).toContain('<cachedir>/tmp/domo-fontconfig</cachedir>')
  })

  it('proves the browser draws something before marking the volume ready', async () => {
    const { populateScript } = await load()
    const script = populateScript()

    // Without fonts the browser launches, navigates and answers every question
    // about the DOM correctly — and screenshots a blank page. A build that
    // cannot draw must not be handed to an agent as a way of looking at a UI.
    expect(script).toContain('rendered a blank page')
    expect(script).toContain('page.screenshot()')
    expect(script.trim().endsWith('touch "$ROOT/.ready"')).toBe(true)
  })

  it('asks for the headless shell only, not the full browser download', async () => {
    const { populateScript } = await load()

    expect(populateScript()).toContain('install --only-shell chromium')
  })
})

describe('ensureBrowserVolume', () => {
  it('populates a volume that has no .ready marker', async () => {
    run.mockImplementation(async (_program, args) => {
      if (args.includes('test')) throw new Error('exit 1')
      return { stdout: '', stderr: '' }
    })
    const { ensureBrowserVolume } = await load()

    const volume = await ensureBrowserVolume()

    expect(dockerCalls()[0]).toEqual(['volume', 'create', '--label', 'domo.browser=true', volume])
    expect(dockerCalls().at(-1)!.at(-1)).toContain('playwright-core@')
  })

  it('does nothing to a volume that is already populated', async () => {
    const { ensureBrowserVolume } = await load()

    await ensureBrowserVolume()

    expect(dockerCalls().join('\n')).not.toContain('apt-get')
    expect(dockerCalls()).toHaveLength(2)
  })

  it('is built once, however many environments ask for it at the same time', async () => {
    const { ensureBrowserVolume } = await load()

    const [first, second] = await Promise.all([ensureBrowserVolume(), ensureBrowserVolume()])

    expect(second).toBe(first)
    expect(dockerCalls().filter(args => args[0] === 'volume' && args[1] === 'create')).toHaveLength(1)
  })

  it('is retried after a failure instead of handing out the failure for ever', async () => {
    run.mockRejectedValueOnce(new Error('no such image'))
    const { ensureBrowserVolume } = await load()

    await expect(ensureBrowserVolume()).rejects.toThrow('no such image')
    await expect(ensureBrowserVolume()).resolves.toMatch(/^domo-dev-browser-/)
  })
})

describe('collectBrowserVolumes', () => {
  it('removes every browser volume but the current one', async () => {
    const { collectBrowserVolumes, browserVolumeName } = await load()
    const current = browserVolumeName('arm64')
    run.mockImplementation(async (_program, args) => ({
      stdout: args[1] === 'ls' ? [current, 'domo-dev-browser-deadbeef0000'].join('\n') : '',
      stderr: ''
    }))

    await collectBrowserVolumes()

    expect(dockerCalls()).toContainEqual(['volume', 'rm', 'domo-dev-browser-deadbeef0000'])
    expect(dockerCalls()).not.toContainEqual(['volume', 'rm', current])
  })
})

describe('browserMcpServer', () => {
  it('runs the MCP server on the bundled Node, out of the mounted volume', async () => {
    const { browserMcpServer } = await load()
    const server = browserMcpServer()

    // Nothing is on PATH, and the environment's image is not required to have
    // a Node of its own — the same reason the adapter wrappers hard-code one.
    expect(server.command).toBe('/opt/domo/node/bin/node')
    expect(server.args[0]).toBe('/opt/domo-browser/js/node_modules/@playwright/mcp/cli.js')
    expect(server.args).toContain('--headless')
    expect(server.args).toContain('--executable-path')
    expect(server.args).toContain('/opt/domo-browser/bin/chrome-headless-shell')
  })

  it('carries the library and font paths itself, rather than the container doing it', async () => {
    const { browserMcpServer } = await load()
    const env = Object.fromEntries(browserMcpServer().env.map(entry => [entry.name, entry.value]))

    expect(env.LD_LIBRARY_PATH).toBe('/opt/domo-browser/lib')
    expect(env.FONTCONFIG_PATH).toBe('/opt/domo-browser/fontconfig')
  })

  it('ignores certificate errors, because what it opens is served by a local CA', async () => {
    const { browserMcpServer } = await load()

    // A project's own dev server and Domo behind Caddy both present a
    // certificate nothing in the container trusts. Ignoring it is what makes
    // HTTP/2 reachable without putting a CA into every environment.
    expect(browserMcpServer().args).toContain('--ignore-https-errors')
  })
})
