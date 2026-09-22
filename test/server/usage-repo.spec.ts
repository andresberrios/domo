import { beforeEach, describe, expect, it } from 'vitest'

import { query } from '../../server/lib/db'
import {
  createAgentSession,
  createVoiceSession,
  getAgentSession,
  getVoiceSession,
  listUsageLimits,
  listUsageProviders,
  setAgentUsage,
  setUsageProviderState,
  setVoiceUsage,
  writeUsageLimits
} from '../../server/lib/repo'
import { captureBus } from '../helpers/bus'
import type { UsageLimitSource } from '~~/shared/types'

/**
 * The usage rows against a real Postgres.
 *
 * Both tables are streamed to the browser with `REPLICA IDENTITY FULL`, so an
 * update that changes nothing still costs a full row over the wire. Write-on-
 * change is therefore a property of the repo layer and not an optimisation the
 * callers are trusted to remember.
 */

const limit = (patch: Partial<Parameters<typeof writeUsageLimits>[1][number]> = {}) => ({
  limitId: 'five_hour',
  label: '5-hour limit',
  usedPercent: 52,
  resetsAt: '2026-09-21T17:00:00.000Z',
  windowMinutes: 300,
  status: null,
  amountUsed: null,
  amountLimit: null,
  currency: null,
  source: 'endpoint' as UsageLimitSource,
  ...patch
})

beforeEach(async () => {
  await query('truncate usage_limits')
  await query('truncate usage_providers')
  await query('truncate agent_sessions cascade')
  await query('truncate voice_sessions cascade')
})

describe('session usage columns', () => {
  it('records a coding session reading without disturbing anything else', async () => {
    const agent = await createAgentSession({ adapter: 'claude-code', title: 'Auth', cwd: '/srv' })
    const before = await getAgentSession(agent.id)

    await setAgentUsage(agent.id, {
      context: { used: 48_500, size: 200_000 },
      cost: { amount: 0.42, currency: 'USD' },
      updatedAt: '2026-09-21T12:00:00.000Z'
    })

    const after = await getAgentSession(agent.id)
    expect(after!.usage).toEqual({
      context: { used: 48_500, size: 200_000 },
      cost: { amount: 0.42, currency: 'USD' },
      updatedAt: '2026-09-21T12:00:00.000Z'
    })
    // A reading is not activity: an idle adapter still reports one, and the
    // voice agent picks "the most recently active agent" off this column.
    expect(after!.lastActivityAt).toBe(before!.lastActivityAt)
    expect(after!.updatedAt).toBe(before!.updatedAt)
  })

  it('records a conversation reading without moving it up the sidebar', async () => {
    const voice = await createVoiceSession({ title: 'Morning' })
    const before = await getVoiceSession(voice.id)

    await setVoiceUsage(voice.id, {
      context: { used: 12_345, size: 131_072 },
      updatedAt: '2026-09-21T12:00:00.000Z'
    })

    const after = await getVoiceSession(voice.id)
    expect(after!.usage).toMatchObject({ context: { used: 12_345, size: 131_072 } })
    expect(after!.updatedAt).toBe(before!.updatedAt)
    expect(after!.lastActivityAt).toBe(before!.lastActivityAt)
    expect(after!.titleSource).toBe(before!.titleSource)
  })

  it('keeps a null size, for a Live model whose window is unknown', async () => {
    const voice = await createVoiceSession({ title: 'Morning' })

    await setVoiceUsage(voice.id, { context: { used: 900, size: null }, updatedAt: 'x' })

    expect((await getVoiceSession(voice.id))!.usage).toMatchObject({ context: { size: null } })
  })
})

