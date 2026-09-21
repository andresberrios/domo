import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The model probe: a throwaway adapter session asked what it could run on.
 *
 * `spawn` is replaced by a pair of pipes with the SDK's own *agent* side on the
 * far end, the same trick `acp-stream.spec.ts` uses — so everything above the
 * process boundary is real, including the ACP round trip.
 */

const state = vi.hoisted(() => ({ adapters: [] as FakeAdapter[], spawns: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: (_command: string, args: string[]) => {
      state.spawns += 1
      // The catalog probes both adapters concurrently, so which one this is has
      // to come from the argv; the order they spawn in is a race.
      const adapter = new FakeAdapter(String(args?.[0] ?? '').includes('codex') ? 'codex' : 'claude-code')
      state.adapters.push(adapter)
      return adapter
    }
  }
})

class FakeAdapter extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  killed = false
  served = false

  constructor(readonly which: 'claude-code' | 'codex' = 'claude-code') {
    super()
  }

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }

  stream() {
    return acp.ndJsonStream(
      Writable.toWeb(this.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(this.stdin) as ReadableStream<Uint8Array>
    )
  }
}

/** An adapter that answers `session/new` with the given model selector. */
function serve(adapter: FakeAdapter, models: { current: string, ids: string[] } | null) {
  return acp
    .agent({ name: 'fake' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false }
    }))
    .onRequest(acp.methods.agent.session.new, () => ({
      sessionId: 'acp_fake',
      ...(models
        ? {
            configOptions: [{
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select' as const,
              currentValue: models.current,
              options: models.ids.map(id => ({ value: id, name: id.toUpperCase() }))
            }]
          }
        : {})
    }))
    .connect(adapter.stream())
}

/**
 * Serve the *next* adapter the probe spawns. Counting from a baseline, not from
 * zero: a test that probes twice would otherwise re-serve the first one and the
 * second probe would wait for the full timeout.
 */
async function answerWith(models: { current: string, ids: string[] } | null) {
  const baseline = state.adapters.length
  await vi.waitFor(() => expect(state.adapters.length).toBeGreaterThan(baseline))
  serve(state.adapters[baseline]!, models)
}

type Answer = { current: string, ids: string[] } | null | 'fail'

/**
 * Answer each adapter as it appears, by *which adapter it is*.
 *
 * The catalog probes both concurrently, so there is no moment at which exactly
 * one exists to be served, and the order they spawn in is a race — waiting for
 * them one at a time deadlocks the second probe until its timeout.
 */
function autoServe(answers: Partial<Record<'claude-code' | 'codex', Answer>>): () => void {
  const timer = setInterval(() => {
    for (const adapter of state.adapters) {
      if (adapter.served || !(adapter.which in answers)) continue
      adapter.served = true
      const answer = answers[adapter.which]!
      if (answer === 'fail') {
        adapter.stderr.write('Not logged in\n')
        setTimeout(() => adapter.emit('exit', 1, null), 20)
      } else {
        serve(adapter, answer)
      }
    }
  }, 5)
  timer.unref?.()
  return () => clearInterval(timer)
}

beforeEach(async () => {
  state.adapters.length = 0
  state.spawns = 0
  const { clearAdapterModelCache } = await import('../../server/lib/acp/models')
  clearAdapterModelCache()
})

afterEach(() => {
  delete process.env.NUXT_ACP_MODEL_PROBE_MS
  vi.restoreAllMocks()
})

