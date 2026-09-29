import { resourcePrefix, run } from './docker'

/**
 * Caches every environment on this daemon shares, so a package is fetched and
 * unpacked once per install rather than once per environment.
 *
 * The built-in ones need nothing from the project or the agent: each tool is
 * pointed at a directory of one shared volume by the environment variable it
 * already reads, so a bare `pnpm install` or `pip install` uses it.
 *
 * pnpm is the exception: it is configured in the remote user's global pnpm
 * config (`~/.config/pnpm/config.yaml`), not by variable, because a variable
 * outranks the project's own `pnpm-workspace.yaml` and the global file does
 * not. Measured on pnpm 11 and 12: the file moves the store, and a project
 * that says `enableGlobalVirtualStore: false` gets its way. The global virtual
 * store is on by default, so the project's `node_modules` holds only symlinks
 * into the store — which is what makes sharing it save disk as well as
 * downloads, because the store and the checkout are on different mounts and a
 * hardlink cannot cross one (measured: a plain store install copies all of
 * it, 1.3 GB for a Nuxt app). Its cost is that a package in the store cannot
 * reach the project's hidden hoist directory from its real path. Nuxt resolves
 * a module's module dependencies that way (`@nuxt/icon` for `@nuxt/ui`), which
 * a project fixes by hoisting exactly those (`publicHoistPattern`, as Domo's
 * own does). A module that resolves from `@nuxt/kit`'s real path
 * (`@nuxtjs/i18n`) cannot be fixed by hoisting, and that project turns the
 * global virtual store off. Domo never hoists for a project.
 *
 * Only caches that are safe to share are built in: each is keyed by content
 * or by version, never by the project that wrote it. A project adds its own in
 * `.domo.json` (`caches: { "<name>": "/path/in/container" }`), each a volume of
 * its own shared by name across the install, and turns a built-in off with
 * `false`, or all of them with `caches: false`.
 */

export const CACHES_ROOT = '/opt/domo-caches'

/** The variables each built-in is pointed at its directory by; pnpm has none, see `PNPM_GLOBAL_CONFIG`. */
export const BUILTIN_CACHES: Record<string, Record<string, string>> = {
  pnpm: {},
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

/** Settings for the remote user's global pnpm config, each written unless the file already sets it. */
export const PNPM_GLOBAL_CONFIG: Record<string, string> = {
  storeDir: `${CACHES_ROOT}/pnpm`,
  enableGlobalVirtualStore: 'true'
}

export interface ResolvedCaches {
  /** The shared volume of built-ins, mounted at `CACHES_ROOT`, or null when all are off. */
  shared: { volume: string } | null
  env: Record<string, string>
  /** Whether pnpm's global config is to point at the shared store (`PNPM_GLOBAL_CONFIG`). */
  pnpm: boolean
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
  const builtins = config === false ? [] : Object.keys(BUILTIN_CACHES).filter(name => entries[name] !== false)
  for (const name of builtins) Object.assign(env, BUILTIN_CACHES[name])
  const custom = Object.entries(entries)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !(entry[0] in BUILTIN_CACHES))
    .map(([name, target]) => ({ name, volume: customCacheVolumeName(name), target }))
  return { shared: builtins.length ? { volume: sharedCacheVolumeName() } : null, env, pnpm: builtins.includes('pnpm'), custom }
}

/**
 * Appends each `PNPM_GLOBAL_CONFIG` setting the remote user's global pnpm
 * config does not have yet, so an image's own choice stands. Keys and values
 * arrive as argv, never interpolated into the script.
 */
export const PNPM_GLOBAL_CONFIG_SCRIPT = [
  'set -e',
  'dir="${XDG_CONFIG_HOME:-$HOME/.config}/pnpm"',
  'mkdir -p "$dir"',
  'file="$dir/config.yaml"',
  'touch "$file"',
  'while [ "$#" -gt 1 ]; do',
  '  grep -q "^$1:" "$file" || printf \'%s: %s\\n\' "$1" "$2" >> "$file"',
  '  shift 2',
  'done'
].join('\n')

export function pnpmGlobalConfigArgs(): string[] {
  return ['sh', '-c', PNPM_GLOBAL_CONFIG_SCRIPT, 'sh', ...Object.entries(PNPM_GLOBAL_CONFIG).flat()]
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