describe('writing plan limits', () => {
  it('inserts what it is given', async () => {
    await writeUsageLimits('claude', [limit()], { replace: true })

    expect(await listUsageLimits('claude')).toEqual([expect.objectContaining({
      provider: 'claude',
      limitId: 'five_hour',
      usedPercent: 52,
      resetsAt: '2026-09-21T17:00:00.000Z',
      windowMinutes: 300,
      source: 'endpoint'
    })])
  })

  it('leaves an unchanged row completely alone, timestamp included', async () => {
    await writeUsageLimits('claude', [limit()], { replace: true })
    const first = (await listUsageLimits('claude'))[0]!

    await new Promise(resolve => setTimeout(resolve, 5))
    await writeUsageLimits('claude', [limit()], { replace: true })

    // Not even `updated_at` moves: an identical row rewritten is a whole row
    // streamed to every browser to say nothing.
    expect((await listUsageLimits('claude'))[0]!.updatedAt).toBe(first.updatedAt)
  })

  it('updates a row whose reading moved', async () => {
    await writeUsageLimits('claude', [limit()], { replace: true })
    await writeUsageLimits('claude', [limit({ usedPercent: 61 })], { replace: true })

    expect((await listUsageLimits('claude'))[0]!.usedPercent).toBe(61)
  })

  it('removes a window a poll no longer reports', async () => {
    await writeUsageLimits('claude', [
      limit(),
      limit({ limitId: 'seven_day_opus', label: 'Weekly · Opus', usedPercent: 8 })
    ], { replace: true })

    // The account stopped having an Opus window — a plan change, say.
    await writeUsageLimits('claude', [limit()], { replace: true })

    expect((await listUsageLimits('claude')).map(row => row.limitId)).toEqual(['five_hour'])
  })

  it('keeps a window a session event says nothing about', async () => {
    await writeUsageLimits('claude', [
      limit(),
      limit({ limitId: 'seven_day_opus', label: 'Weekly · Opus', usedPercent: 8 })
    ], { replace: true })

    await writeUsageLimits('claude', [
      limit({ limitId: 'seven_day', label: 'Weekly · all models', usedPercent: 31, source: 'session-event' })
    ], { replace: false })

    expect((await listUsageLimits('claude')).map(row => row.limitId).sort())
      .toEqual(['five_hour', 'seven_day', 'seven_day_opus'])
  })

  it('does not let one provider poll clear another', async () => {
    await writeUsageLimits('claude', [limit()], { replace: true })
    await writeUsageLimits('codex', [limit({ limitId: 'plan:primary', source: 'app-server' })], { replace: true })

    expect(await listUsageLimits('claude')).toHaveLength(1)
    expect(await listUsageLimits('codex')).toHaveLength(1)
  })

  it('protects a fresh polled reading from a sparser source', async () => {
    await writeUsageLimits('claude', [limit({ usedPercent: 52 })], { replace: true })

    await writeUsageLimits('claude', [limit({ usedPercent: 99, source: 'session-event' })], { replace: false })

    expect((await listUsageLimits('claude'))[0]).toMatchObject({ usedPercent: 52, source: 'endpoint' })
  })

  it('lets a sparser source take over once the better one is stale', async () => {
    await query(
      `insert into usage_limits (provider, limit_id, label, used_percent, window_minutes, source, updated_at)
       values ('claude', 'five_hour', '5-hour limit', 52, 300, 'endpoint', $1)`,
      [new Date(Date.now() - 30 * 60_000).toISOString()]
    )

    await writeUsageLimits('claude', [limit({ usedPercent: 99, source: 'session-event' })], { replace: false })

    expect((await listUsageLimits('claude'))[0]).toMatchObject({ usedPercent: 99, source: 'session-event' })
  })

  it('tells the bus when something changed, and only then', async () => {
    const seen = captureBus()
    try {
      await writeUsageLimits('claude', [limit()], { replace: true })
      expect(seen.events.filter(event => event.type === 'usage-limits-changed')).toHaveLength(1)

      await writeUsageLimits('claude', [limit()], { replace: true })
      expect(seen.events.filter(event => event.type === 'usage-limits-changed')).toHaveLength(1)
    } finally {
      seen.stop()
    }
  })
})

describe('provider health', () => {
  it('records the state and why', async () => {
    await setUsageProviderState('claude', 'unconfigured', 'Set NUXT_CLAUDE_CODE_OAUTH_TOKEN')

    expect(await listUsageProviders()).toEqual([expect.objectContaining({
      provider: 'claude',
      state: 'unconfigured',
      message: 'Set NUXT_CLAUDE_CODE_OAUTH_TOKEN'
    })])
  })

  it('does not rewrite the row when nothing about it changed', async () => {
    await setUsageProviderState('claude', 'ok', null)
    const first = (await listUsageProviders())[0]!

    await new Promise(resolve => setTimeout(resolve, 5))
    await setUsageProviderState('claude', 'ok', null)

    // The same `ok` every hour is not news, and this row is synced too.
    expect((await listUsageProviders())[0]!.checkedAt).toBe(first.checkedAt)
  })

  it('moves to the new state, and back again', async () => {
    await setUsageProviderState('claude', 'ok', null)
    await setUsageProviderState('claude', 'error', 'HTTP 401')
    expect((await listUsageProviders())[0]).toMatchObject({ state: 'error', message: 'HTTP 401' })

    await setUsageProviderState('claude', 'ok', null)
    expect((await listUsageProviders())[0]).toMatchObject({ state: 'ok', message: null })
  })
})
