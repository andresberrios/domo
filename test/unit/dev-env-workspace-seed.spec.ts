import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COPY_IGNORED,
  describeSeed,
  globToRegExp,
  matchesAny,
  MAX_REPORTED_PATHS,
  parsePorcelain,
  seedReport
} from '../../server/lib/dev-env/workspace-seed'

describe('parsePorcelain', () => {
  it('reads NUL-separated entries, and takes a rename as one path and not two', () => {
    const output = ' M app/assets/css/main.css\0?? notes.txt\0R  app/new.vue\0app/old.vue\0 D gone.ts\0'

    expect(parsePorcelain(output)).toEqual(['app/assets/css/main.css', 'notes.txt', 'app/new.vue', 'gone.ts'])
  })

  it('keeps a path with a space in it whole', () => {
    expect(parsePorcelain('?? some file.txt\0')).toEqual(['some file.txt'])
  })

  it('is empty for a clean tree', () => {
    expect(parsePorcelain('')).toEqual([])
  })
})

describe('globToRegExp', () => {
  it('matches a leading **/ at the top level and at any depth, and * only inside one directory', () => {
    expect(globToRegExp('**/.env').test('.env')).toBe(true)
    expect(globToRegExp('**/.env').test('apps/web/.env')).toBe(true)
    expect(globToRegExp('*.pem').test('key.pem')).toBe(true)
    expect(globToRegExp('*.pem').test('certs/key.pem')).toBe(false)
    expect(globToRegExp('config/?.json').test('config/a.json')).toBe(true)
  })

  it('treats every other character literally, dots included', () => {
    expect(globToRegExp('.env').test('xenv')).toBe(false)
    expect(globToRegExp('a+b(c).txt').test('a+b(c).txt')).toBe(true)
  })
})

describe('DEFAULT_COPY_IGNORED', () => {
  it('copies .env files at any depth, and not dependency trees or other ignored files', () => {
    for (const path of ['.env', '.env.local', 'apps/api/.env.development']) {
      expect(matchesAny(path, DEFAULT_COPY_IGNORED), path).toBe(true)
    }
    for (const path of ['node_modules/pkg/index.js', 'dist/app.js', '.envrc', 'environment.ts']) {
      expect(matchesAny(path, DEFAULT_COPY_IGNORED), path).toBe(false)
    }
  })
})

describe('seedReport', () => {
  it('caps the listed paths but keeps the true total', () => {
    const paths = Array.from({ length: MAX_REPORTED_PATHS + 5 }, (_value, index) => `file-${index}.ts`)

    const report = seedReport({ paths })

    expect(report.paths).toHaveLength(MAX_REPORTED_PATHS)
    expect(report.total).toBe(MAX_REPORTED_PATHS + 5)
    expect(report).toMatchObject({ copied: [], install: null })
  })
})

describe('describeSeed', () => {
  it('says it starts from the last commit, and says what stayed behind so an absent change is never silent', () => {
    expect(describeSeed(seedReport({ paths: [] }))).toBe('It starts from the project\'s last commit.')
    expect(describeSeed(seedReport({ paths: ['a.ts', 'b.ts'] }))).toContain('2 uncommitted paths stay on the host')
  })

  it('names what was copied and how dependencies were installed, and a failed install loudly', () => {
    expect(describeSeed(seedReport({ paths: [], copied: ['.env'], install: { command: 'pnpm install --frozen-lockfile', error: null } })))
      .toBe('It starts from the project\'s last commit. Copied .env from the host. Installed dependencies with `pnpm install --frozen-lockfile`.')
    expect(describeSeed(seedReport({ paths: [], install: { command: 'npm ci', error: 'the image has no npm' } })))
      .toContain('`npm ci` failed, so dependencies may be missing: the image has no npm')
  })
})
