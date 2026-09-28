import { resourcePrefix, run } from './docker'

/**
 * Caches every environment on this daemon shares, so a package is fetched and
 * unpacked once per install rather than once per environment.
 *
 * The built-in ones need nothing from the project or the agent: each tool is
 * pointed at a directory of one shared volume by the environment variable it
 * already reads, so a bare `pnpm install` or `pip install` uses it. Measured
 * for pnpm: `pnpm_config_store_dir` moves the store (`npm_config_store_dir` and
 * an `.npmrc` `store-dir` do not, for the pnpm installed here), and with
 * `enable_global_virtual_store` the project's `node_modules` holds only
 * symlinks into the store — which is what makes sharing it save disk as well
 * as downloads, because the store and the checkout are on different mounts and
 * a hardlink cannot cross one (measured: a plain store install copies). A Vite
 * dev server was measured serving that layout. Hoisting is public
 * (`shamefully_hoist`) because a package in the store cannot reach the
 * project's hidden hoist directory by walking up from its real path. Measured:
 * Nuxt resolves a module's module dependencies that way (`@nuxt/icon` for
 * `@nuxt/ui`), and `nuxt prepare` failed until they were at the top of
 * `node_modules`. The cost is that the project's own code can import a package
 * it did not declare here, where the host's install would refuse it.
 *
 * Only caches that are safe to share are built in: each is keyed by content
 * or by version, never by the project that wrote it. A project adds its own in
 * `.domo.json` (`caches: { "<name>": "/path/in/container" }`), each a volume of
 * its own shared by name across the install, and turns a built-in off with
 * `false`, or all of them with `caches: false`.
 */

export const CACHES_ROOT = '/opt/domo-caches'

export const BUILTIN_CACHES: Record<string, Record<string, string>> = {
  pnpm: {
    pnpm_config_store_dir: `${CACHES_ROOT}/pnpm`,
    pnpm_config_enable_global_virtual_store: 'true',
    pnpm_config_shamefully_hoist: 'true'
  },
  npm: { npm_config_cache: `${CACHES_ROOT}/npm` },
  yarn: { YARN_CACHE_FOLDER: `${CACHES_ROOT}/yarn`, YARN_GLOBAL_FOLDER: `${CACHES_ROOT}/yarn-berry` },
  pip: { PIP_CACHE_DIR: `${CACHES_ROOT}/pip` },
  // A `.venv` is on the checkout's mount and the cache is not, so uv could
  // only warn and fall back to copying anyway.
  uv: { UV_CACHE_DIR: `${CACHES_ROOT}/uv`, UV_LINK_MODE: 'copy' },
  go: { GOMODCACHE: `${CACHES_ROOT}/go/mod`, GOCACHE: `${CACHES_ROOT}/go/build` }
}

/** What `.domo.json` may say: `false` for none of the built-ins, or per name a container path (custom) or `false` (off). */
export type CachesConfig = false | Record<string, string | false>

export interface ResolvedCaches {
  /** The shared volume of built-ins, mounted at `CACHES_ROOT`, or null when all are off. */
  shared: { volume: string } | null
  env: Record<string, string>
  custom: Array<{ name: string, volume: string, target: string }>
}

export function sharedCacheVolumeName(): string {
  return `${resourcePrefix()}caches`
}

export function customCacheVolumeName(name: string): string {
  return `${resourcePrefix()}cache-${name}`
}

export const CACHE_NAME = /^[a-z0-9][a-z0-9_.-]*$/

export function resolveCaches(config: CachesConfig | undefined): ResolvedCaches {
  const entries = config === false ? {} : (config ?? {})
  const env: Record<string, string> = {}
  if (config !== false) {
    for (const [name, variables] of Object.entries(BUILTIN_CACHES)) {
      if (entries[name] === false) continue
      Object.assign(env, variables)
    }
  }
  const custom = Object.entries(entries)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !(entry[0] in BUILTIN_CACHES))
    .map(([name, target]) => ({ name, volume: customCacheVolumeName(name), target }))
  return { shared: Object.keys(env).length ? { volume: sharedCacheVolumeName() } : null, env, custom }
}

/** The container paths every cache is mounted at, which the remote user has to be able to write whatever uid it is. */
export function cacheMountTargets(caches: ResolvedCaches): string[] {
  return [...(caches.shared ? [CACHES_ROOT] : []), ...caches.custom.map(cache => cache.target)]
}

/** Create the volumes a set of caches needs. Idempotent, like `docker volume create` itself. */
export async function ensureCacheVolumes(caches: ResolvedCaches): Promise<void> {
  const volumes = [...(caches.shared ? [caches.shared.volume] : []), ...caches.custom.map(cache => cache.volume)]
  for (const volume of volumes) {
    await run('docker', ['volume', 'create', '--label', 'domo.cache=true', volume])
  }
}
