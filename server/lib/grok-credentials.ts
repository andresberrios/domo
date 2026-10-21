import { secret } from './secret-settings'

/**
 * What Grok Build signs in with.
 *
 * A **host** session uses the computer's own `grok login` (a grok.com
 * account: SuperGrok or X Premium), which Grok keeps in `~/.grok/auth.json`.
 * That login rotates its refresh token on every refresh, so it is never
 * copied anywhere: two holders would log each other out. A **container**
 * session gets the xAI API key saved in Settings instead, which does not
 * rotate. The key bills the xAI API per token, so on the host it is passed
 * only when there is no login (`adapterEnv`), even though Grok itself would
 * prefer the login: a login whose refresh fails for good is dropped, and
 * Grok would then move to the key without a word.
 *
 * Grok's model ids carry no provider prefix and every one is xAI's, so a
 * model id cannot land on a second account.
 */

/** The key saved in Settings (or set by the server's configuration), or null. */
export function xaiApiKey(): string | null {
  return secret('xaiApiKey')
}
