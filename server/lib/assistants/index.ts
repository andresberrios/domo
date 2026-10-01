import { mkdir } from 'node:fs/promises'

import { acpManager, type TurnEnd } from '../acp/manager'
import { keyedSerial } from '../keyed-serial'
import { normalizeCwd } from '../paths'
import { getSettings } from '../settings'
import {
  appendAgentEvent,
  carryOverToSession,
  countUserMessages,
  createAssistantRow,
  disableCronJobsForAssistant,
  getAgentSession,
  getAgentSessionWithEnvironment,
  getAssistant,
  getAssistantOfSession,
  getDevEnvironment,
  hasUserMessage,
  setAssistantHandoff,
  updateAgentSession,
  updateAssistant,
  type AssistantFields
} from '../repo'
import { recentExchange, type HandoffPayload } from './context'
import { sessionStartability } from '../../../shared/retention'
import { isAgentAdapter } from '../../../shared/agent-adapters'
import {
  DEFAULT_HANDOFF_THRESHOLD,
  HANDOFF_CONTINUE_PREFIX,
  HANDOFF_REQUEST_PREFIX,
  HANDOFF_THRESHOLD_MAX,
  HANDOFF_THRESHOLD_MIN,
  MAX_ASSISTANT_NAME_CHARS,
  MAX_AVATAR_CHARS,
  MAX_PERSONA_CHARS,
  isHandoffRequest
} from '../../../shared/assistants'
import type {
  AgentSession,
  Assistant,
  HandoffReason,
  MessageDelivery,
  MessageOrigin,
  PendingHandoff
} from '../../../shared/types'

/**
 * An assistant's lifecycle: making one, the session it is currently in, and
 * the handoff that moves it from one session to the next.
 *
 * A handoff has one mechanism and three ways in. The human asks (a button,
 * or in words, which the agent answers by calling `hand_off`), the context
 * passes the assistant's threshold at the end of a turn, or the agent decides
 * by itself. In every case the session writing the note finishes its turn,
 * and at that turn's end the next session starts from the note; what was
 * waiting for the old session moves with it.
 */

/** Prompts a session takes before its context can trigger a handoff by itself. */
const MIN_TURNS_BEFORE_AUTO_HANDOFF = 3

/** One at a time per assistant, for anything that makes or replaces its session. */
const serial = keyedSerial()

function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode, statusMessage: message.split('. ')[0]!.slice(0, 120) })
}

/** The human's fields, checked and filled in. A partial patch checks only what it carries. */
export async function normalizeAssistantFields(
  input: Partial<Record<keyof AssistantFields, unknown>>,
  existing?: Assistant
): Promise<Partial<AssistantFields>> {
  const out: Partial<AssistantFields> = {}
  if (input.name !== undefined || !existing) {
    const name = String(input.name ?? '').trim()
    if (!name) fail('An assistant needs a name.')
    if (name.length > MAX_ASSISTANT_NAME_CHARS) fail(`Keep the name under ${MAX_ASSISTANT_NAME_CHARS} characters.`)
    out.name = name
  }
  if (input.persona !== undefined) {
    const persona = String(input.persona ?? '')
    if (persona.length > MAX_PERSONA_CHARS) fail(`Keep the persona under ${MAX_PERSONA_CHARS} characters.`)
    out.persona = persona
  }
  if (input.avatar !== undefined) {
    const avatar = input.avatar ? String(input.avatar) : null
    if (avatar && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar)) fail('The picture must be a PNG, JPEG, WebP or GIF image.')
    if (avatar && avatar.length > MAX_AVATAR_CHARS) fail('The picture is too large; pick a smaller one.')
    out.avatar = avatar
  }
  if (input.adapter !== undefined || !existing) {
    const adapter = input.adapter ?? 'claude-code'
    if (!isAgentAdapter(adapter)) fail(`Unknown harness ${String(adapter)}.`)
    out.adapter = adapter
  }
  if (input.model !== undefined) out.model = input.model ? String(input.model).trim() || null : null
  if (input.modeId !== undefined) out.modeId = input.modeId ? String(input.modeId).trim() || null : null
  if (input.handoffThreshold !== undefined || !existing) {
    const raw = input.handoffThreshold === undefined ? DEFAULT_HANDOFF_THRESHOLD : input.handoffThreshold
    if (raw === null) {
      out.handoffThreshold = null
    } else {
      const value = Math.round(Number(raw))
      if (!Number.isFinite(value) || value < HANDOFF_THRESHOLD_MIN || value > HANDOFF_THRESHOLD_MAX) {
        fail(`The handoff threshold is a percentage from ${HANDOFF_THRESHOLD_MIN} to ${HANDOFF_THRESHOLD_MAX}, or off.`)
      }
      out.handoffThreshold = value
    }
  }
  // Where it works: an environment, or a directory on the host. Choosing one
  // clears the other.
  if (input.devEnvironmentId !== undefined || input.cwd !== undefined || !existing) {
    const environmentId = input.devEnvironmentId ? String(input.devEnvironmentId) : null
    if (environmentId) {
      const environment = await getDevEnvironment(environmentId)
      if (!environment) fail(`No development environment ${environmentId}.`)
      if (environment.retiredAt) fail(`The development environment "${environment.name}" was retired.`)
      out.devEnvironmentId = environment.id
      out.cwd = environment.workspacePath
    } else {
      const settings = await getSettings()
      out.devEnvironmentId = null
      out.cwd = normalizeCwd(String(input.cwd ?? '') || existing?.cwd || settings.defaultCwd)
    }
  }
  return out
}

