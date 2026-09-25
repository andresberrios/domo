import { bus } from '../bus'
import { acpManager } from '../acp/manager'
import {
  countVoiceMessagesAfter,
  getAgentSession,
  getAgentSessionWithEnvironment,
  getVoiceSession,
  latestAgentMessage,
  listAgentSessions,
  listVoiceMessages
} from '../repo'
import { getSettings } from '../settings'
import { sessionStartability } from '../../../shared/retention'
import { CONTEXT_MESSAGE_LIMIT } from './compaction'
import { buildConversationContext } from './context'
import type { AgentSession, StreamEvent, VoiceDelegationSettings } from '../../../shared/types'

/**
 * Handing a GPT-Live conversation's thinking to a coding agent.
 *
 * This is the second half of what the Live API calls *client delegation*: the
 * live model runs the conversation and says "I need help with this"
 * (`session.delegation.created`), and the application decides what that means.
 * The managed alternative — OpenAI calling a Responses model it hosts — lives
 * in `openai-backend.ts`, because there the API does all of this itself.
 *
 * Three things about the protocol shape the design here.
 *
 * **The delegation event carries no task text.** It is an id, a target and a
 * position on the session timeline, and that is all — the user's actual words
 * are in the transcript deltas. So the request handed to the agent is built
 * the same way a reconnect's instruction is built, out of Postgres, through
 * the same `buildConversationContext`. There is one account of what was said.
 *
 * **The answer goes back as appended context, not as a turn.** `commentary`
 * for something to say out loud, `thinking` for something to know quietly.
 * Both are capped at 500 tokens, which is why a coding agent's answer is
 * clipped hard on the way back: the live model is being told the conclusion,
 * not handed a transcript to read out.
 *
 * **Nothing can wait for a coding agent.** A turn takes minutes; the
 * delegation event needs an answer while the user is still in the room. So a
 * delegation is delivered and then *followed* on the bus — exactly the shape
 * `acp/subscriptions.ts` uses to tell one agent about another — and progress
 * goes back as `thinking` until a `turn_end` produces the real answer.
 */

/** How much of an agent's answer is worth speaking. The API caps an append at 500 tokens. */
const ANSWER_CHARS = 1200

/** What a created thinking session is called, and how one is recognised again. */
export const THINKING_TITLE_PREFIX = 'Voice thinking'

/**
 * The backend prompt, in the shape OpenAI's own delegation guide recommends:
 * what the transcript is, what the task is, and what to return.
 *
 * It says "you are the reasoning behind a voice conversation" rather than
 * "answer this question" because the agent is a coding agent with the Domo
 * mesh attached — it can start other agents, read their transcripts, open
 * projects. What it must not do is answer as if it were on a screen: the reply
 * is going to be spoken.
 */
const BACKEND_PROMPT = `You are the reasoning backend for a live voice conversation between a developer
and Domo, an assistant that runs coding agents for them. A live voice model is
holding the conversation and has delegated this request to you.

About the transcript: it comes from speech, so it can contain mistakes,
unfinished phrases and later corrections. Use the latest context. If a needed
detail is still unclear, say which detail is missing rather than guessing.

What you can do: you have Domo's own tools through the "domo" MCP server —
listing, starting, messaging and reconfiguring coding agents, reading their
transcripts, listing projects and development environments, scheduling work.
Use them to answer, and to carry out what the developer asked for.

What to return: the relevant facts, the current status of the task and the next
step, in two or three spoken sentences. This is read out loud, so no code, no
file paths, no stack traces, no ids, no Markdown. Round numbers and name things
by what they are. Report an action as done only once a tool confirmed it. If
the outcome is unclear, say so and say what needs checking.`

export interface DelegationUpdate {
  delegationId: string | null
  /** `commentary` is spoken; `thinking` is known quietly. */
  kind: 'commentary' | 'thinking'
  text: string
}

export interface AgentDelegateOptions {
  voiceSessionId: string
  /** Send an update back into the live conversation. */
  onUpdate: (update: DelegationUpdate) => void
  /** Say something in the conversation's transcript, as Domo rather than the model. */
  onNote?: (text: string) => void
}

