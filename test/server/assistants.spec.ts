import { beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import {
  appendAgentEvent,
  createAgentSession,
  createCronJob,
  enqueueInboxMessage,
  getAgentSession,
  getAssistant,
  listAgentEvents,
  listAssistantSessions,
  listInboxMessages,
  setAgentUsage
} from '../../server/lib/repo'
import {
  assistantSystemPrompt,
  currentSessionFor,
  primeFirstPrompt
} from '../../server/lib/assistants/context'
import {
  createAssistant,
  deliverToAssistant,
  recordHandoffNote,
  requestHandoff,
  startAssistants,
  updateAssistantFields
} from '../../server/lib/assistants'
import { deliverCronJob } from '../../server/lib/cron/scheduler'
import { handleMeshMcpRequest } from '../../server/lib/mesh/server'
import { mintMeshToken } from '../../server/lib/mesh/token'
import { ASSISTANT_CONTEXT_OPEN, HANDOFF_CONTINUE_PREFIX, HANDOFF_REQUEST_PREFIX } from '../../shared/assistants'
import { isDomoHandOff, type TurnEnd } from '../../server/lib/acp/manager'

/**
 * An assistant against the real Postgres. Only the ACP manager is faked: a
 * real one would start an adapter. Its `create` writes the row and the first
 * event exactly as the real one does, and the turn-end listener the assistants
 * register is captured so a test can end a turn.
 */
const acp = vi.hoisted(() => ({
  listeners: [] as Array<(turn: TurnEnd) => Promise<void>>,
  create: vi.fn(),
  deliver: vi.fn(async (id: string, input: any) => ({ delivery: input.delivery ?? 'steer', outcome: 'prompted', agentSessionId: id })),
  drainInbox: vi.fn(),
  stop: vi.fn(),
  isBusy: vi.fn(() => false),
  onTurnEnd: vi.fn((listener: any) => {
    acp.listeners.push(listener)
    return () => { acp.listeners = acp.listeners.filter(entry => entry !== listener) }
  })
}))

vi.mock('../../server/lib/acp/manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/lib/acp/manager')>()
  return { ...original, acpManager: acp }
})

async function endTurn(turn: Partial<TurnEnd> & { agentSessionId: string }) {
  for (const listener of acp.listeners) await listener({ content: [], ok: true, text: '', ...turn })
}

function textOf(content: any[]): string {
  return content.map(block => block.text ?? '').join('\n')
}

beforeEach(async () => {
  await query('truncate agent_sessions, assistants, projects cascade')
  acp.listeners = []
  acp.deliver.mockClear()
  acp.drainInbox.mockClear()
  acp.stop.mockClear()
  acp.create.mockReset().mockImplementation(async (input: any) => {
    const session = await createAgentSession({
      adapter: input.adapter,
      title: input.title,
      cwd: input.cwd ?? '/workspace',
      devEnvironmentId: input.devEnvironmentId ?? null,
      model: input.model ?? null,
      modeId: input.modeId ?? null,
      assistantId: input.assistantId ?? null
    })
    if (input.firstEvent) await appendAgentEvent(session.id, input.firstEvent.type, input.firstEvent.payload)
    return session
  })
  startAssistants()
})

const pirate = (patch: Record<string, unknown> = {}) => createAssistant({
  name: 'Pete',
  persona: 'Speak like a pirate.',
  adapter: 'opencode',
  cwd: '/tmp/domo-assistants',
  ...patch
})

/** Say something in the session, as a turn would record it. */
async function said(sessionId: string, human: string, reply: string) {
  await appendAgentEvent(sessionId, 'user_message', { content: [{ type: 'text', text: human }] })
  await appendAgentEvent(sessionId, 'agent_message', { text: reply, streaming: false })
}

