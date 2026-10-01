import { readAgentFile } from '../notifications'
import { avatarDataUrl, MAX_IMAGE_INPUT_BYTES } from '../images/resize'
import type { AgentSession } from '../../../shared/types'

/**
 * A picture for an assistant made over the mesh: a file the calling agent can
 * see, or an http(s) URL, shrunk to what the row stores. The type is read
 * from the bytes, not the name or the server's header.
 */
export async function avatarFromSource(caller: AgentSession, source: string): Promise<string> {
  let bytes: Buffer
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(20_000) }).catch((error) => {
      throw new Error(`Could not fetch the picture at ${source}: ${error instanceof Error ? error.message : error}`)
    })
    if (!response.ok) throw new Error(`Could not fetch the picture at ${source}: HTTP ${response.status}.`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_IMAGE_INPUT_BYTES) throw new Error(`The picture at ${source} is larger than ${MAX_IMAGE_INPUT_BYTES / 1024 / 1024} MB.`)
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    bytes = await readAgentFile(caller, source)
  }
  return avatarDataUrl(bytes)
}