function clip(text: string, max = ANSWER_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/**
 * Which coding agent does the thinking for this conversation.
 *
 * Three answers in order, and the order is the point. A session named in
 * Settings is used if it is still there and still runnable — an operator who
 * pointed this at a particular agent meant it. Otherwise the agent this
 * conversation already made (they are linked by `agent_sessions.voice_session_id`,
 * so one survives a restart and a conversation does not collect a new agent
 * per boot). Otherwise one is created, which is the path a fresh install takes
 * and the reason the setting may be left empty.
 *
 * A configured session that has gone — deleted, or in a retired environment —
 * is *not* an error: it falls through to the conversation's own, and the
 * conversation carries on. The alternative is a voice assistant that cannot
 * answer anything because a setting points at a container somebody removed.
 */
export async function resolveThinkingAgent(
  voiceSessionId: string,
  delegation: VoiceDelegationSettings
): Promise<AgentSession> {
  if (delegation.agentSessionId) {
    const named = await getAgentSession(delegation.agentSessionId)
    if (named && (await startable(named))) return named
    console.warn(
      `[voice:${voiceSessionId}] the configured thinking agent ${delegation.agentSessionId} `
      + 'is gone or cannot run; using this conversation\'s own instead'
    )
  }

  const existing = (await listAgentSessions())
    .filter(session => session.voiceSessionId === voiceSessionId)
    .filter(session => session.title.startsWith(THINKING_TITLE_PREFIX))
  for (const session of existing) {
    if (await startable(session)) return session
  }

  const conversation = await getVoiceSession(voiceSessionId)
  return acpManager.create({
    adapter: delegation.agentAdapter,
    title: `${THINKING_TITLE_PREFIX} · ${conversation?.title ?? 'conversation'}`.slice(0, 80),
    voiceSessionId,
    devEnvironmentId: delegation.agentDevEnvironmentId || null
  })
}

async function startable(session: AgentSession): Promise<boolean> {
  const { environment } = await getAgentSessionWithEnvironment(session.id)
  return sessionStartability(session, environment).startable
}

/**
 * The request a delegation becomes: the backend prompt, then the conversation.
 *
 * Pure, so what the agent is asked can be read in a test rather than inferred
 * from a live socket. The conversation is rendered by the same function a
 * reconnect uses, which is what keeps the two accounts of "what has been said"
 * from drifting apart.
 */
export function buildDelegationRequest(input: {
  conversationContext: string
  delegationId: string | null
  /** Something the user typed rather than said, when that is what triggered this. */
  typed?: string | null
}): string {
  const parts = [BACKEND_PROMPT, '']
  if (input.conversationContext) {
    parts.push(input.conversationContext, '')
  } else {
    parts.push('The conversation has only just started and there is no transcript yet.', '')
  }
  parts.push(
    input.typed
      ? `The developer typed this, verbatim: ${input.typed}`
      : 'The live model has delegated the developer\'s latest request, at the end of the '
        + 'transcript above, to you. Work out what they want and answer it.'
  )
  return parts.join('\n')
}

/**
 * One conversation's link to its thinking agent.
 *
 * Created with the socket and thrown away with it. The bus subscription is the
 * live part: an agent's turn ending is how an answer arrives, and there is no
 * other signal — the `deliver` call returns as soon as the prompt is accepted.
 */
export class AgentDelegate {
  private unsubscribe: (() => void) | null = null
  private agentId: string | null = null
  /** The delegation the agent is currently answering, so its turn can be attributed. */
  private open: string | null = null
  private closed = false
  /** Turn ends already reported, since a bus event can be seen more than once. */
  private reported = new Set<string>()

  constructor(private readonly options: AgentDelegateOptions) {}

  /** The agent doing the thinking, once one has been resolved. */
  get thinkingAgentId(): string | null {
    return this.agentId
  }

  /**
   * Hand a delegation to the agent.
   *
   * Steered rather than queued when the agent is mid-turn, and that is the one
   * delivery choice here worth defending: a queued message waits for a turn
   * that may take minutes, and the person who asked is standing in the room.
   * `steer` falls back to `interrupt` on an adapter that cannot be steered,
   * which is the right answer for the same reason — "what I am asking now
   * matters more than what you were doing".
   */
  async ask(delegationId: string | null, typed?: string | null): Promise<void> {
    if (this.closed) return
    const settings = await getSettings()
    const agent = await resolveThinkingAgent(this.options.voiceSessionId, settings.openaiDelegation)
    this.attach(agent.id)
    this.open = delegationId

    const request = buildDelegationRequest({
      conversationContext: await this.conversationContext(),
      delegationId,
      typed
    })

    // Say in the conversation's own transcript which agent is thinking. The
    // user is looking at a screen that would otherwise show a silent gap.
    this.options.onNote?.(`Asked ${agent.title} to work this out.`)
    // And tell the live model, quietly, so it can cover the wait without
    // inventing an answer. `thinking` rather than `commentary`: "let me check"
    // is the live model's line to write, not Domo's.
    this.options.onUpdate({
      delegationId,
      kind: 'thinking',
      text: `Working on this now with the coding agent "${agent.title}". No answer yet.`
    })

    try {
      await acpManager.deliver(agent.id, {
        content: [{ type: 'text', text: request }],
        delivery: 'steer',
        origin: 'user'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.onUpdate({
        delegationId,
        kind: 'commentary',
        text: `The coding agent could not take that: ${clip(message, 200)}`
      })
    }
  }

  private async conversationContext(): Promise<string> {
    const session = await getVoiceSession(this.options.voiceSessionId)
    const messages = await listVoiceMessages(this.options.voiceSessionId, CONTEXT_MESSAGE_LIMIT)
    return buildConversationContext({
      summary: session?.summary,
      summaryThroughSeq: session?.summaryThroughSeq,
      messages,
      uncoveredTotal: await countVoiceMessagesAfter(
        this.options.voiceSessionId,
        session?.summaryThroughSeq ?? 0
      )
    }).text
  }

  /**
   * Follow one agent on the bus.
   *
   * On the bus rather than through a callback on `AgentRuntime` for the reason
   * `acp/subscriptions.ts` gives: the runtime is what `acpManager` is, and a
   * runtime importing this would cycle straight back through itself.
   */
  private attach(agentId: string): void {
    if (this.agentId === agentId && this.unsubscribe) return
    this.unsubscribe?.()
    this.agentId = agentId
    this.unsubscribe = bus.subscribe((event) => {
      void this.onBusEvent(event as StreamEvent).catch(() => {})
    })
  }

  private async onBusEvent(event: StreamEvent): Promise<void> {
    if (this.closed || !this.agentId) return
    const subject = event.type === 'agent-event' || event.type === 'permission-changed'
      ? event.agentSessionId
      : null
    if (subject !== this.agentId) return

    if (event.type === 'permission-changed') {
      if (event.permission.resolvedAt) return
      this.options.onUpdate({
        delegationId: this.open,
        kind: 'commentary',
        text: `Before going further it needs a decision: ${clip(event.permission.title, 200)}. `
          + 'Ask the developer whether to allow it; they answer on screen.'
      })
      return
    }

    if (event.type !== 'agent-event') return

    if (event.event.type === 'turn_end') {
      const key = `${this.agentId}:${event.event.seq}`
      if (this.reported.has(key)) return
      this.reported.add(key)
      const answer = clip(await latestAgentMessage(this.agentId))
      const delegationId = this.open
      this.open = null
      this.options.onUpdate({
        delegationId,
        kind: 'commentary',
        text: answer || 'It finished without saying anything. Tell the developer it came back empty.'
      })
      return
    }

    if (event.event.type === 'error' || event.event.type === 'adapter-exit') {
      const reason = event.event.type === 'error'
        ? clip(String(event.event.payload?.message ?? 'unknown error'), 200)
        : `its adapter exited (code ${event.event.payload?.code ?? 'unknown'})`
      this.options.onUpdate({
        delegationId: this.open,
        kind: 'commentary',
        text: `The coding agent doing the thinking stopped: ${reason}.`
      })
      this.open = null
    }
  }

  close(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