describe('an assistant', () => {
  it('starts with a session of its own, named after it, on what it was set to', async () => {
    const assistant = await pirate({ model: 'opencode-go/glm-5.3-flash' })
    const [session] = await listAssistantSessions(assistant.id)
    expect(assistant.currentSessionId).toBe(session!.id)
    expect(session).toMatchObject({ title: 'Pete', adapter: 'opencode', assistantId: assistant.id, model: 'opencode-go/glm-5.3-flash' })
    expect(assistant.handoffThreshold).toBe(75)
  })

  it('refuses a picture that is not an image, and a threshold out of range', async () => {
    await expect(pirate({ avatar: 'data:text/html;base64,PHNjcmlwdD4=' })).rejects.toThrow('must be a PNG')
    await expect(pirate({ handoffThreshold: 5 })).rejects.toThrow('percentage')
  })

  it('puts its persona in the first prompt on a harness without a system prompt, and only the first', async () => {
    const assistant = await pirate()
    const session = (await getAgentSession(assistant.currentSessionId!))!
    const first = await primeFirstPrompt(session, [{ type: 'text', text: 'hello' }])
    expect(first).toHaveLength(2)
    expect(first[0].text.startsWith(ASSISTANT_CONTEXT_OPEN)).toBe(true)
    expect(first[0].text).toContain('Speak like a pirate.')
    expect(first[1]).toEqual({ type: 'text', text: 'hello' })
    expect(await assistantSystemPrompt(session)).toBeNull()

    await appendAgentEvent(session.id, 'user_message', { content: first })
    await expect(primeFirstPrompt(session, [{ type: 'text', text: 'again' }])).resolves.toEqual([{ type: 'text', text: 'again' }])
  })

  it('puts its persona in the system prompt on Claude Code, and leaves prompts alone', async () => {
    const assistant = await pirate({ adapter: 'claude-code' })
    const session = (await getAgentSession(assistant.currentSessionId!))!
    expect(await assistantSystemPrompt(session)).toContain('Speak like a pirate.')
    await expect(primeFirstPrompt(session, [{ type: 'text', text: 'hi' }])).resolves.toEqual([{ type: 'text', text: 'hi' }])
  })

  it('takes a message in its current session, and one sent to an old session goes there too', async () => {
    const assistant = await pirate()
    const result = await deliverToAssistant(assistant.id, { content: [{ type: 'text', text: 'hi' }] })
    expect(result.agentSessionId).toBe(assistant.currentSessionId)
    await expect(currentSessionFor(assistant.currentSessionId!)).resolves.toBe(assistant.currentSessionId)
  })
})

