import { describe, expect, it } from 'vitest'

import { describeAdapterUpgrade } from '../../shared/dev-environments'

describe('describeAdapterUpgrade', () => {
  it('says the adapters are current when the old ones were never read', () => {
    // An environment moved from another Domo, whose stopped container could not be asked.
    expect(describeAdapterUpgrade({ adapters: { from: null, to: { 'claude-code': '1.2.0', codex: '0.9.0' } } }))
      .toBe('current (claude-code 1.2.0, codex 0.9.0)')
  })

  it('names what changed', () => {
    expect(describeAdapterUpgrade({ adapters: { from: { 'claude-code': '1.2.0', codex: '0.8.0' }, to: { 'claude-code': '1.2.0', codex: '0.9.0' } } }))
      .toBe('updated to current (codex 0.8.0 → 0.9.0)')
  })

  it('says when nothing changed', () => {
    expect(describeAdapterUpgrade({ adapters: { from: { 'claude-code': '1.2.0' }, to: { 'claude-code': '1.2.0' } } }))
      .toBe('already current (claude-code 1.2.0)')
  })
})
