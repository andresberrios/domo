import { describe, expect, it } from 'vitest'

import { isAndroid, micEchoCancellation } from '../../app/utils/echoCancellation'

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** The voice bar's microphone: the ordinary canceller on desktop, "all" kept on Android. */
describe('micEchoCancellation', () => {
  it('asks for "all" on Android, from the client hints or the user agent', () => {
    expect(micEchoCancellation({ userAgent: ANDROID_UA, userAgentData: { platform: 'Android' } })).toBe('all')
    expect(micEchoCancellation({ userAgent: ANDROID_UA })).toBe('all')
  })

  it('asks for true on desktop and iOS', () => {
    expect(micEchoCancellation({ userAgent: MAC_UA, userAgentData: { platform: 'macOS' } })).toBe(true)
    expect(micEchoCancellation({ userAgent: MAC_UA })).toBe(true)
    expect(micEchoCancellation({ userAgent: IPHONE_UA })).toBe(true)
  })

  it('trusts the client hints over the user agent', () => {
    expect(isAndroid({ userAgent: MAC_UA, userAgentData: { platform: 'Android' } })).toBe(true)
    expect(isAndroid({ userAgent: ANDROID_UA, userAgentData: { platform: 'Windows' } })).toBe(false)
  })

  it('falls back to the user agent when the hints have no platform', () => {
    expect(isAndroid({ userAgent: ANDROID_UA, userAgentData: { platform: '' } })).toBe(true)
  })
})