describe('listAdapterModels', () => {
  it('reports what the adapter offers and what it starts on', async () => {
    const { listAdapterModels } = await import('../../server/lib/acp/models')
    const probing = listAdapterModels('claude-code')
    await answerWith({ current: 'sonnet', ids: ['sonnet', 'haiku'] })

    await expect(probing).resolves.toEqual({
      models: [{ id: 'sonnet', name: 'SONNET' }, { id: 'haiku', name: 'HAIKU' }],
      current: 'sonnet'
    })
  })

  it('spawns once for two concurrent callers', async () => {
    const { listAdapterModels } = await import('../../server/lib/acp/models')
    const both = Promise.all([listAdapterModels('claude-code'), listAdapterModels('claude-code')])
    await answerWith({ current: 'sonnet', ids: ['sonnet'] })

    const [first, second] = await both
    expect(first).toEqual(second)
    expect(state.spawns).toBe(1)
  })

  it('answers a second call from the cache, without spawning again', async () => {
    const { listAdapterModels } = await import('../../server/lib/acp/models')
    const probing = listAdapterModels('codex')
    await answerWith({ current: 'gpt-5.6-terra', ids: ['gpt-5.6-terra', 'gpt-5.6-luna'] })
    await probing

    await expect(listAdapterModels('codex')).resolves.toMatchObject({ current: 'gpt-5.6-terra' })
    expect(state.spawns).toBe(1)
  })

  it('keeps the two adapters apart', async () => {
    const { listAdapterModels } = await import('../../server/lib/acp/models')
    const claude = listAdapterModels('claude-code')
    await answerWith({ current: 'sonnet', ids: ['sonnet'] })
    await claude
    const codex = listAdapterModels('codex')
    await answerWith({ current: 'gpt-5.5', ids: ['gpt-5.5'] })

    await expect(codex).resolves.toMatchObject({ current: 'gpt-5.5' })
    expect(state.spawns).toBe(2)
  })

  it('is an empty list for an adapter that offers no model selector', async () => {
    const { listAdapterModels } = await import('../../server/lib/acp/models')
    const probing = listAdapterModels('claude-code')
    await answerWith(null)

    await expect(probing).resolves.toEqual({ models: [], current: null })
  })

  it('gives up rather than hanging when the adapter never answers', async () => {
    process.env.NUXT_ACP_MODEL_PROBE_MS = '300'
    const { listAdapterModels } = await import('../../server/lib/acp/models')

    // Spawned, but nothing is ever served on the other end.
    await expect(listAdapterModels('claude-code')).rejects.toThrow(/did not answer within/)
  })

  it('reports the adapter\'s own stderr when it dies instead of answering', async () => {
    const { listAdapterModels } = await import('../../server/lib/acp/models')
    const probing = listAdapterModels('claude-code')
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    const adapter = state.adapters[0]!
    adapter.stderr.write('Not logged in · Please run /login\n')
    // Let the chunk land before the exit that reports it.
    await new Promise(wait => setTimeout(wait, 20))
    adapter.emit('exit', 1, null)

    await expect(probing).rejects.toThrow(/Not logged in/)
  })

  it('does not cache a failure', async () => {
    const { listAdapterModels } = await import('../../server/lib/acp/models')
    const failing = listAdapterModels('claude-code')
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    state.adapters[0]!.emit('exit', 1, null)
    await expect(failing).rejects.toThrow()

    const retry = listAdapterModels('claude-code')
    await answerWith({ current: 'haiku', ids: ['haiku'] })

    await expect(retry).resolves.toMatchObject({ current: 'haiku' })
    expect(state.spawns).toBe(2)
  })
})

describe('listAdapterCatalog', () => {
  it('names both harnesses and what each offers', async () => {
    const { listAdapterCatalog } = await import('../../server/lib/acp/models')
    const stop = autoServe({
      'claude-code': { current: 'sonnet', ids: ['sonnet', 'haiku'] },
      codex: { current: 'gpt-5.6-terra', ids: ['gpt-5.6-terra', 'gpt-5.6-luna'] }
    })
    const catalog = listAdapterCatalog().finally(stop)

    await expect(catalog).resolves.toEqual({
      adapters: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          models: [{ id: 'sonnet', name: 'SONNET' }, { id: 'haiku', name: 'HAIKU' }],
          default: 'sonnet'
        },
        {
          id: 'codex',
          name: 'Codex',
          models: [{ id: 'gpt-5.6-terra', name: 'GPT-5.6-TERRA' }, { id: 'gpt-5.6-luna', name: 'GPT-5.6-LUNA' }],
          default: 'gpt-5.6-terra'
        }
      ]
    })
  })

  it('asks only the harness it was filtered to', async () => {
    const { listAdapterCatalog } = await import('../../server/lib/acp/models')
    const stop = autoServe({ codex: { current: 'gpt-5.5', ids: ['gpt-5.5'] } })
    const catalog = listAdapterCatalog('codex').finally(stop)

    await expect(catalog).resolves.toMatchObject({ adapters: [{ id: 'codex', default: 'gpt-5.5' }] })
    expect(state.spawns).toBe(1)
  })

  it('puts one harness\'s failure on its own entry and still answers for the other', async () => {
    // Not being logged into Codex is no reason to withhold the Claude list.
    const { listAdapterCatalog } = await import('../../server/lib/acp/models')
    const stop = autoServe({ 'claude-code': { current: 'sonnet', ids: ['sonnet'] }, codex: 'fail' })

    const { adapters } = await listAdapterCatalog().finally(stop)

    expect(adapters[0]).toMatchObject({ id: 'claude-code', default: 'sonnet' })
    expect(adapters[1]!.id).toBe('codex')
    expect(adapters[1]!.models).toEqual([])
    expect(adapters[1]!.error).toMatch(/Not logged in/)
  })
})

