import { extname } from 'node:path'

import { readAgentFile } from '../notifications'
import { MAX_AVATAR_CHARS } from '../../../shared/assistants'
import type { AgentSession } from '../../../shared/types'

/**
 * A picture for an assistant made over the mesh: a file the calling agent can
 * see, or an http(s) URL, turned into the data URL the row stores.
 *
 * Nothing on the server resizes images, so the file has to be small already;
 * the UI shrinks whatever it is given in the browser instead. The type is read
 * from the bytes, not the name, so a misnamed file is still refused.
 */
const MAX_BYTES = Math.floor((MAX_AVATAR_CHARS - 40) * 3 / 4)

function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png'
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

export async function avatarFromSource(caller: AgentSession, source: string): Promise<string> {
  let bytes: Buffer
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(15_000) }).catch((error) => {
      throw new Error(`Could not fetch the picture at ${source}: ${error instanceof Error ? error.message : error}`)
    })
    if (!response.ok) throw new Error(`Could not fetch the picture at ${source}: HTTP ${response.status}.`)
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    bytes = await readAgentFile(caller, source)
  }
  const type = imageType(bytes)
  if (!type) throw new Error(`${extname(source) || source} is not a PNG, JPEG, WebP or GIF image.`)
  if (bytes.length > MAX_BYTES) {
    throw new Error(
      `The picture is ${Math.round(bytes.length / 1024)} KB; the limit is ${Math.floor(MAX_BYTES / 1024)} KB. `
      + 'Shrink it first (a 160×160 image is plenty), or let the human set it in the UI.'
    )
  }
  return `data:${type};base64,${bytes.toString('base64')}`
}
