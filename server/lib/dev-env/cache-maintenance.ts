import type { CacheCleanupLevel, DockerDisk, DockerDiskCache, DockerDiskLevel, DockerDiskUsage } from '../../../shared/types'
import { environmentInstallsMayRun, getDockerDisk, listDevEnvironments, saveDockerDisk } from '../repo'
import { CACHES_ROOT, sharedCacheVolumeName } from './caches'
import { resourcePrefix, run } from './docker'
import { sweepEnvironmentResources } from './reconcile'
import { RUNTIME_IMAGE } from './runtime-volume'

/**
 * Keeps the shared cache volume (`caches.ts`) from filling the disk under
 * Docker, and tells the user before it is full.
 *
 * The caches grow by design: each is keyed by content or version and nothing
 * in the tools ever evicts. Measured on a Docker Desktop VM of 58 GB that hit
 * 100%: 2.5 GB of the pnpm store linked by no environment any more, 643 MB of
 * metadata in a layout pnpm 12 no longer reads, 1.3 GB of npm cache that is
 * mostly agent CLIs at old versions. So this is a backstop, not the fix; the
 * fixes are in what gets downloaded and how it is linked (`caches.ts`).
 *
 * Every 10 minutes it asks for the disk's free space, a second or so in a
 * helper container. The caches themselves are walked when that changes the
 * level, every 6 hours, around a cleanup, and on request: a walk reads every
 * inode on the volume.
 *
 * A `routine` cleanup, once a day, removes only what nothing uses: store
 * files no virtual store links (`pnpm store prune` decides by link count,
 * and every environment's virtual store is on the same volume, so that is
 * exact), metadata directories the current pnpm cannot read, and npx
 * installs untouched for two weeks. A `pressure` cleanup, when the disk is
 * low or the user asks, also empties npm's and uv's download caches. Neither
 * runs while an environment may be installing, because a prune can take a
 * file an install has added and not linked yet; at `critical` it runs
 * anyway, since a full disk fails those installs too.
 */

const FIRST_CHECK_MS = 60_000
const CHECK_MS = 10 * 60_000
const MEASURE_MS = 6 * 60 * 60_000
const ROUTINE_MS = 24 * 60 * 60_000
const PRESSURE_GAP_MS = 60 * 60_000
const CRITICAL_GAP_MS = 30 * 60_000
/** A change in free space smaller than this is not worth a write of the row. */
const FREE_SPACE_STEP = 256 * 1024 ** 2
export const STALE_NPX_DAYS = 14
const GIB = 1024 ** 3

/** The pnpm that prunes. It reads the store layout pnpm 11 and 12 both write (`v11`). */
export const PNPM_PRUNE_SPEC = process.env.NUXT_DEV_ENV_PNPM_PRUNE_SPEC || 'pnpm@12'
/** uv's own image: the helper image has no uv, and `uv cache` takes uv's lock, which a bare `rm` would not. */
export const UV_IMAGE = process.env.NUXT_DEV_ENV_UV_IMAGE || 'ghcr.io/astral-sh/uv:0.12.22'

export const CACHE_LABELS: Record<string, string> = {
  'pnpm-store': 'pnpm package store',
  'pnpm-projects': 'pnpm virtual stores, one per environment',
  'pnpm-metadata': 'pnpm registry metadata',
  'pnpm-managers': 'pnpm versions that projects pin',
  'npm': 'npm cache',
  'npx': 'npx installs',
  'uv': 'uv (Python) cache',
  'other': 'pip, yarn and Go caches'
}

export function diskLevel(disk: { totalBytes: number, freeBytes: number }): DockerDiskLevel {
  const share = disk.totalBytes > 0 ? disk.freeBytes / disk.totalBytes : 1
  if (disk.freeBytes < 3 * GIB || share < 0.05) return 'critical'
  if (disk.freeBytes < 8 * GIB || share < 0.15) return 'low'
  return 'ok'
}

/** Which cleanup is due now, if any. Pure, so the rule is testable. */
export function planCleanup(input: {
  level: DockerDiskLevel
  busy: boolean
  lastCleanupAt: string | null
  lastCleanupLevel: CacheCleanupLevel | null
  now: Date
}): CacheCleanupLevel | null {
  const since = input.lastCleanupAt ? input.now.getTime() - new Date(input.lastCleanupAt).getTime() : Infinity
  const sincePressure = input.lastCleanupLevel === 'pressure' ? since : Infinity
  if (input.level === 'critical') return sincePressure >= CRITICAL_GAP_MS ? 'pressure' : null
  if (input.busy) return null
  if (input.level === 'low') return sincePressure >= PRESSURE_GAP_MS ? 'pressure' : null
  return since >= ROUTINE_MS ? 'routine' : null
}

