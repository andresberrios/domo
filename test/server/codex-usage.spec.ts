import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchCodexUsage } from '../../server/lib/usage/codex'

/**
 * The `codex app-server` exchange, against a fake server on a pair of pipes.
 *
 * Same technique as `acp-stream.spec.ts`: nothing below the process boundary is
 * mocked away, so the framing, the handshake order and the request ids are all
 * the real ones. They had to be — the transport is **newline-delimited JSON**
 * rather than the `Content-Length` framing the name "JSON-RPC over stdio"
 * usually implies, and `initialize` has to land before anything else or the
 * server answers nothing. Both were read out of codex-acp's own
 * `startCodexConnection` / `createJSONRPCReader`.
 *
 * The real Codex binary is deliberately never spawned: it needs a login, and a
 * test must never touch a real account.
 */

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  /** Every request the client sent, in order. */
  readonly seen: any[] = []

  constructor(private readonly reply: (request: any, server: FakeAppServer) => void) {
    super()
    let buffer = ''
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        const request = JSON.parse(line)
        this.seen.push(request)
        this.reply(request, this)
      }
    })
  }

  send(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  kill() {
    this.killed = true
    return true
  }
}

let server: FakeAppServer | null = null

function run(reply: (request: any, server: FakeAppServer) => void) {
  return fetchCodexUsage(
    (() => {
      server = new FakeAppServer(reply)
      return server as any
    }),
    () => '/opt/codex/bin/codex.js'
  )
}

afterEach(() => {
  server = null
  vi.useRealTimers()
})

describe('reading Codex plan limits', () => {
  it('initialises first, then asks, then stops the process', async () => {
    const result = await run((request, fake) => {
      if (request.method === 'initialize') {
        fake.send({ id: request.id, result: { codexHome: '/home/dev/.codex' } })
        return
      }
      if (request.method === 'account/rateLimits/read') {
        fake.send({
          id: request.id,
          result: {
            rateLimitsByLimitId: {
              plan: {
                limitId: 'plan',
                limitName: 'Plus',
                primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_790_000_000 },
                secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1_790_600_000 },
                credits: { unlimited: false, balance: 1250 }
              }
            }
          }
        })
      }
    })

    expect(server!.seen.map(request => request.method))
      .toEqual(['initialize', 'account/rateLimits/read'])
    expect(server!.seen[0]!.params.clientInfo).toMatchObject({ name: 'domo' })
    expect(result.outcome).toBe('ok')
    expect(result.limits.map(limit => limit.limitId))
      .toEqual(['plan:primary', 'plan:secondary', 'plan:credits'])
    expect(result.limits[0]).toMatchObject({
      label: 'Plus · 5h limit',
      usedPercent: 42,
      resetsAt: new Date(1_790_000_000_000).toISOString(),
      source: 'app-server'
    })
    // Short-lived by design: nothing is kept resident for a number that moves
    // on the scale of hours.
    expect(server!.killed).toBe(true)
  })

  it('ignores the notifications it is not waiting for', async () => {
    // `account/rateLimits/updated` and friends arrive unprompted and have no id.
    const result = await run((request, fake) => {
      if (request.method === 'initialize') {
        fake.send({ method: 'account/updated', params: {} })
        fake.send({ id: request.id, result: {} })
        return
      }
      fake.send({ method: 'account/rateLimits/updated', params: { rateLimits: {} } })
      fake.send({
        id: request.id,
        result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 60, resetsAt: null } } }
      })
    })

    expect(result.outcome).toBe('ok')
    expect(result.limits).toEqual([expect.objectContaining({ limitId: 'codex:primary' })])
  })

  it('calls an answer with no limits "not configured", not an error', async () => {
    // A logged-out Codex answers the call rather than failing it.
    const result = await run((request, fake) => {
      fake.send({ id: request.id, result: request.method === 'initialize' ? {} : { rateLimits: null } })
    })

    expect(result.outcome).toBe('unconfigured')
    expect(result.message).toContain('codex login')
  })

  it('reports a JSON-RPC error rather than throwing into the poller', async () => {
    const result = await run((request, fake) => {
      if (request.method === 'initialize') {
        fake.send({ id: request.id, result: {} })
        return
      }
      fake.send({ id: request.id, error: { code: -32601, message: 'Method not found' } })
    })

    expect(result).toMatchObject({ outcome: 'error', message: 'Method not found' })
    expect(server!.killed).toBe(true)
  })

  it('gives up on a server that never answers, and kills it', async () => {
    vi.useFakeTimers()
    // Answers `initialize` and then goes quiet — the hang that a resident
    // process would leave the poller stuck behind forever.
    const pending = run((request, fake) => {
      if (request.method === 'initialize') fake.send({ id: request.id, result: {} })
    })

    await vi.advanceTimersByTimeAsync(16_000)
    const result = await pending

    expect(result.outcome).toBe('error')
    expect(result.message).toContain('did not answer within 15s')
    expect(server!.killed).toBe(true)
  })

  it('survives a line of noise on stdout', async () => {
    const result = await run((request, fake) => {
      if (request.method === 'initialize') {
        fake.stdout.write('not json at all\n')
        fake.send({ id: request.id, result: {} })
        return
      }
      fake.send({
        id: request.id,
        result: { rateLimits: { limitId: 'plan', primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: null } } }
      })
    })

    expect(result.outcome).toBe('ok')
  })
})
