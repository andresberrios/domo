import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { createLocalModelsHost, type FromWorker, type LocalModelRequest, type LocalModelsHost } from '../../server/lib/agent-voice/local-models-host'

/**
 * The local models' process from its holder's side, with a stand-in worker:
 * what matters here is that a request always ends, and that a dead worker is
 * started again. The real models are exercised by hand (`docs/voice.md`).
 */

const dir = mkdtempSync(join(tmpdir(), 'domo-local-models-'))
const worker = join(dir, 'worker.mjs')
writeFileSync(worker, `
process.on('disconnect', () => process.exit(0))
process.on('message', (message) => {
  if (message.kind !== 'request') return
  const { id, request } = message
  if (request.op === 'sentences' && request.text === 'crash') process.exit(3)
  if (request.op === 'sentences' && request.text === 'hang') return
  const samples = request.samples
  process.send({ kind: 'result', id, value: { pid: process.pid, modelsDir: process.argv[2], typed: samples instanceof Int16Array, length: samples?.length } })
})
`)

let host: LocalModelsHost | null = null
afterEach(() => host?.stop())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function ask(request: LocalModelRequest, id = Math.random().toString(36)): Promise<FromWorker> {
  return new Promise((resolve) => {
    host!.listen((message) => {
      if (message.id === id) resolve(message)
    })
    host!.post({ kind: 'request', id, request })
  })
}

describe('createLocalModelsHost', () => {
  it('starts the worker on the first request, with the models directory, and passes typed arrays as they are', async () => {
    host = createLocalModelsHost(() => ({ path: worker, execArgv: [], modelsDir: '/models' }))
    const answer = await ask({ op: 'turn', samples: new Int16Array([1, 2, 3]) })
    expect(answer).toMatchObject({ kind: 'result', value: { modelsDir: '/models', typed: true, length: 3 } })
  })

  it('fails what a dead worker had not answered, and starts another for the next request', async () => {
    host = createLocalModelsHost(() => ({ path: worker, execArgv: [], modelsDir: '/models' }))
    const first = await ask({ op: 'sentences', text: 'hello' })
    const hanging = ask({ op: 'sentences', text: 'hang' })
    const crash = await ask({ op: 'sentences', text: 'crash' })
    expect(crash).toEqual({ kind: 'error', id: expect.any(String), message: 'the local models stopped (exit 3)' })
    expect(await hanging).toMatchObject({ kind: 'error', message: 'the local models stopped (exit 3)' })
    const next = await ask({ op: 'sentences', text: 'hello' })
    expect(next.kind).toBe('result')
    expect((next as any).value.pid).not.toBe((first as any).value.pid)
  })

  it('fails a request when the worker cannot start', async () => {
    host = createLocalModelsHost(() => ({ path: join(dir, 'missing.mjs'), execArgv: [], modelsDir: '/models' }))
    const answer = await ask({ op: 'sentences', text: 'hello' })
    expect(answer).toMatchObject({ kind: 'error', message: expect.stringContaining('the local models stopped') })
  })
})
