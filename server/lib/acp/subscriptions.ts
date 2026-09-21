import { bus } from '../bus'
import {
  enqueueInboxMessage,
  getAgentSession,
  latestAgentMessage,
  listAgentSubscribers,
  listAllSubscriptionTargets
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

function trimmed(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > OUTPUT_LIMIT ? `${clean.slice(0, OUTPUT_LIMIT)}…` : clean
}

/**
 * Queue one note about `targetId` for everyone subscribed to it.
 *
 * Written straight to the inbox rather than through `acpManager.deliver`, and
 * the distinction is not cosmetic: `deliver` starts the adapter it is
 * delivering to. One of the things a subscriber is told about is the target's
 * `adapter-exit`, which is raised for *every* session by `acpManager.shutdown()`
 * on Nitro's `close` hook — so a note that started adapters would spawn a fresh
 * one per subscriber as the server goes down. A row plus a nudge has the
 * behaviour that was wanted anyway: delivered now if the subscriber is up and
 * idle, after its current turn if it is busy, and on its next attach if it is
 * not running at all.
 *
 * `queue` and origin `system`: a note is never a reason to cut across work an
 * agent is already doing.
 */
async function notifySubscribers(targetId: string, what: string): Promise<void> {
  const subscribers = await listAgentSubscribers(targetId)
  if (!subscribers.length) return

  const target = await getAgentSession(targetId)
  if (!target) return

  const output = trimmed(await latestAgentMessage(targetId))
  const text
    = `Agent ${target.title} (${target.id}) ${what}.`
      + (output ? ` Latest output: ${output}` : '')

  for (const subscriber of subscribers) {
    if (subscriber === targetId) continue
    try {
      await enqueueInboxMessage({
        agentSessionId: subscriber,
        content: [{ type: 'text', text }],
        delivery: 'queue',
        origin: 'system'
      })
      acpManager.drainInbox(subscriber)
    } catch (error) {
      console.error(`[acp:${subscriber}] could not queue a subscription note`, error)
    }
  }
}

function handle(event: StreamEvent): Promise<void> | void {
  const targetId
    = event.type === 'agent-event' || event.type === 'permission-changed' ? event.agentSessionId : null
  // Synchronous, and the usual answer: an agent nobody follows must not turn
  // every turn it ends into a query.
  if (!targetId || !watched.has(targetId)) return
  return dispatch(event)
}

async function dispatch(event: StreamEvent): Promise<void> {
  if (event.type === 'permission-changed') {
    if (event.permission.resolvedAt) return
    await notifySubscribers(
      event.agentSessionId,
      `is waiting for a permission: ${event.permission.title}`
    )
    return
  }

  if (event.type !== 'agent-event') return

  switch (event.event.type) {
    case 'turn_end':
      await notifySubscribers(
        event.agentSessionId,
        `finished its turn (${event.event.payload?.stopReason ?? 'end_turn'})`
      )
      break
    case 'error':
      await notifySubscribers(
        event.agentSessionId,
        `stopped with an error: ${event.event.payload?.message ?? 'unknown error'}`
      )
      break
    case 'adapter-exit':
      await notifySubscribers(
        event.agentSessionId,
        `stopped: its adapter exited (code ${event.event.payload?.code ?? 'unknown'})`
      )
      break
  }
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
    if (running) void running.catch(error => console.error('[acp] subscription notifier failed', error))
  })
  const targets = await listAllSubscriptionTargets()
    .catch((error) => {
      console.error('[acp] could not read the subscriptions', error)
      return [] as string[]
    })
  targets.forEach(watch)
}

/** Stop listening, and forget who was followed. For tests; the app never calls it. */
export function stopSubscriptionNotifier(): void {
  g[globalKey]?.()
  g[globalKey] = null
  watched.clear()
}
