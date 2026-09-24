import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import { attachmentPath } from '../../../../lib/notifications'
import { getNotification } from '../../../../lib/repo'

/** Raster images, PDFs and plain text are safe to show inline; the rest is a download. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'])

/**
 * One file an agent attached to a notification.
 *
 * The file came from an agent, and it is served from Domo's own origin, so it
 * is never allowed to run anything there: a sandboxing CSP on every response,
 * no MIME sniffing, and anything that could carry script (HTML, SVG) is sent
 * as a download rather than rendered.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const index = Number(getRouterParam(event, 'index'))
  const notification = await getNotification(id)
  const attachment = Number.isInteger(index) ? notification?.attachments[index] : undefined
  if (!attachment) throw createError({ statusCode: 404, statusMessage: 'Attachment not found' })

  const path = attachmentPath(id, index)
  const info = await stat(path).catch(() => null)
  if (!info) throw createError({ statusCode: 404, statusMessage: 'Attachment file is missing' })

  const inline = INLINE.has(attachment.mimeType)
  setResponseHeaders(event, {
    'content-type': inline ? attachment.mimeType : 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    'content-security-policy': 'sandbox; default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'',
    'x-content-type-options': 'nosniff'
  })
  return sendStream(event, createReadStream(path))
})
