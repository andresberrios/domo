import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'domo-paths-'))
  vi.resetModules()
})

afterEach(async () => {
  delete process.env.NUXT_DATA_DIR
  delete process.env.DOMO_DATA_DIR
  await rm(root, { recursive: true, force: true })
})

/** Everything Domo persists hangs off one directory, and it must exist. */
describe('dataDir', () => {
  it('uses NUXT_DATA_DIR and creates it', async () => {
    const configured = join(root, 'nested', 'data')
    process.env.NUXT_DATA_DIR = configured
    const { dataDir } = await import('../../server/lib/paths')

    expect(dataDir()).toBe(configured)
    expect(existsSync(configured)).toBe(true)
  })

  it('resolves a relative setting against the working directory', async () => {
    process.env.NUXT_DATA_DIR = 'relative-data'
    const { dataDir } = await import('../../server/lib/paths')

    expect(dataDir()).toBe(resolve(process.cwd(), 'relative-data'))
    await rm(resolve(process.cwd(), 'relative-data'), { recursive: true, force: true })
  })

  it('accepts the DOMO_DATA_DIR alias', async () => {
    process.env.DOMO_DATA_DIR = join(root, 'alias')
    const { dataDir } = await import('../../server/lib/paths')

    expect(dataDir()).toBe(join(root, 'alias'))
  })

  it('defaults to ./.data', async () => {
    const { dataDir } = await import('../../server/lib/paths')

    expect(dataDir()).toBe(resolve(process.cwd(), '.data'))
  })
})

describe('sub-directories', () => {
  it('live under the data directory and are created on demand', async () => {
    process.env.NUXT_DATA_DIR = root
    const { dbDir, uploadsDir } = await import('../../server/lib/paths')

    expect(dbDir()).toBe(join(root, 'pglite'))
    expect(uploadsDir()).toBe(join(root, 'uploads'))
    expect(existsSync(join(root, 'uploads'))).toBe(true)
  })
})
