import { avatarDataUrl } from '../../lib/images/resize'
import { avatarPrompt, generateImage } from '../../lib/images/generate'

/**
 * Draw a picture for an assistant from its name and persona, and hand it
 * back without saving it: the form shows it, and saving the form keeps it.
 * About a minute, on the human's ChatGPT plan through Codex.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, persona?: string, style?: string }>(event)
  const name = String(body?.name ?? '').trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: 'Give the assistant a name first' })
  const image = await generateImage(avatarPrompt({ name, persona: body?.persona, style: body?.style }))
  return { avatar: await avatarDataUrl(image.bytes) }
})
