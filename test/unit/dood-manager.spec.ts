import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `manager.ts` without a daemon: where an environment's socket lives, and that
 * starting and stopping one environment's proxy never overlap. The proxy and
 * the network are stubbed; what is under test is the order of their calls.
 */

const log: string[] = []
const gates: Array<() => void> = []
const gate = () => new Promise<void>((resolve) => { gates.push(resolve) })
const startDoodProxy = vi.fn(async ({ socketPath }: { socketPath: string }) => {
  log.push('listen:begin')
  await gate()
  log.push('listen:end')
  return {
    socketPath,
    close: async () => {
      log.push('close:begin')
      await gate()
      // The real close() unlinks the socket path here — after the server has
      // stopped, which is exactly the window a new proxy could be listening in.
      log.push('close:unlink')
    }
  }
})

vi.mock('../../server/lib/dood/proxy', () => ({ startDoodProxy }))
vi.mock('../../server/lib/dood/network', () => ({
  EnvironmentNetwork: class {
    schedule() {}
    async close() {}
    async reconcile() {}
  },
  watchContainerEvents: () => ({ stop() {} })
}))
vi.mock('../../server/lib/dev-env/docker', () => ({ run: vi.fn() }))

const { doodSocketDir, doodSocketPath, ensureDoodProxy, stopDoodProxy } = await import('../../server/lib/dood/manager')

const input = (environmentId: string) => ({
  environmentId,
  containerReference: `c-${environmentId}`,
  workspacePath: '/workspaces/app',
  workspaceVolume: `v-${environmentId}`,
  helperImage: 'busybox'
})

/** Let every pending promise callback run, then open the oldest gate. */
async function openNext() {
  for (let index = 0; index < 20 && !gates.length; index++) await new Promise(resolve => setTimeout(resolve, 0))
  gates.shift()!()
}

const saved = { HOME: process.env.HOME, NUXT_DATA_DIR: process.env.NUXT_DATA_DIR, dir: process.env.NUXT_DOOD_SOCKET_DIR }
afterEach(() => {
  process.env.HOME = saved.HOME
  if (saved.NUXT_DATA_DIR === undefined) delete process.env.NUXT_DATA_DIR
  else process.env.NUXT_DATA_DIR = saved.NUXT_DATA_DIR
  if (saved.dir === undefined) delete process.env.NUXT_DOOD_SOCKET_DIR
  else process.env.NUXT_DOOD_SOCKET_DIR = saved.dir
})

describe('the socket path', () => {
  it('is short, derived from the id, and different per install', () => {
    delete process.env.NUXT_DOOD_SOCKET_DIR
    process.env.HOME = '/Users/dev'
    process.env.NUXT_DATA_DIR = '/tmp/domo-install-a'
    const path = doodSocketPath('env_0123456789abcdefghij')
    expect(path).toMatch(/^\/Users\/dev\/\.domo\/s\/[0-9a-f]{8}\/[0-9a-f]{12}\.sock$/)
    expect(path.length - '/Users/dev'.length).toBe(35)
    expect(doodSocketPath('env_0123456789abcdefghij')).toBe(path)
    expect(doodSocketPath('env_other')).not.toBe(path)
    process.env.NUXT_DATA_DIR = '/tmp/domo-install-b'
    expect(doodSocketDir()).not.toBe(path.slice(0, path.lastIndexOf('/')))
  })

  it('fits Docker Desktop\'s 88 bytes under a 53-character home directory, and says what to do past it', () => {
    delete process.env.NUXT_DOOD_SOCKET_DIR
    process.env.NUXT_DATA_DIR = '/tmp/domo-install-a'
    process.env.HOME = `/Users/${'a'.repeat(53 - '/Users/'.length)}`
    expect(doodSocketPath('env_x')).toHaveLength(88)
    process.env.HOME += 'a'
    expect(() => doodSocketPath('env_x')).toThrow(/Set NUXT_DOOD_SOCKET_DIR to a shorter directory/)
  })

  it('honours NUXT_DOOD_SOCKET_DIR', () => {
    process.env.NUXT_DOOD_SOCKET_DIR = '/srv/domo-sockets'
    expect(doodSocketPath('env_x')).toMatch(/^\/srv\/domo-sockets\/[0-9a-f]{12}\.sock$/)
  })
})

describe('one environment\'s proxy', () => {
  it('is not started again while a stop is still unlinking the socket, nor twice at once', async () => {
    process.env.NUXT_DOOD_SOCKET_DIR = '/srv/domo-sockets'
    log.length = 0
    const first = ensureDoodProxy(input('env_a'))
    const again = ensureDoodProxy(input('env_a'))
    await openNext()
    expect(await first).toBe(await again)
    expect(startDoodProxy).toHaveBeenCalledTimes(1)

    const stopping = stopDoodProxy('env_a')
    const restarting = ensureDoodProxy(input('env_a'))
    await openNext() // close
    await stopping
    await openNext() // the second listen
    await restarting
    expect(log).toEqual(['listen:begin', 'listen:end', 'close:begin', 'close:unlink', 'listen:begin', 'listen:end'])

    const cleanup = stopDoodProxy('env_a')
    await openNext()
    await cleanup
  })

  it('does not wait on another environment\'s', async () => {
    process.env.NUXT_DOOD_SOCKET_DIR = '/srv/domo-sockets'
    log.length = 0
    const slow = ensureDoodProxy(input('env_b'))
    const other = ensureDoodProxy(input('env_c'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toEqual(['listen:begin', 'listen:begin'])
    await openNext()
    await openNext()
    await Promise.all([slow, other])
    await Promise.all([stopDoodProxy('env_b'), stopDoodProxy('env_c'), openNext(), openNext()])
  })
})
