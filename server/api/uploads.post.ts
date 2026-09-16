import { writeFile } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { uploadsDir } from '../lib/paths'
import { newId } from '../lib/db'

/** Save attachments so they can be handed to a coding agent as resource links. */
export default defineEventHandler(async (event) => {
  const parts = await readMultipartFormData(event)
  if (!parts?.length) throw createError({ statusCode: 400, statusMessage: 'No file uploaded' })

  const saved: Array<{ name: string, path: string, mimeType: string, size: number }> = []
  for (const part of parts) {
    if (!part.filename || !part.data) continue
    const safeName = basename(part.filename).replace(/[^\w.\- ]+/g, '_')
    const target = join(uploadsDir(), `${newId('up')}${extname(safeName) || ''}`)
    await writeFile(target, part.data)
    saved.push({
      name: safeName,
      path: target,
      mimeType: part.type || 'application/octet-stream',
      size: part.data.length
    })
  }

  if (!saved.length) throw createError({ statusCode: 400, statusMessage: 'No file uploaded' })
  return { files: saved }
})
