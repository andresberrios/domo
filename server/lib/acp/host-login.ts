import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { adapterEnv, adapterLaunch } from './adapter-process'
import type { AgentAdapter } from '../../../shared/types'

const LOGIN_TTL_MS = 5 * 60_000
const LOGIN_TIMEOUT_MS = 20_000
const cache = new Map<AgentAdapter, { at: number, value: boolean }>()
const asking = new Map<AgentAdapter, Promise<boolean>>()

/** How an adapter says, once initialized, whether it has a login of its own. */
type LoginCheck = (initialized: any, newSession: () => Promise<boolean>) => Promise<boolean>

/**
 * A `session/new` answers "Authentication required" when there is no login.
 * It costs no request against the plan, and the empty session is closed again.
 */
const bySessionNew: LoginCheck = (_initialized, newSession) => newSession()

/**
 * Whether the adapter on this computer is signed in by itself (`copilot
 * login`, `grok login`): asked, with Domo's own credential taken out of the
 * environment (`strip`), because the login is in a credential store or file
 * Domo does not read.
 */
export async function hostLogin(adapter: AgentAdapter, strip: readonly string[], check: LoginCheck = bySessionNew): Promise<boolean> {
  // Asking starts the CLI, which takes seconds on a Mac, and the settings and
  // the setup guide wait on this: an answer that is old is given at once and
  // asked again behind it. Only the first ever waits, and the server asks
  // that at boot (`boot.ts`).
  const known = cache.get(adapter)
  if (known) {
    if (Date.now() - known.at >= LOGIN_TTL_MS) void askOnce(adapter, strip, check)
    return known.value
  }
  return askOnce(adapter, strip, check)
}

/** One ask at a time, however many readers want the answer. */
function askOnce(adapter: AgentAdapter, strip: readonly string[], check: LoginCheck): Promise<boolean> {
  let pending = asking.get(adapter)
  if (!pending) {
    pending = ask(adapter, strip, check).catch(() => false).then((value) => {
      cache.set(adapter, { at: Date.now(), value })
      return value
    }).finally(() => {
      asking.delete(adapter)
    })
    asking.set(adapter, pending)
  }
  return pending
}

async function ask(adapter: AgentAdapter, strip: readonly string[], check: LoginCheck): Promise<boolean> {
  const cwd = await mkdtemp(join(tmpdir(), `domo-${adapter}-`))
  const env = await adapterEnv(adapter, false, undefined, undefined, async () => true)
  for (const name of strip) Reflect.deleteProperty(env, name)
  const launch = adapterLaunch(adapter)
  const proc = spawn(launch.command, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const connection = acp.client({ name: 'domo' }).connect(acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    ))
    const answer = (async () => {
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' }
      } as any)
      return check(initialized, async () => {
        try {
          const created = await connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] } as any) as any
          await connection.agent.request('session/close', { sessionId: created.sessionId } as any).catch(() => {})
          return true
        } catch (error: any) {
          if (/auth/i.test(String(error?.message ?? error))) return false
          throw error
        }
      })
    })()
    const gone = new Promise<never>((_, reject) => {
      proc.once('exit', code => reject(new Error(`${adapter} exited (code ${code})`)))
      timer = setTimeout(() => reject(new Error(`${adapter} did not answer`)), LOGIN_TIMEOUT_MS)
    })
    return await Promise.race([answer, gone])
  } finally {
    if (timer) clearTimeout(timer)
    proc.kill('SIGTERM')
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Whether Grok on this computer is signed in by itself, through `grok login`.
 * Not by `session/new`, which a model of the user's own in `config.toml`
 * (with its own key) lets through with no login at all: Grok names the
 * login it would use in `initialize`, and `cached_token` is the stored
 * grok.com (or company sign-in) session.
 */
export function grokHostLogin(): Promise<boolean> {
  return hostLogin('grok', ['XAI_API_KEY'], async initialized => initialized?._meta?.defaultAuthMethodId === 'cached_token')
}
