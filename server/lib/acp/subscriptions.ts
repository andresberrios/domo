import { inBackground } from '../background'
import { bus } from '../bus'
import { keyedSerial } from '../keyed-serial'
import {
  armMessageWatches,
  consumeSubscriptionTurn,
  enqueueInboxMessage,
  getAgentSession,
  latestAgentMessage,
  listAgentFollowers,
  listAllSubscriptionTargets,
  listMessageWatchIds,
  listPermissions
} from '../repo'
import { acpManager } from './manager'
import type { StreamEvent } from '../../../shared/types'

/**
 * Telling one coding agent what another one is doing.
 *
 * An agent that hands work to a peer has no way to wait for it: its own turn
 * ends, and the peer's finishes minutes later. A subscription closes that gap —
 * when the target finishes a turn, stops for a permission, or dies, Domo
 * composes one message and delivers it to each subscriber's inbox.
 *
 * A subscription lasts a number of turn ends, or indefinitely. Only a turn
 * that ends counts: a permission request or an error is worth hearing about
 * but is not the "it finished" the subscriber is waiting for, so those notify
 * without using the window up. An agent that reported to a subscriber itself
 * (`message_agent` with `turnReport`) spares it the note for that turn end,
 * which still counts.
 *
 * A message an agent sends with `message_agent` is followed the same way, but
 * from the turn that handles it, which may be several turns away: the watch on
 * it (`agent_message_watches`) becomes a subscription when that turn's
 * `user_message` names the message. Events about one agent are handled one at
 * a time, in the order they were written, so that arming and the previous
 * turn's end can never swap places.
 *
 * This listens on the bus rather than being called from `AgentRuntime`, for the
 * same reason the voice runtime does: the notifier needs `acpManager` to
 * deliver, and a runtime that imported the notifier would cycle straight back
 * through itself. Everything it reacts to is already published — `agent-event`
 * by `appendAgentEvent`, `permission-changed` by `createPermission`.
 */

/** Enough of the agent's last message to be worth reading, and no more. */
const OUTPUT_LIMIT = 1500

/**
 * The agents somebody is following, so a turn ending costs no query at all when
 * nobody is — which is almost always, and is every single turn on an install
 * where no agent has ever spawned a peer.
 *
 * Only ever a superset, and nothing ever removes from it: a cascade delete or
 * an unsubscribe can leave an id behind, which costs one query that finds no
 * subscribers. Taking ids out would risk dropping one that a second subscriber
 * still wants, and a missing id costs a note rather than a query.
 */
const watched = new Set<string>()

/** Say that `targetId` now has at least one subscriber. */
export function watch(targetId: string): void {
  watched.add(targetId)
}

/**
 * The messages somebody is waiting on an answer to, so a `user_message` costs
 * no query unless it carries one. A superset, like `watched`: a withdrawn or
 * cascaded watch leaves its id behind, which costs a query that arms nothing.
 */
const awaited = new Set<string>()

/** Say that a watch on message `messageId` exists. */
export function awaitMessage(messageId: string): void {
  awaited.add(messageId)
}

/**
 * Who each agent has reported to on its current turn (`message_agent` with
 * `turnReport`), taken at the turn's end. In memory: a restart ends the turn
 * too, and then the note is sent as usual.
 */
const reported = new Map<string, Set<string>>()

/** `senderId`'s message to `recipientId` is its report on this turn: no turn-end note to it for this turn. */
export function reportTurnTo(senderId: string, recipientId: string): void {
  const recipients = reported.get(senderId) ?? new Set<string>()
  recipients.add(recipientId)
  reported.set(senderId, recipients)
}

/** One queue per agent the events are about. */
const serially = keyedSerial()

function trimmed(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > OUTPUT_LIMIT ? `${clean.slice(0, OUTPUT_LIMIT)}…` : clean
}

/**
 * Queue one note about `targetId` for everyone subscribed to it.
 *
 * Written straight to the inbox rather than through `acpManager.deliver`, so a
 * note never cuts across a turn, and woken with `acpManager.wake`, which does
 * nothing while the server shuts down: delivered now if the subscriber is up
 * and idle, after its current turn if it is busy, and once its adapter has
 * started if it is not running.
 *
 * `queue` and origin `system`: a note is never a reason to cut across work an
 * agent is already doing.
 */
async function notifySubscribers(
  targetId: string,
  what: string,
  subscribers: Array<{ subscriberId: string, remainingTurns: number | null }>
): Promise<void> {
  if (!subscribers.length) return

  const target = await getAgentSession(targetId)
  if (!target) return

  const output = trimmed(await latestAgentMessage(targetId))
  const text
    = `Agent ${target.title} (${target.id}) ${what}.`
      + (output ? ` Latest output: ${output}` : '')

  for (const { subscriberId: subscriber, remainingTurns } of subscribers) {
    if (subscriber === targetId) continue
    try {
      await enqueueInboxMessage({
        agentSessionId: subscriber,
        content: [{ type: 'text', text: text + windowNote(remainingTurns) }],
        delivery: 'queue',
        origin: 'system'
      })
      // Woken, not only drained: a subscriber that is idle is often not
      // running at all — after a restart none is — and a note left in its
      // inbox until somebody opened it is the stall this exists to prevent.
      acpManager.wake(subscriber)
    } catch (error) {
      console.error(`[acp:${subscriber}] could not queue a subscription note`, error)
    }
  }
}

