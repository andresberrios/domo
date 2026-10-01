import sharp from 'sharp'

/**
 * Images Domo stores or hands to an agent, checked and shrunk on the server,
 * so a caller can pass whatever picture it has.
 *
 * sharp (libvips) ships prebuilt for macOS and Linux on both architectures,
 * which covers the host Domo runs on; nothing here runs in a container.
 */

/** What a caller may hand over, before any shrinking. */
export const MAX_IMAGE_INPUT_BYTES = 25 * 1024 * 1024

/** Raster formats sharp decodes, recognised by their first bytes, never by a name or a header. */
export function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png'
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii')
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return 'image/heif'
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2A, 0x00])) || bytes.subarray(0, 4).equals(Buffer.from([0x4D, 0x4D, 0x00, 0x2A]))) {
    return 'image/tiff'
  }
  return null
}

export function assertImage(bytes: Buffer, what = 'The picture'): string {
  if (bytes.length > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`${what} is ${Math.round(bytes.length / 1024 / 1024)} MB; the limit is ${MAX_IMAGE_INPUT_BYTES / 1024 / 1024} MB.`)
  }
  const type = imageType(bytes)
  if (!type) throw new Error(`${what} is not an image Domo can read (PNG, JPEG, WebP, GIF, AVIF, HEIF or TIFF).`)
  return type
}

/**
 * An assistant's picture: a 256px square, cropped to the centre, as a WebP
 * data URL of a few kilobytes, which is what its synced row can carry.
 * The first frame of an animation; the orientation a phone camera recorded.
 */
export async function avatarDataUrl(bytes: Buffer): Promise<string> {
  assertImage(bytes)
  const out = await sharp(bytes, { animated: false })
    .rotate()
    .resize(256, 256, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer()
    .catch((error) => {
      throw new Error(`The picture could not be read: ${error instanceof Error ? error.message : error}`)
    })
  return `data:image/webp;base64,${out.toString('base64')}`
}

/** A data URL's bytes, or null when it is not a base64 data URL. */
export function dataUrlBytes(value: string): Buffer | null {
  const match = /^data:[^;,]*;base64,(.*)$/s.exec(value)
  return match ? Buffer.from(match[1]!, 'base64') : null
}
