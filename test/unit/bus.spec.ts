import { describe, expect, it, vi } from 'vitest'

import { bus } from '../../server/lib/bus'
import type { StreamEvent } from '~~/shared/types'

/**
 * The bus is how the voice runtime hears about coding-agent activity without
 * importing it. It is in-process fan-out, so the only things worth pinning down
 * are that everyone gets every event and that unsubscribing really stops it.
 */
describe('bus', () => {
  const event: StreamEvent = { type: 'agent-changed', agentSessionId: 'ag_1' }

  it('delivers an event to every subscriber', () => {
    const first = vi.fn()
    const second = vi.fn()
    const stop = [bus.subscribe(first), bus.subscribe(second)]

    bus.publish(event)

    expect(first).toHaveBeenCalledWith(event)
    expect(second).toHaveBeenCalledWith(event)
    stop.forEach(off => off())
  })

  it('stops delivering once unsubscribed', () => {
    const listener = vi.fn()
    bus.subscribe(listener)()

    bus.publish(event)

    expect(listener).not.toHaveBeenCalled()
  })

  it('leaves the other subscribers alone when one unsubscribes', () => {
    const kept = vi.fn()
    const dropped = vi.fn()
    const off = bus.subscribe(dropped)
    const stop = bus.subscribe(kept)

    off()
    bus.publish(event)

    expect(kept).toHaveBeenCalledTimes(1)
    expect(dropped).not.toHaveBeenCalled()
    stop()
  })

  it('has no listener cap: a tab, the runtime and every agent all subscribe', () => {
    expect(bus.getMaxListeners()).toBe(0)
  })

  it('is a singleton on globalThis, so a Nitro reload does not fork it', async () => {
    expect((globalThis as any).__domo_bus__).toBe(bus)
    vi.resetModules()

    // A reload re-evaluates the module; the listeners must not move with it.
    await expect(import('../../server/lib/bus').then(module => module.bus)).resolves.toBe(bus)
  })
})
