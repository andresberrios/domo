import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  BUILTIN_CACHES,
  CACHES_ROOT,
  cacheMountTargets,
  PNPM_MANAGERS_DIR,
  pnpmProjectDir,
  pnpmSetupArgs,
  resolveCaches
} from '../../server/lib/dev-env/caches'
import { defaultInstallCommand } from '../../server/lib/dev-env/dependencies'
import { alignUserArgs, ALIGN_USER_SCRIPT, planAlignment } from '../../server/lib/dev-env/user-alignment'

describe('pnpm setup', () => {
  const run = promisify(execFile)
  /** The setup script as creation runs it, with scratch paths for the volume's directories. */
  async function setUp(existing?: string) {
    const root = await mkdtemp(join(tmpdir(), 'domo-pnpm-setup-'))
    const home = join(root, 'home')
    await mkdir(home)
    if (existing !== undefined) {
      await mkdir(join(home, '.config', 'pnpm'), { recursive: true })
      await writeFile(join(home, '.config', 'pnpm', 'config.yaml'), existing)
    }
    const args = pnpmSetupArgs({ environmentId: 'env_1', checkout: '/worktrees/env_1' })
    // The directories it makes, moved under the scratch root; the config it
    // writes, and the argv's shape, are creation's.
    const moved = args.map((arg, index) => index >= 4 && index <= 6 && arg.startsWith(CACHES_ROOT) ? join(root, arg) : arg)
    await run(moved[0]!, moved.slice(1), { env: { PATH: process.env.PATH, HOME: home } })
    const read = async (path: string) => (await run('readlink', [path])).stdout.trim()
    const result = {
      config: await readFile(join(home, '.config', 'pnpm', 'config.yaml'), 'utf8'),
      modulesLink: await read(join(root, pnpmProjectDir('env_1'), 'node_modules')),
      managersLink: await read(join(home, '.local', 'share', 'pnpm', 'package-manager-store'))
    }
    await rm(root, { recursive: true, force: true })
    return { ...result, root }
  }

  it('puts the environment\'s virtual store on the volume, linked back to the checkout, and shares downloaded pnpm versions', async () => {
    const { config, modulesLink, managersLink, root } = await setUp()

    expect(config).toBe([
      `storeDir: ${CACHES_ROOT}/pnpm`,
      `cacheDir: ${CACHES_ROOT}/pnpm-cache`,
      `virtualStoreDir: ${CACHES_ROOT}/pnpm-projects/env_1/.pnpm`,
      'enableGlobalVirtualStore: false',
      ''
    ].join('\n'))
    // What a walk up from a package's real path reaches: the project's own dependencies.
    expect(modulesLink).toBe('/worktrees/env_1/node_modules')
    expect(managersLink).toBe(join(root, PNPM_MANAGERS_DIR))
  })

  it('leaves a setting the image already made, and adds the rest', async () => {
    const { config } = await setUp('storeDir: /elsewhere\n')
    expect(config.split('\n')[0]).toBe('storeDir: /elsewhere')
    expect(config.match(/^storeDir:/gm)).toHaveLength(1)
    expect(config).toContain('virtualStoreDir: ')
  })
})

describe('resolveCaches', () => {
  it('turns every built-in on by default, pointing each tool at the shared volume by the variable it reads', () => {
    const caches = resolveCaches(undefined)

    expect(caches.shared).toEqual({ volume: 'domo-dev-caches' })
    // pnpm by its global config file, never a variable: a variable outranks the project's own settings.
    expect(caches.pnpm).toBe(true)
    expect(Object.keys(caches.env).some(key => key.startsWith('pnpm_config_'))).toBe(false)
    for (const name of Object.keys(BUILTIN_CACHES)) {
      for (const variable of Object.keys(BUILTIN_CACHES[name]!)) expect(caches.env, variable).toHaveProperty(variable)
    }
    expect(Object.values(caches.env).filter(value => value.startsWith('/')).every(path => path.startsWith(`${CACHES_ROOT}/`))).toBe(true)
    expect(cacheMountTargets(caches)).toEqual([CACHES_ROOT])
  })

  it('turns one built-in off by name, and all of them off with false', () => {
    const withoutPnpm = resolveCaches({ pnpm: false })
    expect(withoutPnpm.pnpm).toBe(false)
    expect(withoutPnpm.env).toHaveProperty('npm_config_cache')

    const none = resolveCaches(false)
    expect(none).toEqual({ shared: null, env: {}, pnpm: false, custom: [] })
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
