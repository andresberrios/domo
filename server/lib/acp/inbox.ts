import type { AgentInboxMessage, MessageOrigin } from '../../../shared/types'

/**
 * Where a queued message came from, in one line the model can read.
 *
 * Derived from `origin` alone, which is all the row carries: an `agent:<id>`
 * names the peer by id, and a subscription note's own text already opens with
 * that agent's title, so nothing is looked up to write this.
 */
export function inboxDivider(origin: MessageOrigin): string {
  if (origin.startsWith('agent:')) return `[Message from agent ${origin.slice('agent:'.length)}]`
  // The voice agent speaks for Domo, and so does a subscription note.
  if (origin === 'voice' || origin === 'system') return '[From Domo]'
  return '[From you]'
}

/**
 * Everything that was waiting, as the content of one prompt.
 *
 * Two notes that arrived during the same turn are one thing to answer, not two
 * turns racing each other — but they are still two messages, so each is
 * introduced by a line saying where it came from rather than run together into
 * one wall of text. A single message is handed over exactly as it was written:
 * no divider, nothing added, which is what it was before the queue coalesced.
 */
export function combineInboxContent(messages: AgentInboxMessage[]): any[] {
  if (messages.length === 1) return messages[0]!.content
  const content: any[] = []
  for (const [index, message] of messages.entries()) {
    // The divider owns its line breaks: an adapter joins the blocks of a prompt
    // without adding any, so without them the whole batch is one run-on line.
    content.push({ type: 'text', text: `${index ? '\n' : ''}${inboxDivider(message.origin)}\n` })
    content.push(...message.content)
  }
  return content
}