describe('a handoff', () => {
  it('asks for a note, then starts the next session from it and carries over what was waiting', async () => {
    const assistant = await pirate()
    const first = assistant.currentSessionId!
    await said(first, 'My boat is the Salty Gull.', 'Aye, the Salty Gull.')

    await expect(requestHandoff(assistant.id, 'user')).resolves.toEqual({ started: true })
    const request = acp.deliver.mock.calls.at(-1)!
    expect(request[0]).toBe(first)
    expect(textOf(request[1].content).startsWith(HANDOFF_REQUEST_PREFIX)).toBe(true)
    expect(request[1]).toMatchObject({ delivery: 'queue', origin: 'system' })
    // A second ask while one is under way changes nothing.
    await expect(requestHandoff(assistant.id, 'user')).resolves.toMatchObject({ started: false })

    // Something arrives for the assistant while the note is being written.
    await enqueueInboxMessage({ agentSessionId: first, content: [{ type: 'text', text: 'and paint it blue' }], delivery: 'queue', origin: 'user' })
    const caller = (await getAgentSession(first))!
    await recordHandoffNote(caller, { note: 'The human owns the Salty Gull.' })
    await endTurn({ agentSessionId: first, content: request[1].content, text: 'Handing off.' })

    const after = (await getAssistant(assistant.id))!
    expect(after.currentSessionId).not.toBe(first)
    expect(after.handoff).toBeNull()
    const next = after.currentSessionId!
    const [handoff] = await listAgentEvents(next)
    expect(handoff).toMatchObject({
      type: 'handoff',
      payload: {
        note: 'The human owns the Salty Gull.',
        reason: 'user',
        fromSessionId: first,
        recent: [
          { role: 'human', text: 'My boat is the Salty Gull.' },
          { role: 'assistant', text: 'Aye, the Salty Gull.' }
        ]
      }
    })
    expect((await listAgentEvents(first)).at(-1)).toMatchObject({ type: 'handed_off', payload: { toSessionId: next } })
    await expect(listInboxMessages(next)).resolves.toMatchObject([{ content: [{ text: 'and paint it blue' }] }])
    expect(acp.drainInbox).toHaveBeenCalledWith(next)
    await vi.waitFor(() => expect(acp.stop).toHaveBeenCalledWith(first))

    // The next session reads the note before its first message, and the old one now forwards to it.
    const primed = await primeFirstPrompt((await getAgentSession(next))!, [{ type: 'text', text: 'what is my boat?' }])
    expect(primed[0].text).toContain('The human owns the Salty Gull.')
    expect(primed[0].text).toContain('Human: My boat is the Salty Gull.')
    await expect(currentSessionFor(first)).resolves.toBe(next)
  })

  it('takes the answer as the note when the agent could not call the tool', async () => {
    const assistant = await pirate()
    const first = assistant.currentSessionId!
    await said(first, 'hi', 'ahoy')
    await requestHandoff(assistant.id, 'user')
    const request = acp.deliver.mock.calls.at(-1)![1]
    await endTurn({ agentSessionId: first, content: request.content, text: 'NOTE: we said hello.' })
    const next = (await getAssistant(assistant.id))!.currentSessionId!
    expect((await listAgentEvents(next))[0]!.payload.note).toBe('NOTE: we said hello.')
  })

  it('waits for the request turn, not whatever turn was running when it was asked', async () => {
    const assistant = await pirate()
    const first = assistant.currentSessionId!
    await said(first, 'long job', 'working')
    await requestHandoff(assistant.id, 'user')
    await endTurn({ agentSessionId: first, content: [{ type: 'text', text: 'long job' }], text: 'done' })
    expect((await getAssistant(assistant.id))!).toMatchObject({ currentSessionId: first, handoff: { sessionId: first } })
  })

  it('is dropped when the request turn is cancelled before a note', async () => {
    const assistant = await pirate()
    const first = assistant.currentSessionId!
    await said(first, 'hi', 'ahoy')
    await requestHandoff(assistant.id, 'user')
    const request = acp.deliver.mock.calls.at(-1)![1]
    await endTurn({ agentSessionId: first, content: request.content, ok: false, text: '' })
    expect((await getAssistant(assistant.id))!).toMatchObject({ currentSessionId: first, handoff: null })
    expect((await listAgentEvents(first)).at(-1)).toMatchObject({ type: 'error' })
  })

  it('can be the agent\'s own idea, and go on working in the next session', async () => {
    const assistant = await pirate()
    const first = assistant.currentSessionId!
    await said(first, 'refactor it all', 'on it')
    await recordHandoffNote((await getAgentSession(first))!, { note: 'Halfway through.', nextPrompt: 'Finish the refactor.' })
    await endTurn({ agentSessionId: first, content: [{ type: 'text', text: 'refactor it all' }] })
    const next = (await getAssistant(assistant.id))!.currentSessionId!
    expect((await listAgentEvents(next))[0]!.payload.reason).toBe('agent')
    expect(acp.deliver).toHaveBeenCalledWith(next, {
      content: [{ type: 'text', text: `${HANDOFF_CONTINUE_PREFIX} Finish the refactor.` }],
      delivery: 'queue',
      origin: 'system'
    })
  })

  it('is asked for when a finished turn leaves the context past the threshold', async () => {
    const assistant = await pirate({ handoffThreshold: 60 })
    const first = assistant.currentSessionId!
    await said(first, 'hi', 'ahoy')
    await said(first, 'and?', 'aye')
    await said(first, 'more', 'arr')
    await setAgentUsage(first, { context: { used: 50_000, size: 100_000 }, updatedAt: new Date().toISOString() })
    await endTurn({ agentSessionId: first })
    expect(acp.deliver).not.toHaveBeenCalled()

    await setAgentUsage(first, { context: { used: 61_000, size: 100_000 }, updatedAt: new Date().toISOString() })
    await endTurn({ agentSessionId: first })
    expect((await getAssistant(assistant.id))!.handoff).toMatchObject({ reason: 'context', sessionId: first })
    expect(textOf(acp.deliver.mock.calls.at(-1)![1].content)).toContain('nearly full')
  })

  it('is never held up by a permission prompt for Domo\'s own tool', () => {
    expect(isDomoHandOff({ title: 'mcp__domo__hand_off', _meta: { claudeCode: { toolName: 'mcp__domo__hand_off' } } })).toBe(true)
    expect(isDomoHandOff({ title: 'mcp__other__hand_off' })).toBe(false)
    expect(isDomoHandOff({ title: 'mcp__domo__notify_supervisor' })).toBe(false)
    expect(isDomoHandOff({ title: 'Bash', rawInput: { command: 'echo mcp__domo__hand_off' } })).toBe(false)
  })

  it('is not asked for by the context of a session that has barely started', async () => {
    // Its system prompt alone can pass the threshold on a small window; a
    // handoff then would only start another session that does the same.
    const assistant = await pirate({ handoffThreshold: 30 })
    const first = assistant.currentSessionId!
    await said(first, 'hi', 'ahoy')
    await setAgentUsage(first, { context: { used: 40_000, size: 100_000 }, updatedAt: new Date().toISOString() })
    await endTurn({ agentSessionId: first })
    expect((await getAssistant(assistant.id))!.handoff).toBeNull()
    expect(acp.deliver).not.toHaveBeenCalled()
  })

  it('is refused to an ordinary session', async () => {
    const plain = await createAgentSession({ adapter: 'claude-code', title: 'plain', cwd: '/tmp' })
    await expect(recordHandoffNote(plain, { note: 'x' })).rejects.toThrow('only for sessions of an assistant')
  })

  it('does nothing in a session nobody has spoken in yet', async () => {
    const assistant = await pirate()
    await expect(requestHandoff(assistant.id, 'user')).resolves.toMatchObject({ started: false })
    expect(acp.deliver).not.toHaveBeenCalled()
  })
})