/** Make an assistant and its first session. */
export async function createAssistant(input: Partial<Record<keyof AssistantFields, unknown>>): Promise<Assistant> {
  const fields = await normalizeAssistantFields(input)
  const assistant = await createAssistantRow({
    name: fields.name!,
    avatar: fields.avatar ?? null,
    persona: fields.persona ?? '',
    adapter: fields.adapter!,
    model: fields.model ?? null,
    modeId: fields.modeId ?? null,
    cwd: fields.cwd!,
    devEnvironmentId: fields.devEnvironmentId ?? null,
    handoffThreshold: fields.handoffThreshold ?? null
  })
  await serial(assistant.id, () => startSession(assistant))
  return (await getAssistant(assistant.id))!
}

/**
 * Change an assistant. Name and avatar show at once; the rest is what the
 * next session starts on. A rename also renames the current session, which
 * is what notifications and the voice bar call it.
 */
export async function updateAssistantFields(
  id: string,
  input: Partial<Record<keyof AssistantFields | 'archived', unknown>>
): Promise<Assistant> {
  const existing = await getAssistant(id)
  if (!existing) fail(`No assistant ${id}.`, 404)
  const fields = await normalizeAssistantFields(input, existing)
  let updated = await updateAssistant(id, fields)
  if (fields.name && fields.name !== existing.name && existing.currentSessionId) {
    await updateAgentSession(existing.currentSessionId, { title: fields.name })
  }
  if (typeof input.archived === 'boolean' && input.archived !== existing.archived) {
    updated = await setAssistantArchived(id, input.archived)
  }
  return updated!
}

/**
 * Put an assistant away, or bring it back. Archiving stops its current
 * session and pauses its schedules, as archiving a session does; its
 * sessions and their transcripts are kept.
 */
export async function setAssistantArchived(id: string, archived: boolean): Promise<Assistant | null> {
  const assistant = await updateAssistant(id, { archived })
  if (!assistant || !archived) return assistant
  if (assistant.currentSessionId) acpManager.stop(assistant.currentSessionId)
  await disableCronJobsForAssistant(id)
  await setAssistantHandoff(id, null)
  return getAssistant(id)
}

/**
 * Start a session for the assistant on what it is set to now, and make it
 * current. Called under `serial`.
 */
async function startSession(assistant: Assistant, handoff?: HandoffPayload): Promise<AgentSession> {
  if (assistant.devEnvironmentId) {
    const environment = await getDevEnvironment(assistant.devEnvironmentId)
    if (!environment || environment.retiredAt) {
      fail(`"${assistant.name}" works in a development environment that was retired. Choose another workspace in its settings.`, 409)
    }
  } else {
    await mkdir(assistant.cwd, { recursive: true }).catch(() => {})
  }
  const session = await acpManager.create({
    adapter: assistant.adapter,
    title: assistant.name,
    cwd: assistant.devEnvironmentId ? undefined : assistant.cwd,
    devEnvironmentId: assistant.devEnvironmentId,
    model: assistant.model,
    modeId: assistant.modeId,
    assistantId: assistant.id,
    firstEvent: handoff ? { type: 'handoff', payload: handoff } : undefined
  })
  await updateAssistant(assistant.id, { currentSessionId: session.id })
  return session
}

/**
 * The session to talk to the assistant in, made if there is none. A current
 * session that can no longer run (its environment was retired) is replaced,
 * carrying over what it can without a note it cannot write.
 */