/**
 * Walks the volume, given as the first argument, and prints what each cache
 * holds and what each level of cleanup would free of it. Run with `node -e`
 * in the helper image, the volume mounted read-only.
 *
 * Each inode counts once, for the first cache that reaches it, and the pnpm
 * store is walked first: a virtual store's hardlinks then cost nothing, and
 * what it is charged is what it copied. `du` per directory instead charges
 * every link to whichever directory it happens to read first, which made
 * two environments look like 1.7 GB and 1.4 GB when each held 226 MB.
 */
export const CACHE_SURVEY_SCRIPT = String.raw`
const fs = require('fs'), path = require('path')
const root = process.argv[1], staleMs = Number(process.argv[2]), now = Date.now()
const seen = new Set()
const out = { totalBytes: 0, freeBytes: 0, caches: {}, projects: {}, owners: {} }
const sub = (...parts) => path.join(root, ...parts)
const list = (dir) => { try { return fs.readdirSync(dir) } catch { return [] } }
const handled = new Set()
function add(key, bytes, routine, pressure) {
  const cache = out.caches[key] || (out.caches[key] = { bytes: 0, routine: 0, pressure: 0 })
  cache.bytes += bytes
  if (routine) cache.routine += bytes
  if (pressure) cache.pressure += bytes
}
function walk(start, visit) {
  handled.add(start)
  const stack = [start]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (!handled.has(file)) stack.push(file); continue }
      let stat
      try { stat = fs.lstatSync(file) } catch { continue }
      if (seen.has(stat.ino)) continue
      seen.add(stat.ino)
      visit(file, stat, stat.blocks * 512)
    }
  }
}
const files = path.sep + 'files' + path.sep
walk(sub('pnpm', 'store'), (file, stat, bytes) => {
  const unlinked = stat.nlink === 1 && file.includes(files)
  add('pnpm-store', bytes, unlinked, unlinked)
})
for (const id of list(sub('pnpm', 'projects'))) {
  out.projects[id] = 0
  walk(sub('pnpm', 'projects', id), (file, stat, bytes) => { out.projects[id] += bytes; add('pnpm-projects', bytes, false, false) })
}
const layouts = list(sub('pnpm', 'cache')).filter(name => /^v\d+$/.test(name)).map(name => Number(name.slice(1)))
const newest = Math.max(...layouts)
for (const name of list(sub('pnpm', 'cache'))) {
  const obsolete = /^v\d+$/.test(name) && Number(name.slice(1)) < newest
  walk(sub('pnpm', 'cache', name), (file, stat, bytes) => add('pnpm-metadata', bytes, obsolete, obsolete))
}
walk(sub('pnpm', 'managers'), (file, stat, bytes) => add('pnpm-managers', bytes, false, false))
walk(sub('npm', '_cacache'), (file, stat, bytes) => add('npm', bytes, false, true))
for (const name of list(sub('npm', '_npx'))) {
  let stale = false
  try { stale = now - fs.statSync(sub('npm', '_npx', name)).mtimeMs > staleMs } catch {}
  walk(sub('npm', '_npx', name), (file, stat, bytes) => add('npx', bytes, stale, true))
}
walk(sub('uv'), (file, stat, bytes) => add('uv', bytes, false, true))
walk(root, (file, stat, bytes) => add('other', bytes, false, false))
for (const name of ['pnpm', 'npm', 'uv']) {
  try { const stat = fs.statSync(sub(name)); out.owners[name] = stat.uid + ':' + stat.gid } catch {}
}
const disk = fs.statfsSync(root)
out.totalBytes = disk.blocks * disk.bsize
out.freeBytes = disk.bavail * disk.bsize
console.log(JSON.stringify(out))
`

export const DISK_SCRIPT = String.raw`
const disk = require('fs').statfsSync(process.argv[1])
console.log(JSON.stringify({ totalBytes: disk.blocks * disk.bsize, freeBytes: disk.bavail * disk.bsize }))
`

