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
 * not. Measured on pnpm 11 and 12.
 *
 * A hardlink cannot cross mounts, and the checkout is a bind mount of the
 * host's disk, so pnpm's usual layout would copy every package into it
 * (measured: 1.3 GB for a Nuxt app, per environment). So each environment's
 * virtual store (`node_modules/.pnpm`) lives on the cache volume beside the
 * store (`virtualStoreDir`), where pnpm hardlinks, and the checkout's
 * `node_modules` holds only symlinks into it. That directory also gets a
 * `node_modules` symlink back to the checkout's: tools that resolve an
 * undeclared package by walking up from a package's real path (Nuxt's kit
 * does, for module dependencies and `vue-i18n`) then pass the hidden hoist
 * directory and reach the project's own dependencies, as they do in a normal
 * install. pnpm's global virtual store was tried and rejected: nothing on that
 * walk leads back to the project. A package that takes the project's root to
 * be whatever precedes the first `/node_modules/` in its own path (the Caddy
 * wrapper did) still gets it wrong.
 *
 * pnpm's metadata cache and the pnpm versions it downloads for a project's
 * `packageManager` pin are shared too: both are keyed by what they hold.
 *
 * The first environment's user creates these directories (`PNPM_ROOT`), and
 * they stay its: an image whose remote user has another uid cannot share them.
 *
 * Only caches that are safe to share are built in: each is keyed by content
 * or by version, never by the project that wrote it. A project adds its own in
 * `.domo.json` (`caches: { "<name>": "/path/in/container" }`), each a volume of
 * its own shared by name across the install, and turns a built-in off with
 * `false`, or all of them with `caches: false`.
 */

export const CACHES_ROOT = '/opt/domo-caches'

/** The variables each built-in is pointed at its directory by; pnpm has none, see `pnpmGlobalConfig`. */
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

/**
 * Everything pnpm keeps on the volume, in one directory the environment's user
 * creates and nobody else can write: pnpm 12.8 copies instead of hardlinking
 * when its store sits directly in a world-writable directory such as
 * `CACHES_ROOT` (measured; 11.25 and 12.6 do not).
 */
export const PNPM_ROOT = `${CACHES_ROOT}/pnpm`
/** Each environment's virtual store, by id: what retiring it removes from the volume. */
export const PNPM_PROJECTS_DIR = `${PNPM_ROOT}/projects`
/** The pnpm versions pnpm downloads to honour a project's `packageManager` pin. */
export const PNPM_MANAGERS_DIR = `${PNPM_ROOT}/managers`

export function pnpmProjectDir(environmentId: string): string {
  return `${PNPM_PROJECTS_DIR}/${environmentId}`
}

/** Settings for the remote user's global pnpm config, each written unless the file already sets it. */
export function pnpmGlobalConfig(environmentId: string): Record<string, string> {
  return {
    storeDir: `${PNPM_ROOT}/store`,
    cacheDir: `${PNPM_ROOT}/cache`,
    virtualStoreDir: `${pnpmProjectDir(environmentId)}/.pnpm`,
    enableGlobalVirtualStore: 'false'
  }
}


export interface ResolvedCaches {
  /** The shared volume of built-ins, mounted at `CACHES_ROOT`, or null when all are off. */
  shared: { volume: string } | null
  env: Record<string, string>
  /** Whether pnpm is to be pointed at the shared store (`pnpmGlobalConfig`). */
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
 * Sets pnpm up for one environment, as its remote user: the environment's
 * virtual store directory with its `node_modules` link back to the checkout,
 * the shared directory of downloaded pnpm versions, and each global config
 * setting the file does not have yet, so an image's own choice stands.
 * Everything arrives as argv, never interpolated into the script.
 */
export const PNPM_SETUP_SCRIPT = [
  'set -e',
  'root="$1"; project="$2"; modules="$3"; managers="$4"; shift 4',
  'mkdir -p -m 755 "$root"',
  'mkdir -p "$project" "$managers"',
  'ln -sfn "$modules" "$project/node_modules"',
  'data="${XDG_DATA_HOME:-$HOME/.local/share}/pnpm"',
  'mkdir -p "$data"',
  '[ -e "$data/package-manager-store" ] || ln -s "$managers" "$data/package-manager-store"',
  'dir="${XDG_CONFIG_HOME:-$HOME/.config}/pnpm"',
  'mkdir -p "$dir"',
  'file="$dir/config.yaml"',
  'touch "$file"',
  'while [ "$#" -gt 1 ]; do',
  '  grep -q "^$1:" "$file" || printf \'%s: %s\\n\' "$1" "$2" >> "$file"',
  '  shift 2',
  'done'
].join('\n')

export function pnpmSetupArgs(input: { environmentId: string, checkout: string }): string[] {
  return [
    'sh', '-c', PNPM_SETUP_SCRIPT, 'sh',
    PNPM_ROOT, pnpmProjectDir(input.environmentId), `${input.checkout}/node_modules`, PNPM_MANAGERS_DIR,
    ...Object.entries(pnpmGlobalConfig(input.environmentId)).flat()
  ]
}

/**
 * Removes the virtual stores of the environments named, from a helper
 * container on the cache volume, and lists what is left there: whether one
 * went is decided by looking, as everywhere in the sweep.
 */
export const PNPM_PROJECTS_SWEEP_SCRIPT = [
  'dir="$1"; shift',
  'for id in "$@"; do if [ -e "$dir/$id" ]; then echo "removing $id"; rm -rf "$dir/$id"; fi; done',
  'for entry in "$dir"/*; do [ -e "$entry" ] && echo "left ${entry##*/}"; done',
  'true'
].join('\n')

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
