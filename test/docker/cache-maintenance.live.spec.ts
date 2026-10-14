import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The cache cleanup for real: a real pnpm store with two environments' virtual
 * stores on a volume of its own, pruned by the real `pnpm store prune`, `npm
 * cache` and `uv cache` in their containers. What the argv tests cannot say
 * is whether a prune keeps what a live virtual store links, frees what a
 * retired one did, and leaves every file its owner's.
 *
 * Needs the network (pnpm, the registry, uv's image). Opt in: `pnpm test:docker`.
 */

process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = 'domo-cmlive-'

const state = vi.hoisted(() => ({ row: null as any, retired: [] as string[], swept: 0 }))

vi.mock('../../server/lib/repo', () => ({
  getDockerDisk: async () => state.row,
  saveDockerDisk: async (disk: any) => (state.row = { ...disk, updatedAt: new Date().toISOString() }),
  environmentInstallsMayRun: async () => false,
  listDevEnvironments: async () => state.retired.map(id => ({ id, retiredAt: new Date().toISOString() }))
}))
vi.mock('../../server/lib/dev-env/reconcile', () => ({
  sweepEnvironmentResources: async () => {
    state.swept++
    return { removed: [], leftovers: [], unattributed: [], branches: [] }
  }
}))

const { run } = await import('../../server/lib/dev-env/docker')
const { sharedCacheVolumeName, CACHES_ROOT } = await import('../../server/lib/dev-env/caches')
const { CacheMaintenance } = await import('../../server/lib/dev-env/cache-maintenance')
const { RUNTIME_IMAGE } = await import('../../server/lib/dev-env/runtime-volume')

const volume = sharedCacheVolumeName()

/** A shell on the volume, as the environment's user unless told otherwise. */
async function onVolume(script: string, user = '1000:1000') {
  const { stdout } = await run('docker', [
    'run', '--rm', '--user', user, '--volume', `${volume}:${CACHES_ROOT}`, '--env', 'HOME=/tmp', '--env', 'npm_config_update_notifier=false',
    RUNTIME_IMAGE, 'sh', '-c', script
  ])
  return stdout
}

/** One environment's install, the way `caches.ts` lays it out: the shared store, its own virtual store on the volume. */
function install(id: string, dependency: string) {
  return [
    `mkdir -p /tmp/${id} && cd /tmp/${id}`,
    `echo '{"name":"${id}","version":"1.0.0","dependencies":{${dependency}}}' > package.json`,
    `printf 'storeDir: ${CACHES_ROOT}/pnpm/store\\ncacheDir: ${CACHES_ROOT}/pnpm/cache\\nvirtualStoreDir: ${CACHES_ROOT}/pnpm/projects/${id}/.pnpm\\nenableGlobalVirtualStore: false\\n' > pnpm-workspace.yaml`,
    'npm_config_cache=/tmp/npm npx --yes pnpm@12 install >/dev/null'
  ].join(' && ')
}

beforeAll(async () => {
  await run('docker', ['volume', 'rm', '-f', volume], { allowFailure: true })
  await run('docker', ['volume', 'create', volume])
  await onVolume(`mkdir -p ${CACHES_ROOT}/pnpm ${CACHES_ROOT}/npm ${CACHES_ROOT}/uv && chown 1000:1000 ${CACHES_ROOT}/pnpm ${CACHES_ROOT}/npm ${CACHES_ROOT}/uv && chmod 1777 ${CACHES_ROOT}`, '0:0')
  await onVolume([
    install('env_live', '"is-number":"7.0.0"'),
    install('env_gone', '"left-pad":"1.3.0"'),
    `npm cache add --cache ${CACHES_ROOT}/npm left-pad@1.3.0 >/dev/null`,
    `head -c 1048576 /dev/urandom > ${CACHES_ROOT}/uv/stray`
  ].join(' && '))
}, 300_000)

afterAll(async () => {
  await run('docker', ['volume', 'rm', '-f', volume], { allowFailure: true })
})

describe('cache cleanup', () => {
  it('frees what a removed virtual store linked, keeps what a live one does, and leaves every file its owner\'s', async () => {
    await onVolume(`rm -rf ${CACHES_ROOT}/pnpm/projects/env_gone`)
    state.retired = ['env_retired']
    await onVolume(`mkdir -p ${CACHES_ROOT}/pnpm/projects/env_retired`)

    const disk = await new CacheMaintenance().clean('routine')

    expect(disk?.lastError).toBeNull()
    expect(disk?.lastCleanupLevel).toBe('routine')
    expect(disk?.lastFreedBytes).toBeGreaterThan(0)
    // The sweep is what removes a retired environment's virtual store, and records it.
    expect(state.swept).toBe(1)
    const after = await onVolume([
      `find ${CACHES_ROOT}/pnpm/store -path '*/files/*' -type f -links 1 | wc -l`,
      `find ${CACHES_ROOT}/pnpm/projects/env_live -name package.json -path '*is-number*' -links +1 | wc -l`,
      `find ${CACHES_ROOT}/pnpm ${CACHES_ROOT}/npm ! -user 1000 | wc -l`,
      `find ${CACHES_ROOT}/npm/_cacache -type f | wc -l`
    ].join('; '))
    const [unlinked, live, foreign, npm] = after.split('\n')
    expect(Number(unlinked)).toBe(0)
    expect(Number(live)).toBe(1)
    expect(Number(foreign)).toBe(0)
    // A routine cleanup leaves the download caches alone.
    expect(Number(npm)).toBeGreaterThan(0)
  }, 300_000)

  it('empties the npm and uv caches under pressure', async () => {
    await onVolume(`head -c 1048576 /dev/urandom > ${CACHES_ROOT}/uv/stray`)
    const disk = await new CacheMaintenance().clean('pressure')

    expect(disk?.lastError).toBeNull()
    expect(disk?.caches.find(cache => cache.key === 'npm')?.bytes ?? 0).toBeLessThan(64 * 1024)
    expect(disk?.caches.find(cache => cache.key === 'uv')?.bytes ?? 0).toBe(0)
    expect(disk?.caches.find(cache => cache.key === 'pnpm-projects')?.bytes).toBeGreaterThan(0)
  }, 300_000)
})
