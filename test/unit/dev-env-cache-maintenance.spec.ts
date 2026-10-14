import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/repo', () => ({}))
vi.mock('../../server/lib/dev-env/reconcile', () => ({}))

const {
  CACHE_CLEANUP_SCRIPT,
  CACHE_SURVEY_SCRIPT,
  cleanupArgs,
  cleanupFailures,
  diskLevel,
  parseDockerSize,
  parseSystemDf,
  planCleanup,
  summarizeCaches,
  surveyArgs,
  uvCleanupArgs
} = await import('../../server/lib/dev-env/cache-maintenance')

const GIB = 1024 ** 3

describe('diskLevel', () => {
  it('warns below 8 GiB or 15% free, and is critical below 3 GiB or 5%', () => {
    const total = 58 * GIB
    expect(diskLevel({ totalBytes: total, freeBytes: 20 * GIB })).toBe('ok')
    expect(diskLevel({ totalBytes: total, freeBytes: 7.75 * GIB })).toBe('low')
    expect(diskLevel({ totalBytes: total, freeBytes: 2 * GIB })).toBe('critical')
    // A big disk is low by share before it is low by size.
    expect(diskLevel({ totalBytes: 1000 * GIB, freeBytes: 100 * GIB })).toBe('low')
  })
})

describe('planCleanup', () => {
  const now = new Date('2026-10-14T12:00:00Z')
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()
  const plan = (input: Partial<Parameters<typeof planCleanup>[0]>) =>
    planCleanup({ level: 'ok', busy: false, lastCleanupAt: null, lastCleanupLevel: null, now, ...input })

  it('runs a routine cleanup once a day while the disk is fine', () => {
    expect(plan({})).toBe('routine')
    expect(plan({ lastCleanupAt: ago(60), lastCleanupLevel: 'routine' })).toBeNull()
    expect(plan({ lastCleanupAt: ago(25 * 60), lastCleanupLevel: 'routine' })).toBe('routine')
  })

  it('empties the download caches when the disk is low, at most once an hour', () => {
    expect(plan({ level: 'low', lastCleanupAt: ago(5), lastCleanupLevel: 'routine' })).toBe('pressure')
    expect(plan({ level: 'low', lastCleanupAt: ago(30), lastCleanupLevel: 'pressure' })).toBeNull()
    expect(plan({ level: 'low', lastCleanupAt: ago(61), lastCleanupLevel: 'pressure' })).toBe('pressure')
  })

  it('waits for installs to finish, unless the disk is about to be full', () => {
    expect(plan({ busy: true })).toBeNull()
    expect(plan({ level: 'low', busy: true })).toBeNull()
    expect(plan({ level: 'critical', busy: true })).toBe('pressure')
    expect(plan({ level: 'critical', busy: true, lastCleanupAt: ago(10), lastCleanupLevel: 'pressure' })).toBeNull()
  })
})

describe('the survey script', () => {
  let root: string | null = null
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = null
  })

  const BLOCK = 64 * 1024
  async function file(path: string, size = BLOCK) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, Buffer.alloc(size, 1))
  }

  it('charges a hardlink once, to the store, and a copy to the environment that made it', async () => {
    root = await mkdtemp(join(tmpdir(), 'domo-survey-'))
    const store = join(root, 'pnpm', 'store', 'v11', 'files')
    await file(join(store, 'aa', 'linked'))
    await file(join(store, 'bb', 'unlinked'))
    await file(join(store, '..', 'index.db'))
    // Two environments link the same file; one also holds a copy, as pnpm does for a package with a build script.
    for (const id of ['env_a', 'env_b']) {
      await mkdir(join(root, 'pnpm', 'projects', id, '.pnpm'), { recursive: true })
      await link(join(store, 'aa', 'linked'), join(root, 'pnpm', 'projects', id, '.pnpm', 'linked'))
    }
    await file(join(root, 'pnpm', 'projects', 'env_b', '.pnpm', 'copied'))
    await file(join(root, 'pnpm', 'cache', 'v11', 'metadata', 'old'))
    await file(join(root, 'pnpm', 'cache', 'v12', 'metadata', 'new'))
    await file(join(root, 'npm', '_cacache', 'content'))
    await file(join(root, 'npm', '_npx', 'fresh', 'package.json'))
    await file(join(root, 'npm', '_npx', 'stale', 'package.json'))
    const month = Date.now() / 1000 - 30 * 24 * 3600
    await utimes(join(root, 'npm', '_npx', 'stale'), month, month)
    await file(join(root, 'uv', 'archive'))
    await file(join(root, 'pip', 'wheel'))

    const { stdout } = await promisify(execFile)(process.execPath, ['-e', CACHE_SURVEY_SCRIPT, root, String(14 * 24 * 3600_000)])
    const survey = JSON.parse(stdout)
    const blocks = (key: string) => {
      const cache = survey.caches[key]
      return { bytes: cache.bytes / BLOCK, routine: cache.routine / BLOCK, pressure: cache.pressure / BLOCK }
    }

    expect(blocks('pnpm-store')).toEqual({ bytes: 3, routine: 1, pressure: 1 })
    expect(survey.projects.env_a).toBe(0)
    expect(survey.projects.env_b / BLOCK).toBe(1)
    expect(blocks('pnpm-metadata')).toEqual({ bytes: 2, routine: 1, pressure: 1 })
    expect(blocks('npm')).toEqual({ bytes: 1, routine: 0, pressure: 1 })
    expect(blocks('npx')).toEqual({ bytes: 2, routine: 1, pressure: 2 })
    expect(blocks('uv')).toEqual({ bytes: 1, routine: 0, pressure: 1 })
    expect(blocks('other')).toEqual({ bytes: 1, routine: 0, pressure: 0 })
    expect(survey.totalBytes).toBeGreaterThan(0)
    expect(survey.owners.pnpm).toMatch(/^\d+:\d+$/)
  })
})

