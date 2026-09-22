import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchCodexUsage } from '../../server/lib/usage/codex'
import { PASSTHROUGH_ENV_FOR_TEST } from '../../server/lib/acp/adapter-process'

/**
 * What Domo hands the operating system to read Codex's plan limits.
 *
 * The exchange itself is covered against a fake JSON-RPC server in
 * `test/server/codex-usage.spec.ts`; what matters here is the process boundary,
 * which needs no Codex and no login: an argument array rather than an
 * interpolated shell string, and the same scrubbed allow-list environment every
 * ACP adapter gets. Inheriting this process's environment would hand the nested
 * Codex whatever `CLAUDE_*` / `CLAUDECODE` variables Domo was started with.
 */

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  kill() {
    this.killed = true
    return true
  }
}

afterEach(() => vi.restoreAllMocks())

describe('spawning `codex app-server`', () => {
  it('passes an argument array, never a shell string', async () => {
    const calls: Array<{ command: string, args: string[], env: NodeJS.ProcessEnv }> = []
    const child = new FakeChild()

    const result = fetchCodexUsage(
      ((command, args, options) => {
        calls.push({ command, args, env: options.env })
        // Answer nothing: the exchange is not what is under test.
        queueMicrotask(() => child.emit('exit', 1, null))
        return child as any
      }),
      () => '/opt/codex/bin/codex.js'
    )
    await result

    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe(process.execPath)
    expect(calls[0]!.args).toEqual(['/opt/codex/bin/codex.js', 'app-server'])
    // Not one string with spaces in it, which is how a path with a space in it
    // silently becomes two arguments.
    expect(calls[0]!.args.every(arg => typeof arg === 'string')).toBe(true)
  })

  it('hands it the scrubbed allow-list environment, not this process one', async () => {
    process.env.DOMO_SHOULD_NOT_LEAK = 'x'
    const child = new FakeChild()
    let env: NodeJS.ProcessEnv = {}

    await fetchCodexUsage(
      ((_command, _args, options) => {
        env = options.env
        queueMicrotask(() => child.emit('exit', 1, null))
        return child as any
      }),
      () => '/opt/codex/bin/codex.js'
    )
    delete process.env.DOMO_SHOULD_NOT_LEAK

    expect(env.DOMO_SHOULD_NOT_LEAK).toBeUndefined()
    expect(Object.keys(env).every(key => PASSTHROUGH_ENV_FOR_TEST.includes(key)
      || ['CODEX_API_KEY', 'OPENAI_API_KEY', 'DEFAULT_AUTH_REQUEST'].includes(key))).toBe(true)
  })

  it('reports why, rather than throwing, when the process dies before answering', async () => {
    const child = new FakeChild()

    const result = await fetchCodexUsage(
      (() => {
        queueMicrotask(() => {
          child.stderr.write('Missing optional dependency @openai/codex-linux-arm64\n')
          queueMicrotask(() => child.emit('exit', 1, null))
        })
        return child as any
      }),
      () => '/opt/codex/bin/codex.js'
    )

    expect(result.outcome).toBe('error')
    expect(result.message).toContain('Missing optional dependency')
  })

  it('reports why, rather than throwing, when Codex is not installed at all', async () => {
    const result = await fetchCodexUsage(
      (() => { throw new Error('spawn ENOENT') }),
      () => { throw new Error('Could not find @openai/codex.') }
    )

    expect(result).toMatchObject({ outcome: 'error' })
    expect(result.message).toContain('Could not find @openai/codex')
  })
})
