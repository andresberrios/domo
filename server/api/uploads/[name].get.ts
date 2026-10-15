import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { uploadsDir } from '../../lib/paths'

/** Raster images are shown inline; everything else is a download. */
const INLINE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif'
}

/**
 * A file the composer uploaded, for its thumbnail and the lightbox. Only by
 * the name the upload gave it (`up_…`), so nothing else on disk is reachable,
 * and with the same guard as a notification's attachment: a sandboxing CSP,
 * no sniffing, and anything that could carry script sent as a download.
 */
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name') ?? ''
  if (!/^up_[a-f0-9]{20}(\.[\w]+)?$/.test(name)) throw createError({ statusCode: 404, statusMessage: 'Upload not found' })
  const path = join(uploadsDir(), name)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw createError({ statusCode: 404, statusMessage: 'Upload not found' })

  const type = INLINE[extname(name).toLowerCase()]
  setResponseHeaders(event, {
    'content-type': type ?? 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': type ? 'inline' : 'attachment',
    'content-security-policy': 'sandbox; default-src \'none\'; img-src \'self\'',
    'x-content-type-options': 'nosniff',
    // The name is random and the file is never rewritten.
    'cache-control': 'private, max-age=31536000, immutable'
  })
  return sendStream(event, createReadStream(path))
})
