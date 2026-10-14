/**
 * What is typed into a composer and not sent yet, per session, in this browser.
 * The new-session page is one more key (`new`). Attachments are kept by their
 * upload metadata: the files themselves are already on the server.
 */
export interface ComposerDraft {
  text: string
  attachments: Array<{ name: string, path: string, mimeType: string, size: number }>
}

const PREFIX = 'domo:composer:'

export function readComposerDraft(key: string): ComposerDraft | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PREFIX + key) ?? 'null')
    if (!stored || typeof stored.text !== 'string') return null
    return { text: stored.text, attachments: Array.isArray(stored.attachments) ? stored.attachments : [] }
  } catch {
    return null
  }
}

/** Writes it, or forgets it when there is nothing left to keep. */
export function writeComposerDraft(key: string, draft: ComposerDraft): void {
  try {
    if (!draft.text && !draft.attachments.length) window.localStorage.removeItem(PREFIX + key)
    else window.localStorage.setItem(PREFIX + key, JSON.stringify(draft))
  } catch {
    /* private mode, or full */
  }
}