async function ensureCurrentSession(assistantId: string): Promise<string> {
  return serial(assistantId, async () => {
    const assistant = await getAssistant(assistantId)
    if (!assistant) fail(`No assistant ${assistantId}.`, 404)
    if (assistant.archived) fail(`"${assistant.name}" is archived. Unarchive it to talk to it.`, 409)
    if (!assistant.currentSessionId) return (await startSession(assistant)).id
    const { session, environment } = await getAgentSessionWithEnvironment(assistant.currentSessionId)
    if (!session) return (await startSession(assistant)).id
    const state = sessionStartability(session, environment)
    if (state.startable) return session.id
    const next = await replaceSession(assistant, {
      reason: 'unavailable',
      sessionId: session.id,
      requestedAt: new Date().toISOString()
    }, `The previous session could not run any more (${state.reason}) and wrote no note. `
      + 'The last exchange below is everything that carried over.')
    return next.id
  })
}

/**
 * Send something to the assistant: to its current session, as a message to
 * any session would go. Returns which session took it.
 */
export async function deliverToAssistant(
  assistantId: string,
  input: { content: any[], delivery?: MessageDelivery, origin?: MessageOrigin }
) {
  const sessionId = await ensureCurrentSession(assistantId)
  return acpManager.deliver(sessionId, input)
}

const REQUEST_REASONS: Record<Exclude<HandoffReason, 'agent' | 'unavailable'>, string> = {
  user: 'The human asked you to start fresh',
  context: 'Your context window is nearly full'
}

function handoffRequest(reason: keyof typeof REQUEST_REASONS): string {
  return [
    `${HANDOFF_REQUEST_PREFIX} ${REQUEST_REASONS[reason]}. Your context is about to be replaced by a fresh session `
    + 'that starts from a note you write now. Call the `hand_off` tool with that note, then end your turn without '
    + 'saying anything else to the human.',
    '',
    'Write the note for yourself, in your own voice. Keep what you need to pick the thread up: what the human is '
    + 'working on and why, decisions and preferences they stated, coding agents, environments, files and branches '
    + 'involved and how each ended, open questions, and anything you promised but have not done yet. Keep '
    + 'identifiers exact (ids, paths, branch names, error text). Drop chit-chat and tool output that changed '
    + 'nothing. Prefer the recent and unresolved over the old and settled, but never drop a commitment. Stay under '
    + '400 words. Your last few messages carry over word for word, so the note need not repeat them.',
    '',
    'If you were in the middle of work that should go on without waiting for the human, pass it as nextPrompt.',
    'If you cannot call the tool, reply with the note itself as your whole answer.'
  ].join('\n')
}

/**
 * Ask the assistant's current session to write its handoff note. It is
 * queued behind whatever the session is doing; the handoff completes when
 * the note-writing turn ends.
 */
export async function requestHandoff(
  assistantId: string,
  reason: 'user' | 'context'
): Promise<{ started: boolean, note?: string }> {
  const assistant = await getAssistant(assistantId)
  if (!assistant) fail(`No assistant ${assistantId}.`, 404)
  if (assistant.archived) fail(`"${assistant.name}" is archived.`, 409)
  if (assistant.handoff) return { started: false, note: 'A handoff is already under way.' }
  const sessionId = assistant.currentSessionId
  if (!sessionId || !await hasUserMessage(sessionId)) {
    return { started: false, note: 'Nothing has been said in this session yet; it is already fresh.' }
  }
  const { session, environment } = await getAgentSessionWithEnvironment(sessionId)
  if (session && !sessionStartability(session, environment).startable) {
    // It cannot write a note, so the next message replaces it without one.
    await ensureCurrentSession(assistantId)
    return { started: true }
  }
  const claimed = await setAssistantHandoff(assistantId, {
    reason,
    sessionId,
    requestedAt: new Date().toISOString()
  }, null)
  if (!claimed) return { started: false, note: 'A handoff is already under way.' }
  try {
    await acpManager.deliver(sessionId, {
      content: [{ type: 'text', text: handoffRequest(reason) }],
      delivery: 'queue',
      origin: 'system'
    })
  } catch (error) {
    await setAssistantHandoff(assistantId, null, sessionId)
    throw error
  }
  return { started: true }
}

/**
 * The `hand_off` tool: the calling session's note. Completes when its turn
 * ends. A session that was not asked is handing off on its own initiative.
 */
