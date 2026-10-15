import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWorkDir, expandPath, insideOwnInstall, normalizeCwd } from '../../server/lib/paths'

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

describe('a path inside Domo\'s own install', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is the releases, the links to them and the old git checkout, and nothing else', () => {
    for (const path of ['/h/.domo/releases/2026.10.15-abc1234', '/h/.domo/current', '/h/.domo/previous/sub', '/h/.domo/app/server']) {
      expect(insideOwnInstall(path, '/h/.domo'), path).toBe(true)
    }
    for (const path of ['/h/.domo', '/h/.domo/data', '/h/.domo/releases-old', '/h/code/app', '/h']) {
      expect(insideOwnInstall(path, '/h/.domo'), path).toBe(false)
    }
    expect(insideOwnInstall('/h/.domo/releases/x', undefined)).toBe(false)
  })

  it('is taken as no path for a session, which then works in the default directory', () => {
    vi.stubEnv('DOMO_HOME', '/tmp/domo-home')
    vi.stubEnv('NUXT_DEFAULT_CWD', '')
    expect(normalizeCwd('/tmp/domo-home/releases/bfb09dbfda9a77a4fb7daf49815874f4fd8d8336')).toBe(homedir())
    expect(normalizeCwd('/tmp/domo-home/app')).toBe(homedir())
    expect(normalizeCwd('/tmp/elsewhere')).toBe('/tmp/elsewhere')
    expect(expandPath('/tmp/domo-home/app')).toBe('/tmp/domo-home/app')
  })
})
