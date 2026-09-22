import { describe, expect, it } from 'vitest'

import { sessionStartability } from '../../shared/retention'
import type { AgentSession, DevEnvironment } from '../../shared/types'

/**
 * The rule that decides whether a session can be started.
 *
 * It is pure and it is shared, which is the whole point: the server refuses off
 * it and the UI explains off it, so the composer is never offered for something
 * a prompt would reject. These are the answers it has to keep giving.
 */

function session(overrides: Partial<AgentSession> = {}) {
  return { devEnvironmentId: null, cwd: '/work/domo', ...overrides } as
    Pick<AgentSession, 'devEnvironmentId' | 'cwd'>
}

function environment(overrides: Partial<DevEnvironment> = {}) {
  return { name: 'feature-auth', retiredAt: null, ...overrides } as
    Pick<DevEnvironment, 'name' | 'retiredAt'>
}

describe('sessionStartability', () => {
  it('starts a host session whose directory is there, or not checked', () => {
    expect(sessionStartability(session(), null, true)).toEqual({ startable: true })
    // `null` is "nobody looked" — only the start path stats the filesystem, and
    // everything above it asks the environment question alone.
    expect(sessionStartability(session(), null)).toEqual({ startable: true })
  })

  it('refuses a host session whose working directory has gone, and names it', () => {
    const state = sessionStartability(session({ cwd: '/work/gone' }), null, false)

    expect(state.startable).toBe(false)
    expect(state.startable === false && state.reason).toContain('/work/gone')
  })

  it('starts a container session while its environment is live', () => {
    expect(sessionStartability(session({ devEnvironmentId: 'env_1' }), environment()))
      .toEqual({ startable: true })
  })

  it('refuses one whose environment has been retired, and names it', () => {
    const state = sessionStartability(
      session({ devEnvironmentId: 'env_1' }),
      environment({ retiredAt: '2026-09-21T09:00:00.000Z' })
    )

    expect(state.startable).toBe(false)
    expect(state.startable === false && state.reason).toContain('feature-auth')
  })

  it('refuses one whose environment row has gone entirely', () => {
    // `pruneRetiredRecords` only drops a retired environment once nothing
    // references it, so this is the case where the row was never kept at all.
    expect(sessionStartability(session({ devEnvironmentId: 'env_gone' }), null).startable).toBe(false)
  })

  it('never lets a missing working directory refuse a container session', () => {
    // The container's checkout is in a volume; the host path is meaningless
    // there, and stating it would refuse every environment session on a host
    // whose workspace path happens not to exist locally.
    expect(sessionStartability(session({ devEnvironmentId: 'env_1' }), environment(), false))
      .toEqual({ startable: true })
  })
})
