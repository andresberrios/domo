import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installInfo, shouldAutoApply } from '../../server/lib/updates'
import { DEFAULT_UPDATE_SETTINGS } from '../../server/lib/settings'

const settings = { ...DEFAULT_UPDATE_SETTINGS, autoApply: true }
const check = { behind: 3, target: 'bbb' }

describe('shouldAutoApply', () => {
  it('needs the switch on and something new', () => {
    expect(shouldAutoApply({ settings: { ...settings, autoApply: false }, check, state: 'idle', lastAppliedAt: null, failedTarget: null })).toBe(false)
    expect(shouldAutoApply({ settings, check: { behind: 0, target: 'aaa' }, state: 'idle', lastAppliedAt: null, failedTarget: null })).toBe(false)
    expect(shouldAutoApply({ settings, check, state: 'idle', lastAppliedAt: null, failedTarget: null })).toBe(true)
  })

  it('treats an unknown count as something new', () => {
    expect(shouldAutoApply({ settings, check: { behind: null, target: 'bbb' }, state: 'idle', lastAppliedAt: null, failedTarget: null })).toBe(true)
  })

  it('does not retry the target that just failed, but does try the next one', () => {
    expect(shouldAutoApply({ settings, check, state: 'failed', lastAppliedAt: null, failedTarget: 'bbb' })).toBe(false)
    expect(shouldAutoApply({ settings, check: { behind: 4, target: 'ccc' }, state: 'failed', lastAppliedAt: null, failedTarget: 'bbb' })).toBe(true)
  })

  it('leaves a build or a pending restart alone', () => {
    for (const state of ['checking', 'building', 'ready', 'restarting'] as const) {
      expect(shouldAutoApply({ settings, check, state, lastAppliedAt: null, failedTarget: null })).toBe(false)
    }
  })

  it('keeps the configured gap between automatic switches', () => {
    const now = new Date('2026-10-02T12:00:00Z')
    const recent = new Date('2026-10-02T11:30:00Z').toISOString()
    const old = new Date('2026-10-02T10:30:00Z').toISOString()
    expect(shouldAutoApply({ settings, check, state: 'idle', lastAppliedAt: recent, failedTarget: null, now })).toBe(false)
    expect(shouldAutoApply({ settings, check, state: 'idle', lastAppliedAt: old, failedTarget: null, now })).toBe(true)
    expect(shouldAutoApply({ settings: { ...settings, minHoursBetweenApplies: 0 }, check, state: 'idle', lastAppliedAt: recent, failedTarget: null, now })).toBe(true)
  })
})

describe('installInfo', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'domo-updates-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('is null under pnpm dev, where DOMO_HOME is unset', async () => {
    await writeFile(join(dir, 'build.json'), JSON.stringify({ commit: 'abc' }))
    expect(installInfo({}, dir)).toBeNull()
  })

  it('reads the release it runs from', async () => {
    await writeFile(join(dir, 'build.json'), JSON.stringify({ commit: 'abc', builtAt: '2026-10-02T00:00:00Z' }))
    expect(installInfo({ DOMO_HOME: '/x' }, dir)).toEqual({ home: '/x', commit: 'abc', builtAt: '2026-10-02T00:00:00Z' })
  })

  it('is null without a build stamp, so a stray DOMO_HOME does not start the updater', () => {
    expect(installInfo({ DOMO_HOME: '/x' }, dir)).toBeNull()
  })
})