export async function recordHandoffNote(
  caller: AgentSession,
  input: { note: unknown, nextPrompt?: unknown }
): Promise<{ assistant: Assistant, reason: HandoffReason }> {
  const note = String(input.note ?? '').trim()
  if (!note) fail('Pass the note: what your next session needs to pick up where you are.')
  const nextPrompt = typeof input.nextPrompt === 'string' && input.nextPrompt.trim() ? input.nextPrompt.trim() : undefined
  const assistant = await getAssistantOfSession(caller.id)
  if (!assistant) {
    fail('hand_off is only for sessions of an assistant. This is an ordinary session; it has no next session to hand off to.')
  }
  if (assistant.currentSessionId !== caller.id) fail('This session has already handed off.')
  const pending = assistant.handoff
  if (pending && pending.sessionId !== caller.id) fail('Another handoff is under way.')
  const next: PendingHandoff = pending
    ? { ...pending, note, nextPrompt }
    : { reason: 'agent', sessionId: caller.id, requestedAt: new Date().toISOString(), note, nextPrompt }
  const written = await setAssistantHandoff(assistant.id, next, pending ? caller.id : null)
  if (!written) fail('The handoff changed while the note was being written; try again.')
  return { assistant: written, reason: next.reason }
}

/**
 * Finish a handoff: the next session starts from the note, takes over what
 * was waiting, and becomes current; the old one stops. Called under `serial`.
 */
async function replaceSession(
  assistant: Assistant,
  pending: PendingHandoff,
  note: string
): Promise<AgentSession> {
  const from = pending.sessionId
  const payload: HandoffPayload = {
    note,
    reason: pending.reason,
    fromSessionId: from,
    recent: await recentExchange(from)
  }
  const next = await startSession(assistant, payload)
  const moved = await carryOverToSession(from, next.id)
  await setAssistantHandoff(assistant.id, null)
  await appendAgentEvent(from, 'handed_off', { toSessionId: next.id, reason: pending.reason })
  if (pending.nextPrompt) {
    await acpManager.deliver(next.id, {
      content: [{ type: 'text', text: `${HANDOFF_CONTINUE_PREFIX} ${pending.nextPrompt}` }],
      delivery: 'queue',
      origin: 'system'
    })
  } else if (moved) {
    acpManager.drainInbox(next.id)
  }
  // After the turn that called this has returned: stopping the adapter from
  // inside its own turn would race the turn's own bookkeeping.
  setTimeout(() => acpManager.stop(from), 0)
  return next
}

/** Did this turn carry Domo's request for a note? */
function askedForNote(turn: TurnEnd): boolean {
  return turn.content.some((block: any) => block?.type === 'text' && isHandoffRequest(block.text))
}

/**
 * A turn ended somewhere. For the current session of an assistant this is
 * where a handoff completes, and where the context threshold is checked.
 */
async function onTurnEnd(turn: TurnEnd): Promise<void> {
  const assistant = await getAssistantOfSession(turn.agentSessionId)
  if (!assistant || assistant.archived || assistant.currentSessionId !== turn.agentSessionId) return
  const pending = assistant.handoff

  if (pending?.sessionId === turn.agentSessionId) {
    // The note the agent wrote with `hand_off`; failing that, the answer to
    // the request, which asked for the note itself when the tool was out of
    // reach. A request turn that failed or was cancelled ends the handoff.
    const asked = askedForNote(turn)
    const note = pending.note ?? (asked && turn.ok ? turn.text.trim() : '')
    if (note) {
      await serial(assistant.id, () => replaceSession(assistant, pending, note))
      return
    }
    if (asked) {
      await setAssistantHandoff(assistant.id, null, turn.agentSessionId)
      await appendAgentEvent(turn.agentSessionId, 'error', {
        message: turn.ok
          ? 'The handoff did not happen: no note was written. Ask again to retry.'
          : 'The handoff was stopped before a note was written.'
      })
    }
    return
  }

  if (!turn.ok || pending || !assistant.handoffThreshold) return
  const session = await getAgentSession(turn.agentSessionId)
  const context = session?.usage?.context
  if (!context?.size) return
  const percent = (context.used / context.size) * 100
  if (percent < assistant.handoffThreshold) return
  // A fresh session already holds the harness's system prompt and tools, and
  // on a small window that alone can pass the threshold: every new session
  // would hand off after its first turn, for ever. A few turns of its own
  // first means a handoff only ever sheds conversation.
  if (await countUserMessages(turn.agentSessionId) < MIN_TURNS_BEFORE_AUTO_HANDOFF) return
  await requestHandoff(assistant.id, 'context')
}

/**
 * Listen for turn ends: where handoffs complete and the threshold is checked.
 * Idempotent, and a hot reload replaces the old listener rather than adding
 * a second one.
 */
export function startAssistants(): void {
  const g = globalThis as any
  g.__domo_assistant_turn_end__?.()
  g.__domo_assistant_turn_end__ = acpManager.onTurnEnd(onTurnEnd)
}