/** What is left of the subscriber's window, so ending it is never a surprise. */
function windowNote(remainingTurns: number | null): string {
  if (remainingTurns === null) return ''
  if (remainingTurns === 0) {
    return '\n\n(That was the last update this subscription covered; call subscribe_to_agent to keep following it.)'
  }
  return `\n\n(Subscribed for ${remainingTurns} more turn end${remainingTurns === 1 ? '' : 's'}.)`
}

function handle(event: StreamEvent): Promise<void> | void {
  const targetId
    = event.type === 'agent-event' || event.type === 'permission-changed' ? event.agentSessionId : null
  if (!targetId) return
  const arming = event.type === 'agent-event' && event.event.type === 'user_message' ? awaitedIn(event.event.payload) : []
  // Synchronous, and the usual answer: an agent nobody follows must not turn
  // every turn it ends into a query. Its report, if it made one, was for this turn.
  if (!arming.length && !watched.has(targetId)) {
    if (event.type === 'agent-event' && (event.event.type === 'turn_end' || event.event.type === 'adapter-exit')) reported.delete(targetId)
    return
  }
  return serially(targetId, async () => {
    if (arming.length) {
      const armed = await armMessageWatches(targetId, arming)
      arming.forEach(id => awaited.delete(id))
      if (armed.length) watch(targetId)
      return
    }
    await dispatch(event)
  })
}

/** The messages on a `user_message` that somebody is waiting on. */
function awaitedIn(payload: any): string[] {
  const ids: unknown = payload?.messageIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && awaited.has(id)) : []
}

async function dispatch(event: StreamEvent): Promise<void> {
  if (event.type === 'permission-changed') {
    if (event.permission.resolvedAt) return
    await notifySubscribers(
      event.agentSessionId,
      `is waiting for a permission: ${event.permission.title} (permission id ${event.permission.id})`,
      await followers(event.agentSessionId)
    )
    return
  }

  if (event.type !== 'agent-event') return

  switch (event.event.type) {
    case 'turn_end': {
      const stopReason = event.event.payload?.stopReason ?? 'end_turn'
      const told = reported.get(event.agentSessionId) ?? new Set<string>()
      reported.delete(event.agentSessionId)
      // Counted for everyone, told or not: the window is turn ends.
      const subscribers = await consumeSubscriptionTurn(event.agentSessionId)
      // A report covers a turn that ended normally; a refusal, a cancel or a
      // waiting permission is news it did not carry.
      const spared = told.size && stopReason === 'end_turn' && !(await listPermissions(event.agentSessionId)).length
      await notifySubscribers(
        event.agentSessionId,
        `finished its turn (${stopReason})`,
        spared ? subscribers.filter(subscriber => !told.has(subscriber.subscriberId)) : subscribers
      )
      break
    }
    case 'error':
      await notifySubscribers(
        event.agentSessionId,
        `stopped with an error: ${event.event.payload?.message ?? 'unknown error'}`,
        await followers(event.agentSessionId)
      )
      break
    case 'adapter-exit':
      // Its turn, if any, went with it.
      reported.delete(event.agentSessionId)
      // Domo stopped it: a shutdown, an archive or a handoff, none of which
      // is news to whoever follows the agent.
      if (event.event.payload?.requested) break
      await notifySubscribers(
        event.agentSessionId,
        `stopped: its adapter exited (code ${event.event.payload?.code ?? 'unknown'})`,
        await followers(event.agentSessionId)
      )
      break
  }
}

async function followers(targetId: string) {
  return (await listAgentFollowers(targetId))
    .map(entry => ({ subscriberId: entry.subscriberId, remainingTurns: entry.remainingTurns }))
}

const globalKey = '__domo_subscription_notifier__'
const g = globalThis as any

/**
 * Start listening, once per process. Idempotent: the boot plugin starts it, and
 * so does anything that can create a subscription, so a subscription is never
 * made against a notifier that is not running.
 *
 * Subscriptions are rows and outlive the process that made them, so the set of
 * followed agents is read back here before the first event can be missed.
 */
export async function startSubscriptionNotifier(): Promise<void> {
  if (g[globalKey]) return
  g[globalKey] = bus.subscribe((event) => {
    const running = handle(event)
    if (running) inBackground(running.catch(error => console.error('[acp] subscription notifier failed', error)))
  })
  const [targets, messages] = await Promise.all([
    listAllSubscriptionTargets(),
    listMessageWatchIds()
  ]).catch((error) => {
    console.error('[acp] could not read the subscriptions', error)
    return [[], []] as string[][]
  })
  targets!.forEach(watch)
  messages!.forEach(awaitMessage)
}

/** Stop listening, and forget who was followed. For tests; the app never calls it. */
export function stopSubscriptionNotifier(): void {
  g[globalKey]?.()
  g[globalKey] = null
  watched.clear()
  awaited.clear()
  reported.clear()
}
