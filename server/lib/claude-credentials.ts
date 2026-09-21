import { spawn } from 'node:child_process'
import { access, chmod, mkdir, open } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'

import { dataDir } from './paths'

/** The Keychain item Claude Code keeps its login in on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Where Claude Code keeps the same JSON on Linux, and where a container reads it. */
export const CREDENTIALS_FILENAME = '.credentials.json'

let warned = false

/** Said once: a login that cannot be synced is a steady-state condition, not an event. */
function warnOnce(reason: string): null {
  if (!warned) {
    warned = true
    console.warn(
      `[claude] could not sync Claude Code credentials into development environments: ${reason}. `
      + 'Sessions in an environment will fall back to CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. '
      + 'Run `claude setup-token` and set NUXT_CLAUDE_CODE_OAUTH_TOKEN to avoid this.'
    )
  }
  return null
}

/** The file Claude Code itself reads on a non-macOS host. */
export function homeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.NUXT_CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, '.claude') : null)
  return home ? join(home, CREDENTIALS_FILENAME) : null
}

/**
 * Read the Keychain item, without a shell and without ever putting the secret
 * anywhere but this function's own string. The first call prompts macOS to let
 * the node binary read the item; allowing it once is enough.
 */
function readKeychain(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', userInfo().username, '-w'
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.resume()
    child.once('error', () => resolvePromise(null))
    child.once('close', code => resolvePromise(code === 0 ? stdout.trim() : null))
  })
}

/** Where the synced copy lives. A fixed path, because it is a bind-mount source. */
export function syncedCredentialsPath(): string {
  return join(dataDir(), 'claude', CREDENTIALS_FILENAME)
}

/**
 * Make the host's Claude Code login readable by an agent in a container, and say
 * where it is.
 *
 * On macOS the login is in the Keychain (`Claude Code-credentials`), not in
 * `~/.claude/.credentials.json`, so the directory Domo bind-mounts into an
 * environment has nothing to authenticate with. The Keychain item's payload is
 * the same JSON Linux stores in that file, so writing it out is all it takes.
 *
 * The file is rewritten **in place** (truncate, not rename): its path is a bind
 * mount source, and replacing the inode would leave the container looking at the
 * old, unlinked file forever.
 */
export async function syncClaudeCredentials(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    const path = homeCredentialsPath()
    if (!path) return null
    return access(path).then(() => path, () => null)
  }

  const secret = await readKeychain()
  if (!secret) return warnOnce(`no \`${KEYCHAIN_SERVICE}\` item in the login keychain`)

  let payload: string
  try {
    const parsed = JSON.parse(secret) as { claudeAiOauth?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.claudeAiOauth) {
      return warnOnce('the keychain item is not Claude Code OAuth credentials')
    }
    payload = JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth })
  } catch {
    return warnOnce('the keychain item is not valid JSON')
  }

  try {
    return await writeSyncedCredentials(payload)
  } catch (error) {
    return warnOnce(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Put the credentials JSON where the container's bind mount points, privately.
 *
 * Rewritten **in place** (truncate, not rename): the path is a mount source, and
 * a new inode would leave the container looking at the old, unlinked file.
 *
 * Only `claudeAiOauth` is ever passed in. The Keychain item also holds
 * `mcpOAuth` — every access token Claude Code has obtained for a third-party MCP
 * server (Figma, Linear, …) — and this file is mounted into a container an agent
 * has a shell in. Domo hands environment sessions the MCP servers it is
 * configured with; it has no business handing them those.
 */
export async function writeSyncedCredentials(payload: string): Promise<string> {
  const directory = join(dataDir(), 'claude')
  const path = syncedCredentialsPath()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const handle = await open(path, 'w', 0o600)
  try {
    await handle.writeFile(payload, 'utf8')
  } finally {
    await handle.close()
  }
  // `open` only applies its mode when it *creates* the file, and the directory
  // may predate a change of ours; neither is worth leaving world-readable.
  await chmod(path, 0o600)
  await chmod(directory, 0o700)
  return path
}

/**
 * Whether Claude Code on *this host* can log in without an API key.
 *
 * An `ANTHROPIC_API_KEY` in the environment wins inside Claude Code and bills
 * the API instead of the subscription, so it must not be passed when a
 * subscription login exists. On macOS that login is the Keychain item, which
 * Claude Code reads for itself — its presence is all Domo needs to know.
 */
export async function hasClaudeSubscriptionLogin(): Promise<boolean> {
  if (process.platform === 'darwin') return (await readKeychain()) !== null
  const path = homeCredentialsPath()
  if (!path) return false
  return access(path).then(() => true, () => false)
}
