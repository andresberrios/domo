import { acpManager } from '../../lib/acp/manager'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    title?: string
    cwd?: string
    voiceSessionId?: string | null
    modeId?: string | null
    initialPrompt?: string
  }>(event)

  return acpManager.create({
    title: body?.title,
    cwd: body?.cwd,
    voiceSessionId: body?.voiceSessionId ?? null,
    modeId: body?.modeId ?? null,
    initialPrompt: body?.initialPrompt
  })
})