export interface CacheSurvey {
  totalBytes: number
  freeBytes: number
  caches: Record<string, { bytes: number, routine: number, pressure: number }>
  projects: Record<string, number>
  owners: Record<string, string>
}

/**
 * Cleans the volume as root in the helper image, each tool as the owner of
 * its directory: a file pnpm or npm writes as root (the store's `index.db`
 * is rewritten by a prune) would lock every environment's user out of it.
 * Prints one `ok <step>` or `failed <step>: <why>` line per step. uv runs
 * apart, in its own image (`uvCleanupArgs`).
 */
export const CACHE_CLEANUP_SCRIPT = [
  'root="$1"; level="$2"; pnpm="$3"; stale_days="$4"',
  'as_owner() {',
  '  owner=$(stat -c %u:%g "$1") || return 1; shift',
  '  home="/tmp/home-${owner%:*}"; mkdir -p "$home"; chown "$owner" "$home"',
  '  setpriv --reuid="${owner%:*}" --regid="${owner#*:}" --clear-groups \\',
  '    env -C "$home" HOME="$home" npm_config_cache="$home/.npm" npm_config_update_notifier=false "$@"',
  '}',
  'step() {',
  '  name="$1"; shift',
  '  if "$@" >/tmp/step.log 2>&1; then echo "ok $name"',
  '  else echo "failed $name: $(tail -n 3 /tmp/step.log | tr \'\\n\' \' \')"; fi',
  '}',
  // By variable: pnpm 12 takes `--store-dir` here but refuses `--cache-dir`.
  'export pnpm_config_store_dir="$root/pnpm/store" pnpm_config_cache_dir="$root/pnpm/cache"',
  'if [ -d "$root/pnpm/store" ]; then',
  '  step pnpm-store as_owner "$root/pnpm/store" npx --yes "$pnpm" store prune',
  'fi',
  'if [ -d "$root/pnpm/cache" ]; then',
  '  step pnpm-metadata as_owner "$root/pnpm/cache" npx --yes "$pnpm" cache prune --yes',
  'fi',
  'if [ -d "$root/npm" ]; then',
  '  if [ "$level" = pressure ]; then',
  '    step npm as_owner "$root/npm" npm cache clean --force --cache "$root/npm"',
  '    [ -d "$root/npm/_npx" ] && step npx find "$root/npm/_npx" -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
  '  else',
  '    step npm as_owner "$root/npm" npm cache verify --cache "$root/npm"',
  '    [ -d "$root/npm/_npx" ] && step npx find "$root/npm/_npx" -mindepth 1 -maxdepth 1 -mtime +"$stale_days" -exec rm -rf {} +',
  '  fi',
  'fi',
  'true'
].join('\n')

function cleanupContainerName(): string {
  return `${resourcePrefix()}cache-cleanup`
}

export function surveyArgs(volume: string): string[] {
  return [
    'run', '--rm', '--volume', `${volume}:${CACHES_ROOT}:ro`, RUNTIME_IMAGE,
    'node', '-e', CACHE_SURVEY_SCRIPT, CACHES_ROOT, String(STALE_NPX_DAYS * 24 * 60 * 60_000)
  ]
}

export function cleanupArgs(volume: string, level: CacheCleanupLevel): string[] {
  return [
    'run', '--rm', '--name', cleanupContainerName(), '--volume', `${volume}:${CACHES_ROOT}`, RUNTIME_IMAGE,
    'sh', '-c', CACHE_CLEANUP_SCRIPT, 'sh', CACHES_ROOT, level, PNPM_PRUNE_SPEC, String(STALE_NPX_DAYS)
  ]
}

/** `uv cache prune` drops what no entry uses; `clean` empties it, once no uv holds its lock. */
export function uvCleanupArgs(volume: string, level: CacheCleanupLevel, owner: string): string[] {
  return [
    'run', '--rm', '--name', `${cleanupContainerName()}-uv`, '--user', owner, '--volume', `${volume}:${CACHES_ROOT}`, UV_IMAGE,
    'cache', level === 'pressure' ? 'clean' : 'prune', '--cache-dir', `${CACHES_ROOT}/uv`
  ]
}

