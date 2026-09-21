import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureTestDatabase, unavailableError } from '../helpers/database'

/**
 * What the `agents-live` layer needs, checked once, before a single test
 * reports.
 *
 * Every missing thing is named in one message rather than one per run, because
 * this layer's preconditions are the awkward kind — an account, a daemon and a
 * database — and finding out about them one at a time is three round trips.
 * There is no skip and no opt-out; see test/CLAUDE.md.
 */

function dockerIsUp(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' })
    child.once('error', () => resolvePromise(false))
    child.once('close', code => resolvePromise(code === 0))
  })
}

/** Whether Codex has a login of its own to use — `codex login` writes this. */
async function hasCodexLogin(): Promise<boolean> {
  if (process.env.NUXT_CODEX_API_KEY || process.env.CODEX_API_KEY) return true
  if (process.env.NUXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY) return true
  const dir = process.env.NUXT_CODEX_CONFIG_DIR
    || (process.env.HOME ? join(process.env.HOME, '.codex') : null)
  if (!dir) return false
  return access(join(dir, 'auth.json')).then(() => true, () => false)
}

export async function setup(): Promise<void> {
  const missing: string[] = []

  if (!await ensureTestDatabase()) missing.push(unavailableError().message)
  if (!await dockerIsUp()) {
    missing.push('Docker is not answering. Start Docker Desktop (or your daemon) and try again.')
  }
  // The one credential with no fallback: a host login is never copied into an
  // environment, so inside a container this token is the only way Claude Code
  // can authenticate. See README, "Claude authentication".
  if (!process.env.NUXT_CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    missing.push(
      'NUXT_CLAUDE_CODE_OAUTH_TOKEN is not set. Run `claude setup-token` and put it in .env — '
      + 'a host login is deliberately never copied into an environment, so nothing else authenticates '
      + 'Claude Code inside one.'
    )
  }
  if (!await hasCodexLogin()) {
    missing.push(
      'No Codex login found. Run `codex login` (writes ~/.codex/auth.json), or set '
      + 'NUXT_CODEX_API_KEY / NUXT_OPENAI_API_KEY.'
    )
  }

  if (missing.length > 0) {
    throw new Error(
      `The agents-live layer did not run — it needs all of the following:\n - ${missing.join('\n - ')}`
    )
  }
}
