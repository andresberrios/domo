import { describe, expect, it } from 'vitest'

import { BUILTIN_CACHES, CACHES_ROOT, cacheMountTargets, resolveCaches } from '../../server/lib/dev-env/caches'
import { defaultInstallCommand } from '../../server/lib/dev-env/dependencies'
import { alignUserArgs, ALIGN_USER_SCRIPT, planAlignment } from '../../server/lib/dev-env/user-alignment'

describe('resolveCaches', () => {
  it('turns every built-in on by default, pointing each tool at the shared volume by the variable it reads', () => {
    const caches = resolveCaches(undefined)

    expect(caches.shared).toEqual({ volume: 'domo-dev-caches' })
    // Measured: the variable, not an `.npmrc` or `npm_config_store_dir`, is what moves pnpm's store.
    expect(caches.env.pnpm_config_store_dir).toBe(`${CACHES_ROOT}/pnpm`)
    // And the global virtual store is what makes the project's node_modules symlinks, not copies.
    expect(caches.env.pnpm_config_enable_global_virtual_store).toBe('true')
    for (const name of Object.keys(BUILTIN_CACHES)) {
      for (const variable of Object.keys(BUILTIN_CACHES[name]!)) expect(caches.env, variable).toHaveProperty(variable)
    }
    expect(Object.values(caches.env).filter(value => value.startsWith('/')).every(path => path.startsWith(`${CACHES_ROOT}/`))).toBe(true)
    expect(cacheMountTargets(caches)).toEqual([CACHES_ROOT])
  })

  it('turns one built-in off by name, and all of them off with false', () => {
    const withoutPnpm = resolveCaches({ pnpm: false })
    expect(withoutPnpm.env).not.toHaveProperty('pnpm_config_store_dir')
    expect(withoutPnpm.env).toHaveProperty('npm_config_cache')

    const none = resolveCaches(false)
    expect(none).toEqual({ shared: null, env: {}, custom: [] })
    expect(cacheMountTargets(none)).toEqual([])
  })

  it('gives each custom cache a volume of its own, shared by name, at the path the project named', () => {
    const caches = resolveCaches({ gradle: '/home/vscode/.gradle/caches', pip: false })

    expect(caches.custom).toEqual([{ name: 'gradle', volume: 'domo-dev-cache-gradle', target: '/home/vscode/.gradle/caches' }])
    expect(caches.env).not.toHaveProperty('PIP_CACHE_DIR')
    expect(cacheMountTargets(caches)).toEqual([CACHES_ROOT, '/home/vscode/.gradle/caches'])
  })
})

describe('defaultInstallCommand', () => {
  it('installs frozen, by the lockfile the project committed', () => {
    expect(defaultInstallCommand(['pnpm-lock.yaml'])).toEqual(['pnpm', 'install', '--frozen-lockfile'])
    expect(defaultInstallCommand(['package-lock.json'])).toEqual(['npm', 'ci'])
    expect(defaultInstallCommand(['yarn.lock'])).toEqual(['yarn', 'install', '--frozen-lockfile'])
    expect(defaultInstallCommand(['yarn.lock', '.yarnrc.yml'])).toEqual(['yarn', 'install', '--immutable'])
    expect(defaultInstallCommand(['uv.lock'])).toEqual(['uv', 'sync', '--frozen'])
    expect(defaultInstallCommand(['bun.lock'])).toEqual(['bun', 'install', '--frozen-lockfile'])
  })

  it('prefers pnpm when a stale npm lockfile sits beside it, and installs nothing it cannot identify', () => {
    expect(defaultInstallCommand(['package-lock.json', 'pnpm-lock.yaml'])).toEqual(['pnpm', 'install', '--frozen-lockfile'])
    expect(defaultInstallCommand([])).toBeNull()
    expect(defaultInstallCommand(['.yarnrc.yml'])).toBeNull()
  })
})

describe('planAlignment', () => {
  const linux = { daemonOs: 'Ubuntu 24.04.3 LTS', remoteUser: 'vscode', hostUid: 1001, hostGid: 1001, containerUid: 1000 }

  it('renumbers the user to the checkout owner on a Linux daemon', () => {
    expect(planAlignment(linux)).toEqual({ kind: 'renumber', uid: 1001, gid: 1001 })
  })

  it('does nothing on Docker Desktop, which maps ownership itself, or when the ids already agree', () => {
    expect(planAlignment({ ...linux, daemonOs: 'Docker Desktop' })).toEqual({ kind: 'none' })
    expect(planAlignment({ ...linux, hostUid: 1000 })).toEqual({ kind: 'none' })
  })

  it('never hands the user root\'s uid, and warns about a root remote user writing into the checkout', () => {
    expect(planAlignment({ ...linux, hostUid: 0 })).toEqual({ kind: 'none' })
    expect(planAlignment({ ...linux, remoteUser: 'root', containerUid: 0 })).toEqual({ kind: 'root-owned' })
  })

  it('re-owns only what the old ids owned, on the home\'s own filesystem, with every value as argv', () => {
    expect(alignUserArgs({ user: 'vscode; rm -rf /', uid: 1001, gid: 1001 }).slice(-3)).toEqual(['vscode; rm -rf /', '1001', '1001'])
    expect(ALIGN_USER_SCRIPT).toContain('-xdev')
    expect(ALIGN_USER_SCRIPT).toContain('-uid "$old_uid"')
    expect(ALIGN_USER_SCRIPT).not.toContain('chown -R')
  })
})