/** What a survey says each cache holds and would give back, with the virtual stores of retired environments counted as freeable. */
export function summarizeCaches(survey: CacheSurvey, retired: Set<string>): DockerDiskCache[] {
  const caches = Object.entries(survey.caches).map(([key, cache]) => ({
    key,
    label: CACHE_LABELS[key] ?? key,
    bytes: cache.bytes,
    reclaimable: key === 'pnpm-projects'
      ? Object.entries(survey.projects).filter(([id]) => retired.has(id)).reduce((sum, [, bytes]) => sum + bytes, 0)
      : cache.pressure
  }))
  return caches.filter(cache => cache.bytes > 0).sort((a, b) => b.bytes - a.bytes)
}

const SIZE_UNITS: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 }

/** Docker's sizes are go-units' decimal strings: `1.2GB`, `0B`, `512.3kB (12%)`. */
export function parseDockerSize(text: string): number {
  const match = /^\s*([\d.]+)\s*([kKMGTP]?B)/.exec(text ?? '')
  return match ? Math.round(Number(match[1]) * (SIZE_UNITS[match[2]!] ?? 1)) : 0
}

/** `docker system df --format '{{json .}}'`, one object per line. */
export function parseSystemDf(stdout: string): DockerDiskUsage[] {
  return stdout.split('\n').map(line => line.trim()).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      return [{ type: String(row.Type), bytes: parseDockerSize(row.Size), reclaimable: parseDockerSize(row.Reclaimable) }]
    } catch {
      return []
    }
  })
}

/** The lines of a cleanup that failed, as one message; null when every step did its part. */
export function cleanupFailures(stdout: string): string | null {
  const failed = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('failed '))
  return failed.length ? failed.map(line => line.slice('failed '.length)).join('\n') : null
}

async function volumeExists(volume: string): Promise<boolean> {
  return run('docker', ['volume', 'inspect', volume], { allowFailure: true })
    .then(result => result.stdout.trim().startsWith('[') && result.stdout.trim() !== '[]', () => false)
}

/** A helper container that may outlive its own `docker` client, which a timeout kills; then it is removed by name. */
async function runNamed(args: string[], name: string, ms: number): Promise<{ stdout: string, stderr: string }> {
  try {
    return await run('docker', args, { signal: AbortSignal.timeout(ms) })
  } catch (error) {
    await run('docker', ['rm', '-f', name], { allowFailure: true }).catch(() => {})
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`took longer than ${Math.round(ms / 60_000)} minutes`, { cause: error })
    throw error
  }
}

const sum = (caches: DockerDiskCache[]) => caches.reduce((total, cache) => total + cache.bytes, 0)

export class CacheMaintenance {
  private timer: ReturnType<typeof setTimeout> | null = null
  private busy: Promise<unknown> | null = null

