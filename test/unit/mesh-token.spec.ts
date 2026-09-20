import { describe, expect, it } from 'vitest'

import { mintMeshToken, verifyMeshToken } from '../../server/lib/mesh/token'

/**
 * The mesh token is the only thing standing between a coding agent and the
 * mesh endpoint, so what matters is that nothing but a token this process
 * minted ever verifies — and that nothing malformed throws on the way there.
 */
describe('mesh tokens', () => {
  it('verifies back to the session it was minted for', () => {
    const token = mintMeshToken('ag_1234')
    expect(token.startsWith('ag_1234.')).toBe(true)
    expect(verifyMeshToken(token)).toBe('ag_1234')
  })

  it('rejects a tampered signature', () => {
    const token = mintMeshToken('ag_1234')
    const flipped = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')
    expect(verifyMeshToken(flipped)).toBeNull()
  })

  it('rejects another session id on a valid signature', () => {
    const [, signature] = mintMeshToken('ag_1234').split('.')
    expect(verifyMeshToken(`ag_5678.${signature}`)).toBeNull()
  })

  it('rejects malformed and empty input', () => {
    for (const token of ['', '.', 'ag_1234', 'ag_1234.', '.deadbeef', undefined, null]) {
      expect(verifyMeshToken(token)).toBeNull()
    }
  })

  it('does not throw on a signature of the wrong length', () => {
    // `timingSafeEqual` throws on mismatched buffers; the length check is first.
    expect(() => verifyMeshToken('ag_1234.ab')).not.toThrow()
    expect(verifyMeshToken('ag_1234.ab')).toBeNull()
    expect(verifyMeshToken(`${mintMeshToken('ag_1234')}00`)).toBeNull()
  })
})