describe('an assistant\'s schedule', () => {
  it('fires into whichever session is current', async () => {
    const assistant = await pirate()
    const job = await createCronJob({
      agentSessionId: null,
      assistantId: assistant.id,
      name: 'Inbox',
      prompt: 'Sort the inbox.',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      runAt: null,
      enabled: true,
      delivery: 'queue',
      nextRunAt: null,
      createdBy: 'user'
    })
    const result = await deliverCronJob(job)
    expect(result.agentSessionId).toBe(assistant.currentSessionId)
  })

  it('is paused when the assistant is archived', async () => {
    const assistant = await pirate()
    const job = await createCronJob({
      agentSessionId: null, assistantId: assistant.id, name: 'Inbox', prompt: 'Sort.', scheduleType: 'cron',
      cronExpression: '0 9 * * *', timezone: 'UTC', runAt: null, enabled: true, delivery: 'queue',
      nextRunAt: '2099-01-01T09:00:00.000Z', createdBy: 'user'
    })
    await updateAssistantFields(assistant.id, { archived: true })
    const [row] = await query('select enabled from cron_jobs where id = $1', [job.id])
    expect(row.enabled).toBe(false)
    await expect(deliverToAssistant(assistant.id, { content: [] })).rejects.toThrow('archived')
  })
})

describe('the mesh, for an assistant', () => {
  let nextId = 1
  const withToken = (id: string) => mintMeshToken(id)
  async function call(token: string, name: string, args: unknown = {}) {
    const response = await handleMeshMcpRequest(new Request('http://mesh.internal/api/internal/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })
    }))
    return JSON.parse(await response.text()).result.content[0].text as string
  }

  it('schedules for the assistant by default, not for the session it is in', async () => {
    const assistant = await pirate()
    const answer = JSON.parse(await call(withToken(assistant.currentSessionId!), 'schedule_task', {
      name: 'Daily', prompt: 'Check mail.', cronExpression: '0 8 * * *'
    }))
    expect(answer).toMatchObject({ assistantId: assistant.id })
    expect(answer.agentId).toBeUndefined()
  })

  it('lists assistants, and messages one by its id', async () => {
    const assistant = await pirate()
    const other = await createAgentSession({ adapter: 'claude-code', title: 'peer', cwd: '/tmp' })
    const listed = JSON.parse(await call(withToken(other.id), 'list_assistants'))
    expect(listed.assistants).toMatchObject([{ id: assistant.id, name: 'Pete', currentSession: { id: assistant.currentSessionId } }])
    const sent = JSON.parse(await call(withToken(other.id), 'message_agent', { agentId: assistant.id, message: 'ahoy' }))
    expect(sent).toMatchObject({ delivered: true, assistantId: assistant.id, agentId: assistant.currentSessionId })
  })

  it('records the note through hand_off', async () => {
    const assistant = await pirate()
    const answer = JSON.parse(await call(withToken(assistant.currentSessionId!), 'hand_off', { note: 'All done.' }))
    expect(answer).toMatchObject({ handingOff: true, reason: 'agent' })
    expect((await getAssistant(assistant.id))!.handoff).toMatchObject({ note: 'All done.', reason: 'agent' })
  })
})
