/**
 * The part of a `DataTransfer` the decision below reads. Structural on
 * purpose: `app/utils` is typechecked by the test project too, which has no
 * DOM, and this way the rule is testable without one.
 */
export interface PastedClipboard {
  readonly files?: ArrayLike<File> | null
  getData: (format: string) => string
}

/**
 * What a paste into the composer means.
 *
 * A clipboard carries the same selection in several flavours at once, so
 * "there is a file on it" is not the same as "the user meant to attach a
 * file". A spreadsheet range, a rich-text selection and some editors all put
 * an `image/png` rendering beside the text, and attaching a picture of what
 * was about to paste correctly is the worse failure of the two — so files are
 * taken only when the clipboard has no text to paste.
 */
export function pastedFiles(data: PastedClipboard | null | undefined): File[] {
  const files: File[] = Array.from<File>(data?.files ?? [])
  if (!files.length) return []
  const text = data?.getData('text/plain') ?? ''
  return text.trim() ? [] : files
}

/**
 * Extensions for the types a clipboard actually hands over unnamed. Anything
 * else falls back to the subtype, which is right often enough (`application/
 * pdf` → `pdf`) and harmless when it is not.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'text/plain': 'txt'
}

function extensionFor(mimeType: string): string {
  if (EXTENSIONS[mimeType]) return EXTENSIONS[mimeType]
  const subtype = mimeType.split('/')[1]?.replace(/[^\w]+.*$/, '')
  return subtype || 'bin'
}

/**
 * The names browsers give every clipboard image (Chrome, Firefox and Safari
 * all hand a screenshot over as `image.png`): a name, but not the file's own.
 */
const CLIPBOARD_NAME = /^image\.[a-z0-9]+$/i

/**
 * What an attachment is called: the badge, the thumbnail's caption, and what
 * the agent is told the resource link is.
 *
 * A file that came with a name of its own keeps it. A clipboard image has
 * none worth keeping — every one is `image.png`, which read as if each paste
 * replaced the last — so it is numbered, `image-1.png`, `image-2.png`, past
 * every name in `taken`: the message's other attachments and the ones the
 * session has already been sent. A real name that is taken gets a number too,
 * from 2, so the agent can still tell the two files apart.
 */
export function uploadName(file: File, taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, name => name.toLowerCase()))
  const own = file.name && !CLIPBOARD_NAME.test(file.name) ? file.name : ''
  if (own && !used.has(own.toLowerCase())) return own

  const dot = own.lastIndexOf('.')
  const stem = own ? (dot > 0 ? own.slice(0, dot) : own) : (file.type.startsWith('image/') ? 'image' : 'pasted')
  const extension = own
    ? (dot > 0 ? own.slice(dot) : '')
    : `.${file.name ? file.name.split('.').pop()!.toLowerCase() : extensionFor(file.type || '')}`
  for (let n = own ? 2 : 1; ; n++) {
    const name = `${stem}-${n}${extension}`
    if (!used.has(name.toLowerCase())) return name
  }
}
