type NavigatorLike = Pick<Navigator, 'userAgent'> & { userAgentData?: { platform?: string } }

/** Android, from the client hints where the browser has them, else from the user agent. */
export function isAndroid(nav: NavigatorLike = navigator): boolean {
  const platform = nav.userAgentData?.platform
  if (platform) return platform === 'Android'
  return /Android/i.test(nav.userAgent)
}

/**
 * The echo cancellation the microphone asks for.
 *
 * Desktop: `true`, as call apps do. Chrome's own canceller subtracts all the
 * tab plays, the agent's voice included. `"all"` adds only the device's own
 * voices, through a system loopback that delays the microphone by ~170 ms
 * and, in some Chromium browsers (Dia), leaves it sending only zeros.
 *
 * Android: `"all"` (Chrome 141+; older browsers read it as `true`). Both pick
 * the phone's own canceller there, and `"all"` is what was tested on phones.
 */
export function micEchoCancellation(nav: NavigatorLike = navigator): boolean {
  return isAndroid(nav) ? ('all' as unknown as boolean) : true
}
