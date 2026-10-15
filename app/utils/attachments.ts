/**
 * Where the browser can fetch an attachment the composer uploaded: its file
 * under the uploads directory, served by `server/api/uploads/[name].get.ts`.
 * Only Domo's own upload names (`up_…`) have a URL; a resource link to any
 * other file — an agent's, a path typed by hand — is a name and nothing more.
 */
export function attachmentUrl(pathOrUri: string | null | undefined): string | null {
  const name = pathOrUri?.split('/').pop() ?? ''
  return /^up_[a-f0-9]{20}(\.[\w]+)?$/.test(name) ? `/api/uploads/${name}` : null
}

/** The images a thumbnail can show; SVG is left out, because it can carry script. */
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i

export function isImageAttachment(name: string | null | undefined, mimeType?: string | null): boolean {
  if (mimeType) return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml'
  return IMAGE.test(name ?? '')
}

/** The names of every file a session's messages were sent with, for `uploadName` to number past. */
export function sentAttachmentNames(events: ReadonlyArray<{ type: string, payload: any }>): string[] {
  const names: string[] = []
  for (const event of events) {
    if (event.type !== 'user_message') continue
    for (const block of event.payload?.content ?? []) {
      if (block?.type === 'resource_link' && typeof block.name === 'string') names.push(block.name)
    }
  }
  return names
}
