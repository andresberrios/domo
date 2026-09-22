import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { adapterEnv } from '../acp/adapter-process'
import { codexLimits, type UsageLimitValue } from './normalize'
import { describeError } from './claude'

/**
 * Codex plan limits, read the way codex-acp reads them.
 *
 * The ACP adapter does not expose them: it spawns the bundled Codex CLI as
 * `codex app-server` — a JSON-RPC server over stdio — calls
 * `account/rateLimits/read`, and renders the answer as text in its `/status`
 * output. Domo makes the same call directly rather than scraping that text,
 * because the text is lossy and the structure is right there.
 *
 * The handshake, the framing and the method name were all read out of
 * `@agentclientprotocol/codex-acp/dist/index.js` (`startCodexConnection`,
 * `createJSONRPCReader`, `accountRateLimitsRead`) rather than guessed at. Two
 * details matter: the transport is **newline-delimited JSON**, not
 * `Content-Length`-framed LSP framing, and `initialize` has to come first or
 * the server answers nothing.
 */

/** Long enough for a cold binary, short enough not to stall the poller. */
const TIMEOUT_MS = 15_000

export interface CodexUsageResult {
  outcome: 'ok' | 'unconfigured' | 'error'
  limits: UsageLimitValue[]
  message: string | null
}

/**
 * The bundled Codex CLI's entry point.
 *
 * Resolved from the working directory first and `import.meta.url` second, for
 * the same reason `adapterEntry()` is: the production bundle runs from a
 * virtual module path where `import.meta.url` resolution finds nothing.
 */
export function codexEntry(): string {
  const override = process.env.NUXT_CODEX_ENTRY
  if (override) return override
  const resolvers = [
    () => createRequire(pathToFileURL(join(process.cwd(), 'package.json')).href)
      .resolve('@openai/codex/bin/codex.js'),
    () => createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
  ]
  for (const resolve of resolvers) {
    try {
      return resolve()
    } catch {
      /* try the next strategy */
    }
  }
  throw new Error(
    'Could not find @openai/codex. Run `pnpm install` in the Domo directory, '
    + 'or point NUXT_CODEX_ENTRY at the Codex CLI entry file.'
  )
}

export type CodexSpawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv })
=> ChildProcessWithoutNullStreams

/**
 * One short-lived `codex app-server`, asked one question.
 *
 * Deliberately not a resident process. At one poll every few minutes the spawn
 * is cheap, and a long-lived child would be one more thing to supervise, keep
 * alive across a Nitro reload and shut down on `close` — for a number that
 * moves on the scale of hours.
 *
 * The environment is the same scrubbed allow-list every adapter gets
 * (`adapterEnv`), so the Codex login this reads is exactly the one Domo's own
 * Codex sessions run on, and nothing about the host leaks in beside it.
 */
export async function fetchCodexUsage(
  doSpawn: CodexSpawn = spawn as unknown as CodexSpawn,
  entry: () => string = codexEntry
): Promise<CodexUsageResult> {
  let child: ChildProcessWithoutNullStreams
  try {
    const env = await adapterEnv('codex', false)
    child = doSpawn(process.execPath, [entry(), 'app-server'], { env })
  } catch (error) {
    return { outcome: 'error', limits: [], message: describeError(error) }
  }

  let settled = false
  let nextId = 1
  const pending = new Map<number, (result: { result?: any, error?: any }) => void>()
  let stderr = ''

  const done = new Promise<CodexUsageResult>((resolve) => {
    const finish = (result: CodexUsageResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // SIGTERM, then let it go: the process has answered everything we asked.
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      resolve(result)
    }

    const timer = setTimeout(() => finish({
      outcome: 'error',
      limits: [],
      message: `\`codex app-server\` did not answer within ${TIMEOUT_MS / 1000}s.`
    }), TIMEOUT_MS)
    timer.unref?.()

    child.on('error', error => finish({ outcome: 'error', limits: [], message: describeError(error) }))
    child.on('exit', (code) => {
      // Exiting before an answer is how "not installed" and "not logged in"
      // both present, so whatever it said on stderr is the useful part.
      const detail = stderr.trim().split('\n').filter(Boolean).at(-1)
      finish({
        outcome: 'error',
        limits: [],
        message: detail || `\`codex app-server\` exited with code ${code} before answering.`
      })
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })

    // Newline-delimited JSON, exactly as codex-acp's own reader expects it.
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        // Notifications (`account/rateLimits/updated` among them) have no id.
        if (typeof message?.id !== 'number') continue
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    })

    const request = (method: string, params: unknown) => new Promise<any>((resolveRequest, rejectRequest) => {
      const id = nextId++
      pending.set(id, (message) => {
        if (message.error) rejectRequest(new Error(message.error?.message ?? `\`${method}\` failed`))
        else resolveRequest(message.result)
      })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })

    void (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' },
          capabilities: null
        })
        const response = await request('account/rateLimits/read', undefined)
        const limits = codexLimits(response)
        // A logged-out Codex answers the call with nothing to report rather
        // than failing it, and an account with no plan limits is not an error.
        if (!limits.length) {
          finish({
            outcome: 'unconfigured',
            limits: [],
            message: 'Codex reported no plan limits. Log in with `codex login` to see them.'
          })
          return
        }
        finish({ outcome: 'ok', limits, message: null })
      } catch (error) {
        finish({ outcome: 'error', limits: [], message: describeError(error) })
      }
    })()
  })

  return done
}
