import { describe, expect, it } from 'vitest'

import { internalBaseUrl } from '../../server/lib/internal-url'

describe('internalBaseUrl', () => {
  it('dials loopback on the port Nitro listens on', () => {
    expect(internalBaseUrl(false, { PORT: '3667' })).toBe('http://127.0.0.1:3667')
    expect(internalBaseUrl(false, { NITRO_PORT: '4000' })).toBe('http://127.0.0.1:4000')
    expect(internalBaseUrl(false, {})).toBe('http://127.0.0.1:3000')
  })

  it('reaches the host through host.docker.internal from an environment', () => {
    expect(internalBaseUrl(true, { PORT: '3667' })).toBe('http://host.docker.internal:3667')
  })

  it('lets NUXT_INTERNAL_URL win, without a trailing slash', () => {
    expect(internalBaseUrl(false, { NUXT_INTERNAL_URL: 'http://domo.lan:8080/', PORT: '1' })).toBe('http://domo.lan:8080')
    expect(internalBaseUrl(true, { NUXT_INTERNAL_URL: 'http://domo.lan:8080' })).toBe('http://domo.lan:8080')
  })

  it('still rewrites a loopback NUXT_INTERNAL_URL for a container', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']) {
      expect(internalBaseUrl(true, { NUXT_INTERNAL_URL: `http://${host}:3667` })).toBe('http://host.docker.internal:3667')
    }
  })
})
