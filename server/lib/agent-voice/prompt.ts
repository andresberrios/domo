import { SPOKEN_NOTE_PREFIX } from '../../../shared/agent-voice'

/**
 * How a coding agent is told about the spoken channel.
 *
 * ACP has no portable way to set a system prompt: the Claude Code adapter
 * reads one from session metadata, Codex and OpenCode have no hook at all.
 * And a system prompt would be the wrong place anyway, because it would
 * change every session, spoken to or not. So the instructions ride on the
 * spoken messages themselves, and the *message* switches the behaviour: a
 * message with the note was spoken and is answered for speech; one without
 * was typed and is answered as text. That is what lets one session move
 * between the composer and the microphone without a restart.
 *
 * Not on every message, though. The full text goes with the first spoken
 * message of an episode (`needsFullInstructions`), and a one-line reminder
 * with the rest, so the agent is neither told the same thing twenty times nor
 * left to remember it across a long typed stretch.
 */
export const SPOKEN_CHANNEL_INSTRUCTIONS = `The developer is talking to you out loud, and your reply is read to them by
text-to-speech as it streams.

Their message was transcribed by speech recognition, which gets ordinary words
right and mishears the ones that matter most here: names of files, functions,
components, tools, libraries, models and people. When a word or phrase looks
odd, read it as the term from this project or this conversation that it sounds
like ("cocoa row" is likely Kokoro, "use a gent voice" likely useAgentVoice),
and search the code when you are not sure. If a mishearing could change what
you do and you cannot settle it, ask one short question before you act.

While messages arrive this way:
- Write the way you would talk. Short plain sentences, contractions. No
  Markdown, no headings, no lists, no code, no file paths, no ids, no URLs.
  Say what a thing is, not where it lives.
- Before you go off to work (reading files, running commands), say in one
  short sentence what you are about to do, so they know you heard them. Then
  work quietly; your tool calls are silent to them.
- When you are done, give the conclusion in two to four sentences: what you
  found or did, what matters, and the one decision or next step if there is
  one. Offer detail instead of reading it all out; they can ask.
- Ask at most one question at a time, then stop and wait.
- Report an action as done only once you did it.

A message without this note was typed. Answer that one in your normal written
form.`

const FULL_NOTE = `${SPOKEN_NOTE_PREFIX}\n\n${SPOKEN_CHANNEL_INSTRUCTIONS}`
const SHORT_NOTE = `${SPOKEN_NOTE_PREFIX} Transcribed from speech: read odd words as the project or conversation terms they sound like. Answer for speech, as the earlier spoken message described.`

/** How long a spoken episode is trusted to be remembered. */
const EPISODE_MS = 30 * 60_000
/** How many user messages the full text is good for before it is repeated. */
const EPISODE_MESSAGES = 12

export function spokenNoteKind(text: string | null | undefined): 'full' | 'short' | null {
  if (typeof text !== 'string' || !text.startsWith(SPOKEN_NOTE_PREFIX)) return null
  return text === FULL_NOTE ? 'full' : 'short'
}

function noteOf(content: any[]): 'full' | 'short' | null {
  for (const block of content) {
    const kind = block?.type === 'text' ? spokenNoteKind(block.text) : null
    if (kind) return kind
  }
  return null
}

/**
 * Whether the next spoken message needs the whole text, judged from the
 * newest user messages (newest first). It does when the previous message was
 * typed (the channel changed), when the full text is not within the last
 * dozen messages, or when the last spoken one is half an hour old.
 */
export function needsFullInstructions(
  recent: Array<{ content: any[], createdAt: string }>,
  now = Date.now()
): boolean {
  const last = recent[0]
  if (!last || !noteOf(last.content)) return true
  if (now - Date.parse(last.createdAt) > EPISODE_MS) return true
  return !recent.slice(0, EPISODE_MESSAGES).some(message => noteOf(message.content) === 'full')
}

/**
 * The content blocks a spoken turn is delivered as: the words, then the note.
 * Two blocks rather than one so the transcript can hide the note and show a
 * microphone instead (`isSpokenNote`).
 */
export function spokenContent(
  transcript: string,
  options: { full: boolean }
): Array<{ type: 'text', text: string }> {
  return [
    { type: 'text', text: transcript },
    { type: 'text', text: options.full ? FULL_NOTE : SHORT_NOTE }
  ]
}
