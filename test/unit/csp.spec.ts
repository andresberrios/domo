import { describe, expect, it } from 'vitest'

import { contentSecurityPolicy } from '../../server/lib/csp'

/**
 * The CSP is defence in depth for `MarkdownView`'s `v-html`, so what is worth
 * pinning down is not the exact string but the two properties that make it
 * worth having: `script-src` never learns to run inline script, and a hostile
 * `Host` header cannot write directives of its own.
 *
 * The rest — whether the app still renders under it — is a browser question and
 * is verified by loading the production build in Chromium; happy-dom does not
 * enforce CSP, so no test here can answer it.
 */

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((part) => {
      const [name, ...values] = part.split(' ')
      return [name!, values]
    })
  )
}

describe('contentSecurityPolicy', () => {
  const policy = contentSecurityPolicy('localhost:3000', 'AbC123==')
  const parsed = directives(policy)

  it('runs inline script only by nonce', () => {
    const script = parsed.get('script-src')!
    expect(script).toContain(`'nonce-AbC123=='`)
    expect(script).not.toContain(`'unsafe-inline'`)
    expect(script).not.toContain(`'unsafe-eval'`)
    // Allowing WebAssembly (Shiki's regex engine) must not drag `eval` in.
    expect(script).toContain(`'wasm-unsafe-eval'`)
  })

  it('reaches the voice WebSocket and nothing else off-origin', () => {
    expect(parsed.get('connect-src')).toEqual([
      `'self'`,
      'ws://localhost:3000',
      'wss://localhost:3000'
    ])
  })

  it('never lets a hostile Host header write a directive', () => {
    const hostile = contentSecurityPolicy(
      "evil.test; script-src 'unsafe-inline' https://evil.test",
      'n'
    )
    expect(hostile).not.toContain('evil.test')
    expect(directives(hostile).get('connect-src')).toEqual([`'self'`])
  })

  it('keeps the directives that have no cost here', () => {
    expect(parsed.get('object-src')).toEqual([`'none'`])
    expect(parsed.get('base-uri')).toEqual([`'self'`])
    expect(parsed.get('frame-ancestors')).toEqual([`'none'`])
    expect(parsed.get('form-action')).toEqual([`'self'`])
    expect(parsed.get('default-src')).toEqual([`'self'`])
  })

  it('does not let the worklet exception become a worker exception', () => {
    expect(parsed.get('script-src')).toContain('blob:')
    expect(parsed.get('worker-src')).toEqual([`'self'`])
  })

  it('allows no remote origin but https images', () => {
    const offOrigin = [...parsed]
      .filter(([name]) => name !== 'connect-src')
      .flatMap(([name, values]) => values.filter(v => v.includes(':') && !v.startsWith(`'`)).map(v => `${name} ${v}`))
    expect(offOrigin).toEqual(['script-src blob:', 'img-src data:', 'img-src https:'])
  })
})