describe('summarizeCaches', () => {
  it('counts a retired environment\'s virtual store as freeable, and a live one\'s not', () => {
    const caches = summarizeCaches({
      totalBytes: 0,
      freeBytes: 0,
      caches: {
        'pnpm-projects': { bytes: 300, routine: 0, pressure: 0 },
        'npm': { bytes: 500, routine: 0, pressure: 500 },
        'uv': { bytes: 0, routine: 0, pressure: 0 }
      },
      projects: { env_live: 100, env_retired: 200 },
      owners: {}
    }, new Set(['env_retired']))

    expect(caches).toEqual([
      { key: 'npm', label: 'npm cache', bytes: 500, reclaimable: 500 },
      { key: 'pnpm-projects', label: 'pnpm virtual stores, one per environment', bytes: 300, reclaimable: 200 }
    ])
  })
})

describe('docker system df', () => {
  it('reads go-units\' decimal sizes', () => {
    expect(parseDockerSize('0B')).toBe(0)
    expect(parseDockerSize('512.3kB')).toBe(512_300)
    expect(parseDockerSize('1.25GB (12%)')).toBe(1_250_000_000)
    expect(parseDockerSize('')).toBe(0)
  })

  it('reads one object per line and skips what is not one', () => {
    expect(parseSystemDf([
      '{"Active":"3","Reclaimable":"2.1GB (40%)","Size":"5.3GB","TotalCount":"9","Type":"Images"}',
      'garbage',
      '{"Active":"0","Reclaimable":"800MB","Size":"800MB","TotalCount":"12","Type":"Build Cache"}'
    ].join('\n'))).toEqual([
      { type: 'Images', bytes: 5_300_000_000, reclaimable: 2_100_000_000 },
      { type: 'Build Cache', bytes: 800_000_000, reclaimable: 800_000_000 }
    ])
  })
})

describe('the cleanup', () => {
  it('only reads the volume to survey it', () => {
    expect(surveyArgs('domo-dev-caches')).toContain('domo-dev-caches:/opt/domo-caches:ro')
  })

  it('runs each tool as the owner of its directory, never as root', () => {
    expect(CACHE_CLEANUP_SCRIPT).toContain('setpriv --reuid=')
    for (const line of CACHE_CLEANUP_SCRIPT.split('\n').filter(line => /npx --yes|npm cache/.test(line))) {
      expect(line).toContain('as_owner')
    }
    expect(uvCleanupArgs('v', 'routine', '1000:1000')).toEqual(expect.arrayContaining(['--user', '1000:1000', 'prune']))
    expect(uvCleanupArgs('v', 'pressure', '1000:1000')).toContain('clean')
  })

  it('empties the download caches only under pressure', () => {
    const routine = cleanupArgs('v', 'routine')
    expect(routine.slice(-4)).toEqual(['/opt/domo-caches', 'routine', expect.stringMatching(/^pnpm@/), '14'])
    expect(CACHE_CLEANUP_SCRIPT).toMatch(/if \[ "\$level" = pressure \]; then\n\s+step npm as_owner "\$root\/npm" npm cache clean --force/)
  })

  it('reports only the steps that failed', () => {
    expect(cleanupFailures('ok pnpm-store\nok npm')).toBeNull()
    expect(cleanupFailures('ok pnpm-store\nfailed npm: EACCES\n')).toBe('npm: EACCES')
  })
})
