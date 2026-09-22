import { describe, expect, it } from 'vitest'

import { revivalState } from '../../shared/retention'
import type { AgentSession, DevEnvironment } from '../../shared/types'

/**
 * The rule that decides whether a retired session can come back.
 *
 * It is pure and it is shared, which is the whole point: the archive page and
 * the agent page render the Revive button off it, and `POST /revive` refuses
 * off it, so the UI can never offer an action the server would reject. These
 * are the four answers it has to keep giving.
 */

function session(overrides: Partial<AgentSession> = {}) {
  return {
    retiredAt: '2026-09-20T10:00:00.000Z',
    devEnvironmentId: null,
    ...overrides
  } as Pick<AgentSession, 'retiredAt' | 'devEnvironmentId'>
}

function environment(overrides: Partial<DevEnvironment> = {}) {
  return { name: 'api', deletedAt: null, ...overrides } as Pick<DevEnvironment, 'name' | 'deletedAt'>
}

describe('revivalState', () => {
  it('refuses a session that is not retired', () => {
    expect(revivalState(session({ retiredAt: null }), null)).toEqual({
      revivable: false,
      reason: 'This session is not retired.'
    })
  })

  it('revives a host session, whatever its working directory looks like now', () => {
    // No environment means no container to have lost. Whether the cwd is still
    // on disk is the adapter's problem at start time, and it says so readably;
    // refusing here would block a revival that would have worked.
    expect(revivalState(session(), null)).toEqual({ revivable: true })
  })

  it('revives a container session whose environment is still there', () => {
    expect(revivalState(session({ devEnvironmentId: 'env_1' }), environment())).toEqual({
      revivable: true
    })
  })

  it('refuses one whose environment was deleted, and names it', () => {
    const state = revivalState(
      session({ devEnvironmentId: 'env_1' }),
      environment({ name: 'feature-auth', deletedAt: '2026-09-21T09:00:00.000Z' })
    )

    expect(state.revivable).toBe(false)
    expect(state.revivable === false && state.reason).toContain('feature-auth')
  })

  it('refuses one whose environment row has gone entirely', () => {
    // `pruneEmptyTombstones` only drops a tombstone once nothing references it,
    // so this is the legacy case: a session pointing at an environment deleted
    // before tombstones existed.
    const state = revivalState(session({ devEnvironmentId: 'env_gone' }), null)

    expect(state.revivable).toBe(false)
  })
})
