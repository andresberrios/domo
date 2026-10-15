import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWorkDir, normalizeCwd } from '../../server/lib/paths'

describe('defaultWorkDir', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is the checkout under pnpm dev', () => {
    vi.stubEnv('DOMO_HOME', '')
    vi.stubEnv('NUXT_DEFAULT_CWD', '')
    expect(defaultWorkDir()).toBe(process.cwd())
  })

  it('is the home directory in an installed Domo, never the release it runs from', () => {
    vi.stubEnv('DOMO_HOME', '/tmp/domo-home')
    vi.stubEnv('NUXT_DEFAULT_CWD', '')
    expect(defaultWorkDir()).toBe(homedir())
    expect(normalizeCwd('')).toBe(homedir())
  })

  it('takes the override first', () => {
    vi.stubEnv('DOMO_HOME', '/tmp/domo-home')
    vi.stubEnv('NUXT_DEFAULT_CWD', '/srv/work')
    expect(defaultWorkDir()).toBe('/srv/work')
  })
})