  start() {
    this.timer = setTimeout(() => void this.loop(), FIRST_CHECK_MS)
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  get cleaning(): boolean {
    return !!this.busy
  }

  private async loop() {
    await this.tick().catch(error => console.error('[caches] check failed', error))
    if (this.timer) this.timer = setTimeout(() => void this.loop(), CHECK_MS)
  }

  /** One check: the free space, then whatever it calls for. Asks nothing of a volume that does not exist, which asking would create. */
  async tick(now = new Date()): Promise<void> {
    if (this.busy) return
    const volume = sharedCacheVolumeName()
    if (!(await volumeExists(volume))) return
    const disk = JSON.parse((await run('docker', ['run', '--rm', '--volume', `${volume}:${CACHES_ROOT}:ro`, RUNTIME_IMAGE, 'node', '-e', DISK_SCRIPT, CACHES_ROOT])).stdout)
    const row = await getDockerDisk()
    const level = diskLevel(disk)
    const plan = planCleanup({
      level,
      busy: await environmentInstallsMayRun(),
      lastCleanupAt: row?.lastCleanupAt ?? null,
      lastCleanupLevel: row?.lastCleanupLevel ?? null,
      now
    })
    if (plan) {
      await this.clean(plan)
      return
    }
    if (!row || row.level !== level || !row.measuredAt || now.getTime() - new Date(row.measuredAt).getTime() >= MEASURE_MS) {
      await this.measure()
      return
    }
    if (Math.abs(row.freeBytes - disk.freeBytes) >= FREE_SPACE_STEP) {
      await saveDockerDisk({ ...row, ...disk, level, checkedAt: now.toISOString() })
    }
  }

  /** Walk the caches and write what they hold. */
  async measure(): Promise<DockerDisk | null> {
    // A cleanup measures before and after, and owns the row while it runs.
    if (this.busy) return getDockerDisk()
    const volume = sharedCacheVolumeName()
    if (!(await volumeExists(volume))) return null
    const { caches, survey } = await this.survey(volume)
    const row = await getDockerDisk()
    return saveDockerDisk({
      ...this.lastCleanup(row),
      totalBytes: survey.totalBytes,
      freeBytes: survey.freeBytes,
      level: diskLevel(survey),
      caches,
      docker: await this.dockerUsage(),
      reclaimableBytes: caches.reduce((total, cache) => total + cache.reclaimable, 0),
      measuredAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      cleaning: false
    })
  }

  /** Clean up at a level, once at a time; a second call while one runs joins it. */
  clean(level: CacheCleanupLevel): Promise<DockerDisk | null> {
    if (this.busy) return this.busy as Promise<DockerDisk | null>
    const pending = this.cleanNow(level).finally(() => {
      this.busy = null
    })
    this.busy = pending
    return pending
  }

  private async cleanNow(level: CacheCleanupLevel): Promise<DockerDisk | null> {
    const volume = sharedCacheVolumeName()
    if (!(await volumeExists(volume))) return null
    const started = new Date().toISOString()
    const row = await getDockerDisk()
    if (row) await saveDockerDisk({ ...row, cleaning: true })
    const before = await this.survey(volume)
    const failures: string[] = []
    // A retired environment's virtual store is the sweep's to remove: it is
    // what records that the environment owes nothing any more. It already
    // runs at retirement and at boot; this is for one that outlived both.
    if (Object.keys(before.survey.projects).some(id => before.retired.has(id))) {
      const report = await sweepEnvironmentResources()
      if (report.unreachable) failures.push(`removing retired environments' dependencies: ${report.unreachable}`)
    }
    try {
      const { stdout } = await runNamed(cleanupArgs(volume, level), cleanupContainerName(), 20 * 60_000)
      const failed = cleanupFailures(stdout)
      if (failed) failures.push(failed)
    } catch (error) {
      failures.push(`cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    const uvOwner = before.survey.owners.uv
    if (uvOwner && (before.survey.caches.uv?.bytes ?? 0) > 0) {
      await runNamed(uvCleanupArgs(volume, level, uvOwner), `${cleanupContainerName()}-uv`, 5 * 60_000).catch((error) => {
        failures.push(`uv: ${error instanceof Error ? error.message : String(error)}${/longer than/.test(String(error)) ? ' (a uv process, such as a running uvx, holds its cache)' : ''}`)
      })
    }
    const after = await this.survey(volume)
    const freed = Math.max(0, sum(before.caches) - sum(after.caches))
    const lastError = failures.length ? failures.join('\n') : null
    console.log(`[caches] ${level} cleanup freed ${(freed / GIB).toFixed(2)} GiB${lastError ? `; ${lastError}` : ''}`)
    return saveDockerDisk({
      totalBytes: after.survey.totalBytes,
      freeBytes: after.survey.freeBytes,
      level: diskLevel(after.survey),
      caches: after.caches,
      docker: await this.dockerUsage(),
      reclaimableBytes: after.caches.reduce((total, cache) => total + cache.reclaimable, 0),
      measuredAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      cleaning: false,
      lastCleanupAt: started,
      lastCleanupLevel: level,
      lastFreedBytes: freed,
      lastError
    })
  }

  private async survey(volume: string) {
    // Read-only, so a walk cut short by the timeout leaves nothing half-done.
    const survey = JSON.parse((await run('docker', surveyArgs(volume), { signal: AbortSignal.timeout(10 * 60_000) })).stdout) as CacheSurvey
    const retired = new Set((await listDevEnvironments(undefined, true)).filter(environment => environment.retiredAt).map(environment => environment.id))
    return { survey, retired, caches: summarizeCaches(survey, retired) }
  }

  private async dockerUsage(): Promise<DockerDiskUsage[]> {
    const { stdout } = await run('docker', ['system', 'df', '--format', '{{json .}}'], { allowFailure: true }).catch(() => ({ stdout: '' }))
    return parseSystemDf(stdout)
  }

  private lastCleanup(row: DockerDisk | null) {
    return {
      lastCleanupAt: row?.lastCleanupAt ?? null,
      lastCleanupLevel: row?.lastCleanupLevel ?? null,
      lastFreedBytes: row?.lastFreedBytes ?? null,
      lastError: row?.lastError ?? null
    }
  }
}

export const cacheMaintenance = new CacheMaintenance()
