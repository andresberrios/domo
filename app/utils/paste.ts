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
 * A screenshot on the clipboard arrives with no filename at all, and the name
 * is what the badge shows and what the agent is told the resource link is. So
 * one is made up — dated, because the only thing distinguishing two pasted
 * screenshots is when they were pasted.
 */
export function uploadName(file: File, at: Date = new Date()): string {
  if (file.name) return file.name
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `pasted-${stamp}.${extensionFor(file.type || '')}`
}
