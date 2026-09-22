import { usagePoller } from '../../lib/usage/poller'
import type { UsageProviderId } from '../../../shared/types'

const PROVIDERS: UsageProviderId[] = ['claude', 'codex', 'opencode']

/**
 * Ask the poller to look again, now.
 *
 * Answers as soon as the request is placed rather than when it lands: the
 * numbers arrive in the browser through Electric like everything else, so
 * waiting here would only make the button feel slower than the data.
 *
 * The one-a-minute floor and any `Retry-After` the provider asked for still
 * apply — pressing the button harder cannot make Anthropic answer sooner.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  const asked = typeof body?.provider === 'string' ? body.provider : null
  const providers = asked && PROVIDERS.includes(asked as UsageProviderId)
    ? [asked as UsageProviderId]
    : PROVIDERS

  for (const provider of providers) {
    void usagePoller.request(provider, { force: true })
      .catch(error => console.error(`[usage] refresh failed for ${provider}`, error))
  }
  return { requested: providers }
})
