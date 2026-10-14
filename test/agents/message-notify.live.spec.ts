import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { events, fixtureRepo, startMeshServer, type MeshHarness } from './helpers'

/**
 * One real agent messages another over the mesh and hears back when the turn
 * that handles the message ends, without asking to. Host sessions only: what
 * is under test is the mesh and the runtime, not a container.
 */

let mesh: MeshHarness
let cwd = ''
const sessions: string[] = []

beforeAll(async () => {
  mesh = await startMeshServer()
  process.env.NUXT_INTERNAL_URL = `http://127.0.0.1:${mesh.port}`
  cwd = await fixtureRepo()
  const { startSubscriptionNotifier } = await import('../../server/lib/acp/subscriptions')
  await startSubscriptionNotifier()
})

afterAll(async () => {
  const { acpManager } = await import('../../server/lib/acp/manager')
  const { stopSubscriptionNotifier } = await import('../../server/lib/acp/subscriptions')
  stopSubscriptionNotifier()
  for (const id of sessions) {
    await acpManager.cancel(id).catch(() => {})
    acpManager.stop(id)
  }
  await mesh?.close()
  if (cwd) await rm(dirname(cwd), { recursive: true, force: true })
  delete process.env.NUXT_INTERNAL_URL
})

async function start(title: string) {
  const { acpManager } = await import('../../server/lib/acp/manager')
  const session = await acpManager.create({ adapter: 'claude-code', title, cwd, model: 'haiku' })
  sessions.push(session.id)
  expect(session.status, `${title} failed to start: ${session.lastError}`).not.toBe('error')
  return session
}

/** Allow whatever is asked, so a tool call never waits on a human. */
function allowEverything(agentSessionIds: string[]) {
  let running = true
  const loop = (async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { listPermissions } = await import('../../server/lib/repo')
    while (running) {
      for (const id of agentSessionIds) {
        for (const pending of await listPermissions(id).catch(() => [])) {
          const allow = pending.options.find(option => option.kind === 'allow_once') ?? pending.options[0]
          if (allow) await acpManager.answerPermission(id, pending.id, allow.optionId, 'user')
        }
      }
      await new Promise(wait => setTimeout(wait, 250))
    }
  })()
  return async () => {
    running = false
    await loop
  }
}

describe('message_agent', () => {
  it('tells the sender when the turn its message started ends', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const coordinator = await start('Coordinator')
    const worker = await start('Worker')
    const stop = allowEverything([coordinator.id, worker.id])

    await acpManager.prompt(coordinator.id, [{
      type: 'text',
      text: `Call the message_agent tool from the domo MCP server with agentId "${worker.id}" and the message `
        + '"Reply with exactly the word PONG and nothing else." Pass no other arguments. Then end your turn '
        + 'saying only "sent".'
    }])

    // The worker answers the message, and Domo tells the coordinator, which
    // takes the note as a turn of its own.
    await vi.waitFor(async () => {
      const notes = (await events(coordinator.id)).filter(event =>
        event.type === 'user_message' && event.payload?.origin === 'system')
      expect(notes).toHaveLength(1)
    }, { timeout: 180_000, interval: 1000 })
    await stop()

    const prompted = (await events(worker.id)).filter(event => event.type === 'user_message')
    expect(prompted).toHaveLength(1)
    expect(prompted[0]!.payload.origin).toBe(`agent:${coordinator.id}`)
    expect(prompted[0]!.payload.messageIds).toHaveLength(1)
    const note = (await events(coordinator.id)).find(event =>
      event.type === 'user_message' && event.payload?.origin === 'system')!
    const text = note.payload.content.map((block: any) => block.text ?? '').join('')
    expect(text).toContain(`Agent Worker (${worker.id}) finished its turn (end_turn).`)
    expect(text).toContain('PONG')
  }, 300_000)
})
