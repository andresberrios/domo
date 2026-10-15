import { createWriteStream } from 'node:fs'
import { access, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/** A model file at `path`, fetched from `url` the first time. For the local models' process only. */
export async function fetchModelFile(url: string, path: string, what: string): Promise<string> {
  if (await access(path).then(() => true, () => false)) return path
  await mkdir(dirname(path), { recursive: true })
  console.log(`[agent-voice] fetching ${what} into ${path}`)
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`could not fetch ${url}: ${response.status}`)
  const partial = `${path}.part`
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(partial))
  await rename(partial, path)
  return path
}
