import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'

/** The Keychain item Claude Code keeps its login in on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** The file Claude Code itself reads on a non-macOS host. */
export function homeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.NUXT_CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, '.claude') : null)
  return home ? join(home, '.credentials.json') : null
}

/**
 * Whether the Keychain holds a Claude Code login, asked without reading it.
 *
 * `find-generic-password` without `-w` prints the item's attributes and not its
 * payload, which is both all Domo needs and the difference between a silent
 * check and a Keychain prompt.
 */
function keychainHasLogin(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', userInfo().username
    ], { stdio: 'ignore' })
    child.once('error', () => resolvePromise(false))
    child.once('close', code => resolvePromise(code === 0))
  })
}

/**
 * Whether Claude Code on *this host* can log in without an API key.
 *
 * `ANTHROPIC_API_KEY` outranks every OAuth path inside Claude Code, and in
 * non-interactive mode it is used with no approval prompt, so passing it
 * alongside a subscription login silently moves the work onto API billing.
 * Domo therefore asks first and passes the key only when there is nothing else.
 *
 * Host sessions only. A container has no Keychain and no copied login — nothing
 * is ever copied into one, because Anthropic rotates the refresh token on every
 * refresh and a second copy of the chain logs the first one out.
 */
export async function hasClaudeSubscriptionLogin(): Promise<boolean> {
  if (process.platform === 'darwin' && await keychainHasLogin()) return true
  const path = homeCredentialsPath()
  if (!path) return false
  return access(path).then(() => true, () => false)
}
